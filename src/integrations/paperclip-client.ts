/**
 * Avelton-claw → Paperclip inbound webhook client.
 *
 * Posts chat-channel replies to Paperclip's
 * POST /api/integrations/openclaw/inbound endpoint so that when a human
 * replies to an OpenClaw-mediated session, Paperclip (which issued the
 * outbound message via `paperclip_channel_send`) sees the response and
 * can surface it to the waiting agent via `paperclip_channel_wait`.
 *
 * Wire contract — the POST body must match Paperclip's `inboundSchema`
 * (see paperclip-avelton/server/src/routes/openclaw-inbound.ts):
 *   {
 *     companyId: string,             // UUID
 *     sessionKey: string,             // same key used on the outbound
 *     userId?: string,                // optional external user id
 *     message: string,                // <= 16000 chars
 *     inReplyToCorrelationId?: string, // echo outbound correlationId
 *     agentId?: string,               // optional UUID
 *     idempotencyKey?: string,        // UUID for replay dedup
 *     metadata?: Record<string, unknown>,
 *   }
 *
 * Authentication — shared bearer from PAPERCLIP_INBOUND_TOKEN. Paperclip
 * returns 503 when the token is unset, so a missing env on either side
 * makes the bridge degrade gracefully rather than silently misrouting.
 *
 * The client is intentionally mirror-symmetric to Paperclip's own
 * outbound openclaw-client: 3 attempts total, backoff [500ms, 1500ms],
 * 5-second per-attempt timeout. Failures are logged and returned as
 * `{ ok: false }` — callers must not throw so a temporary Paperclip
 * outage doesn't break the OpenClaw agent run that produced the reply.
 */

import { createPaperclipCircuit, type PaperclipCircuit } from "./paperclip-circuit.js";
import { recordCircuitTransitionSpan, withBridgeSpan } from "./paperclip-spans.js";
import { getActivePaperclipMetrics } from "./paperclip-metrics.js";

type Logger = {
  warn(msg: string, ...args: unknown[]): void;
  info?(msg: string, ...args: unknown[]): void;
};

export const PAPERCLIP_CLIENT_TIMEOUT_MS = 5_000;
export const PAPERCLIP_CLIENT_RETRY_DELAYS_MS = [500, 1500];

export interface PaperclipClientConfig {
  /**
   * Paperclip base URL, e.g. `http://paperclip:3100`. The inbound path is
   * derived from this by appending `/api/integrations/openclaw/inbound`
   * unless `inboundUrl` is given explicitly.
   */
  baseUrl?: string;
  /** Explicit override for the inbound endpoint; takes precedence over baseUrl. */
  inboundUrl?: string;
  /** Shared bearer gating the Paperclip inbound route. Required to activate the client. */
  inboundToken?: string;
}

export interface PostInboundInput {
  companyId: string;
  sessionKey: string;
  message: string;
  userId?: string;
  inReplyToCorrelationId?: string;
  agentId?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  /** Optional W3C traceparent to propagate the bridge trace end-to-end. */
  traceparent?: string;
}

export interface PostInboundResult {
  ok: boolean;
  /** HTTP status of the first terminal response (success or final failure). */
  status?: number;
  /**
   * When Paperclip returns 200 with idempotent=true, the caller was a
   * duplicate and no new row was written. Useful for tracing "we tried
   * twice, Paperclip deduped correctly".
   */
  idempotent?: boolean;
  /** The id of the persisted agent_channel_messages row, when Paperclip returns one. */
  messageId?: string;
  /** Measured latency of the successful attempt, in milliseconds. */
  latencyMs?: number;
}

export interface PaperclipClient {
  postInbound(input: PostInboundInput): Promise<PostInboundResult>;
  /** Snapshot of the outbound circuit-breaker state — exposed for /health. */
  circuit(): PaperclipCircuit;
}

export function resolvePaperclipClientConfig(
  env: NodeJS.ProcessEnv = process.env,
): PaperclipClientConfig | null {
  const inboundUrl = env.PAPERCLIP_INBOUND_URL?.trim();
  const baseUrl = env.PAPERCLIP_BASE_URL?.trim();
  const inboundToken = env.PAPERCLIP_INBOUND_TOKEN?.trim();
  if (!inboundUrl && !baseUrl) return null;
  return {
    baseUrl,
    inboundUrl,
    inboundToken,
  };
}

export function deriveInboundUrl(cfg: PaperclipClientConfig): string | null {
  if (cfg.inboundUrl) return cfg.inboundUrl;
  if (!cfg.baseUrl) return null;
  const trimmed = cfg.baseUrl.replace(/\/+$/, "");
  return `${trimmed}/api/integrations/openclaw/inbound`;
}

/**
 * Create a Paperclip inbound client. Returns `null` when the environment
 * doesn't define PAPERCLIP_BASE_URL/PAPERCLIP_INBOUND_URL so callers can
 * short-circuit without throwing. This mirrors the graceful-degrade
 * contract Paperclip's own openclaw-client uses on the opposite arrow.
 */
export function createPaperclipClient(
  config?: PaperclipClientConfig | null,
  deps: { logger?: Logger; fetchImpl?: typeof fetch; circuit?: PaperclipCircuit } = {},
): PaperclipClient | null {
  const cfg = config ?? resolvePaperclipClientConfig();
  if (!cfg) return null;
  const url: string | null = deriveInboundUrl(cfg);
  if (!url) return null;
  // Capture the post-narrowing URL in a closure-stable const. Without this
  // the closure inside postInbound widens `url` back to `string | null`
  // and trips fetch()'s typing — the original cause of a long-standing
  // typecheck error in this file.
  const targetUrl: string = url;
  if (!cfg.inboundToken) {
    deps.logger?.warn(
      "paperclip-client: PAPERCLIP_INBOUND_TOKEN is unset — requests will fail 401. " +
        "Either set the token or clear PAPERCLIP_BASE_URL to disable the client.",
    );
  }
  const fetchFn = deps.fetchImpl ?? fetch;
  // When the caller doesn't supply a pre-built circuit, attach a default
  // transition listener that surfaces state changes through the client's
  // logger. This makes trips and recoveries visible in the same log
  // stream as the HTTP retry warnings above, so operators can correlate
  // "the circuit opened at 12:34" with "the request bursts that led to
  // it". A caller-supplied circuit keeps its own listener policy.
  const circuit =
    deps.circuit ??
    createPaperclipCircuit(undefined, {
      onTransition: (event) => {
        deps.logger?.warn(
          `paperclip-circuit: ${event.from} → ${event.to} (${event.reason})`,
        );
        // Tempo-visible record of the trip so an operator investigating
        // a postInbound failure spike can find the breaker open event in
        // the same trace search. arrow="paperclip_outbound" matches the
        // Prometheus gauge label.
        recordCircuitTransitionSpan("paperclip_outbound", event);
      },
    });

  async function postInbound(input: PostInboundInput): Promise<PostInboundResult> {
    return withBridgeSpan(
      "openclaw.paperclip.postInbound",
      {
        // From Avelton-claw's POV this is the outbound arrow (we're
        // posting to Paperclip); Paperclip records the matching span
        // as direction="inbound" on the receive side. The two line up
        // in Tempo via the shared traceparent/correlationId.
        "bridge.direction": "outbound",
        "bridge.company_id": input.companyId,
        "bridge.session_key": input.sessionKey,
        "bridge.correlation_id": input.inReplyToCorrelationId ?? input.idempotencyKey,
        "bridge.has_traceparent": input.traceparent != null,
        "http.url": targetUrl,
        "peer.service": "paperclip",
      },
      () => postInboundImpl(input),
    );
  }

  async function postInboundImpl(input: PostInboundInput): Promise<PostInboundResult> {
    if (!circuit.allow()) {
      deps.logger?.warn("paperclip-client: circuit open — short-circuiting POST without network call");
      return { ok: false, status: 503, latencyMs: 0 };
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg!.inboundToken) headers["Authorization"] = `Bearer ${cfg!.inboundToken}`;
    if (input.traceparent) headers["traceparent"] = input.traceparent;

    const body = JSON.stringify({
      companyId: input.companyId,
      sessionKey: input.sessionKey,
      message: input.message,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.inReplyToCorrelationId
        ? { inReplyToCorrelationId: input.inReplyToCorrelationId }
        : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });

    const startedAt = Date.now();
    const maxAttempts = 1 + PAPERCLIP_CLIENT_RETRY_DELAYS_MS.length;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PAPERCLIP_CLIENT_TIMEOUT_MS);
      try {
        const res = await fetchFn(targetUrl, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
        clearTimeout(timer);

        // 201 → new row; 200 with idempotent=true → dedup replay. Both
        // are treated as success — the caller has no more work to do.
        if (res.ok) {
          let messageId: string | undefined;
          let idempotent = false;
          try {
            const parsed = (await res.json()) as unknown;
            if (parsed && typeof parsed === "object") {
              const obj = parsed as Record<string, unknown>;
              if (typeof obj.id === "string") messageId = obj.id;
              if (obj.idempotent === true) idempotent = true;
            }
          } catch {
            // Body may be empty; that's fine.
          }
          circuit.recordSuccess();
          const latencyMs = Date.now() - startedAt;
          const metrics = getActivePaperclipMetrics();
          metrics?.recordRequest("outbound", "ok");
          metrics?.recordLatency("outbound", latencyMs);
          return {
            ok: true,
            status: res.status,
            messageId,
            idempotent,
            latencyMs,
          };
        }

        // Non-2xx. 5xx / network blips deserve a retry; 4xx is the caller's
        // problem (bad body, bad token) — no point retrying the same payload.
        const retryable = res.status >= 500 && res.status < 600;
        if (retryable && attempt < PAPERCLIP_CLIENT_RETRY_DELAYS_MS.length) {
          deps.logger?.warn(
            `paperclip-client: inbound failed status=${res.status} attempt=${attempt + 1} — retrying`,
          );
          await new Promise((r) => setTimeout(r, PAPERCLIP_CLIENT_RETRY_DELAYS_MS[attempt]));
          continue;
        }
        deps.logger?.warn(
          `paperclip-client: inbound failed status=${res.status} (no retry, will not re-send)`,
        );
        // 4xx is a caller bug, not a Paperclip outage — don't trip the
        // breaker on those. Only 5xx counts toward the failure tally.
        if (res.status >= 500) {
          circuit.recordFailure(`http_${res.status}`);
        }
        const latencyMs = Date.now() - startedAt;
        const metrics = getActivePaperclipMetrics();
        metrics?.recordRequest("outbound", "error", `http_${res.status}`);
        metrics?.recordLatency("outbound", latencyMs);
        return { ok: false, status: res.status, latencyMs };
      } catch (err) {
        clearTimeout(timer);
        if (attempt < PAPERCLIP_CLIENT_RETRY_DELAYS_MS.length) {
          deps.logger?.warn(
            `paperclip-client: inbound network error attempt=${attempt + 1}: ${String(err)} — retrying`,
          );
          await new Promise((r) => setTimeout(r, PAPERCLIP_CLIENT_RETRY_DELAYS_MS[attempt]));
          continue;
        }
        deps.logger?.warn(
          `paperclip-client: inbound network error after ${attempt + 1} attempts: ${String(err)}`,
        );
        circuit.recordFailure(`network: ${String(err)}`);
        const latencyMs = Date.now() - startedAt;
        // AbortController signals an abort on timeout; all other throws
        // (DNS, connection refused, TLS) land as "error/network".
        const isTimeout = err instanceof Error && err.name === "AbortError";
        const metrics = getActivePaperclipMetrics();
        metrics?.recordRequest("outbound", isTimeout ? "timeout" : "error", "network");
        metrics?.recordLatency("outbound", latencyMs);
        return { ok: false, latencyMs };
      }
    }
    circuit.recordFailure("max_attempts_exhausted");
    const latencyMs = Date.now() - startedAt;
    const metrics = getActivePaperclipMetrics();
    metrics?.recordRequest("outbound", "error", "max_attempts_exhausted");
    metrics?.recordLatency("outbound", latencyMs);
    return { ok: false, latencyMs };
  }

  return {
    postInbound,
    circuit: () => circuit,
  };
}
