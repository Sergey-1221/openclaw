/**
 * Avelton-claw → Paperclip agent heartbeat.
 *
 * Every N seconds the OpenClaw gateway makes a cheap authenticated call
 * against Paperclip so the server-side middleware touches
 * `agent_api_keys.last_used_at` on the bridge service-account row. The
 * Paperclip UI surfaces that column as "Last seen", which is how
 * operators tell at a glance whether the bridge is online.
 *
 * Because the only thing we need is a "bearer was presented to
 * Paperclip" side effect, we reuse `GET /api/health`-adjacent
 * authenticated endpoints. `GET /api/companies` is picked because:
 *   1. every agent has read access to its own company;
 *   2. it's cheap (no cross-company joins);
 *   3. its response shape is stable across Paperclip versions.
 *
 * Graceful degradation:
 *   - PAPERCLIP_BASE_URL or PAPERCLIP_AGENT_API_KEY unset → heartbeat
 *     disabled; createPaperclipHeartbeat returns null.
 *   - Any network/HTTP failure is logged and the interval continues.
 *     One transient outage must not stop the heartbeat.
 *
 * The module intentionally does NOT re-provision an agent on Paperclip.
 * Bootstrap is Paperclip's concern (OPENCLAW_BOOTSTRAP_AUTO=1 on the
 * paperclip container). This file only reports liveness.
 */

import { withBridgeSpan } from "./paperclip-spans.js";
import { getActivePaperclipMetrics } from "./paperclip-metrics.js";
import { generateTraceparent } from "./paperclip-traceparent.js";

type Logger = {
  warn(msg: string, ...args: unknown[]): void;
  info?(msg: string, ...args: unknown[]): void;
};

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 5_000;
/** Default upper bound on the backoff-inflated interval. 5 minutes is
 * the sweet spot between "stopped harassing a dead Paperclip" and
 * "still detects recovery within one scrape window" for the homelab
 * profile this stack targets. Operators with multi-gateway clusters
 * or known-slow recovery windows can override via
 * PAPERCLIP_HEARTBEAT_MAX_INTERVAL_MS (see {@link resolveHeartbeatMaxIntervalMs}).
 *
 * Kept exported as a const for tests and back-compat — the runtime
 * resolver below reads env first, falls back to this default. */
export const HEARTBEAT_MAX_INTERVAL_MS = 5 * 60_000;

/**
 * Threshold at which the heartbeat emits a one-shot warn-log marking
 * the loop as "stuck in failure". Operators eyeballing logs see this
 * line BEFORE the gauge reaches the alert threshold, giving them a
 * head start on triage. De-duplicated until the next successful tick
 * — a recovery resets the latch and a future regression is logged
 * fresh.
 */
export const HEARTBEAT_WARN_LOG_FAILURE_THRESHOLD = 3;

/**
 * Resolve the maximum heartbeat interval from the environment. Mirrors
 * the resolveX pattern used elsewhere in the integration: env first,
 * defensive fallback on malformed input, default const last. Bounded
 * below by the base interval (a max < base would deadlock the
 * scheduler).
 */
export function resolveHeartbeatMaxIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.PAPERCLIP_HEARTBEAT_MAX_INTERVAL_MS);
  if (Number.isFinite(raw) && raw > 0) {
    // Floor at the minute granularity Avelton OS uses elsewhere
    // (60_000ms). A max below 1 minute would defeat backoff entirely
    // and is almost certainly a misconfiguration; log nothing here
    // because the env is read once at init and a louder signal would
    // spam during a misconfig.
    return Math.max(60_000, Math.trunc(raw));
  }
  return HEARTBEAT_MAX_INTERVAL_MS;
}

export interface PaperclipHeartbeatConfig {
  /** Paperclip base URL, e.g. `http://paperclip:3100`. */
  baseUrl?: string;
  /** Agent API key — the bootstrap bridge key or a dedicated service key. */
  apiKey?: string;
  /** Poll interval in ms. Defaults to DEFAULT_HEARTBEAT_INTERVAL_MS. */
  intervalMs?: number;
  /** Optional override for the endpoint hit during heartbeat. */
  probeUrl?: string;
}

/**
 * Result of resolving heartbeat config. Either the config itself, or a
 * structured reason why it was disabled — so callers can log a precise
 * "why" (e.g. "api key missing" vs "base url missing") instead of a
 * generic "heartbeat disabled" that forces the operator to guess.
 */
export type ResolveHeartbeatResult =
  | { kind: "config"; config: PaperclipHeartbeatConfig }
  | { kind: "disabled"; reason: "no_base_url" | "no_api_key" };

export function resolvePaperclipHeartbeatConfig(
  env: NodeJS.ProcessEnv = process.env,
): PaperclipHeartbeatConfig | null {
  const result = resolvePaperclipHeartbeatConfigWithReason(env);
  return result.kind === "config" ? result.config : null;
}

/**
 * Extended variant that reports why heartbeat was disabled. Used by
 * startPaperclipIntegration so status.heartbeat carries the precise
 * reason instead of a generic "disabled" — operators who see
 * `heartbeat=off reason=no_api_key` know to check the shared volume
 * (openclaw-bridge-key.txt), not the base URL env.
 */
export function resolvePaperclipHeartbeatConfigWithReason(
  env: NodeJS.ProcessEnv = process.env,
): ResolveHeartbeatResult {
  const baseUrl = env.PAPERCLIP_BASE_URL?.trim();
  const apiKey = env.PAPERCLIP_AGENT_API_KEY?.trim();
  const probeUrl = env.PAPERCLIP_HEARTBEAT_URL?.trim();
  const intervalMs = Number(env.PAPERCLIP_HEARTBEAT_INTERVAL_MS);
  if (!baseUrl && !probeUrl) return { kind: "disabled", reason: "no_base_url" };
  if (!apiKey) return { kind: "disabled", reason: "no_api_key" };
  return {
    kind: "config",
    config: {
      baseUrl,
      apiKey,
      probeUrl,
      intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : undefined,
    },
  };
}

export function deriveHeartbeatProbeUrl(cfg: PaperclipHeartbeatConfig): string | null {
  if (cfg.probeUrl) return cfg.probeUrl;
  if (!cfg.baseUrl) return null;
  const trimmed = cfg.baseUrl.replace(/\/+$/, "");
  return `${trimmed}/api/companies`;
}

export interface PaperclipHeartbeat {
  /** Start the periodic heartbeat. Idempotent — calling start() twice is a no-op. */
  start(): void;
  /** Stop the periodic heartbeat and release the timer. */
  stop(): void;
  /** Run a single heartbeat attempt. Exposed for tests and on-demand pings. */
  tick(): Promise<HeartbeatTickResult>;
}

export interface HeartbeatTickResult {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
}

export function createPaperclipHeartbeat(
  config?: PaperclipHeartbeatConfig | null,
  deps: {
    logger?: Logger;
    fetchImpl?: typeof fetch;
    /** Override setTimeout — used by tests so backoff scheduling is
     * observable without real timers. */
    setTimeoutImpl?: typeof setTimeout;
    /** Override clearTimeout — paired with setTimeoutImpl. */
    clearTimeoutImpl?: typeof clearTimeout;
    /** @deprecated retained for API stability; no longer used internally. */
    setIntervalImpl?: typeof setInterval;
    /** @deprecated retained for API stability; no longer used internally. */
    clearIntervalImpl?: typeof clearInterval;
    /**
     * Override the random source used for backoff jitter. Defaults to
     * Math.random — pass `() => 0.5` from tests to disable jitter
     * (the midpoint of the jitter band yields the unscaled delay so
     * existing exact-value assertions keep passing). The jitter spreads
     * recovery thundering-herds: without it, N gateways restarting
     * together compute the same backoff curve and all probe Paperclip
     * at the same wall-clock instant.
     */
    randomFn?: () => number;
  } = {},
): PaperclipHeartbeat | null {
  const cfg = config ?? resolvePaperclipHeartbeatConfig();
  if (!cfg) return null;
  const probeUrl = deriveHeartbeatProbeUrl(cfg);
  if (!probeUrl || !cfg.apiKey) return null;

  const fetchFn = deps.fetchImpl ?? fetch;
  const setTimeoutFn = deps.setTimeoutImpl ?? setTimeout;
  const randomFn = deps.randomFn ?? Math.random;
  const clearTimeoutFn = deps.clearTimeoutImpl ?? clearTimeout;
  const baseIntervalMs = cfg.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  // Resolve the max-interval cap once at construction time. Operators
  // get a single restart-required tunable; reading on every tick would
  // surprise an operator who set the env mid-flight and got a partial
  // effect.
  const maxIntervalMs = Math.max(
    baseIntervalMs,
    resolveHeartbeatMaxIntervalMs(),
  );

  // Timer is now setTimeout-based (not setInterval) so each tick can
  // apply an exponentially-backed-off delay. The setInterval path would
  // either fire every base-interval regardless of success, or need
  // ugly skip-logic that fights with node's timer accuracy.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveFailures = 0;
  let stopped = false;
  /** Latch the warn-log so a stuck heartbeat doesn't spam the log
   *  every tick. Cleared on the next successful tick (recovery), so a
   *  later regression triggers a fresh warning. */
  let stuckWarnEmitted = false;

  async function tick(): Promise<HeartbeatTickResult> {
    // Fresh traceparent per tick. Heartbeat has no inbound caller, so
    // there's no existing trace context to continue — without this the
    // bridge_audit row on Paperclip's side has a null trace_id and the
    // hop disappears from Tempo. One synthetic trace per tick gives
    // operators a grouping handle even for cold-path liveness checks.
    const traceparent = generateTraceparent();
    return withBridgeSpan(
      "openclaw.paperclip.heartbeat",
      {
        "bridge.direction": "outbound",
        "http.url": probeUrl!,
        "peer.service": "paperclip",
        "bridge.has_traceparent": true,
      },
      () => tickImpl(traceparent),
    );
  }

  async function tickImpl(traceparent: string): Promise<HeartbeatTickResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT_MS);
    try {
      const res = await fetchFn(probeUrl!, {
        method: "GET",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${cfg!.apiKey}`,
          Accept: "application/json",
          traceparent,
        },
      });
      clearTimeout(timeoutTimer);
      const latencyMs = Date.now() - startedAt;
      const metrics = getActivePaperclipMetrics();
      if (!res.ok) {
        // 4xx from /api/companies probably means the bearer is invalid —
        // worth surfacing loudly so operators notice a stale PAPERCLIP_AGENT_API_KEY.
        deps.logger?.warn(
          `paperclip-heartbeat: probe returned HTTP ${res.status} (is PAPERCLIP_AGENT_API_KEY current?)`,
        );
        metrics?.recordRequest("heartbeat", "error", `http_${res.status}`);
        metrics?.recordLatency("heartbeat", latencyMs);
        return { ok: false, status: res.status, latencyMs };
      }
      // Drain the body so Node doesn't keep the socket alive.
      try {
        await res.text();
      } catch {
        // ignored
      }
      metrics?.recordRequest("heartbeat", "ok");
      metrics?.recordLatency("heartbeat", latencyMs);
      return { ok: true, status: res.status, latencyMs };
    } catch (err) {
      clearTimeout(timeoutTimer);
      deps.logger?.warn(`paperclip-heartbeat: probe error: ${String(err)}`);
      const latencyMs = Date.now() - startedAt;
      const isTimeout = err instanceof Error && err.name === "AbortError";
      const metrics = getActivePaperclipMetrics();
      metrics?.recordRequest("heartbeat", isTimeout ? "timeout" : "error", "network");
      metrics?.recordLatency("heartbeat", latencyMs);
      return { ok: false, error: String(err), latencyMs };
    }
  }

  /** Compute the next tick delay given the current consecutive-failure
   * count. Exponential doubling capped at HEARTBEAT_MAX_INTERVAL_MS,
   * with ±20% jitter applied to the result (centre 1.0, range
   * [0.8, 1.2]) so multi-gateway restarts don't compute identical
   * backoff curves and synchronise their recovery probes against
   * Paperclip. First failure → base * 2 * jitter, second → base * 4 *
   * jitter, … clamped. Separated into a pure function so tests can
   * assert the backoff curve without running the actual polling loop.
   *
   * Why jitter on every interval (not just retries): even healthy ticks
   * benefit because if N gateways all start at the same wall-clock
   * instant (an Avelton OS reboot), their healthy 30s heartbeats would
   * otherwise collide every cycle. The ±20% spread costs nothing on a
   * single-gateway homelab and meaningfully smooths the load on a
   * multi-gateway cluster.
   *
   * Why apply jitter BEFORE the cap: applying it after would let the
   * jitter push us above HEARTBEAT_MAX_INTERVAL_MS by 20%, which is
   * usually fine but breaks the documented invariant that the heartbeat
   * never sleeps longer than the cap. Pre-cap is the safer order.
   *
   * Exported indirectly via the test-only path (see paperclip-heartbeat.test.ts).
   */
  function nextIntervalMs(failures: number): number {
    const baseDelay = failures <= 0 ? baseIntervalMs : baseIntervalMs * Math.pow(2, failures);
    // 0.8 + r*0.4 maps r∈[0,1] to a multiplier in [0.8, 1.2] with mean
    // 1.0. Tests injecting `() => 0.5` get unmodified delays — keeps
    // the existing exact-value assertions passing.
    const jittered = baseDelay * (0.8 + randomFn() * 0.4);
    return Math.min(jittered, maxIntervalMs);
  }

  /** Schedule the next tick. Called at startup and after every tick
   * completion so the interval adjusts based on the latest health. */
  function scheduleNext(): void {
    if (stopped) return;
    const delay = nextIntervalMs(consecutiveFailures);
    timer = setTimeoutFn(async () => {
      if (stopped) return;
      const result = await tick();
      // Re-check stopped AFTER the await: stop() may have been
      // called while tick() was in flight. Without this gate the
      // late-resolving tick would still mutate consecutiveFailures
      // and the heartbeat gauge — operators would see the gauge
      // updating on a stopped heartbeat, which violates the
      // documented contract that stop() yields silence.
      if (stopped) return;
      // Update the gauge inline so the metrics exposition sees the
      // current count rather than a stale value.
      if (result.ok) {
        consecutiveFailures = 0;
        // Recovery: clear the stuck-warn latch so a future regression
        // is surfaced fresh. We don't log on the recovery itself —
        // the gauge dropping back to 0 is the recovery signal that
        // operator dashboards already render.
        stuckWarnEmitted = false;
      } else {
        consecutiveFailures += 1;
        // First crossing of the warn threshold gets one warn line.
        // Operators reading the log stream see "stuck" before the
        // alerting threshold (typically `> 3` per INTEGRATION.md §5.2)
        // so they have a head start on triage. Bounded to one log
        // per outage by the latch — a 30-min outage emits one line,
        // not 60.
        if (
          !stuckWarnEmitted &&
          consecutiveFailures >= HEARTBEAT_WARN_LOG_FAILURE_THRESHOLD
        ) {
          stuckWarnEmitted = true;
          deps.logger?.warn(
            `paperclip-heartbeat: ${consecutiveFailures} consecutive failures — ` +
              `Paperclip is unreachable. Backoff is exponentially-doubling toward ` +
              `${maxIntervalMs}ms cap. ` +
              `Next tick: ${Math.round(nextIntervalMs(consecutiveFailures))}ms.`,
          );
        }
      }
      const metrics = getActivePaperclipMetrics();
      metrics?.setHeartbeatConsecutiveFailures(consecutiveFailures);
      scheduleNext();
    }, delay);
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(timer);
  }

  function start(): void {
    if (timer !== null || stopped) return;
    // Fire once immediately so /agents "Last seen" flips on quickly;
    // don't await — start() must be non-blocking. The immediate tick
    // runs OUTSIDE the scheduleNext path so initial latency to liveness
    // is independent of baseIntervalMs.
    void (async () => {
      const result = await tick();
      // Same post-await stopped guard as in scheduleNext: a stop()
      // while the immediate tick was in flight must NOT bump the
      // failure counter or schedule a follow-up. Without this guard
      // a fast SIGTERM right after start() leaves a residual gauge
      // reading and an orphan setTimeout call to scheduleNext()
      // (which itself bails, but the metric mutation already
      // happened by then).
      if (stopped) return;
      if (result.ok) {
        consecutiveFailures = 0;
        stuckWarnEmitted = false;
      } else {
        consecutiveFailures += 1;
        // Same warn-log path as in scheduleNext — kept symmetric so a
        // first-tick failure that already crosses the threshold (e.g.
        // Paperclip down at gateway boot) emits the same hint operators
        // expect. The latch ensures the line fires only once per outage.
        if (
          !stuckWarnEmitted &&
          consecutiveFailures >= HEARTBEAT_WARN_LOG_FAILURE_THRESHOLD
        ) {
          stuckWarnEmitted = true;
          deps.logger?.warn(
            `paperclip-heartbeat: ${consecutiveFailures} consecutive failures — ` +
              `Paperclip is unreachable. Backoff is exponentially-doubling toward ` +
              `${maxIntervalMs}ms cap. ` +
              `Next tick: ${Math.round(nextIntervalMs(consecutiveFailures))}ms.`,
          );
        }
      }
      const metrics = getActivePaperclipMetrics();
      metrics?.setHeartbeatConsecutiveFailures(consecutiveFailures);
      scheduleNext();
    })();
  }

  function stop(): void {
    // Order matters: set the flag BEFORE clearing the timer so a
    // tick that fires concurrently with stop() (Node's timer wheel
    // can race with our clearTimeout in pathological cases — e.g.
    // the timer pool just ticked over and a callback is mid-dispatch
    // when we call clearTimeout) sees stopped=true on its first
    // check inside the callback. Reverse order would let the
    // callback proceed because it observes the still-false flag.
    stopped = true;
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  return { start, stop, tick };
}
