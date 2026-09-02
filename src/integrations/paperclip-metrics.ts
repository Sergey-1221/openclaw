/**
 * Avelton-claw → Paperclip bridge metrics.
 *
 * In-process Prometheus-exposition collector for the gateway side of the
 * bridge. Symmetric with paperclip-avelton/server/src/routes/metrics.ts
 * so a single Grafana dashboard can plot both arrows side by side:
 *
 *   paperclip_bridge_*   — recorded by Paperclip from bridge_audit
 *   openclaw_bridge_*    — recorded here in-process (no DB)
 *
 * Design constraints:
 *   1. No prom-client dependency. Exposition is assembled by hand from
 *      a handful of maps and a circular sample buffer; keeps the bundle
 *      tiny and matches the Paperclip-side approach.
 *   2. All counters are monotonic for the process lifetime. The
 *      collector scrape cadence + prometheus `rate()` take care of
 *      windowing; we don't try to implement rolling windows inline
 *      beyond latency (where quantiles require a bounded sample).
 *   3. Latency samples are capped per direction (MAX_LATENCY_SAMPLES)
 *      as a FIFO buffer. At default heartbeat cadence (30s) and ~5
 *      directions this stays under 10 KB of memory indefinitely.
 *   4. Thread-safe by construction: Node is single-threaded and every
 *      public method is synchronous, so there's no tearing.
 */

import type { CircuitSnapshot, CircuitState } from "./paperclip-circuit.js";

/**
 * Label vocabulary for `openclaw_paperclip_auth_cache_hits_total`.
 *
 * Three of the four values correspond directly to the underlying breaker
 * state at hit time. The fourth — `"open_stale"` — is virtual: it
 * indicates the cache served an entry that was past its safety window
 * (or even past its declared expiresAt) BECAUSE the breaker was open
 * and stale-grace allowed it. Operators should alert on
 * `rate(...{breaker_state="open_stale"}[5m]) > 0` more aggressively
 * than on `breaker_state="open"`: stale-serve means tokens may already
 * be revoked or expired and Paperclip will start 401-ing as soon as
 * the breaker recovers.
 */
export type AuthCacheBreakerLabel = CircuitState | "open_stale";

export type MetricsDirection =
  | "outbound"
  | "exchange"
  | "mcp"
  | "heartbeat";

export type MetricsOutcome = "ok" | "error" | "timeout";

export type DispatchOutcome = "forwarded" | "skipped" | "failed";

/**
 * Auth-cache miss vocabulary. Bounded so Prometheus label cardinality
 * on `openclaw_paperclip_auth_cache_misses_total{reason}` stays at 3.
 */
export type AuthCacheMissReason = "stale_expired" | "breaker_open" | "first_request";

/**
 * Upper bound on per-direction latency samples kept for quantile
 * calculation. A scrape every 30s with a 30s heartbeat cadence keeps
 * the window well inside this cap; higher-throughput call sites
 * (postInbound bursts) just lose the oldest samples, which is fine —
 * Prometheus will re-compute quantiles on each scrape and Grafana
 * plots them as instantaneous values, not totals.
 */
const MAX_LATENCY_SAMPLES = 1024;

/**
 * Snapshot provider for a single named circuit breaker. The metrics
 * renderer calls `get()` once per scrape — providers must be synchronous
 * and cheap. Returning null emits a zeroed gauge (breaker not wired)
 * rather than gapping the series.
 */
export interface CircuitSnapshotProvider {
  /** Label value for the `arrow` Prometheus label, e.g. `paperclip_outbound`. */
  arrow: string;
  get: () => CircuitSnapshot | null;
}

export interface PaperclipMetrics {
  /** Record a bridge call completing with the given outcome + category. */
  recordRequest(direction: MetricsDirection, outcome: MetricsOutcome, errorCategory?: string): void;
  /** Record the latency of a bridge call, regardless of outcome. */
  recordLatency(direction: MetricsDirection, latencyMs: number): void;
  /**
   * Record a dispatcher result. The optional `errorCategory` is folded
   * into the Prometheus label set so operators can disambiguate
   * `outcome="failed"` causes (breaker open vs upstream 5xx vs network)
   * without cross-referencing the breaker-state gauge during incident
   * response. The label is the same vocabulary `recordRequest` uses for
   * the bridge counter so a single Grafana legend covers both series.
   */
  recordDispatch(outcome: DispatchOutcome, errorCategory?: string): void;
  /**
   * Update the heartbeat-failures gauge. Called by the heartbeat loop
   * after every tick; 0 on success, incremented on failure. Rendered as
   * `openclaw_paperclip_heartbeat_consecutive_failures` so dashboards
   * can plot a flat line when healthy and a staircase during an outage.
   */
  setHeartbeatConsecutiveFailures(count: number): void;
  /**
   * Read-only snapshot of the heartbeat-failures gauge. Exposed so
   * `/health` can mirror the Prometheus value without operators having
   * to wire a separate scrape.
   */
  getHeartbeatConsecutiveFailures(): number;
  /**
   * Record that an exchange call was served from the auth cache. The
   * breaker_state label lets operators spot "cache hit while breaker
   * open" — a subtle-but-important signal: with open breaker, reading
   * from cache is the ONLY way MCP tool calls keep succeeding, and
   * reveals that the bridge is effectively running on stale tokens.
   * The synthetic `"open_stale"` value indicates the cache served an
   * entry past its normal safety window because stale-grace was
   * activated by the open breaker — louder signal than plain `"open"`
   * because it implies tokens are likely already past their declared
   * expiresAt. Rendered as
   * `openclaw_paperclip_auth_cache_hits_total{breaker_state}`.
   */
  recordAuthCacheHit(breakerState: AuthCacheBreakerLabel): void;
  /**
   * Record an auth-cache miss. Pair with `recordAuthCacheHit` so
   * operators can compute hit-rate (`hits / (hits + misses)`) — a drop
   * from a steady ~95% to ~30% signals tokens are expiring faster than
   * they're being reused, often the precursor to a stampede after an
   * outage. The `reason` label distinguishes:
   *   - `stale_expired` — cached token aged out of stale-grace
   *   - `breaker_open` — breaker open AND cache empty (no entry to serve)
   *   - `first_request` — a (sub, scopes) tuple seen for the first time
   * Rendered as `openclaw_paperclip_auth_cache_misses_total{reason}`.
   */
  recordAuthCacheMiss(reason: AuthCacheMissReason): void;
  /**
   * Snapshot the current dispatcher buffer depth. Called once per scrape
   * by the dispatcher when its TTL-bounded retry buffer is enabled
   * (PAPERCLIP_DISPATCHER_BUFFER_MAX > 0). 0 when disabled or empty.
   * Rendered as `openclaw_dispatcher_buffer_size`.
   */
  setDispatcherBufferSize(size: number): void;
  /**
   * Record an attempt to drain a buffered reply. `outcome="forwarded"`
   * for successful re-delivery (the buffered entry is removed),
   * `outcome="failed"` when the retry hit a still-open breaker or
   * upstream error and the entry stays buffered. Pair with
   * `_evicted_total` to distinguish "delivered late" from "expired".
   */
  recordDispatcherBufferDrained(outcome: "forwarded" | "failed"): void;
  /**
   * Record that a buffered entry was dropped without delivery.
   *   - `ttl_expired` — entry exceeded PAPERCLIP_DISPATCHER_BUFFER_TTL_MS
   *     and is now meaningfully stale (chat user has likely moved on).
   *   - `cap_reached` — buffer was full when a new failure tried to
   *     enqueue; the OLDEST entry is dropped to make room (FIFO).
   * Sustained `cap_reached > 0` is the "buffer is too small for the
   * outage profile" signal — operators bump PAPERCLIP_DISPATCHER_BUFFER_MAX.
   */
  recordDispatcherBufferEvicted(reason: "ttl_expired" | "cap_reached"): void;
  /**
   * Render Prometheus text exposition.
   *
   * Legacy signature — a bare callable — is a shortcut for one breaker
   * labelled `arrow="paperclip_outbound"`. Pass an array of named
   * providers to expose multiple breakers (outbound + auth + mcp). Always
   * emits at least the paperclip_outbound gauge so Grafana dashboards
   * never gap the series when a given arrow is disabled.
   */
  renderExposition(
    getCircuit?: (() => CircuitSnapshot | null) | readonly CircuitSnapshotProvider[],
  ): string;
  /** Reset all counters and samples. Intended for tests only. */
  reset(): void;
}

interface Counter {
  value: number;
}

export function createPaperclipMetrics(): PaperclipMetrics {
  /** Keyed by `${direction}|${outcome}|${errorCategory}`. */
  const requestCounters = new Map<string, Counter>();
  /** Keyed by direction. Circular buffer capped at MAX_LATENCY_SAMPLES. */
  const latencySamples = new Map<MetricsDirection, number[]>();
  /** Keyed by `${outcome}|${errorCategory}`. The error_category dimension
   *  exists for `failed` outcomes to disambiguate the cause; `forwarded`
   *  and `skipped` always use `errorCategory="none"` so the cardinality
   *  stays bounded (3 outcomes × ~5 categories = 15 series max). */
  const dispatchCounters = new Map<string, Counter>();
  /** Latest heartbeat failure count. Scalar (not per-key) because there
   * is exactly one heartbeat loop per process. */
  let heartbeatConsecutiveFailures = 0;
  /** Auth cache-hit counter, keyed by breaker state so operators can
   * distinguish "normal cache hits" from "cache hits riding an open
   * breaker" — the latter means tool calls are succeeding only because
   * tokens are still warm, and is the cliff edge before broader failure. */
  const authCacheHitsByState = new Map<AuthCacheBreakerLabel, Counter>();
  /** Auth-cache miss counter, keyed by reason. Pair with hits to derive
   * hit-rate. The reason vocabulary is bounded by AuthCacheMissReason. */
  const authCacheMissesByReason = new Map<AuthCacheMissReason, Counter>();
  /** Current dispatcher retry-buffer depth. Updated by the dispatcher on
   * every enqueue/drain. Scalar — there is exactly one buffer per
   * gateway process. */
  let dispatcherBufferSize = 0;
  /** Buffer drain outcomes. Keyed by outcome for two-line exposition. */
  const dispatcherBufferDrainedByOutcome = new Map<"forwarded" | "failed", Counter>();
  /** Buffer eviction reasons. Keyed by reason for two-line exposition. */
  const dispatcherBufferEvictedByReason = new Map<"ttl_expired" | "cap_reached", Counter>();

  function bumpRequest(direction: MetricsDirection, outcome: MetricsOutcome, errorCategory: string): void {
    const key = `${direction}|${outcome}|${errorCategory}`;
    let counter = requestCounters.get(key);
    if (!counter) {
      counter = { value: 0 };
      requestCounters.set(key, counter);
    }
    counter.value += 1;
  }

  function recordRequest(
    direction: MetricsDirection,
    outcome: MetricsOutcome,
    errorCategory?: string,
  ): void {
    bumpRequest(direction, outcome, errorCategory ?? "none");
  }

  function recordLatency(direction: MetricsDirection, latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
    let samples = latencySamples.get(direction);
    if (!samples) {
      samples = [];
      latencySamples.set(direction, samples);
    }
    samples.push(latencyMs);
    if (samples.length > MAX_LATENCY_SAMPLES) {
      // Drop the oldest half at once rather than one-by-one to avoid
      // O(N) shift cost on every insert under high throughput.
      samples.splice(0, samples.length - MAX_LATENCY_SAMPLES);
    }
  }

  function recordDispatch(outcome: DispatchOutcome, errorCategory?: string): void {
    const category = outcome === "failed" ? (errorCategory ?? "unknown") : "none";
    const key = `${outcome}|${category}`;
    let counter = dispatchCounters.get(key);
    if (!counter) {
      counter = { value: 0 };
      dispatchCounters.set(key, counter);
    }
    counter.value += 1;
  }

  function setHeartbeatConsecutiveFailures(count: number): void {
    // Clamp to non-negative integer defensively — setInterval jitter
    // can occasionally fire a tick during teardown with a late result.
    heartbeatConsecutiveFailures = Math.max(0, Math.trunc(count));
  }

  function getHeartbeatConsecutiveFailures(): number {
    return heartbeatConsecutiveFailures;
  }

  function recordAuthCacheHit(breakerState: AuthCacheBreakerLabel): void {
    let counter = authCacheHitsByState.get(breakerState);
    if (!counter) {
      counter = { value: 0 };
      authCacheHitsByState.set(breakerState, counter);
    }
    counter.value += 1;
  }

  function recordAuthCacheMiss(reason: AuthCacheMissReason): void {
    let counter = authCacheMissesByReason.get(reason);
    if (!counter) {
      counter = { value: 0 };
      authCacheMissesByReason.set(reason, counter);
    }
    counter.value += 1;
  }

  function setDispatcherBufferSize(size: number): void {
    // Clamp defensively. The dispatcher is single-threaded so size is
    // a clean non-negative int in practice, but the gauge is exposed
    // to a Prometheus scrape and we'd rather emit `0` than a NaN line.
    dispatcherBufferSize = Math.max(0, Math.trunc(Number.isFinite(size) ? size : 0));
  }

  function recordDispatcherBufferDrained(outcome: "forwarded" | "failed"): void {
    let counter = dispatcherBufferDrainedByOutcome.get(outcome);
    if (!counter) {
      counter = { value: 0 };
      dispatcherBufferDrainedByOutcome.set(outcome, counter);
    }
    counter.value += 1;
  }

  function recordDispatcherBufferEvicted(reason: "ttl_expired" | "cap_reached"): void {
    let counter = dispatcherBufferEvictedByReason.get(reason);
    if (!counter) {
      counter = { value: 0 };
      dispatcherBufferEvictedByReason.set(reason, counter);
    }
    counter.value += 1;
  }

  function renderExposition(
    getCircuit?: (() => CircuitSnapshot | null) | readonly CircuitSnapshotProvider[],
  ): string {
    const lines: string[] = [];

    lines.push(
      "# HELP openclaw_bridge_requests_total Count of Paperclip-facing bridge calls, partitioned by direction, outcome and error category.",
    );
    lines.push("# TYPE openclaw_bridge_requests_total counter");
    // Stable ordering so snapshot tests don't flake on Map iteration
    // quirks across Node versions.
    const sortedRequestKeys = [...requestCounters.keys()].sort();
    for (const key of sortedRequestKeys) {
      const counter = requestCounters.get(key)!;
      const [direction, outcome, errorCategory] = key.split("|") as [
        string,
        string,
        string,
      ];
      lines.push(
        `openclaw_bridge_requests_total{direction="${escapeLabelValue(direction)}",outcome="${escapeLabelValue(outcome)}",error_category="${escapeLabelValue(errorCategory)}"} ${counter.value}`,
      );
    }

    lines.push(
      "# HELP openclaw_bridge_latency_ms Paperclip-facing bridge latency in milliseconds, windowed by sample cap.",
    );
    lines.push("# TYPE openclaw_bridge_latency_ms summary");
    const sortedDirections = [...latencySamples.keys()].sort();
    for (const direction of sortedDirections) {
      const samples = latencySamples.get(direction)!;
      if (samples.length === 0) continue;
      const sorted = [...samples].sort((a, b) => a - b);
      const p50 = quantile(sorted, 0.5);
      const p95 = quantile(sorted, 0.95);
      const p99 = quantile(sorted, 0.99);
      const label = escapeLabelValue(direction);
      lines.push(`openclaw_bridge_latency_ms{direction="${label}",quantile="0.5"} ${p50}`);
      lines.push(`openclaw_bridge_latency_ms{direction="${label}",quantile="0.95"} ${p95}`);
      lines.push(`openclaw_bridge_latency_ms{direction="${label}",quantile="0.99"} ${p99}`);
      lines.push(`openclaw_bridge_latency_ms_count{direction="${label}"} ${samples.length}`);
    }

    // Heartbeat backoff signal. 0 on healthy ticks; rises monotonically
    // across a Paperclip outage (1, 2, 3, …) until recovery resets to 0.
    // Exposed so operators can alert on `> 3` for sustained failure
    // without waiting for the full backoff ceiling.
    lines.push(
      "# HELP openclaw_paperclip_heartbeat_consecutive_failures Consecutive heartbeat failures since the last successful tick.",
    );
    lines.push("# TYPE openclaw_paperclip_heartbeat_consecutive_failures gauge");
    lines.push(
      `openclaw_paperclip_heartbeat_consecutive_failures ${heartbeatConsecutiveFailures}`,
    );

    // Auth-cache hit counter. Watch the `breaker_state="open"` series:
    // sustained non-zero means MCP tool calls are succeeding only via
    // cached tokens while the breaker is open — token expiry will then
    // cause a cliff. Pair with an alert on
    // rate(openclaw_paperclip_auth_cache_hits_total{breaker_state="open"}[5m]) > 0.
    lines.push(
      "# HELP openclaw_paperclip_auth_cache_hits_total Auth-exchange calls served from cache, partitioned by the breaker state at the time of the hit.",
    );
    lines.push("# TYPE openclaw_paperclip_auth_cache_hits_total counter");
    const sortedAuthHitStates = [...authCacheHitsByState.keys()].sort();
    for (const state of sortedAuthHitStates) {
      const counter = authCacheHitsByState.get(state)!;
      lines.push(
        `openclaw_paperclip_auth_cache_hits_total{breaker_state="${escapeLabelValue(state)}"} ${counter.value}`,
      );
    }

    // Auth-cache miss counter. Paired with hits so operators can chart
    // hit-rate; a sudden drop signals the cache is re-populating faster
    // than steady-state and the bridge is one outage away from a
    // stampede.
    lines.push(
      "# HELP openclaw_paperclip_auth_cache_misses_total Auth-exchange calls that did NOT find a usable cache entry, partitioned by reason (stale_expired / breaker_open / first_request).",
    );
    lines.push("# TYPE openclaw_paperclip_auth_cache_misses_total counter");
    const sortedAuthMissReasons = [...authCacheMissesByReason.keys()].sort();
    for (const reason of sortedAuthMissReasons) {
      const counter = authCacheMissesByReason.get(reason)!;
      lines.push(
        `openclaw_paperclip_auth_cache_misses_total{reason="${escapeLabelValue(reason)}"} ${counter.value}`,
      );
    }

    lines.push(
      "# HELP openclaw_dispatcher_dispatch_total Count of user-reply dispatch attempts, partitioned by outcome and error_category. error_category is `none` for forwarded/skipped; for failed it disambiguates breaker_open / http_4xx / http_5xx / network / unknown.",
    );
    lines.push("# TYPE openclaw_dispatcher_dispatch_total counter");
    const sortedDispatchKeys = [...dispatchCounters.keys()].sort();
    for (const key of sortedDispatchKeys) {
      const counter = dispatchCounters.get(key)!;
      const sep = key.indexOf("|");
      const outcome = sep === -1 ? key : key.slice(0, sep);
      const errorCategory = sep === -1 ? "none" : key.slice(sep + 1);
      lines.push(
        `openclaw_dispatcher_dispatch_total{outcome="${escapeLabelValue(outcome)}",error_category="${escapeLabelValue(errorCategory)}"} ${counter.value}`,
      );
    }

    // Dispatcher retry-buffer telemetry. Always emit the gauge even
    // when 0 / disabled so dashboards never gap the series. The
    // buffer is opt-in via PAPERCLIP_DISPATCHER_BUFFER_MAX > 0; with
    // the default (0), all three series stay flat at zero.
    lines.push(
      "# HELP openclaw_dispatcher_buffer_size Current depth of the in-memory retry buffer for replies that failed with breaker_open. 0 when the buffer is disabled.",
    );
    lines.push("# TYPE openclaw_dispatcher_buffer_size gauge");
    lines.push(`openclaw_dispatcher_buffer_size ${dispatcherBufferSize}`);

    lines.push(
      "# HELP openclaw_dispatcher_buffer_drained_total Buffered replies re-attempted after a breaker recovery, partitioned by outcome (forwarded / failed).",
    );
    lines.push("# TYPE openclaw_dispatcher_buffer_drained_total counter");
    const sortedDrainOutcomes = [...dispatcherBufferDrainedByOutcome.keys()].sort();
    for (const outcome of sortedDrainOutcomes) {
      const counter = dispatcherBufferDrainedByOutcome.get(outcome)!;
      lines.push(
        `openclaw_dispatcher_buffer_drained_total{outcome="${escapeLabelValue(outcome)}"} ${counter.value}`,
      );
    }

    lines.push(
      "# HELP openclaw_dispatcher_buffer_evicted_total Buffered replies dropped without delivery, partitioned by reason (ttl_expired = entry aged out; cap_reached = buffer full, oldest pushed out).",
    );
    lines.push("# TYPE openclaw_dispatcher_buffer_evicted_total counter");
    const sortedEvictReasons = [...dispatcherBufferEvictedByReason.keys()].sort();
    for (const reason of sortedEvictReasons) {
      const counter = dispatcherBufferEvictedByReason.get(reason)!;
      lines.push(
        `openclaw_dispatcher_buffer_evicted_total{reason="${escapeLabelValue(reason)}"} ${counter.value}`,
      );
    }

    lines.push(
      "# HELP openclaw_bridge_circuit_state Outbound-to-Paperclip circuit breaker state (0=closed, 1=half_open, 2=open).",
    );
    lines.push("# TYPE openclaw_bridge_circuit_state gauge");
    // Normalise the `getCircuit` argument into a provider list. Callers
    // passing a bare callable (legacy API) get an implicit `paperclip_outbound`
    // arrow label. The outbound gauge is always emitted so Grafana
    // dashboards don't gap the series if that breaker isn't wired.
    const providers: readonly CircuitSnapshotProvider[] = Array.isArray(getCircuit)
      ? (getCircuit as readonly CircuitSnapshotProvider[])
      : typeof getCircuit === "function"
        ? [{ arrow: "paperclip_outbound", get: getCircuit as () => CircuitSnapshot | null }]
        : [];
    const labelsSeen = new Set<string>();
    for (const p of providers) {
      const snap = safeSnapshot(p.get);
      const arrowLabel = escapeLabelValue(p.arrow);
      if (snap) {
        lines.push(
          `openclaw_bridge_circuit_state{arrow="${arrowLabel}"} ${circuitStateToNumber(snap.state)}`,
        );
        lines.push(
          `openclaw_bridge_circuit_consecutive_failures{arrow="${arrowLabel}"} ${snap.consecutiveFailures}`,
        );
      } else {
        lines.push(`openclaw_bridge_circuit_state{arrow="${arrowLabel}"} 0`);
        lines.push(
          `openclaw_bridge_circuit_consecutive_failures{arrow="${arrowLabel}"} 0`,
        );
      }
      labelsSeen.add(p.arrow);
    }
    // Guaranteed-present outbound gauge: keeps the dashboard query
    // `openclaw_bridge_circuit_state{arrow="paperclip_outbound"}` from
    // going nodata when the outbound arrow is disabled.
    if (!labelsSeen.has("paperclip_outbound")) {
      lines.push('openclaw_bridge_circuit_state{arrow="paperclip_outbound"} 0');
      lines.push(
        'openclaw_bridge_circuit_consecutive_failures{arrow="paperclip_outbound"} 0',
      );
    }

    return lines.join("\n") + "\n";
  }

  function reset(): void {
    requestCounters.clear();
    latencySamples.clear();
    dispatchCounters.clear();
    heartbeatConsecutiveFailures = 0;
    authCacheHitsByState.clear();
    authCacheMissesByReason.clear();
    dispatcherBufferSize = 0;
    dispatcherBufferDrainedByOutcome.clear();
    dispatcherBufferEvictedByReason.clear();
  }

  return {
    recordRequest,
    recordLatency,
    recordDispatch,
    setHeartbeatConsecutiveFailures,
    getHeartbeatConsecutiveFailures,
    recordAuthCacheHit,
    recordAuthCacheMiss,
    setDispatcherBufferSize,
    recordDispatcherBufferDrained,
    recordDispatcherBufferEvicted,
    renderExposition,
    reset,
  };
}

/**
 * Module-level singleton. Set by `startPaperclipIntegration()` so the
 * `/metrics` HTTP route (registered in `src/gateway/server-http.ts`) and
 * instrumentation call sites deep in the bridge clients can reach the
 * same instance without constructor threading. Reset on
 * integration.stop() so tests that re-bootstrap see a clean slate.
 */
let activeMetrics: PaperclipMetrics | null = null;

export function setActivePaperclipMetrics(metrics: PaperclipMetrics | null): void {
  activeMetrics = metrics;
}

export function getActivePaperclipMetrics(): PaperclipMetrics | null {
  return activeMetrics;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function circuitStateToNumber(state: CircuitState): number {
  if (state === "open") return 2;
  if (state === "half_open") return 1;
  return 0;
}

function safeSnapshot(getCircuit: () => CircuitSnapshot | null): CircuitSnapshot | null {
  try {
    return getCircuit();
  } catch {
    return null;
  }
}
