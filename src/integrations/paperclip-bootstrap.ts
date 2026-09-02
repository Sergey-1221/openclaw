/**
 * Paperclip integration bootstrap.
 *
 * Single entry point that activates the five Paperclip-facing clients
 * during gateway startup. Exposed via `startPaperclipIntegration()` so
 * the gateway runner can wire it in without having to know each
 * module's env-resolution shape.
 *
 * Every piece is strictly opt-in via env:
 *   - Heartbeat requires PAPERCLIP_BASE_URL + PAPERCLIP_AGENT_API_KEY
 *   - Dispatcher + Client require PAPERCLIP_INBOUND_TOKEN
 *   - Auth requires OPENCLAW_EXCHANGE_CLIENT_SECRET
 *   - MCP requires PAPERCLIP_BASE_URL (+ auth or a static API key)
 *
 * Any missing piece disables just that direction — the others keep
 * working. A bridge where only the Logto-exchange flow is wired still
 * works for per-user Paperclip tool calls even if service-account
 * inbound is off, and vice versa.
 *
 * Singleton + chat-stack integration:
 *   `startPaperclipIntegration()` sets a module-level
 *   `activeIntegration` reference that `maybeDispatchReplyToPaperclip()`
 *   reads to forward chat replies into Paperclip. The dispatcher itself
 *   is fire-and-forget — by design, a slow Paperclip must not block
 *   user-facing chat replies. The chat layer calls into the helper and
 *   ignores the returned promise on the hot path.
 *
 * Graceful shutdown contract:
 *   The fire-and-forget dispatcher would orphan in-flight HTTP calls on
 *   SIGTERM, leaving spans without `.end()` and bridge_audit rows
 *   never written on Paperclip's side. To avoid that, every
 *   `maybeDispatchReplyToPaperclip()` promise is tracked in a private
 *   per-integration Set; `integration.drain(timeoutMs)` returns once
 *   all tracked promises settle (or `timeoutMs` elapses, default 5s).
 *   The gateway's SIGTERM handler MUST `await integration.drain()`
 *   BEFORE calling `integration.stop()` (which releases timers) and
 *   BEFORE awaiting `stopPaperclipOtel()` (which flushes pending
 *   spans). See `src/cli/gateway-cli/run.ts` stopBridge for the
 *   canonical sequence; deviating from that order silently drops
 *   either the audit row (skipping drain) or the span export
 *   (firing-and-forgetting OTel shutdown).
 *
 *   Hand-constructed integration handles (test stubs, plugins) that
 *   bypass `startPaperclipIntegration()` will be missing the in-flight
 *   Set and `trackInFlightDispatch` warns once per such instance —
 *   their `drain()` becomes a no-op and their dispatchers leak on
 *   shutdown. Always go through the real entry point unless writing
 *   a unit test for the helper itself.
 */

import {
  createPaperclipHeartbeat,
  resolvePaperclipHeartbeatConfigWithReason,
  type PaperclipHeartbeat,
} from "./paperclip-heartbeat.js";
import {
  createPaperclipClient,
  resolvePaperclipClientConfig,
  type PaperclipClient,
} from "./paperclip-client.js";
import {
  createPaperclipCircuit,
  resolveCircuitConfigForPrefix,
  type CircuitSnapshot,
  type PaperclipCircuit,
} from "./paperclip-circuit.js";
import {
  createPaperclipDispatcher,
  PAPERCLIP_SESSION_PREFIX,
  type DispatchUserReplyInput,
  type DispatchUserReplyResult,
  type PaperclipDispatcher,
} from "./paperclip-dispatcher.js";
import { activeTraceparent, resolveTraceparent } from "./paperclip-traceparent.js";
import {
  createPaperclipAuthClient,
  resolvePaperclipAuthConfig,
  type PaperclipAuthClient,
} from "./paperclip-auth.js";
import {
  createPaperclipMcpClient,
  resolvePaperclipMcpConfig,
  type PaperclipMcpCallContext,
  type PaperclipMcpClient,
} from "./paperclip-mcp-client.js";
import {
  createPaperclipMetrics,
  getActivePaperclipMetrics,
  setActivePaperclipMetrics,
  type PaperclipMetrics,
} from "./paperclip-metrics.js";
import { recordCircuitTransitionSpan } from "./paperclip-spans.js";

type Logger = {
  info?(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error?(msg: string, ...args: unknown[]): void;
};

export interface PaperclipIntegration {
  heartbeat: PaperclipHeartbeat | null;
  client: PaperclipClient | null;
  dispatcher: PaperclipDispatcher | null;
  auth: PaperclipAuthClient | null;
  mcp: PaperclipMcpClient | null;
  /**
   * Bridge metrics singleton. Same instance the HTTP `/metrics` route
   * renders, and the one call sites inside the bridge clients write to
   * via `getActivePaperclipMetrics()`. Exposed here so tests can
   * assert on counter totals without poking the module-level global.
   */
  metrics: PaperclipMetrics;
  /**
   * Stops every background timer the integration owns. Safe to call
   * multiple times. Does not throw. Synchronous — does NOT wait for
   * in-flight dispatcher calls. Use `drain()` first when shutting down
   * cleanly (typical on SIGTERM); skip it during process-crash teardown
   * where you want the timers killed regardless.
   */
  stop(): void;
  /**
   * Wait for any in-flight `maybeDispatchReplyToPaperclip` promises to
   * settle, capped at `timeoutMs` (default 5_000). Returns when either
   * (a) all tracked dispatches have settled, or (b) the timeout elapses.
   * Always resolves — never rejects, even if individual dispatches
   * failed (those failures are already counted in
   * `openclaw_dispatcher_dispatch_total{outcome="failed"}` and rendered
   * as `dispatch_failed` events on the spans).
   *
   * Why drain at all: the dispatcher is fire-and-forget by design (a
   * slow Paperclip must not block the user-facing chat reply), but on
   * graceful shutdown the gateway DOES want those last-second hops to
   * finish — otherwise the bridge_audit row is missing on Paperclip's
   * side and the corresponding span ends with `recordException(SIGTERM)`
   * mid-write, which is harder to diagnose than a clean failure.
   *
   * Why a timeout: a Paperclip that's slow-but-not-down would otherwise
   * pin the process forever. 5s matches the default kubelet
   * terminationGracePeriodSeconds for typical web apps and is short
   * enough that operators don't notice on systemd shutdowns either.
   */
  drain(timeoutMs?: number): Promise<void>;
  /**
   * Human-readable summary of which arrows are live. Useful for the
   * gateway startup log: `paperclip integration: heartbeat=on dispatcher=off ...`.
   */
  describe(): string;
  /**
   * Structured view of which arrows are wired, split by how damaging it
   * is when the arrow is OFF. Consumers (run.ts) can decide whether to
   * log a plain info line or a WARN based on whether any `critical`
   * piece is disabled — more useful than the flat `describe()` string
   * when one arrow quietly fell off in a new deployment.
   *
   * Arrow classification:
   *   - `critical`: outbound client + dispatcher. Without these Paperclip
   *     → OpenClaw notifications are dark and user replies never reach
   *     Paperclip's `bridge_audit` / `paperclip_channel_wait`. Any of
   *     these off in production should page.
   *   - `important`: auth + mcp. Token-exchange and the JSON-RPC client.
   *     Off means per-user Logto-exchange flow is disabled and Paperclip
   *     tools can't be invoked from OpenClaw agents — significant, but
   *     a bridge can still proxy heartbeats + inbound replies without them.
   *   - `optional`: heartbeat. Without it the Paperclip "last seen"
   *     display stays stale; no functional loss.
   */
  describeStatus(): IntegrationStatus;
  /**
   * Snapshot of the outbound circuit-breaker state — exposed so the
   * gateway's `/health` endpoint can report a degraded bridge without
   * the caller needing a direct reference to the `PaperclipClient`.
   * Returns `null` when the outbound client was never instantiated
   * (PAPERCLIP_BASE_URL unset), so consumers can distinguish
   * "bridge off" from "bridge open".
   */
  circuitSnapshot(): CircuitSnapshot | null;
  /**
   * Per-arrow circuit snapshots for the /metrics exposition. The three
   * breakers (outbound, auth, mcp) are instantiated eagerly on bootstrap
   * so a scrape always gets a valid snapshot — even when the arrow's
   * client is disabled (in which case `outbound` returns null; auth and
   * mcp return their always-initialised breaker state).
   */
  circuitSnapshots(): {
    outbound: CircuitSnapshot | null;
    auth: CircuitSnapshot;
    mcp: CircuitSnapshot;
  };
  /**
   * Bind the auth client's `exchange()` as an MCP `tokenProvider` for a
   * specific user session, returning `{ mcp, context }` ready to invoke
   * Paperclip tools on behalf of that human. Returns `null` when either
   * the auth or MCP arrow isn't wired. See `bindUserMcp` below for the
   * full contract.
   */
  bindUserMcp(userCtx: BindUserMcpContext): BindUserMcpResult | null;
}

export type IntegrationArrow = "heartbeat" | "outbound" | "dispatcher" | "auth" | "mcp";

/**
 * Structured view of which arrows are wired and how severe each gap is.
 * Mirrors the `describe()` summary but lets the caller decide whether
 * to log INFO or WARN based on whether a critical arrow is off. See the
 * `describeStatus` comment on `PaperclipIntegration` for the arrow
 * classification rationale.
 */
export interface IntegrationStatus {
  arrows: Record<IntegrationArrow, boolean>;
  critical: IntegrationArrow[];
  important: IntegrationArrow[];
  optional: IntegrationArrow[];
  /** Arrows that are off AND in the `critical` set — operators should page. */
  missingCritical: IntegrationArrow[];
  /** Arrows that are off AND in the `important` set — operators should notice. */
  missingImportant: IntegrationArrow[];
  /** All-up: `healthy` if nothing critical is off, `degraded` if important arrows missing, `broken` if any critical missing. */
  severity: "healthy" | "degraded" | "broken";
}

export interface BindUserMcpContext {
  /** Logto-issued id_token for the human driving the call. */
  idToken: string;
  /** Paperclip company id the call targets. */
  companyId: string;
  /** Optional scope override — defaults to whatever exchange grants. */
  scopes?: string[];
  /** Optional W3C traceparent propagated through MCP + span. */
  traceparent?: string;
}

export interface BindUserMcpResult {
  /** Wrapped MCP client; every call auto-exchanges the bearer. */
  mcp: PaperclipMcpClient;
  /**
   * Pre-built call context for convenience — the returned `mcp` already
   * resolves the bearer per call, but some callers want the subject/
   * companyId in a single place for logging.
   */
  context: PaperclipMcpCallContext;
}

export interface StartPaperclipIntegrationOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

/**
 * Module-level reference to the active integration. Set by
 * `startPaperclipIntegration` and read by callers deep in the gateway
 * chat stack that can't easily receive a handle via constructor
 * injection (e.g. `src/gateway/server-methods/chat.ts`).
 *
 * The singleton is intentional but minimal: it's here so
 * `chat.send` can fire-and-forget replies into Paperclip when the
 * session key has the `paperclip:` prefix, WITHOUT requiring a
 * context-threading pass through shared-types / server-request-context.
 *
 * Reset by `stop()` so tests that construct multiple integrations see
 * only the active one. Never throws; readers that run before
 * `startPaperclipIntegration` simply observe null and no-op.
 */
let activeIntegration: PaperclipIntegration | null = null;

/**
 * Read the currently-started Paperclip integration handle, or null
 * when the integration hasn't been started (or was stopped). Safe to
 * call from anywhere. Consumers MUST guard against null and treat it
 * as "feature disabled".
 */
export function getActivePaperclipIntegration(): PaperclipIntegration | null {
  return activeIntegration;
}

/**
 * Fire-and-forget helper used by the channel-layer to mirror a user's
 * reply into Paperclip. Encapsulates:
 *
 *   - Singleton lookup (returns "skipped" when not wired).
 *   - The `paperclip:` prefix guard (saves an integration lookup + a
 *     full `dispatchUserReply` call for non-Paperclip sessions).
 *   - `.catch()` around the async dispatch so a throwing client cannot
 *     bubble up into the reply path and fail the user-facing send.
 *
 * Call sites — there is currently only one (`chat.send`), but hooks
 * and future bot-platform adapters should funnel through here rather
 * than re-implementing the same check. Returns a promise only for tests;
 * production callers typically ignore it.
 */
export async function maybeDispatchReplyToPaperclip(
  input: DispatchUserReplyInput,
  logger?: Logger,
): Promise<DispatchUserReplyResult> {
  if (!input.sessionKey.startsWith(PAPERCLIP_SESSION_PREFIX) && !input.companyIdOverride) {
    return { outcome: "skipped", reason: "not-a-paperclip-session" };
  }
  const integration = activeIntegration;
  if (!integration?.dispatcher) {
    return { outcome: "skipped", reason: "integration-not-wired" };
  }
  // Resolve the traceparent in a three-tier fallback:
  //   1. caller-supplied (highest priority — preserves an explicit trace
  //      context the RPC layer threaded in).
  //   2. active OTel span in the current async context (e.g. chat.send
  //      handler's span auto-instrumented by NodeSDK). Chains the
  //      dispatcher onto the same trace as the handler that triggered it.
  //   3. synthesised random (the "fresh call, no parent" case — e.g. a
  //      test harness or a non-OTel deployment).
  //
  // Without this, Paperclip's bridge_audit row for the inbound hop has a
  // null trace_id and the reply is unsearchable in Tempo — one of the
  // high-traffic paths we most need to trace.
  const resolvedTraceparent = resolveTraceparent(input.traceparent ?? activeTraceparent());
  const enrichedInput: DispatchUserReplyInput = {
    ...input,
    traceparent: resolvedTraceparent,
  };
  // Track the in-flight promise so `integration.drain()` can wait for
  // it on graceful shutdown. The Set lives on the integration instance
  // so two concurrent integrations (e.g. test scenarios that start a
  // second one while teardown of the first runs) don't share state.
  // The .finally() block removes the entry whether the dispatch
  // resolved or threw — without it the Set would leak and `drain()`
  // would always hit the timeout.
  const promise = (async () => {
    try {
      return await integration.dispatcher.dispatchUserReply(enrichedInput);
    } catch (err) {
      logger?.warn(
        `paperclip-dispatcher: unexpected throw forwarding reply: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { outcome: "failed", reason: "unexpected-throw" };
    }
  })();
  trackInFlightDispatch(integration, promise, logger);
  return promise;
}

/**
 * Set of integration instances we've already logged a missing-Set
 * warning for. Backed by WeakSet so the integration GC isn't pinned by
 * the diagnostic — a test that spins up many short-lived integrations
 * gets one warn per instance, not one per call, and orphaned
 * integrations are reclaimed normally.
 */
const warnedMissingInFlightSet = new WeakSet<PaperclipIntegration>();

/**
 * Internal helper to attach a dispatch promise to an integration's
 * in-flight set, with auto-removal on settle. Pulled out as a standalone
 * function so the test harness can call it directly (without going
 * through `maybeDispatchReplyToPaperclip`'s singleton lookup) when
 * verifying drain behavior.
 *
 * The integration object is expected to carry the
 * `__inFlightDispatches` Set installed by `startPaperclipIntegration`.
 * If a caller (a test or a plugin) constructs the handle by hand, the
 * Set is missing and we'd silently no-op — `drain()` would then never
 * wait for these promises and SIGTERM teardown could orphan their
 * spans. The warn surfaces the misconfiguration; the WeakSet dedupes
 * so a high-traffic test loop doesn't drown the log in repeated
 * messages.
 *
 * Exported (rather than module-private) ONLY so the warn-dedup
 * behavior is unit-testable without the test having to defeat the
 * non-configurable `Object.defineProperty` guard on real integration
 * handles. The exported name is leading-underscored to flag it as
 * internal — callers in production code use `maybeDispatchReplyToPaperclip`.
 */
export function _trackInFlightDispatchForTests(
  integration: PaperclipIntegration,
  promise: Promise<DispatchUserReplyResult>,
  logger?: Logger,
): void {
  trackInFlightDispatch(integration, promise, logger);
}

function trackInFlightDispatch(
  integration: PaperclipIntegration,
  promise: Promise<DispatchUserReplyResult>,
  logger?: Logger,
): void {
  // The integration handle exposes the Set as a private-by-convention
  // property; we cast through `unknown` to avoid widening the public
  // interface with what is effectively shutdown plumbing.
  const set = (integration as unknown as { __inFlightDispatches?: Set<Promise<unknown>> })
    .__inFlightDispatches;
  if (!set) {
    if (!warnedMissingInFlightSet.has(integration)) {
      warnedMissingInFlightSet.add(integration);
      const sink = logger ?? console;
      sink.warn(
        "paperclip-bootstrap: dispatcher in-flight Set missing on integration handle — " +
          "this integration was constructed outside startPaperclipIntegration() and " +
          "drain() will not wait for its in-flight dispatches. Construct integrations " +
          "via startPaperclipIntegration() so graceful-shutdown semantics work as documented.",
      );
    }
    return;
  }
  set.add(promise);
  void promise.finally(() => {
    set.delete(promise);
  });
}

/**
 * Activates the Paperclip integration on startup. Returns a handle
 * whose `stop()` releases the background heartbeat timer. All other
 * clients are stateless and need no teardown.
 *
 * Does not throw on partial configuration — we'd rather the gateway
 * start with a degraded bridge than refuse to boot.
 */
export function startPaperclipIntegration(
  opts: StartPaperclipIntegrationOptions = {},
): PaperclipIntegration {
  const env = opts.env ?? process.env;
  const logger: Logger = opts.logger ?? {
    warn: (msg, ...args) => console.warn("[paperclip-bootstrap]", msg, ...args),
    info: (msg, ...args) => console.info("[paperclip-bootstrap]", msg, ...args),
  };

  // --- Metrics singleton (must come first) ------------------------------
  // Created eagerly so every downstream client records against the live
  // instance from their first call. In particular, `heartbeat.start()`
  // fires one tick synchronously — if we set the active metrics after
  // that, the first tick's latency is lost to the collector.
  const metrics = createPaperclipMetrics();
  setActivePaperclipMetrics(metrics);

  // --- Heartbeat --------------------------------------------------------
  // resolveWithReason returns a discriminated result so we can log the
  // precise "why" when disabled. "no_api_key" is the common failure
  // mode during bridge-key bootstrap (paperclip hasn't minted the key
  // yet, or the shared volume isn't mounted). "no_base_url" is a
  // deployment misconfig and deserves a louder signal.
  const heartbeatResolution = resolvePaperclipHeartbeatConfigWithReason(env);
  let heartbeatDisabledReason: "no_base_url" | "no_api_key" | null = null;
  let heartbeat: PaperclipHeartbeat | null = null;
  if (heartbeatResolution.kind === "config") {
    heartbeat = createPaperclipHeartbeat(heartbeatResolution.config, { logger });
    if (heartbeat) {
      heartbeat.start();
      logger.info?.("Paperclip heartbeat started");
    }
  } else {
    heartbeatDisabledReason = heartbeatResolution.reason;
    if (heartbeatResolution.reason === "no_api_key") {
      // Distinguish from the no-base-url case: the operator HAS wired
      // PAPERCLIP_BASE_URL, just not the agent key. Common during first
      // boot when the paperclip bootstrap is still minting the key.
      logger.warn(
        "Paperclip heartbeat disabled — PAPERCLIP_AGENT_API_KEY is unset. On Avelton OS this is usually populated from /srv/bridge/openclaw-bridge-key.txt by avelton-bridge-entrypoint.sh. Check the shared volume is mounted and paperclip's bootstrap has completed.",
      );
    }
    // no_base_url is the default "bridge not configured" case; logging
    // a warning would be noise on vanilla OpenClaw deployments that
    // don't talk to Paperclip. Silent is correct here.
  }

  // --- Outbound client (POST /api/integrations/openclaw/inbound) --------
  const clientCfg = resolvePaperclipClientConfig(env);
  const client = clientCfg ? createPaperclipClient(clientCfg) : null;

  // --- Dispatcher (routes user replies into Paperclip) ------------------
  // The dispatcher is *available* via the returned PaperclipIntegration
  // handle but is not auto-wired into OpenClaw's chat-reply pipeline by
  // this bootstrap. Channel-layer integration that wants to forward
  // human replies to Paperclip should:
  //
  //   const integration = startPaperclipIntegration();
  //   integration.dispatcher?.dispatchUserReply({ ... });
  //
  // Auto-wiring would require touching many files inside src/gateway/chat
  // — that's left as a follow-up so this bootstrap stays small and
  // testable. Until then, dispatcher is a ready-to-use API surface, not
  // an active subscriber.
  const dispatcher = client ? createPaperclipDispatcher({ client, logger }) : null;

  // --- Per-arrow circuit breakers --------------------------------------
  // Three independent breakers so a failure on one arrow (Logto outage,
  // runaway MCP tool loop) can't blackhole the others. Env knobs use
  // distinct `PAPERCLIP_AUTH_CIRCUIT_*` and `PAPERCLIP_MCP_CIRCUIT_*`
  // prefixes; defaults mirror the outbound breaker (5 failures → 30s
  // cooldown → idle timeout 60s). Listeners emit a structured log and
  // push the same transition reason the outbound breaker uses, so
  // operator dashboards can plot all three on one panel.
  const authCircuit: PaperclipCircuit = createPaperclipCircuit(
    resolveCircuitConfigForPrefix("PAPERCLIP_AUTH", env),
    {
      onTransition: (event) => {
        logger.warn?.(
          `paperclip-auth circuit: ${event.from} → ${event.to} (reason=${event.reason})`,
        );
        // Mirror the log into Tempo so operators investigating an auth
        // outage see the trip on the same timeline as the affected
        // exchange spans. The arrow label matches the Prometheus
        // circuit_state{arrow="paperclip_auth"} gauge so trace ↔ metric
        // navigation works one-to-one.
        recordCircuitTransitionSpan("paperclip_auth", event);
      },
    },
  );
  const mcpCircuit: PaperclipCircuit = createPaperclipCircuit(
    resolveCircuitConfigForPrefix("PAPERCLIP_MCP", env),
    {
      onTransition: (event) => {
        logger.warn?.(
          `paperclip-mcp circuit: ${event.from} → ${event.to} (reason=${event.reason})`,
        );
        recordCircuitTransitionSpan("paperclip_mcp", event);
      },
    },
  );

  // --- Token-exchange auth client ---------------------------------------
  const authCfg = resolvePaperclipAuthConfig(env);
  const auth = authCfg
    ? createPaperclipAuthClient(authCfg, { logger, circuit: authCircuit })
    : null;

  // --- MCP client (remote tools) ----------------------------------------
  // MCP uses either the static PAPERCLIP_AGENT_API_KEY (legacy path) or
  // a per-call token. The tokenProvider hook here is intentionally
  // *not* wired to the auth client by default — per-user exchange needs
  // an id_token from the calling user's Logto session, which only the
  // chat/channel layer has. Callers that have an id_token should pass
  // `ctx.bearer` directly via PaperclipMcpCallContext. The config below
  // covers the common service-account case (cfg.apiKey).
  const mcpCfg = resolvePaperclipMcpConfig(env);
  const mcp = mcpCfg
    ? createPaperclipMcpClient(mcpCfg, { logger, circuit: mcpCircuit })
    : null;

  // In-flight dispatcher promises tracked for graceful drain. Populated
  // by `trackInFlightDispatch` from `maybeDispatchReplyToPaperclip` and
  // emptied by each promise's .finally() handler. Stored as a private-
  // by-convention property (no `__` getter on the public interface) so
  // shutdown plumbing doesn't bleed into the API surface clients use.
  const inFlightDispatches = new Set<Promise<unknown>>();

  const integration: PaperclipIntegration = {
    heartbeat,
    client,
    dispatcher,
    auth,
    mcp,
    metrics,
    stop() {
      heartbeat?.stop();
      // Only unregister if WE are the active one — if the caller
      // restarted the integration, that newer handle will already have
      // overwritten `activeIntegration` and this stale `stop()` should
      // not blank it out.
      if (activeIntegration === integration) {
        activeIntegration = null;
      }
      // Mirror for the metrics singleton: only clear if we installed it.
      if (getActivePaperclipMetrics() === metrics) {
        setActivePaperclipMetrics(null);
      }
    },
    async drain(timeoutMs = 5_000): Promise<void> {
      if (inFlightDispatches.size === 0) return;
      // Snapshot the set so a late .finally() doesn't ConcurrentModify
      // our await. New dispatches added DURING the drain are not awaited
      // — that's intentional: the signal-handler caller is shutting
      // down, and a steady stream of new replies during shutdown
      // suggests upstream traffic isn't being drained either.
      const snapshot = [...inFlightDispatches];
      // Promise.allSettled because individual dispatches may reject —
      // we only care that they SETTLED, not how. The metric/span
      // accounting happened inside dispatchUserReply already.
      const allDone = Promise.allSettled(snapshot).then(() => undefined);
      // Use unref so the timer doesn't hold the event loop open past
      // the actual settle (Node would otherwise wait for the timeout
      // to fire even when allDone resolved earlier).
      let timerHandle: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timerHandle = setTimeout(resolve, Math.max(0, timeoutMs));
        timerHandle.unref?.();
      });
      try {
        await Promise.race([allDone, timeout]);
      } finally {
        if (timerHandle) clearTimeout(timerHandle);
      }
    },
    describe() {
      const parts = [
        `heartbeat=${heartbeat ? "on" : "off"}`,
        `outbound=${client ? "on" : "off"}`,
        `dispatcher=${dispatcher ? "on" : "off"}`,
        `auth=${auth ? "on" : "off"}`,
        `mcp=${mcp ? "on" : "off"}`,
      ];
      return parts.join(" ");
    },
    describeStatus(): IntegrationStatus {
      const arrows: Record<IntegrationArrow, boolean> = {
        heartbeat: heartbeat !== null,
        outbound: client !== null,
        dispatcher: dispatcher !== null,
        auth: auth !== null,
        mcp: mcp !== null,
      };
      const critical: IntegrationArrow[] = ["outbound", "dispatcher"];
      const important: IntegrationArrow[] = ["auth", "mcp"];
      const optional: IntegrationArrow[] = ["heartbeat"];
      const missingCritical = critical.filter((a) => !arrows[a]);
      const missingImportant = important.filter((a) => !arrows[a]);
      const severity: IntegrationStatus["severity"] =
        missingCritical.length > 0
          ? "broken"
          : missingImportant.length > 0
            ? "degraded"
            : "healthy";
      return {
        arrows,
        critical,
        important,
        optional,
        missingCritical,
        missingImportant,
        severity,
      };
    },
    circuitSnapshot() {
      return client ? client.circuit().snapshot() : null;
    },
    circuitSnapshots() {
      return {
        outbound: client ? client.circuit().snapshot() : null,
        auth: authCircuit.snapshot(),
        mcp: mcpCircuit.snapshot(),
      };
    },
    bindUserMcp(userCtx) {
      return bindUserMcpImpl({ auth, mcp, mcpCfg, logger }, userCtx);
    },
  };
  // Stash the in-flight set as a private-by-convention property so
  // `trackInFlightDispatch` (module-scope) can find it without
  // widening the public PaperclipIntegration interface with shutdown
  // plumbing. The double-underscore prefix marks it as internal —
  // consumers writing `integration.__inFlightDispatches.add(...)` are
  // doing something they should not.
  Object.defineProperty(integration, "__inFlightDispatches", {
    value: inFlightDispatches,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  activeIntegration = integration;
  return integration;
}

interface BindUserMcpDeps {
  auth: PaperclipAuthClient | null;
  mcp: PaperclipMcpClient | null;
  mcpCfg: ReturnType<typeof resolvePaperclipMcpConfig>;
  logger: Logger;
}

/**
 * Helper that combines `auth.exchange()` + MCP `tokenProvider` into a
 * single call site, so per-user Paperclip tool flows don't have to
 * manage the bearer lifecycle manually.
 *
 * Usage:
 *   const integration = startPaperclipIntegration();
 *   const bound = integration.bindUserMcp({
 *     idToken: session.logtoIdToken,
 *     companyId: currentCompanyId,
 *   });
 *   if (!bound) throw new Error("Paperclip bridge not configured for per-user calls");
 *   await bound.mcp.callTool("create_issue", { title: "..." }, bound.context);
 *
 * Returns `null` when either the auth or MCP arrow isn't wired; callers
 * must guard against that to avoid throwing deep in an agent run.
 *
 * The wrapped MCP client is cheap to create — it just forwards to the
 * shared `mcp` instance with a tokenProvider bound to this user. We
 * don't cache wrapped clients here because `auth.exchange()` already
 * caches on (idTokenFingerprint, companyId, scopes), so repeated
 * invocations are de-duped at the bearer level.
 */
function bindUserMcpImpl(
  deps: BindUserMcpDeps,
  userCtx: BindUserMcpContext,
): BindUserMcpResult | null {
  const { auth, mcp, mcpCfg, logger } = deps;
  if (!auth || !mcp || !mcpCfg) return null;

  // Build a fresh MCP client bound to the caller-specific tokenProvider.
  // We re-use mcpCfg (URL / static apiKey), but override the apiKey to
  // null so the tokenProvider is the sole source of bearers — otherwise
  // the client would fall back to the service-account key, silently
  // losing the per-user attribution Paperclip expects in audit rows.
  const boundClient = createPaperclipMcpClient(
    { ...mcpCfg, apiKey: undefined },
    {
      logger,
      tokenProvider: async () => {
        const result = await auth.exchange({
          idToken: userCtx.idToken,
          companyId: userCtx.companyId,
          ...(userCtx.scopes ? { scopes: userCtx.scopes } : {}),
        });
        return { bearer: result.token, logtoSubject: result.userId };
      },
    },
  );
  if (!boundClient) return null;

  // Three-tier traceparent fallback, same as maybeDispatchReplyToPaperclip:
  //   1. caller-supplied userCtx.traceparent
  //   2. active OTel span context (chat handler / tool-invoker's span)
  //   3. undefined — call site may still synthesise if it wants
  // Without tier 2, per-user MCP calls that start inside a gateway
  // handler span lose trace continuity because callers rarely remember
  // to thread traceparent through every API boundary.
  const resolvedTraceparent = userCtx.traceparent ?? activeTraceparent();
  const context: PaperclipMcpCallContext = {
    companyId: userCtx.companyId,
    ...(resolvedTraceparent ? { traceparent: resolvedTraceparent } : {}),
  };
  return { mcp: boundClient, context };
}
