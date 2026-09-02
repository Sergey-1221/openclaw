import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CACHE_EXPIRY_SAFETY_MS,
  PaperclipAuthError,
  createPaperclipAuthClient,
  deriveExchangeUrl,
  resolvePaperclipAuthConfig,
} from "./paperclip-auth.js";
import {
  createPaperclipMetrics,
  setActivePaperclipMetrics,
} from "./paperclip-metrics.js";
import type { CircuitSnapshot } from "./paperclip-circuit.js";

describe("resolvePaperclipAuthConfig", () => {
  it("returns null when neither base nor exchange URL is set", () => {
    expect(resolvePaperclipAuthConfig({})).toBeNull();
  });

  it("parses all three env vars", () => {
    expect(
      resolvePaperclipAuthConfig({
        PAPERCLIP_BASE_URL: "http://paperclip:3100",
        OPENCLAW_EXCHANGE_CLIENT_SECRET: "csec",
      }),
    ).toEqual({
      baseUrl: "http://paperclip:3100",
      exchangeUrl: undefined,
      clientSecret: "csec",
    });
  });
});

describe("deriveExchangeUrl", () => {
  it("honors explicit override", () => {
    expect(deriveExchangeUrl({ exchangeUrl: "https://custom/x" })).toBe("https://custom/x");
  });
  it("derives from base URL", () => {
    expect(deriveExchangeUrl({ baseUrl: "http://paperclip:3100/" })).toBe(
      "http://paperclip:3100/api/auth/openclaw-exchange",
    );
  });
  it("returns null when nothing is set", () => {
    expect(deriveExchangeUrl({})).toBeNull();
  });
});

function okResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("createPaperclipAuthClient", () => {
  let fetchImpl: ReturnType<typeof vi.fn>;
  let nowValue: number;

  beforeEach(() => {
    fetchImpl = vi.fn();
    nowValue = 1_700_000_000_000;
  });

  it("returns null when no base URL is configured", () => {
    expect(createPaperclipAuthClient(null)).toBeNull();
  });

  it("posts to the exchange URL with the client secret and returns the token", async () => {
    fetchImpl.mockResolvedValue(
      okResponse({
        token: "pcp_tkn_123",
        expiresAt: new Date(nowValue + 3_600_000).toISOString(),
        userId: "logto:abc",
        scopes: ["channels:send"],
      }),
    );
    const client = createPaperclipAuthClient(
      { baseUrl: "http://paperclip:3100", clientSecret: "csec" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => nowValue },
    );
    expect(client).not.toBeNull();

    const res = await client!.exchange({
      idToken: "eyJ.fake.jwt",
      companyId: "c-1",
      scopes: ["channels:send"],
    });
    expect(res.token).toBe("pcp_tkn_123");
    expect(res.userId).toBe("logto:abc");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://paperclip:3100/api/auth/openclaw-exchange");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer csec");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      idToken: "eyJ.fake.jwt",
      companyId: "c-1",
      scopes: ["channels:send"],
    });
  });

  it("serves a second identical request from cache (one fetch)", async () => {
    fetchImpl.mockImplementation(async () =>
      okResponse({
        token: "t",
        expiresAt: new Date(nowValue + 3_600_000).toISOString(),
        userId: "u",
        scopes: ["s"],
      }),
    );
    const client = createPaperclipAuthClient(
      { baseUrl: "http://p", clientSecret: "cs" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => nowValue },
    )!;
    const a = await client.exchange({ idToken: "tok-1", companyId: "c", scopes: ["s"] });
    const b = await client.exchange({ idToken: "tok-1", companyId: "c", scopes: ["s"] });
    expect(a.token).toBe(b.token);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("evicts the cached token before its expiresAt (safety window)", async () => {
    fetchImpl.mockImplementation(async () =>
      okResponse({
        token: "t",
        expiresAt: new Date(nowValue + CACHE_EXPIRY_SAFETY_MS + 1_000).toISOString(),
        userId: "u",
        scopes: [],
      }),
    );
    const client = createPaperclipAuthClient(
      { baseUrl: "http://p" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => nowValue },
    )!;
    await client.exchange({ idToken: "x", companyId: "c" });
    // Advance close to expiry — should still be cached.
    nowValue += 500;
    await client.exchange({ idToken: "x", companyId: "c" });
    // Advance past the safety window — second fetch should fire.
    nowValue += CACHE_EXPIRY_SAFETY_MS;
    await client.exchange({ idToken: "x", companyId: "c" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws PaperclipAuthError with status on non-2xx", async () => {
    fetchImpl.mockResolvedValue(new Response("nope", { status: 401 }));
    const client = createPaperclipAuthClient(
      { baseUrl: "http://p", clientSecret: "cs" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )!;
    await expect(
      client.exchange({ idToken: "x", companyId: "c" }),
    ).rejects.toMatchObject({
      name: "PaperclipAuthError",
      status: 401,
    });
  });

  it("different scope sets get different cache entries", async () => {
    fetchImpl.mockImplementation(async () =>
      okResponse({
        token: "t",
        expiresAt: new Date(nowValue + 3_600_000).toISOString(),
        userId: "u",
        scopes: [],
      }),
    );
    const client = createPaperclipAuthClient(
      { baseUrl: "http://p" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => nowValue },
    )!;
    await client.exchange({ idToken: "x", companyId: "c", scopes: ["a"] });
    await client.exchange({ idToken: "x", companyId: "c", scopes: ["b"] });
    await client.exchange({ idToken: "x", companyId: "c", scopes: ["a"] });
    // Two distinct scope sets → two fetches; the third is a cache hit.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

// Pepper-rollout analogue on the Avelton-claw side: when a cache hit
// happens, we record the breaker state at the time of the hit. This is
// load-bearing — the "cache hit with open breaker" case is exactly the
// signal that precedes a cliff. Test coverage below exercises both
// directions (state propagation and counter increments).
describe("paperclip-auth cache-hit metrics", () => {
  function makeCircuit(state: CircuitSnapshot["state"]) {
    const snapshot: CircuitSnapshot = {
      state,
      consecutiveFailures: state === "closed" ? 0 : 3,
      openedAt: state === "open" ? new Date("2026-04-20T00:00:00Z") : null,
      lastReachableAt: state === "closed" ? new Date() : null,
      lastErrorAt: state === "open" ? new Date() : null,
      lastError: state === "open" ? { category: "http_5xx" } : null,
    };
    return {
      allow: () => state !== "open",
      recordSuccess: () => {},
      recordFailure: () => {},
      snapshot: () => snapshot,
    };
  }

  let nowValue = 1_700_000_000_000;
  const fetchImpl = vi.fn();

  beforeEach(() => {
    nowValue = 1_700_000_000_000;
    fetchImpl.mockReset();
    fetchImpl.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          token: "t",
          expiresAt: new Date(nowValue + 3_600_000).toISOString(),
          userId: "u",
          scopes: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  });

  afterEach(() => {
    setActivePaperclipMetrics(null);
  });

  it("records a closed-state cache hit on the second exchange", async () => {
    const metrics = createPaperclipMetrics();
    setActivePaperclipMetrics(metrics);
    const client = createPaperclipAuthClient(
      { baseUrl: "http://p" },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => nowValue,
        circuit: makeCircuit("closed") as never,
      },
    )!;
    await client.exchange({ idToken: "t", companyId: "c" });
    await client.exchange({ idToken: "t", companyId: "c" });
    const body = metrics.renderExposition();
    expect(body).toContain(
      'openclaw_paperclip_auth_cache_hits_total{breaker_state="closed"} 1',
    );
  });

  it("labels the hit with the breaker's current state (open)", async () => {
    const metrics = createPaperclipMetrics();
    setActivePaperclipMetrics(metrics);
    // First call populates the cache while the breaker is closed.
    const circuitAllow = { value: true };
    const circuit = {
      allow: () => circuitAllow.value,
      recordSuccess: () => {},
      recordFailure: () => {},
      snapshot: () => ({
        state: (circuitAllow.value ? "closed" : "open") as CircuitSnapshot["state"],
        consecutiveFailures: circuitAllow.value ? 0 : 5,
        openedAt: circuitAllow.value ? null : new Date(),
        lastReachableAt: null,
        lastErrorAt: null,
        lastError: null,
      }),
    };
    const client = createPaperclipAuthClient(
      { baseUrl: "http://p" },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => nowValue,
        circuit: circuit as never,
      },
    )!;
    await client.exchange({ idToken: "t", companyId: "c" });
    // Simulate the breaker tripping open *between* calls. The next call
    // finds the cached token and must log the open state — exactly the
    // signal operators need to see.
    circuitAllow.value = false;
    await client.exchange({ idToken: "t", companyId: "c" });
    const body = metrics.renderExposition();
    expect(body).toContain(
      'openclaw_paperclip_auth_cache_hits_total{breaker_state="open"} 1',
    );
  });
});

// Stale-grace: the cache normally evicts entries past their safety window.
// With the breaker OPEN that eviction is the cliff edge — every revoked
// or expired entry forces a fresh exchange call that fails fast on the
// open breaker, and MCP cascades to 401. Stale-grace flips the trade:
// while breaker=open we hand out entries even past their declared
// expiresAt for up to STALE_GRACE_MS, recording the synthetic
// `breaker_state="open_stale"` label so operators see the symptom
// before users start hitting 401s.
describe("paperclip-auth stale-grace under open breaker", () => {
  function makeMutableCircuit(initial: CircuitSnapshot["state"]) {
    let current = initial;
    return {
      setState(next: CircuitSnapshot["state"]) {
        current = next;
      },
      circuit: {
        allow: () => current !== "open",
        recordSuccess: () => {},
        recordFailure: () => {},
        snapshot: () => ({
          state: current,
          consecutiveFailures: current === "open" ? 5 : 0,
          openedAt: current === "open" ? new Date() : null,
          lastReachableAt: null,
          lastErrorAt: null,
          lastError: null,
        }),
      },
    };
  }

  let nowValue = 1_700_000_000_000;
  const fetchImpl = vi.fn();

  beforeEach(() => {
    nowValue = 1_700_000_000_000;
    fetchImpl.mockReset();
    fetchImpl.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          token: "t",
          // Token issued at t=now with 60s TTL — well within the
          // CACHE_EXPIRY_SAFETY_MS window. We then advance `nowValue`
          // in each test to step over the safety boundary.
          expiresAt: new Date(nowValue + 60_000).toISOString(),
          userId: "u",
          scopes: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  });

  afterEach(() => {
    setActivePaperclipMetrics(null);
  });

  it("with closed breaker, evicts past-safety entries and re-mints", async () => {
    const metrics = createPaperclipMetrics();
    setActivePaperclipMetrics(metrics);
    const { circuit } = makeMutableCircuit("closed");
    const client = createPaperclipAuthClient(
      { baseUrl: "http://p" },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => nowValue,
        circuit: circuit as never,
        // Generous grace value to prove it has no effect when breaker is
        // closed — the closed-breaker path must always evict and re-mint.
        staleGraceMs: 24 * 60 * 60 * 1000,
      },
    )!;
    await client.exchange({ idToken: "t", companyId: "c" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Step past the safety window (60s expiry, 60s safety → past at +1ms).
    nowValue += 60_001;
    await client.exchange({ idToken: "t", companyId: "c" });
    // Closed breaker means a fresh mint is required: the second call
    // hits the network, no stale-serve.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const body = metrics.renderExposition();
    expect(body).not.toMatch(/breaker_state="open_stale"/);
  });

  it("with open breaker, serves stale entries (past safety) under open_stale label", async () => {
    const metrics = createPaperclipMetrics();
    setActivePaperclipMetrics(metrics);
    const { setState, circuit } = makeMutableCircuit("closed");
    const client = createPaperclipAuthClient(
      { baseUrl: "http://p" },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => nowValue,
        circuit: circuit as never,
        staleGraceMs: 30 * 60 * 1000, // 30 min grace
      },
    )!;
    // 1) Populate cache while closed.
    await client.exchange({ idToken: "t", companyId: "c" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // 2) Trip the breaker, advance past the safety window. Without
    // stale-grace this would be an eviction + re-mint; with stale-grace
    // and breaker open it's a stale-serve.
    setState("open");
    nowValue += 60_001; // past safety window, still well within token TTL
    await client.exchange({ idToken: "t", companyId: "c" });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no fresh fetch
    const body = metrics.renderExposition();
    expect(body).toContain(
      'openclaw_paperclip_auth_cache_hits_total{breaker_state="open_stale"} 1',
    );
  });

  it("with open breaker, serves entries even past actual expiresAt (within grace)", async () => {
    const metrics = createPaperclipMetrics();
    setActivePaperclipMetrics(metrics);
    const { setState, circuit } = makeMutableCircuit("closed");
    const client = createPaperclipAuthClient(
      { baseUrl: "http://p" },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => nowValue,
        circuit: circuit as never,
        staleGraceMs: 60 * 60 * 1000, // 1h grace
      },
    )!;
    await client.exchange({ idToken: "t", companyId: "c" });
    setState("open");
    // Advance past the token's actual expiresAt (60s TTL) but well
    // within the 1h stale grace. This is the "desperate-last-resort"
    // path documented in DEFAULT_AUTH_CACHE_STALE_GRACE_MS — Paperclip
    // may 401 the eventual MCP call, but operators are alerted via
    // the open_stale counter long before that happens.
    nowValue += 5 * 60_000; // +5min, token expired 4min ago
    await client.exchange({ idToken: "t", companyId: "c" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = metrics.renderExposition();
    expect(body).toContain(
      'openclaw_paperclip_auth_cache_hits_total{breaker_state="open_stale"} 1',
    );
  });

  it("with open breaker beyond stale grace, evicts (cliff edge)", async () => {
    const metrics = createPaperclipMetrics();
    setActivePaperclipMetrics(metrics);
    const { setState, circuit } = makeMutableCircuit("closed");
    const client = createPaperclipAuthClient(
      { baseUrl: "http://p" },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => nowValue,
        circuit: circuit as never,
        staleGraceMs: 60 * 1000, // 1min grace — easy to step over
      },
    )!;
    await client.exchange({ idToken: "t", companyId: "c" });
    setState("open");
    // Advance well past expiresAt + grace. Stale-grace expired; the
    // entry must be evicted and the next exchange attempt will
    // fail-fast on the open breaker (no fetch, throws).
    nowValue += 60_000 + 60_000 + 1; // expiresAt + grace + 1ms
    await expect(
      client.exchange({ idToken: "t", companyId: "c" }),
    ).rejects.toThrow(/circuit open/);
    // No additional fetch attempt was made — breaker prevented it.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = metrics.renderExposition();
    // No open_stale increment because stale-grace had already expired.
    expect(body).not.toMatch(/breaker_state="open_stale"/);
  });

  it("with staleGraceMs=0 (operator-disabled), behaves as legacy hard-evict", async () => {
    const metrics = createPaperclipMetrics();
    setActivePaperclipMetrics(metrics);
    const { setState, circuit } = makeMutableCircuit("closed");
    const client = createPaperclipAuthClient(
      { baseUrl: "http://p" },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => nowValue,
        circuit: circuit as never,
        staleGraceMs: 0, // operator opt-out
      },
    )!;
    await client.exchange({ idToken: "t", companyId: "c" });
    setState("open");
    nowValue += 60_001;
    // No stale-grace → eviction → breaker open → fail-fast. Same as
    // pre-stale-grace behavior.
    await expect(
      client.exchange({ idToken: "t", companyId: "c" }),
    ).rejects.toThrow(/circuit open/);
    const body = metrics.renderExposition();
    expect(body).not.toMatch(/breaker_state="open_stale"/);
  });
});

// -----------------------------------------------------------------------
// Cache-miss counter (T5, 2026-04-25). Pairs with the existing hit
// counter so operators can chart hit-rate. Each miss records EXACTLY
// ONE reason — first_request / stale_expired / breaker_open — so
// summing the miss series doesn't double-count.
// -----------------------------------------------------------------------
describe("paperclip-auth cache-miss metrics", () => {
  let nowValue = 1_700_000_000_000;
  const fetchImpl = vi.fn();

  beforeEach(() => {
    nowValue = 1_700_000_000_000;
    fetchImpl.mockReset();
  });

  afterEach(() => {
    setActivePaperclipMetrics(null);
  });

  function okFn(ttlMs = 3_600_000) {
    return async () =>
      new Response(
        JSON.stringify({
          token: "t",
          expiresAt: new Date(nowValue + ttlMs).toISOString(),
          userId: "u",
          scopes: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
  }

  it("first uncached call counts as first_request", async () => {
    const metrics = createPaperclipMetrics();
    setActivePaperclipMetrics(metrics);
    fetchImpl.mockImplementation(okFn());
    const client = createPaperclipAuthClient(
      { baseUrl: "http://p" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => nowValue },
    )!;
    await client.exchange({ idToken: "t", companyId: "c" });
    expect(metrics.renderExposition()).toContain(
      'openclaw_paperclip_auth_cache_misses_total{reason="first_request"} 1',
    );
  });

  it("safety-window eviction counts as stale_expired", async () => {
    const metrics = createPaperclipMetrics();
    setActivePaperclipMetrics(metrics);
    fetchImpl.mockImplementation(okFn(CACHE_EXPIRY_SAFETY_MS + 1_000));
    const client = createPaperclipAuthClient(
      { baseUrl: "http://p" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => nowValue },
    )!;
    // First call mints (first_request). Second after safety expires
    // re-mints (stale_expired).
    await client.exchange({ idToken: "t", companyId: "c" });
    nowValue += CACHE_EXPIRY_SAFETY_MS + 500;
    await client.exchange({ idToken: "t", companyId: "c" });
    const body = metrics.renderExposition();
    expect(body).toContain(
      'openclaw_paperclip_auth_cache_misses_total{reason="first_request"} 1',
    );
    expect(body).toContain(
      'openclaw_paperclip_auth_cache_misses_total{reason="stale_expired"} 1',
    );
  });

  it("breaker_open counts when the breaker fail-fasts a miss", async () => {
    const metrics = createPaperclipMetrics();
    setActivePaperclipMetrics(metrics);
    const circuit = {
      allow: () => false, // always denied
      recordSuccess: () => {},
      recordFailure: () => {},
      snapshot: () => ({
        state: "open" as CircuitSnapshot["state"],
        consecutiveFailures: 5,
        openedAt: new Date(),
        lastReachableAt: null,
        lastErrorAt: new Date(),
        lastError: null,
      }),
    };
    const client = createPaperclipAuthClient(
      { baseUrl: "http://p" },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => nowValue,
        circuit: circuit as never,
      },
    )!;
    await expect(
      client.exchange({ idToken: "t", companyId: "c" }),
    ).rejects.toThrow(/circuit open/);
    const body = metrics.renderExposition();
    expect(body).toContain(
      'openclaw_paperclip_auth_cache_misses_total{reason="breaker_open"} 1',
    );
    // breaker_open is mutually exclusive with first_request — we did
    // not double-count the underlying empty-cache miss.
    expect(body).not.toContain(
      'openclaw_paperclip_auth_cache_misses_total{reason="first_request"}',
    );
  });
});

// -----------------------------------------------------------------------
// Retry jitter (T5, 2026-04-25). N concurrent failed exchanges
// re-attempting at exactly the same moment stampede the breaker
// boundary; jitter spreads them. The exposed pure function makes the
// schedule deterministic in tests via the random source override.
// -----------------------------------------------------------------------
import {
  PAPERCLIP_AUTH_RETRY_DELAYS_MS,
  PAPERCLIP_AUTH_RETRY_JITTER_MS,
  computeJitteredAuthRetryDelay,
} from "./paperclip-auth.js";

describe("computeJitteredAuthRetryDelay", () => {
  it("adds the minimum jitter when randomFn returns 0", () => {
    expect(computeJitteredAuthRetryDelay(0, () => 0)).toBe(
      PAPERCLIP_AUTH_RETRY_DELAYS_MS[0]! + PAPERCLIP_AUTH_RETRY_JITTER_MS.min,
    );
    expect(computeJitteredAuthRetryDelay(1, () => 0)).toBe(
      PAPERCLIP_AUTH_RETRY_DELAYS_MS[1]! + PAPERCLIP_AUTH_RETRY_JITTER_MS.min,
    );
  });

  it("adds the maximum jitter when randomFn returns ~1", () => {
    // Math.floor(0.999 * (max-min+1)) + min = max
    expect(computeJitteredAuthRetryDelay(0, () => 0.999999)).toBe(
      PAPERCLIP_AUTH_RETRY_DELAYS_MS[0]! + PAPERCLIP_AUTH_RETRY_JITTER_MS.max,
    );
  });

  it("clamps out-of-range attempt indices defensively", () => {
    const last = PAPERCLIP_AUTH_RETRY_DELAYS_MS.length - 1;
    expect(computeJitteredAuthRetryDelay(99, () => 0)).toBe(
      PAPERCLIP_AUTH_RETRY_DELAYS_MS[last]! + PAPERCLIP_AUTH_RETRY_JITTER_MS.min,
    );
    expect(computeJitteredAuthRetryDelay(-5, () => 0)).toBe(
      PAPERCLIP_AUTH_RETRY_DELAYS_MS[0]! + PAPERCLIP_AUTH_RETRY_JITTER_MS.min,
    );
  });

  it("Math.random default (no override) stays inside the documented band", () => {
    // Sample 50 calls with the real RNG; every one should land in
    // [base+min, base+max]. The rare-but-possible edge of randomFn=1
    // is excluded by Math.random's [0, 1) range.
    for (let i = 0; i < 50; i++) {
      const v = computeJitteredAuthRetryDelay(0);
      const lo = PAPERCLIP_AUTH_RETRY_DELAYS_MS[0]! + PAPERCLIP_AUTH_RETRY_JITTER_MS.min;
      const hi = PAPERCLIP_AUTH_RETRY_DELAYS_MS[0]! + PAPERCLIP_AUTH_RETRY_JITTER_MS.max;
      expect(v).toBeGreaterThanOrEqual(lo);
      expect(v).toBeLessThanOrEqual(hi);
    }
  });
});
