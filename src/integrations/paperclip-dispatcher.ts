/**
 * Avelton-claw → Paperclip chat-reply dispatcher.
 *
 * Bridges user-facing chat replies arriving in OpenClaw sessions that
 * were originated by Paperclip (via `paperclip_channel_send`) back to
 * Paperclip's inbound webhook so that `paperclip_channel_wait` resolves.
 *
 * Wiring contract: every code path in Avelton-claw that receives a
 * user-typed reply in a chat session should call `dispatchUserReply`
 * with the session key + body + optional correlationId. The dispatcher
 * decides whether the reply belongs to Paperclip by inspecting the
 * session key (prefix `paperclip:` by convention) or a caller-supplied
 * origin flag. Non-Paperclip sessions are ignored — the dispatcher
 * costs nothing when not applicable.
 *
 * Session-key convention (documented in the Paperclip MCP tools):
 *   paperclip:{companyId}:{purpose}
 *   paperclip:{companyId}:agent:{agentName}
 *
 * The first segment is `paperclip`; the second is the companyId we
 * need to forward to Paperclip. We parse it out so callers don't have
 * to carry `companyId` through every layer of the chat stack.
 *
 * Correlation:
 *   - If the outbound MCP tool call attached a `correlationId` in its
 *     metadata, OpenClaw must thread it back on replies as
 *     `inReplyToCorrelationId` for `paperclip_channel_wait` to match.
 *   - Otherwise the reply is still delivered, but agents waiting on a
 *     specific correlationId will time out rather than picking it up.
 *
 * Backpressure & overflow semantics — drop-or-buffer-on-overflow
 * (default-disabled buffer, drop-on-overflow when buffer disabled):
 *   - The dispatcher is fire-and-forget — `maybeDispatchReplyToPaperclip`
 *     in paperclip-bootstrap.ts schedules the call and does NOT await it
 *     in the user-facing chat.send reply path. That is intentional: a
 *     slow or broken Paperclip MUST NOT block the chat user's reply.
 *   - Under sustained Paperclip outage, outbound attempts fail fast via
 *     the breaker in paperclip-client.ts; the dispatcher records each
 *     skipped/failed attempt as `openclaw_dispatcher_dispatch_total`
 *     `{outcome="failed"}` (breaker-blocked) or `{outcome="skipped"}`
 *     (not-a-paperclip-session).
 *   - Optional in-memory retry buffer (T5, 2026-04-25): when
 *     PAPERCLIP_DISPATCHER_BUFFER_MAX > 0, replies that fail with
 *     `breaker_open` are queued in a TTL-bounded FIFO. The next
 *     successful dispatch drains the buffer (Paperclip's inbound
 *     idempotency-key handling makes re-delivery safe). Cap reaches
 *     drop the OLDEST entry (FIFO eviction); TTL expiry drops a
 *     meaningfully-stale entry (the chat user has likely moved on).
 *     The buffer is OFF by default to preserve pre-T5 semantics — set
 *     PAPERCLIP_DISPATCHER_BUFFER_MAX=100 (and optionally
 *     PAPERCLIP_DISPATCHER_BUFFER_TTL_MS, default 120000) to enable.
 *     This closes the brief-outage case (≤ TTL) without going to a
 *     durable queue. For longer outages the contract remains drop:
 *     a durable queue would need persistence, at-least-once semantics,
 *     and dedup — out of scope for the homelab/single-host profile.
 *     Operators who need at-least-once for arbitrary outage durations
 *     should run Paperclip with ≥ two replicas behind traefik (the
 *     inbound endpoint is idempotent on `idempotencyKey`).
 *   - The canonical "bridge is dropping replies" signal is
 *     `rate(openclaw_dispatcher_dispatch_total{outcome="failed"}[5m])`
 *     staying non-zero while the outbound breaker is `open`, AND
 *     `rate(openclaw_dispatcher_buffer_evicted_total{reason="ttl_expired"}[5m])`
 *     non-zero (when the buffer is enabled — replies aged out before
 *     the breaker recovered). Alert on either; don't alert on
 *     `outcome="skipped"` (benign no-op).
 */

import type { PaperclipClient } from "./paperclip-client.js";
import { withBridgeSpan } from "./paperclip-spans.js";
import { getActivePaperclipMetrics } from "./paperclip-metrics.js";

type Logger = {
  warn(msg: string, ...args: unknown[]): void;
  info?(msg: string, ...args: unknown[]): void;
};

/**
 * The session-key prefix Paperclip's MCP channel tools use on every
 * outbound message. Kept as an exported constant so both sides of the
 * bridge can reference it symbolically.
 */
export const PAPERCLIP_SESSION_PREFIX = "paperclip:" as const;

export interface DispatchUserReplyInput {
  /** OpenClaw session key the reply arrived on. */
  sessionKey: string;
  /** Plaintext reply body typed by the end user. */
  message: string;
  /** Optional correlationId — typically propagated from the outbound metadata. */
  correlationId?: string;
  /** Optional external user id (Slack user, Telegram username, etc.). */
  externalUserId?: string;
  /**
   * Override the companyId parsed from the session key. Use when the
   * session-key convention doesn't apply (e.g. metadata-routed
   * sessions) — callers must supply a UUID.
   */
  companyIdOverride?: string;
  /** Optional idempotency key for retry-safe delivery. */
  idempotencyKey?: string;
  /** Optional W3C traceparent to propagate the bridge trace. */
  traceparent?: string;
  /** Arbitrary metadata attached to the inbound row. */
  metadata?: Record<string, unknown>;
}

export interface DispatchUserReplyResult {
  /** "forwarded" when the reply was sent, "skipped" when not a Paperclip session,
   *  "failed" when Paperclip rejected or was unreachable. */
  outcome: "forwarded" | "skipped" | "failed";
  /** Reason string, helpful for logging. */
  reason?: string;
  /** Paperclip's message id, when the forward succeeded. */
  messageId?: string;
}

/** UUID regex — tolerant of uppercase and missing dashes to cover legacy ids. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Map a (status, latencyMs) tuple from `paperclip-client.postInbound` to
 * the dispatcher's error_category vocabulary. Vocabulary kept narrow so
 * the Prometheus label cardinality stays bounded:
 *
 *   - `breaker_open` — paperclip-client short-circuited because the
 *     outbound breaker is open. Distinguished from a real upstream 503
 *     by `latencyMs === 0` (the breaker block path is the only return
 *     site that sets latency to zero).
 *   - `http_4xx` / `http_5xx` — Paperclip responded with a status the
 *     client classified as a non-success. Different remediation per
 *     class: 4xx is a contract bug (idempotency key collision, missing
 *     companyId, malformed payload) and operator should fix the call;
 *     5xx is an upstream incident and the breaker will trip if it
 *     persists.
 *   - `network` — fetch threw or returned with no status (DNS failure,
 *     connection refused, TLS, AbortError). Indistinguishable from
 *     "Paperclip is just down" — the breaker will close shortly.
 *   - `unknown` — guard for the unexpected (status defined but outside
 *     200–599). Should never fire in practice; if it does we want the
 *     metric to surface "we got something weird" rather than silently
 *     bucketed into `network`.
 *
 * Exported so the unit test can pin every branch — without that test,
 * a future refactor of paperclip-client's return shape (e.g. adding a
 * `reason` field directly) could quietly land all failures in the
 * `unknown` bucket and operators would only notice during an incident.
 */
export function classifyDispatchFailure(
  status: number | undefined,
  latencyMs: number | undefined,
): string {
  if (status === 503 && latencyMs === 0) return "breaker_open";
  if (typeof status === "number") {
    if (status >= 500 && status < 600) return "http_5xx";
    if (status >= 400 && status < 500) return "http_4xx";
    return "unknown";
  }
  return "network";
}

/**
 * Extract the company UUID from a Paperclip session key. Returns null
 * when the session isn't a Paperclip session or the second segment
 * isn't a UUID. Public so unit tests can cover the parsing.
 */
export function parsePaperclipCompanyId(sessionKey: string): string | null {
  if (!sessionKey.startsWith(PAPERCLIP_SESSION_PREFIX)) return null;
  const rest = sessionKey.slice(PAPERCLIP_SESSION_PREFIX.length);
  const firstSep = rest.indexOf(":");
  const candidate = firstSep === -1 ? rest : rest.slice(0, firstSep);
  if (!candidate) return null;
  if (!UUID_RE.test(candidate)) return null;
  return candidate.toLowerCase();
}

/**
 * TTL-bounded retry buffer config. The dispatcher's behaviour stays
 * pre-T5 (drop-on-breaker-open) when {@link maxSize} is 0 or negative —
 * the entire buffer code path becomes inert. Operators opt in by
 * setting PAPERCLIP_DISPATCHER_BUFFER_MAX > 0 (typically 50–200).
 */
export interface DispatcherBufferConfig {
  /** Hard cap on buffered entries. When the cap is reached and a new
   *  failure tries to enqueue, the OLDEST entry is dropped (FIFO).
   *  0 (default) → buffer disabled — preserves the pre-T5 contract. */
  maxSize: number;
  /** Time-to-live in milliseconds. Entries older than this are
   *  evicted on every dispatch attempt, before any drain or enqueue,
   *  so the buffer never serves a reply that's older than the TTL.
   *  Default 120000 (2 min) targets the brief-outage case. */
  ttlMs: number;
}

const DEFAULT_BUFFER_TTL_MS = 120_000;

/**
 * Read the dispatcher buffer config from the environment. Mirrors
 * the resolveX pattern used by paperclip-heartbeat. Defensive on
 * malformed inputs: a non-finite or negative MAX produces a disabled
 * buffer, NOT a thrown error — the dispatcher must keep working
 * even when env is misconfigured.
 */
export function resolveDispatcherBufferConfig(
  env: NodeJS.ProcessEnv = process.env,
): DispatcherBufferConfig {
  const rawMax = Number(env.PAPERCLIP_DISPATCHER_BUFFER_MAX);
  const maxSize =
    Number.isFinite(rawMax) && rawMax > 0 ? Math.trunc(rawMax) : 0;
  const rawTtl = Number(env.PAPERCLIP_DISPATCHER_BUFFER_TTL_MS);
  const ttlMs =
    Number.isFinite(rawTtl) && rawTtl > 0
      ? Math.trunc(rawTtl)
      : DEFAULT_BUFFER_TTL_MS;
  return { maxSize, ttlMs };
}

export interface CreatePaperclipDispatcherOptions {
  /** The configured Paperclip inbound client. When null, dispatcher no-ops. */
  client: PaperclipClient | null;
  logger?: Logger;
  /** Optional override of the buffer config. Falls back to env
   *  lookup via {@link resolveDispatcherBufferConfig}. Tests inject
   *  a tight TTL + small cap for fast deterministic assertions. */
  bufferConfig?: DispatcherBufferConfig;
  /** Test-only clock. Defaults to Date.now. Replacing it lets the
   *  buffer-TTL eviction test advance "time" without sleeping. */
  now?: () => number;
}

export interface PaperclipDispatcher {
  dispatchUserReply(input: DispatchUserReplyInput): Promise<DispatchUserReplyResult>;
  /**
   * Test-only inspector for the current buffer depth. The metric layer
   * is the production read path; this is a shortcut for unit tests
   * that don't want to render the full Prometheus exposition just to
   * read one number. Hidden from PaperclipIntegration's public surface.
   */
  __getBufferSize?(): number;
}

/**
 * One pending entry in the retry buffer. We keep the original input
 * verbatim — the call we want to retry should look identical to the
 * call that originally failed. Paperclip's inbound idempotency-key
 * handling makes re-delivery safe even if a partial earlier attempt
 * landed.
 */
interface BufferEntry {
  input: DispatchUserReplyInput;
  companyId: string;
  queuedAt: number;
}

export function createPaperclipDispatcher(
  opts: CreatePaperclipDispatcherOptions,
): PaperclipDispatcher {
  const { client, logger } = opts;
  const bufferConfig = opts.bufferConfig ?? resolveDispatcherBufferConfig();
  const now = opts.now ?? (() => Date.now());

  // Single FIFO buffer per dispatcher instance. We push to the back
  // on a fresh failure, shift from the front on drain. The cap is
  // small (default 100) so Array.shift's O(n) cost is irrelevant.
  const buffer: BufferEntry[] = [];

  function bufferEnabled(): boolean {
    return bufferConfig.maxSize > 0;
  }

  /** Drop entries older than TTL. Called before any other buffer
   *  operation so we never serve, drain, or count stale entries. */
  function pruneExpired(): void {
    if (!bufferEnabled()) return;
    const cutoff = now() - bufferConfig.ttlMs;
    let evicted = 0;
    while (buffer.length > 0 && buffer[0]!.queuedAt < cutoff) {
      buffer.shift();
      evicted++;
    }
    if (evicted > 0) {
      const m = getActivePaperclipMetrics();
      for (let i = 0; i < evicted; i++) {
        m?.recordDispatcherBufferEvicted("ttl_expired");
      }
      m?.setDispatcherBufferSize(buffer.length);
      logger?.info?.(
        `paperclip-dispatcher: buffer evicted ${evicted} TTL-expired ${evicted === 1 ? "entry" : "entries"} (depth=${buffer.length})`,
      );
    }
  }

  /** Enqueue a failed entry. Drops the oldest on cap reach. No-op
   *  when the buffer is disabled (pre-T5 behavior preserved). */
  function enqueue(input: DispatchUserReplyInput, companyId: string): void {
    if (!bufferEnabled()) return;
    if (buffer.length >= bufferConfig.maxSize) {
      buffer.shift();
      getActivePaperclipMetrics()?.recordDispatcherBufferEvicted("cap_reached");
    }
    buffer.push({ input, companyId, queuedAt: now() });
    getActivePaperclipMetrics()?.setDispatcherBufferSize(buffer.length);
  }

  /** Re-attempt buffered entries in FIFO order. Stops on the first
   *  failure to avoid hammering an open breaker — the next successful
   *  dispatch will resume the drain. */
  async function drainBuffer(): Promise<void> {
    if (!bufferEnabled() || buffer.length === 0 || !client) return;
    pruneExpired();
    while (buffer.length > 0) {
      const entry = buffer[0]!;
      const trimmedMessage = entry.input.message.trim();
      const enrichedMetadata: Record<string, unknown> = {
        ...(entry.input.metadata ?? {}),
        source: "openclaw",
        ...(entry.input.traceparent ? { traceparent: entry.input.traceparent } : {}),
      };
      const res = await client.postInbound({
        companyId: entry.companyId,
        sessionKey: entry.input.sessionKey,
        message: trimmedMessage,
        inReplyToCorrelationId: entry.input.correlationId,
        idempotencyKey: entry.input.idempotencyKey,
        ...(entry.input.externalUserId ? { userId: entry.input.externalUserId } : {}),
        metadata: enrichedMetadata,
        traceparent: entry.input.traceparent,
      });
      const m = getActivePaperclipMetrics();
      if (res.ok) {
        buffer.shift();
        m?.recordDispatcherBufferDrained("forwarded");
        m?.setDispatcherBufferSize(buffer.length);
        logger?.info?.(
          `paperclip-dispatcher: drained buffered reply for session=${entry.input.sessionKey} → id=${res.messageId ?? "?"} (depth=${buffer.length})`,
        );
      } else {
        // Stop on first failure — likely the breaker is still open or
        // half-open and we don't want to burn through retries in a
        // tight loop. The next successful dispatchUserReply call
        // will resume.
        m?.recordDispatcherBufferDrained("failed");
        break;
      }
    }
  }

  async function dispatchUserReply(
    input: DispatchUserReplyInput,
  ): Promise<DispatchUserReplyResult> {
    // Wrap the whole dispatch in a span so operators can correlate
    // "user reply arrived in openclaw" with "forward to paperclip
    // failed" inside a single Tempo trace, joined by the traceparent
    // the caller threaded in. The `outbound` direction on this span
    // mirrors the direction on the inner postInbound span — both
    // describe the same arrow from OpenClaw's point of view.
    const parsedCompanyId = input.companyIdOverride ?? parsePaperclipCompanyId(input.sessionKey);
    return withBridgeSpan(
      "openclaw.paperclip.dispatchUserReply",
      {
        "bridge.direction": "outbound",
        "bridge.company_id": parsedCompanyId ?? undefined,
        "bridge.session_key": input.sessionKey,
        "bridge.correlation_id": input.correlationId ?? input.idempotencyKey,
        "bridge.has_traceparent": input.traceparent != null,
        "peer.service": "paperclip",
      },
      async (ctx) => {
        // Always prune TTL-expired entries up front so a long-stalled
        // buffer doesn't grow unbounded across "skipped" calls.
        pruneExpired();

        const result = await dispatchUserReplyImpl(input, parsedCompanyId);
        const metrics = getActivePaperclipMetrics();
        // Reason on failed dispatches is one of:
        //   "breaker_open" — paperclip-client short-circuited (status=503, latency=0)
        //   "http_4xx" / "http_5xx" — Paperclip responded with an error
        //   "network" — fetch rejected (connection refused, DNS, TLS, abort)
        //   "unknown" — fallthrough (shouldn't happen; log if it does)
        // For forwarded/skipped the metric layer normalises this to "none".
        metrics?.recordDispatch(result.outcome, result.reason);
        if (result.outcome === "failed") {
          // Tempo-visible marker so a failed dispatch is findable by
          // operators filtering on event name without diving into the
          // log stream. The reason string mirrors `result.reason` so
          // the event annotates "why" without duplicating the top-level
          // span status (which is already error via annotateResult).
          ctx.addEvent("dispatch_failed", {
            "bridge.error_category": result.reason ?? "unknown",
            ...(input.correlationId ? { "bridge.correlation_id": input.correlationId } : {}),
          });
          // Buffer the failed entry IFF (a) buffer is enabled, (b) the
          // failure was a breaker-block (transient outage by definition;
          // 4xx/5xx are deterministic per-request faults that retrying
          // wouldn't fix), and (c) we have a valid companyId — entries
          // without one weren't legitimate Paperclip sessions to begin
          // with.
          if (
            result.reason === "breaker_open" &&
            parsedCompanyId &&
            input.message.trim().length > 0
          ) {
            enqueue(input, parsedCompanyId);
          }
        } else if (result.outcome === "forwarded") {
          // A success means the breaker just confirmed it's at least
          // half-open — try draining buffered entries. We don't await
          // the drain in the user-facing critical path; do it inline
          // here since we're already past the per-call result and
          // the chat user has their reply confirmation.
          //
          // Drain failures don't propagate to the caller — the current
          // dispatch already succeeded and the buffer state is private.
          try {
            await drainBuffer();
          } catch (err) {
            logger?.warn(
              `paperclip-dispatcher: buffer drain threw — keeping entries for next attempt (${err instanceof Error ? err.message : String(err)})`,
            );
          }
        }
        return result;
      },
    );
  }

  async function dispatchUserReplyImpl(
    input: DispatchUserReplyInput,
    companyId: string | null,
  ): Promise<DispatchUserReplyResult> {
    if (!client) {
      return { outcome: "skipped", reason: "paperclip-client-not-configured" };
    }

    if (!companyId) {
      // Not a Paperclip session (or an ill-formed one). No-op.
      return { outcome: "skipped", reason: "not-a-paperclip-session" };
    }

    const trimmedMessage = input.message.trim();
    if (!trimmedMessage) {
      return { outcome: "skipped", reason: "empty-message" };
    }

    const enrichedMetadata: Record<string, unknown> = {
      ...(input.metadata ?? {}),
      source: "openclaw",
      ...(input.traceparent ? { traceparent: input.traceparent } : {}),
    };

    const res = await client.postInbound({
      companyId,
      sessionKey: input.sessionKey,
      message: trimmedMessage,
      inReplyToCorrelationId: input.correlationId,
      idempotencyKey: input.idempotencyKey,
      ...(input.externalUserId ? { userId: input.externalUserId } : {}),
      metadata: enrichedMetadata,
      traceparent: input.traceparent,
    });

    if (res.ok) {
      logger?.info?.(
        `paperclip-dispatcher: forwarded reply for session=${input.sessionKey} → id=${res.messageId ?? "?"}`,
      );
      return { outcome: "forwarded", messageId: res.messageId };
    }
    logger?.warn(
      `paperclip-dispatcher: forward failed for session=${input.sessionKey} status=${res.status ?? "n/a"}`,
    );
    return {
      outcome: "failed",
      reason: classifyDispatchFailure(res.status, res.latencyMs),
    };
  }

  return {
    dispatchUserReply,
    __getBufferSize: () => buffer.length,
  };
}
