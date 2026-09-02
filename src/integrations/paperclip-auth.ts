/**
 * Avelton-claw → Paperclip token-exchange client (Logto-backed).
 *
 * OpenClaw exchanges a user's Logto `id_token` for a short-lived,
 * scope-limited Paperclip bearer by POSTing to
 * POST /api/auth/openclaw-exchange on Paperclip. The exchange endpoint
 * is gated by a shared `OPENCLAW_EXCHANGE_CLIENT_SECRET` so a
 * compromised id_token alone cannot mint Paperclip bearers — the
 * attacker also needs the client secret.
 *
 * This file stays intentionally small: just the HTTP call + a
 * per-(user,scopes) cache so repeated MCP tool invocations during one
 * agent turn don't each trigger a fresh exchange. The caller brings its
 * own Logto integration for issuing the id_token — that code lives in
 * Avelton-claw's existing auth layer; we only receive the finished
 * token and hand it to Paperclip.
 *
 * Cache eviction has two modes:
 *   - Normal (breaker closed): entries expire `CACHE_EXPIRY_SAFETY_MS`
 *     (60s) before their declared `expiresAt` so a slow Paperclip clock
 *     or request path doesn't hand out a token that will 401 at the
 *     other end. Strict expiry compliance.
 *   - Stale-grace (breaker open): when the paperclip_auth circuit is
 *     open, the cache hands out entries past the safety window AND past
 *     the declared `expiresAt` for up to `STALE_GRACE_MS` (default 1h,
 *     env `PAPERCLIP_AUTH_CACHE_STALE_GRACE_MS`). This trades strict
 *     expiry for availability during Paperclip outages — operators get
 *     a `breaker_state="open_stale"` metric that fires proactively as
 *     a "you're now riding stale tokens" signal, ~1h before the
 *     cascade of 401s when even stale tokens age out. Stale-serve
 *     can be disabled by setting the env to 0 (legacy hard-evict).
 *
 * A negative-result cache is intentionally omitted — exchange failures
 * are rare and benefit from seeing a fresh attempt on the next request
 * rather than re-serving a stale error.
 */

import { withBridgeSpan } from "./paperclip-spans.js";
import { getActivePaperclipMetrics } from "./paperclip-metrics.js";
import type { PaperclipCircuit } from "./paperclip-circuit.js";
import { resolveTraceparent } from "./paperclip-traceparent.js";

type Logger = {
  warn(msg: string, ...args: unknown[]): void;
  info?(msg: string, ...args: unknown[]): void;
};

export interface PaperclipAuthConfig {
  /** Paperclip base URL, e.g. `http://paperclip:3100`. */
  baseUrl?: string;
  /** Explicit override for the exchange endpoint. */
  exchangeUrl?: string;
  /** Shared client secret gating the exchange endpoint. */
  clientSecret?: string;
}

export interface ExchangeRequest {
  /** Logto-issued id_token for the acting user. */
  idToken: string;
  /** Paperclip company id the user wants to operate against. */
  companyId: string;
  /** Optional override of the scope set to request. */
  scopes?: string[];
  /** Optional override of the token TTL (max 86400s / 24h). */
  ttlSeconds?: number;
  /**
   * Optional W3C traceparent to forward to Paperclip. When absent a
   * fresh one is synthesised so the exchange hop is never a null-trace
   * row in bridge_audit. Pass the caller's traceparent (e.g. from the
   * Logto-session middleware) to preserve a single distributed trace.
   */
  traceparent?: string;
}

export interface ExchangeResult {
  /** Paperclip bearer token to use on subsequent MCP/REST calls. */
  token: string;
  /** When the token expires; caller must re-exchange after this. */
  expiresAt: Date;
  /** Namespaced Paperclip user id (e.g. `logto:<sub>`). */
  userId: string;
  /** The scopes Paperclip actually granted. */
  scopes: string[];
}

export class PaperclipAuthError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "PaperclipAuthError";
  }
}

export const DEFAULT_EXCHANGE_TIMEOUT_MS = 5_000;
export const CACHE_EXPIRY_SAFETY_MS = 60_000;
/**
 * Stale-serve grace window — only consulted when the auth circuit is
 * open. Default 1h. Background:
 *
 *   - The auth cache exists so a tool-call burst doesn't N+1 the
 *     exchange endpoint. Entries normally expire `CACHE_EXPIRY_SAFETY_MS`
 *     before their declared `expiresAt` so the bearer never 401s in
 *     transit.
 *   - When Paperclip is unreachable (auth breaker open) the cache is
 *     the ONLY thing keeping live MCP calls succeeding. Once entries
 *     age out, every subsequent MCP attempt cascades to 401 — a quiet
 *     cliff that operators only notice once the user-facing tool calls
 *     start failing.
 *   - Stale-grace flips the trade: while the breaker is open, the
 *     cache hands out entries past their normal safety margin and even
 *     past the declared expiresAt for up to `STALE_GRACE_MS`. If
 *     Paperclip is back in time, those tokens MAY be honoured (Paperclip
 *     re-validates per request anyway); if they 401, the caller sees
 *     the same outcome they'd see without stale-grace, but operators
 *     have a metric (`breaker_state="open_stale"`) that fires
 *     proactively as a "you're now riding stale tokens" signal.
 *   - Cap is 1h to bound the worst-case window where a revoked user can
 *     still operate. Operators on stricter compliance setups can lower
 *     it via `PAPERCLIP_AUTH_CACHE_STALE_GRACE_MS=0` to disable
 *     stale-serve entirely (back to the legacy hard-evict path).
 */
export const DEFAULT_AUTH_CACHE_STALE_GRACE_MS = 60 * 60 * 1000;
/**
 * Retry delay schedule mirrors paperclip-client.ts — 3 total attempts,
 * short backoffs to cover the common case of a paperclip restart that
 * takes ≤2s. 4xx responses (bad client secret, malformed id_token) are
 * caller bugs and never retried — see shouldRetryExchangeStatus().
 *
 * The base delays are augmented at runtime by a small randomised
 * jitter (see {@link PAPERCLIP_AUTH_RETRY_JITTER_MS}). Without jitter,
 * N concurrent exchanges that all fail at moment T re-attempt at
 * exactly T+500, then exactly T+2000 — stampeding the breaker
 * boundary as soon as it half-opens. Jitter spreads the herd.
 */
export const PAPERCLIP_AUTH_RETRY_DELAYS_MS: readonly number[] = [500, 1500];

/**
 * Range of randomised jitter ADDED to each retry delay. Min keeps
 * even single-caller retries from being too tight; max bounds the
 * worst-case retry latency at ~base + 250ms. Picked to be small
 * relative to the base delays (500/1500ms) so the user-perceived
 * "exchange took N seconds" stays predictable.
 */
export const PAPERCLIP_AUTH_RETRY_JITTER_MS = { min: 50, max: 250 } as const;

/**
 * Compute the jittered delay for a given retry attempt. Exposed for
 * tests + for the off-chance an operator wants to reuse the schedule
 * outside the auth client. Input outside [0, delays.length) is
 * clamped — the function never throws.
 *
 * Implementation pulls from `randomFn` (default `Math.random`) so
 * tests can pin the result without monkey-patching the global.
 */
export function computeJitteredAuthRetryDelay(
  attempt: number,
  randomFn: () => number = Math.random,
): number {
  const idx = Math.max(0, Math.min(attempt, PAPERCLIP_AUTH_RETRY_DELAYS_MS.length - 1));
  const base = PAPERCLIP_AUTH_RETRY_DELAYS_MS[idx]!;
  const span = PAPERCLIP_AUTH_RETRY_JITTER_MS.max - PAPERCLIP_AUTH_RETRY_JITTER_MS.min;
  const jitter =
    PAPERCLIP_AUTH_RETRY_JITTER_MS.min + Math.floor(randomFn() * (span + 1));
  return base + jitter;
}

/**
 * A 4xx response means the exchange payload itself is wrong — wrong
 * client secret, expired id_token, bad audience. Retrying won't fix
 * those; we fail fast. 5xx and network errors are the only retryable
 * conditions.
 */
function shouldRetryExchangeStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

export function resolvePaperclipAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): PaperclipAuthConfig | null {
  const exchangeUrl = env.PAPERCLIP_EXCHANGE_URL?.trim();
  const baseUrl = env.PAPERCLIP_BASE_URL?.trim();
  const clientSecret = env.OPENCLAW_EXCHANGE_CLIENT_SECRET?.trim();
  if (!exchangeUrl && !baseUrl) return null;
  return { baseUrl, exchangeUrl, clientSecret };
}

export function deriveExchangeUrl(cfg: PaperclipAuthConfig): string | null {
  if (cfg.exchangeUrl) return cfg.exchangeUrl;
  if (!cfg.baseUrl) return null;
  const trimmed = cfg.baseUrl.replace(/\/+$/, "");
  return `${trimmed}/api/auth/openclaw-exchange`;
}

interface CacheKey {
  userKey: string;
  companyId: string;
  scopesKey: string;
}

function cacheKeyString(k: CacheKey): string {
  return `${k.userKey}|${k.companyId}|${k.scopesKey}`;
}

/**
 * Cheap stable fingerprint of the id_token so cache keys don't store
 * the raw JWT. Uses a short base16 slice of a hex digest — collisions
 * are acceptable because each entry is scoped by (companyId, scopes)
 * and the cost of a cache miss is one HTTP call.
 */
function idTokenFingerprint(idToken: string): string {
  // Tiny FNV-1a 32-bit hash — no dependency cost, good enough for a
  // per-process in-memory key. We are NOT using this for security.
  let h = 0x811c9dc5;
  for (let i = 0; i < idToken.length; i++) {
    h ^= idToken.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function normalizeScopes(scopes: readonly string[] | undefined): string {
  if (!scopes || scopes.length === 0) return "*";
  return [...scopes].sort().join(",");
}

export interface PaperclipAuthClient {
  /**
   * Exchange a Logto id_token for a Paperclip bearer, consulting the
   * in-memory cache first. The cache is keyed by (id_token fingerprint,
   * companyId, scope set) — change any of these to force a fresh mint.
   */
  exchange(req: ExchangeRequest): Promise<ExchangeResult>;
  /** Clear the cache — operators call this after revoking a user. */
  clearCache(): void;
}

export function createPaperclipAuthClient(
  config?: PaperclipAuthConfig | null,
  deps: {
    logger?: Logger;
    fetchImpl?: typeof fetch;
    now?: () => number;
    /**
     * Optional circuit breaker — when supplied, `exchange()` checks
     * `circuit.allow()` before each attempt and fail-fasts during
     * cooldown. The bootstrap wires a `PAPERCLIP_AUTH`-prefixed breaker
     * so auth storms (Logto outage, bad shared secret) don't pin
     * connection pools. Leaving this unset disables the gate — legacy
     * behavior for callers that construct the client directly.
     */
    circuit?: PaperclipCircuit | null;
    /**
     * Override the stale-grace window. Read from
     * `PAPERCLIP_AUTH_CACHE_STALE_GRACE_MS` when unset; defaults to
     * `DEFAULT_AUTH_CACHE_STALE_GRACE_MS` (1h). Set to 0 to disable
     * stale-serve entirely (legacy hard-evict behavior). Tests pass
     * an explicit value to avoid env reads.
     */
    staleGraceMs?: number;
    /**
     * Test-only deterministic random source for the retry jitter
     * (see {@link computeJitteredAuthRetryDelay}). Production code
     * leaves this unset — falls through to Math.random, giving real
     * herd-spreading behaviour.
     */
    randomFn?: () => number;
  } = {},
): PaperclipAuthClient | null {
  const cfg = config ?? resolvePaperclipAuthConfig();
  if (!cfg) return null;
  const url: string | null = deriveExchangeUrl(cfg);
  if (!url) return null;
  // Capture the post-narrowing URL so the closure below keeps `string`
  // typing — TS widens back to `string | null` across function
  // boundaries otherwise.
  const targetUrl: string = url;
  if (!cfg.clientSecret) {
    deps.logger?.warn(
      "paperclip-auth: OPENCLAW_EXCHANGE_CLIENT_SECRET is unset — exchange calls will 401. " +
        "Either set the secret or clear PAPERCLIP_BASE_URL to disable the client.",
    );
  }
  const fetchFn = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  // Resolve the stale-grace window once at construction time. Reading
  // process.env on every cache lookup would let an operator hot-toggle
  // the value via `docker compose exec`, but the cost in startup
  // simplicity (and the surprise factor of "why is the bridge behaving
  // differently than env says?") is not worth it. Operator changes the
  // env, restarts paperclip+openclaw — same model as every other
  // bridge tunable.
  const staleGraceMs = (() => {
    if (typeof deps.staleGraceMs === "number" && deps.staleGraceMs >= 0) {
      return deps.staleGraceMs;
    }
    const raw = Number(process.env.PAPERCLIP_AUTH_CACHE_STALE_GRACE_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_AUTH_CACHE_STALE_GRACE_MS;
  })();

  const cache = new Map<string, ExchangeResult>();

  /**
   * Cache lookup with optional stale-grace.
   *
   * Returns one of:
   *   - `{ entry, freshness: "fresh" }` when the entry is comfortably
   *     within its safety window — normal hot path.
   *   - `{ entry, freshness: "stale" }` when the entry is past safety
   *     (or even past expiresAt by ≤ staleGraceMs) AND the breaker is
   *     open. The caller renders the synthetic `breaker_state="open_stale"`
   *     metric label so operators see they're now riding likely-revoked
   *     tokens.
   *   - `null` when the entry is too old to serve (past stale grace
   *     OR safety-window-stale with a closed breaker). The entry is
   *     evicted from the cache so the next call mints fresh.
   */
  /**
   * Cache-miss reason returned by {@link getCached} — kept structurally
   * narrow (vs. recording metrics here) so the breaker-open path in
   * {@link exchangeImpl} can override the label. We want exactly ONE
   * reason recorded per miss, otherwise hit-rate
   * (`hits / (hits + sum(misses))`) double-counts.
   */
  type CacheMissReason = "first_request" | "stale_expired";

  function getCached(
    key: CacheKey,
  ):
    | { hit: true; entry: ExchangeResult; freshness: "fresh" | "stale" }
    | { hit: false; missReason: CacheMissReason } {
    const entry = cache.get(cacheKeyString(key));
    if (!entry) {
      // First-time-seen miss for this (id_token, company, scopes).
      return { hit: false, missReason: "first_request" };
    }
    const expiresMs = entry.expiresAt.getTime();
    const tNow = now();
    // Fresh: normal expiry check with safety margin.
    if (expiresMs - tNow > CACHE_EXPIRY_SAFETY_MS) {
      return { hit: true, entry, freshness: "fresh" };
    }
    // Past safety window. If the breaker is open AND we are within the
    // stale-grace window past the actual expiresAt, hand it out anyway —
    // the bridge needs SOMETHING to send to Paperclip and we'll discover
    // soon enough whether the token still works. The grace is measured
    // from the declared expiresAt (not from the safety boundary) so a
    // "1h grace" really means "1h past the API's declared expiry."
    const breakerOpen = deps.circuit?.snapshot().state === "open";
    if (breakerOpen && staleGraceMs > 0 && tNow - expiresMs <= staleGraceMs) {
      return { hit: true, entry, freshness: "stale" };
    }
    // Otherwise: too old to serve — evict and miss. Distinct from
    // `first_request` because operators alerting on a dropping
    // hit-rate need to disambiguate "tokens are short-lived"
    // (stale_expired) from "many new tuples" (first_request).
    cache.delete(cacheKeyString(key));
    return { hit: false, missReason: "stale_expired" };
  }

  async function exchange(req: ExchangeRequest): Promise<ExchangeResult> {
    return withBridgeSpan(
      "openclaw.paperclip.exchange",
      {
        "bridge.direction": "exchange",
        "bridge.company_id": req.companyId,
        "http.url": targetUrl,
        "peer.service": "paperclip",
      },
      async () => {
        const startedAt = Date.now();
        const metrics = getActivePaperclipMetrics();
        try {
          const result = await exchangeImpl(req);
          metrics?.recordRequest("exchange", "ok");
          metrics?.recordLatency("exchange", Date.now() - startedAt);
          return result;
        } catch (err) {
          // Categorize the failure so operator dashboards can plot
          // "401 spike" (bad secret) separately from "503 spike"
          // (paperclip down) separately from timeouts.
          const latencyMs = Date.now() - startedAt;
          let errorCategory = "unknown";
          let outcome: "error" | "timeout" = "error";
          if (err instanceof PaperclipAuthError && typeof err.status === "number") {
            errorCategory = `http_${err.status}`;
          } else if (err instanceof Error && err.name === "AbortError") {
            errorCategory = "network";
            outcome = "timeout";
          } else {
            errorCategory = "network";
          }
          metrics?.recordRequest("exchange", outcome, errorCategory);
          metrics?.recordLatency("exchange", latencyMs);
          throw err;
        }
      },
    );
  }

  async function exchangeImpl(req: ExchangeRequest): Promise<ExchangeResult> {
    const key: CacheKey = {
      userKey: idTokenFingerprint(req.idToken),
      companyId: req.companyId,
      scopesKey: normalizeScopes(req.scopes),
    };
    const cached = getCached(key);
    if (cached.hit) {
      // Record the cache hit labelled by the effective breaker state at
      // the time of the hit. Three real states (closed/half_open/open)
      // are the breaker's snapshot; the synthetic "open_stale" tells
      // operators we served an entry past its normal safety window —
      // a louder cliff-edge signal than a plain open-state hit.
      const metrics = getActivePaperclipMetrics();
      const breakerState = deps.circuit?.snapshot().state ?? "closed";
      const label =
        cached.freshness === "stale" ? "open_stale" : breakerState;
      metrics?.recordAuthCacheHit(label);
      // Log on each non-healthy hit. The warn-level state-transition log
      // in the breaker itself covers closed→open already; here we
      // mirror the key fact into the cache path so a log-only operator
      // sees what tokens the bridge is actually using during an outage.
      // Stale hits get warn (operator action recommended) instead of
      // info because the affected tokens may already be revoked.
      if (label === "open_stale") {
        deps.logger?.warn(
          `paperclip-auth: SERVING STALE token (breaker=open, past expiresAt by ` +
            `${Math.max(0, now() - cached.entry.expiresAt.getTime())}ms) — ` +
            `MCP calls may 401 if the token was revoked. Restore Paperclip access ASAP.`,
        );
      } else if (breakerState !== "closed") {
        deps.logger?.info?.(
          `paperclip-auth: cache hit while breaker=${breakerState} — tool calls are running on cached tokens`,
        );
      }
      return cached.entry;
    }

    // Fail-fast when the auth breaker is open. Cached hits above are
    // always served — the cache shortens Paperclip round-trips and a
    // recent success is as strong a health signal as the circuit itself.
    //
    // Why the info-log here: operators debugging "MCP tool calls are
    // failing with 401" land on this throw and don't always realize
    // that a stale-cache entry MAY have served the next caller — the
    // failure looks total. The hint "an immediately-retried call may
    // succeed via stale-grace" surfaces the cliff-edge behavior so
    // operators don't burn time on the wrong hypothesis. Logged once
    // per cache miss (roughly once per (user, scopes) per breaker
    // window) so the log isn't flooded.
    if (deps.circuit && !deps.circuit.allow()) {
      // breaker_open is the dominant signal — overrides the underlying
      // miss reason (first_request / stale_expired) since the operator
      // action is "fix Paperclip" regardless of which kind of miss it
      // would otherwise have been. Mutually exclusive with the
      // post-mint reason recorded below so hit-rate sums cleanly.
      getActivePaperclipMetrics()?.recordAuthCacheMiss("breaker_open");
      deps.logger?.info?.(
        `paperclip-auth: breaker open, no fresh cache entry for this (user,scopes) — ` +
          `failing fast. If a recent exchange for the SAME (user,scopes) succeeded, an ` +
          `immediately-retried call may serve a stale token (see PAPERCLIP_AUTH_CACHE_STALE_GRACE_MS).`,
      );
      throw new PaperclipAuthError(
        "Paperclip auth circuit open — not exchanging id_token",
      );
    }

    // Past the breaker gate — about to mint. Record the underlying
    // miss reason so operators can chart hit-rate over time and see
    // whether dropping hit-rate is driven by churning new tuples
    // (`first_request`) or by short-lived tokens
    // (`stale_expired`).
    getActivePaperclipMetrics()?.recordAuthCacheMiss(cached.missReason);

    const body = JSON.stringify({
      idToken: req.idToken,
      companyId: req.companyId,
      ...(req.scopes ? { scopes: req.scopes } : {}),
      ...(req.ttlSeconds ? { ttlSeconds: req.ttlSeconds } : {}),
    });
    const traceparent = resolveTraceparent(req.traceparent);
    const headers = {
      "Content-Type": "application/json",
      traceparent,
      ...(cfg!.clientSecret ? { Authorization: `Bearer ${cfg!.clientSecret}` } : {}),
    };

    // Symmetric retry pattern to paperclip-client.ts. Rationale: a
    // token-exchange failure aborts the entire Paperclip-tool call a
    // user is waiting on, so absorbing a ≤2s paperclip restart blip
    // here saves the operator a manual re-run. 4xx responses and
    // caller-aborted requests break out immediately.
    const maxAttempts = 1 + PAPERCLIP_AUTH_RETRY_DELAYS_MS.length;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_EXCHANGE_TIMEOUT_MS);
      try {
        const res = await fetchFn(targetUrl, {
          method: "POST",
          signal: controller.signal,
          headers,
          body,
        });
        clearTimeout(timer);

        if (res.ok) {
          const parsed = (await res.json()) as {
            token: string;
            expiresAt: string;
            userId: string;
            scopes: string[];
          };
          const result: ExchangeResult = {
            token: parsed.token,
            expiresAt: new Date(parsed.expiresAt),
            userId: parsed.userId,
            scopes: Array.isArray(parsed.scopes) ? parsed.scopes : [],
          };
          cache.set(cacheKeyString(key), result);
          // Success closes the breaker. Resetting on every 200 keeps a
          // healthy pair from flapping into open state because of a
          // handful of transient 5xx earlier.
          deps.circuit?.recordSuccess();
          return result;
        }

        const text = await res.text().catch(() => "");
        if (shouldRetryExchangeStatus(res.status) && attempt < PAPERCLIP_AUTH_RETRY_DELAYS_MS.length) {
          const wait = computeJitteredAuthRetryDelay(attempt, deps.randomFn);
          deps.logger?.warn(
            `paperclip-auth: exchange failed status=${res.status} attempt=${attempt + 1} — retrying in ${wait}ms`,
          );
          await new Promise((r) => setTimeout(r, wait));
          lastErr = new PaperclipAuthError(
            `Paperclip exchange failed (HTTP ${res.status}): ${text}`,
            res.status,
          );
          continue;
        }
        // 4xx — caller bug (bad client secret, bad id_token). These
        // do NOT trip the breaker because they are deterministic failures
        // of THIS request, not evidence of a downstream problem that
        // other requests would also hit. Match the policy on the
        // outbound client.
        if (res.status < 500) {
          throw new PaperclipAuthError(
            `Paperclip exchange failed (HTTP ${res.status}): ${text}`,
            res.status,
          );
        }
        // 5xx after retries exhausted — count as a breaker failure.
        deps.circuit?.recordFailure(`http_${res.status}`);
        throw new PaperclipAuthError(
          `Paperclip exchange failed (HTTP ${res.status}): ${text}`,
          res.status,
        );
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof PaperclipAuthError) {
          // 5xx that is NOT retryable anymore (attempts exhausted) OR
          // 4xx (already not retryable at the check above) — surface
          // to the caller without wrapping. Circuit accounting already
          // happened at the throw site above.
          throw err;
        }
        // Network/abort error. Retry if we have budget left.
        if (attempt < PAPERCLIP_AUTH_RETRY_DELAYS_MS.length) {
          const wait = computeJitteredAuthRetryDelay(attempt, deps.randomFn);
          deps.logger?.warn(
            `paperclip-auth: exchange network error attempt=${attempt + 1} — retrying in ${wait}ms: ${String(err)}`,
          );
          await new Promise((r) => setTimeout(r, wait));
          lastErr = err;
          continue;
        }
        // Retries exhausted on a network error — count as a breaker
        // failure. AbortErrors and fetch TypeErrors both flow here.
        deps.circuit?.recordFailure(
          err instanceof Error && err.name === "AbortError" ? "timeout" : "network",
        );
        throw new PaperclipAuthError(
          `Paperclip exchange network error: ${String(err)}`,
        );
      }
    }
    // Loop exited without returning/throwing — retries exhausted on
    // retryable HTTP status. Surface the last PaperclipAuthError and
    // record the failure against the breaker if we haven't already.
    if (lastErr instanceof PaperclipAuthError) {
      if (typeof lastErr.status === "number" && lastErr.status >= 500) {
        deps.circuit?.recordFailure(`http_${lastErr.status}`);
      }
      throw lastErr;
    }
    deps.circuit?.recordFailure("unknown");
    throw new PaperclipAuthError(
      `Paperclip exchange failed after ${maxAttempts} attempts: ${String(lastErr)}`,
    );
  }

  function clearCache(): void {
    cache.clear();
  }

  return { exchange, clearCache };
}
