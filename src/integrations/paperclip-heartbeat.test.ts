import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_INTERVAL_MS,
  createPaperclipHeartbeat,
  deriveHeartbeatProbeUrl,
  resolvePaperclipHeartbeatConfig,
  resolvePaperclipHeartbeatConfigWithReason,
} from "./paperclip-heartbeat.js";

describe("resolvePaperclipHeartbeatConfig", () => {
  it("returns null when base URL is missing", () => {
    expect(resolvePaperclipHeartbeatConfig({ PAPERCLIP_AGENT_API_KEY: "k" })).toBeNull();
  });

  it("returns null when agent key is missing", () => {
    expect(resolvePaperclipHeartbeatConfig({ PAPERCLIP_BASE_URL: "x" })).toBeNull();
  });

  it("picks up both env vars and interval override", () => {
    const cfg = resolvePaperclipHeartbeatConfig({
      PAPERCLIP_BASE_URL: "http://paperclip:3100",
      PAPERCLIP_AGENT_API_KEY: "pcp_abc",
      PAPERCLIP_HEARTBEAT_INTERVAL_MS: "12345",
    });
    expect(cfg).toEqual({
      baseUrl: "http://paperclip:3100",
      apiKey: "pcp_abc",
      probeUrl: undefined,
      intervalMs: 12345,
    });
  });
});

describe("deriveHeartbeatProbeUrl", () => {
  it("honors explicit probe override", () => {
    expect(deriveHeartbeatProbeUrl({ probeUrl: "https://custom/ping", apiKey: "k" })).toBe(
      "https://custom/ping",
    );
  });

  it("derives /api/companies from baseUrl", () => {
    expect(deriveHeartbeatProbeUrl({ baseUrl: "http://paperclip:3100/", apiKey: "k" })).toBe(
      "http://paperclip:3100/api/companies",
    );
  });

  it("returns null when nothing resolvable", () => {
    expect(deriveHeartbeatProbeUrl({ apiKey: "k" })).toBeNull();
  });
});

describe("createPaperclipHeartbeat", () => {
  it("returns null when config is unavailable", () => {
    expect(createPaperclipHeartbeat(null)).toBeNull();
    expect(createPaperclipHeartbeat({ baseUrl: "x" })).toBeNull(); // no apiKey
  });

  it("tick() performs an authenticated GET and returns ok=true on 200", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    });
    const hb = createPaperclipHeartbeat(
      { baseUrl: "http://paperclip:3100", apiKey: "pcp_xyz" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(hb).not.toBeNull();
    const res = await hb!.tick();
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://paperclip:3100/api/companies");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer pcp_xyz" });
  });

  it("tick() returns ok=false on 401 and logs", async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn(async () => new Response("", { status: 401 }));
    const hb = createPaperclipHeartbeat(
      { baseUrl: "http://paperclip:3100", apiKey: "stale" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, logger: { warn } },
    );
    const res = await hb!.tick();
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(warn).toHaveBeenCalled();
  });

  it("tick() returns ok=false on network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const hb = createPaperclipHeartbeat(
      { baseUrl: "http://paperclip:3100", apiKey: "k" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, logger: { warn: vi.fn() } },
    );
    const res = await hb!.tick();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("ECONNREFUSED");
  });

  it("start() fires one immediate tick and schedules the next via setTimeout", async () => {
    const fetchImpl = vi.fn(async () => new Response("[]", { status: 200 }));
    const scheduled: Array<{ fn: () => void; delay: number }> = [];
    const setTimeoutImpl = ((fn: () => void, delay: number) => {
      scheduled.push({ fn, delay });
      return { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const clearTimeoutImpl = vi.fn();
    const hb = createPaperclipHeartbeat(
      { baseUrl: "http://paperclip:3100", apiKey: "k", intervalMs: 12345 },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        setTimeoutImpl,
        clearTimeoutImpl: clearTimeoutImpl as unknown as typeof clearTimeout,
        // Pin jitter midpoint so the exact-value assertion below
        // remains stable. See the dedicated jitter test for the
        // ±20% range coverage.
        randomFn: () => 0.5,
      },
    );
    hb!.start();
    // Immediate tick kicks off a fetch asynchronously; wait for it so
    // the post-tick scheduleNext call has fired.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(fetchImpl).toHaveBeenCalledOnce();
    // After a successful immediate tick we schedule the next at base
    // interval (no backoff) — scheduled[0].delay must be 12345.
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delay).toBe(12345);

    // Calling start() again is a no-op (timer already active).
    hb!.start();
    expect(scheduled).toHaveLength(1);

    hb!.stop();
    expect(clearTimeoutImpl).toHaveBeenCalledOnce();
    hb!.stop(); // idempotent
  });

  it("applies exponential backoff after consecutive failures", async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt++;
      return new Response("", { status: 503 });
    });
    const scheduled: Array<{ fn: () => void; delay: number }> = [];
    const setTimeoutImpl = ((fn: () => void, delay: number) => {
      scheduled.push({ fn, delay });
      return { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const baseIntervalMs = 1_000;
    const hb = createPaperclipHeartbeat(
      { baseUrl: "http://paperclip:3100", apiKey: "k", intervalMs: baseIntervalMs },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        setTimeoutImpl,
        clearTimeoutImpl: (() => {}) as unknown as typeof clearTimeout,
        logger: { warn: vi.fn() },
        // Pin the jitter to the band midpoint (0.5 → 1.0× multiplier)
        // so this test keeps asserting exact delay values. The
        // jitter behaviour itself is exercised by a dedicated test
        // below. Without the pin, `delay === 2_000` would flake by
        // ±20% across runs.
        randomFn: () => 0.5,
      },
    );
    hb!.start();
    // First (immediate) tick — records failure #1, schedules next at
    // base * 2 = 2_000ms.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(attempt).toBe(1);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delay).toBe(2_000);

    // Fire the scheduled tick → failure #2, next at base * 4.
    await scheduled[0]!.fn();
    await new Promise((r) => setImmediate(r));
    expect(attempt).toBe(2);
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1]!.delay).toBe(4_000);

    // Fire → failure #3, next at base * 8 = 8_000ms (still under cap).
    await scheduled[1]!.fn();
    await new Promise((r) => setImmediate(r));
    expect(attempt).toBe(3);
    expect(scheduled).toHaveLength(3);
    expect(scheduled[2]!.delay).toBe(8_000);

    hb!.stop();
  });

  it("caps backoff at HEARTBEAT_MAX_INTERVAL_MS and resets on success", async () => {
    // Seed a series of failures that would exceed the 5min cap, then a
    // success that must reset the interval to base.
    let attempt = 0;
    let succeed = false;
    const fetchImpl = vi.fn(async () => {
      attempt++;
      return succeed
        ? new Response("[]", { status: 200 })
        : new Response("", { status: 503 });
    });
    const scheduled: Array<{ fn: () => void; delay: number }> = [];
    const setTimeoutImpl = ((fn: () => void, delay: number) => {
      scheduled.push({ fn, delay });
      return { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    // Base large enough that 2^10 * base >> HEARTBEAT_MAX_INTERVAL_MS.
    const baseIntervalMs = 1_000;
    const hb = createPaperclipHeartbeat(
      { baseUrl: "http://paperclip:3100", apiKey: "k", intervalMs: baseIntervalMs },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        setTimeoutImpl,
        clearTimeoutImpl: (() => {}) as unknown as typeof clearTimeout,
        logger: { warn: vi.fn() },
        // Pin the jitter to the band midpoint (0.5 → 1.0× multiplier)
        // so this test keeps asserting exact delay values. The
        // jitter behaviour itself is exercised by a dedicated test
        // below. Without the pin, `delay === 2_000` would flake by
        // ±20% across runs.
        randomFn: () => 0.5,
      },
    );
    hb!.start();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // Run 15 failures — 2^15 × 1s far exceeds 5m, so later scheduled
    // delays must saturate at HEARTBEAT_MAX_INTERVAL_MS.
    for (let i = 0; i < 15; i++) {
      await scheduled[scheduled.length - 1]!.fn();
      await new Promise((r) => setImmediate(r));
    }
    const lastBeforeSuccess = scheduled[scheduled.length - 1]!.delay;
    expect(lastBeforeSuccess).toBe(HEARTBEAT_MAX_INTERVAL_MS);

    // Flip to success; next scheduled delay must reset to base.
    succeed = true;
    await scheduled[scheduled.length - 1]!.fn();
    await new Promise((r) => setImmediate(r));
    const lastAfterSuccess = scheduled[scheduled.length - 1]!.delay;
    expect(lastAfterSuccess).toBe(baseIntervalMs);

    hb!.stop();
  });

  // The jitter prevents thundering-herd recovery: without it, N
  // gateways restarting together compute identical backoff curves
  // and all probe Paperclip at the same wall-clock instant. The
  // tests below pin the ±20% band so a future refactor that drops
  // jitter (or widens it past sane bounds) fails immediately.
  it("applies ±20% jitter to scheduled delays — minimum at random=0", async () => {
    const fetchImpl = vi.fn(async () => new Response("[]", { status: 200 }));
    const scheduled: Array<{ fn: () => void; delay: number }> = [];
    const setTimeoutImpl = ((fn: () => void, delay: number) => {
      scheduled.push({ fn, delay });
      return { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const hb = createPaperclipHeartbeat(
      { baseUrl: "http://paperclip:3100", apiKey: "k", intervalMs: 10_000 },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        setTimeoutImpl,
        clearTimeoutImpl: (() => {}) as unknown as typeof clearTimeout,
        // random=0 → multiplier=0.8 → 10s base × 0.8 = 8_000ms
        randomFn: () => 0,
      },
    );
    hb!.start();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(scheduled[0]!.delay).toBe(8_000);
    hb!.stop();
  });

  it("applies ±20% jitter — maximum at random=1", async () => {
    const fetchImpl = vi.fn(async () => new Response("[]", { status: 200 }));
    const scheduled: Array<{ fn: () => void; delay: number }> = [];
    const setTimeoutImpl = ((fn: () => void, delay: number) => {
      scheduled.push({ fn, delay });
      return { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const hb = createPaperclipHeartbeat(
      { baseUrl: "http://paperclip:3100", apiKey: "k", intervalMs: 10_000 },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        setTimeoutImpl,
        clearTimeoutImpl: (() => {}) as unknown as typeof clearTimeout,
        // random=1 → multiplier=1.2 → 10s base × 1.2 = 12_000ms.
        // Floating-point gives 12000.0000000000018 — toBeCloseTo
        // matches at 0.001ms tolerance which is well below
        // setTimeout's actual resolution.
        randomFn: () => 1,
      },
    );
    hb!.start();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(scheduled[0]!.delay).toBeCloseTo(12_000, 3);
    hb!.stop();
  });

  // T3 #20: stop() must short-circuit a tick that's mid-await. Without
  // the post-await `if (stopped) return;` guard, a SIGTERM landing
  // between setTimeout firing and tick() resolving would still mutate
  // consecutiveFailures and the heartbeat gauge — operators would see
  // the gauge tick over on a heartbeat they thought was halted.
  it("stop() during an in-flight tick prevents the failure counter from incrementing", async () => {
    let releaseFetch: (response: Response) => void = () => {};
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = resolve;
        }),
    );
    const scheduled: Array<{ fn: () => void; delay: number }> = [];
    const setTimeoutImpl = ((fn: () => void, delay: number) => {
      scheduled.push({ fn, delay });
      return { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const hb = createPaperclipHeartbeat(
      { baseUrl: "http://paperclip:3100", apiKey: "k", intervalMs: 1_000 },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        setTimeoutImpl,
        clearTimeoutImpl: (() => {}) as unknown as typeof clearTimeout,
        logger: { warn: vi.fn() },
        randomFn: () => 0.5,
      },
    );
    hb!.start();
    // Immediate tick is now in-flight, awaiting fetch. Call stop()
    // while the fetch hasn't resolved.
    await new Promise((r) => setImmediate(r));
    expect(fetchImpl).toHaveBeenCalledOnce();
    hb!.stop();
    // Now resolve the fetch with a 5xx so the failure path runs.
    // Without the post-await guard, this would land in the failure
    // branch and increment consecutiveFailures. With the guard, the
    // callback bails on the second `if (stopped) return;` check.
    releaseFetch(new Response("", { status: 503 }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // No follow-up tick was scheduled — scheduleNext was never reached
    // because the post-await gate fired first.
    expect(scheduled).toHaveLength(0);
  });

  it("jitter cannot push the delay above HEARTBEAT_MAX_INTERVAL_MS (clamp wins)", async () => {
    // Confirms the documented invariant: even with the +20% jitter,
    // we never sleep longer than the cap. This matters because k8s/
    // compose health checks budget against the cap; a jittered overrun
    // could trip a false-positive failure gauge.
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 }));
    const scheduled: Array<{ fn: () => void; delay: number }> = [];
    const setTimeoutImpl = ((fn: () => void, delay: number) => {
      scheduled.push({ fn, delay });
      return { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    // Base × 2^N must dwarf the cap so we hit the clamp regardless
    // of jitter direction.
    const baseIntervalMs = 1_000;
    const hb = createPaperclipHeartbeat(
      { baseUrl: "http://paperclip:3100", apiKey: "k", intervalMs: baseIntervalMs },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        setTimeoutImpl,
        clearTimeoutImpl: (() => {}) as unknown as typeof clearTimeout,
        logger: { warn: vi.fn() },
        // random=1 (max jitter +20%) AND 2^15 × 1s would otherwise
        // give 32_768s — the cap MUST win.
        randomFn: () => 1,
      },
    );
    hb!.start();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 15; i++) {
      await scheduled[scheduled.length - 1]!.fn();
      await new Promise((r) => setImmediate(r));
    }
    expect(scheduled[scheduled.length - 1]!.delay).toBe(HEARTBEAT_MAX_INTERVAL_MS);
    hb!.stop();
  });
});

describe("resolvePaperclipHeartbeatConfigWithReason", () => {
  it("reports 'no_base_url' when base URL is absent", () => {
    const res = resolvePaperclipHeartbeatConfigWithReason({ PAPERCLIP_AGENT_API_KEY: "k" });
    expect(res).toEqual({ kind: "disabled", reason: "no_base_url" });
  });

  it("reports 'no_api_key' when base URL is set but agent key is absent", () => {
    const res = resolvePaperclipHeartbeatConfigWithReason({
      PAPERCLIP_BASE_URL: "http://paperclip:3100",
    });
    expect(res).toEqual({ kind: "disabled", reason: "no_api_key" });
  });

  it("returns the populated config when both env vars are set", () => {
    const res = resolvePaperclipHeartbeatConfigWithReason({
      PAPERCLIP_BASE_URL: "http://paperclip:3100",
      PAPERCLIP_AGENT_API_KEY: "pcp_abc",
    });
    expect(res.kind).toBe("config");
    if (res.kind === "config") {
      expect(res.config.baseUrl).toBe("http://paperclip:3100");
      expect(res.config.apiKey).toBe("pcp_abc");
    }
  });

  it("the backwards-compat resolvePaperclipHeartbeatConfig collapses disabled to null", () => {
    // The legacy API surface returns null for either disabled reason.
    // Kept tested so a future refactor doesn't accidentally change it.
    expect(resolvePaperclipHeartbeatConfig({ PAPERCLIP_AGENT_API_KEY: "k" })).toBeNull();
    expect(resolvePaperclipHeartbeatConfig({ PAPERCLIP_BASE_URL: "x" })).toBeNull();
    // Avoid unused-import warnings when the DEFAULT constant is not
    // otherwise referenced from tests.
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------
// Max-interval env knob (T5, 2026-04-25). Operators with multi-gateway
// clusters or known-slow recovery windows can extend the backoff cap
// past the 5-min default via PAPERCLIP_HEARTBEAT_MAX_INTERVAL_MS.
// -----------------------------------------------------------------------
import { resolveHeartbeatMaxIntervalMs } from "./paperclip-heartbeat.js";

describe("resolveHeartbeatMaxIntervalMs", () => {
  it("returns the documented default when the env is unset", () => {
    expect(resolveHeartbeatMaxIntervalMs({})).toBe(HEARTBEAT_MAX_INTERVAL_MS);
  });

  it("parses a positive integer override", () => {
    expect(
      resolveHeartbeatMaxIntervalMs({
        PAPERCLIP_HEARTBEAT_MAX_INTERVAL_MS: "900000",
      }),
    ).toBe(900_000);
  });

  it("floors absurdly small values at the 60s minimum", () => {
    // A < 1-min cap would defeat backoff entirely. Defensive floor
    // protects operators who typo'd seconds-instead-of-ms.
    expect(
      resolveHeartbeatMaxIntervalMs({
        PAPERCLIP_HEARTBEAT_MAX_INTERVAL_MS: "5",
      }),
    ).toBe(60_000);
  });

  it("treats non-numeric / negative input as default (defensive)", () => {
    expect(
      resolveHeartbeatMaxIntervalMs({
        PAPERCLIP_HEARTBEAT_MAX_INTERVAL_MS: "garbage",
      }),
    ).toBe(HEARTBEAT_MAX_INTERVAL_MS);
    expect(
      resolveHeartbeatMaxIntervalMs({
        PAPERCLIP_HEARTBEAT_MAX_INTERVAL_MS: "-100",
      }),
    ).toBe(HEARTBEAT_MAX_INTERVAL_MS);
  });
});
