/**
 * Paperclip outbound circuit breaker.
 *
 * Mirror of paperclip-avelton/server/src/services/openclaw-health.ts on
 * the OpenClaw → Paperclip arrow. Keeps a per-process tally of
 * consecutive `postInbound` failures and trips a breaker when the
 * threshold is exceeded — short-circuiting subsequent attempts for a
 * cooldown window so a downstream Paperclip outage doesn't pin the
 * gateway's connection pool with retry storms.
 *
 * Env tunables:
 *   PAPERCLIP_OUTBOUND_CIRCUIT_FAILURE_THRESHOLD   (default 5)
 *   PAPERCLIP_OUTBOUND_CIRCUIT_COOLDOWN_MS         (default 30_000)
 *   PAPERCLIP_OUTBOUND_CIRCUIT_HALF_OPEN_IDLE_MS   (default 60_000)
 *
 * State machine:
 *   closed   ──fail × N─▶ open
 *   open     ──cooldown elapsed─▶ half_open
 *   half_open──success──▶ closed
 *   half_open──fail───▶ open (timer resets)
 *   half_open──idle-timeout, no probe arrived──▶ closed
 *
 * The idle-timeout path closes half_open automatically after a quiet
 * period so a bridge with thin traffic doesn't sit ambiguous forever.
 */

export type CircuitState = "closed" | "open" | "half_open";

/**
 * Why a circuit state transition happened. Same vocabulary as the
 * Paperclip side's `CircuitTransitionReason` — operators who correlate
 * both audit tables see consistent labels.
 */
export type CircuitTransitionReason =
  | "threshold_reached"
  | "cooldown_expired"
  | "probe_success"
  | "idle_timeout";

export interface CircuitTransition {
  from: CircuitState;
  to: CircuitState;
  reason: CircuitTransitionReason;
  /** Millisecond timestamp of the transition. */
  at: number;
}

export type CircuitTransitionListener = (event: CircuitTransition) => void;

export interface CircuitSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: string | null;
  lastReachableAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

export interface PaperclipCircuit {
  /** Returns true when the next attempt is allowed; false during cooldown. */
  allow(now?: number): boolean;
  /** Record a successful POST — resets failures and closes the breaker. */
  recordSuccess(now?: number): void;
  /** Record a failure — increments counter and may open the breaker. */
  recordFailure(reason: string, now?: number): void;
  /** Snapshot of breaker state for logs / health endpoints. */
  snapshot(): CircuitSnapshot;
}

interface CircuitInternalState {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number | null;
  halfOpenEnteredAt: number | null;
  lastReachableAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
}

export interface CircuitConfig {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenIdleMs: number;
}

export function resolveCircuitConfig(env: NodeJS.ProcessEnv = process.env): CircuitConfig {
  return resolveCircuitConfigForPrefix("PAPERCLIP_OUTBOUND", env);
}

/**
 * Prefix-aware config resolver. Each bridge arrow (outbound postInbound,
 * auth exchange, MCP call) has its own breaker with its own thresholds.
 * Callers pass e.g. `PAPERCLIP_AUTH` or `PAPERCLIP_MCP` to read
 * `PAPERCLIP_AUTH_CIRCUIT_FAILURE_THRESHOLD` etc.
 *
 * Why three breakers instead of one: a Logto outage (exchange 5xx storm)
 * shouldn't trip the outbound-inbound arrow, and an MCP-tool flood from
 * a runaway agent shouldn't blackhole legitimate user replies. Operators
 * can tune each arrow independently via env.
 */
export function resolveCircuitConfigForPrefix(
  prefix: string,
  env: NodeJS.ProcessEnv = process.env,
): CircuitConfig {
  const threshold = Number(env[`${prefix}_CIRCUIT_FAILURE_THRESHOLD`]);
  const cooldown = Number(env[`${prefix}_CIRCUIT_COOLDOWN_MS`]);
  const halfOpenIdle = Number(env[`${prefix}_CIRCUIT_HALF_OPEN_IDLE_MS`]);
  return {
    failureThreshold: Number.isFinite(threshold) && threshold > 0 ? threshold : 5,
    cooldownMs: Number.isFinite(cooldown) && cooldown > 0 ? cooldown : 30_000,
    halfOpenIdleMs: Number.isFinite(halfOpenIdle) && halfOpenIdle > 0 ? halfOpenIdle : 60_000,
  };
}

export interface CreatePaperclipCircuitDeps {
  /**
   * Invoked synchronously on every state transition — same contract as
   * Paperclip's `onCircuitTransition`. Use it to emit a log line and/or
   * a span event so operators can see the breaker trip in their
   * aggregator without tailing live logs at the exact moment. Throws in
   * the listener are swallowed so a misbehaving subscriber cannot
   * perturb the breaker state machine.
   */
  onTransition?: CircuitTransitionListener;
}

export function createPaperclipCircuit(
  config?: CircuitConfig,
  deps: CreatePaperclipCircuitDeps = {},
): PaperclipCircuit {
  const effectiveConfig = config ?? resolveCircuitConfig();
  const state: CircuitInternalState = {
    state: "closed",
    consecutiveFailures: 0,
    openedAt: null,
    halfOpenEnteredAt: null,
    lastReachableAt: null,
    lastErrorAt: null,
    lastError: null,
  };

  function emit(from: CircuitState, to: CircuitState, reason: CircuitTransitionReason, at: number): void {
    if (from === to) return;
    if (!deps.onTransition) return;
    try {
      deps.onTransition({ from, to, reason, at });
    } catch {
      // Listener failures must not perturb the breaker — same contract
      // as the Paperclip side.
    }
  }

  function allow(now: number = Date.now()): boolean {
    if (state.state === "closed") return true;
    if (state.state === "open") {
      if (state.openedAt != null && now - state.openedAt >= effectiveConfig.cooldownMs) {
        // Cooldown elapsed — allow exactly one probe through.
        const from = state.state;
        state.state = "half_open";
        state.halfOpenEnteredAt = now;
        emit(from, "half_open", "cooldown_expired", now);
        return true;
      }
      return false;
    }
    // half_open: allow exactly one probe at a time. We let multiple
    // through here intentionally — concurrent retries during the
    // half-open window are rare in practice and we don't want to add
    // mutex bookkeeping for a single probe lockout. If the state has
    // been held without resolution longer than the idle timeout, drop
    // back to closed so a breaker on a quiet bridge doesn't linger
    // ambiguous indefinitely — the next real failure will reopen it.
    if (
      state.halfOpenEnteredAt != null &&
      now - state.halfOpenEnteredAt >= effectiveConfig.halfOpenIdleMs
    ) {
      const from = state.state;
      state.state = "closed";
      state.openedAt = null;
      state.halfOpenEnteredAt = null;
      state.consecutiveFailures = 0;
      emit(from, "closed", "idle_timeout", now);
    }
    return true;
  }

  function recordSuccess(now: number = Date.now()): void {
    const from = state.state;
    state.consecutiveFailures = 0;
    state.openedAt = null;
    state.halfOpenEnteredAt = null;
    state.state = "closed";
    state.lastReachableAt = now;
    state.lastError = null;
    state.lastErrorAt = null;
    emit(from, "closed", "probe_success", now);
  }

  function recordFailure(reason: string, now: number = Date.now()): void {
    state.consecutiveFailures += 1;
    state.lastError = reason;
    state.lastErrorAt = now;
    if (state.consecutiveFailures >= effectiveConfig.failureThreshold) {
      const from = state.state;
      state.state = "open";
      state.openedAt = now;
      state.halfOpenEnteredAt = null;
      emit(from, "open", "threshold_reached", now);
    }
  }

  function snapshot(): CircuitSnapshot {
    return {
      state: state.state,
      consecutiveFailures: state.consecutiveFailures,
      openedAt: state.openedAt != null ? new Date(state.openedAt).toISOString() : null,
      lastReachableAt: state.lastReachableAt != null ? new Date(state.lastReachableAt).toISOString() : null,
      lastErrorAt: state.lastErrorAt != null ? new Date(state.lastErrorAt).toISOString() : null,
      lastError: state.lastError,
    };
  }

  return { allow, recordSuccess, recordFailure, snapshot };
}
