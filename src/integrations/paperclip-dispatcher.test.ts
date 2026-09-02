import { describe, expect, it, vi } from "vitest";
import {
  PAPERCLIP_SESSION_PREFIX,
  createPaperclipDispatcher,
  parsePaperclipCompanyId,
} from "./paperclip-dispatcher.js";
import type { PaperclipClient } from "./paperclip-client.js";
import type { PaperclipCircuit } from "./paperclip-circuit.js";

// Minimal stand-in for the circuit accessor on the mocked client — the
// dispatcher itself never calls it, but the PaperclipClient interface
// requires it to exist, so tests cast through a helper.
function mockClient(postInbound: ReturnType<typeof vi.fn>): PaperclipClient {
  return {
    postInbound,
    circuit: (() => ({}) as unknown) as () => PaperclipCircuit,
  } as unknown as PaperclipClient;
}

const COMPANY = "11111111-1111-1111-1111-111111111111";

describe("parsePaperclipCompanyId", () => {
  it("extracts the UUID from a paperclip:<uuid>:<rest> session key", () => {
    expect(parsePaperclipCompanyId(`${PAPERCLIP_SESSION_PREFIX}${COMPANY}:ceo`)).toBe(COMPANY);
  });

  it("extracts the UUID when nothing follows", () => {
    expect(parsePaperclipCompanyId(`paperclip:${COMPANY}`)).toBe(COMPANY);
  });

  it("returns null for non-paperclip session keys", () => {
    expect(parsePaperclipCompanyId("opaque-session-123")).toBeNull();
    expect(parsePaperclipCompanyId("openclaw:acme:updates")).toBeNull();
  });

  it("returns null when the second segment is not a UUID", () => {
    expect(parsePaperclipCompanyId("paperclip:acme:updates")).toBeNull();
    expect(parsePaperclipCompanyId("paperclip:")).toBeNull();
  });

  it("lowercases the parsed UUID", () => {
    const upper = COMPANY.toUpperCase();
    expect(parsePaperclipCompanyId(`paperclip:${upper}:x`)).toBe(COMPANY);
  });
});

describe("createPaperclipDispatcher", () => {
  it("skips when no client is configured", async () => {
    const d = createPaperclipDispatcher({ client: null });
    const res = await d.dispatchUserReply({ sessionKey: "paperclip:x", message: "m" });
    expect(res.outcome).toBe("skipped");
    expect(res.reason).toBe("paperclip-client-not-configured");
  });

  it("skips when session is not a paperclip session", async () => {
    const postInbound = vi.fn();
    const d = createPaperclipDispatcher({ client: mockClient(postInbound) });
    const res = await d.dispatchUserReply({
      sessionKey: "slack:team:channel",
      message: "hello",
    });
    expect(res.outcome).toBe("skipped");
    expect(postInbound).not.toHaveBeenCalled();
  });

  it("skips on empty message", async () => {
    const postInbound = vi.fn();
    const d = createPaperclipDispatcher({ client: mockClient(postInbound) });
    const res = await d.dispatchUserReply({
      sessionKey: `paperclip:${COMPANY}:ceo`,
      message: "   ",
    });
    expect(res.outcome).toBe("skipped");
    expect(postInbound).not.toHaveBeenCalled();
  });

  it("forwards a Paperclip-origin reply with companyId parsed from session", async () => {
    const postInbound = vi.fn().mockResolvedValue({ ok: true, status: 201, messageId: "row-1" });
    const d = createPaperclipDispatcher({ client: mockClient(postInbound) });
    const res = await d.dispatchUserReply({
      sessionKey: `paperclip:${COMPANY}:ceo`,
      message: "reply!",
      correlationId: "corr-xyz",
      externalUserId: "slack:U123",
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      metadata: { channel: "slack" },
    });
    expect(res.outcome).toBe("forwarded");
    expect(res.messageId).toBe("row-1");
    expect(postInbound).toHaveBeenCalledOnce();
    const arg = postInbound.mock.calls[0]![0];
    expect(arg).toMatchObject({
      companyId: COMPANY,
      sessionKey: `paperclip:${COMPANY}:ceo`,
      message: "reply!",
      inReplyToCorrelationId: "corr-xyz",
      userId: "slack:U123",
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });
    expect(arg.metadata).toMatchObject({ source: "openclaw", channel: "slack" });
  });

  it("honors companyIdOverride when session-key parsing fails", async () => {
    const postInbound = vi.fn().mockResolvedValue({ ok: true, status: 201, messageId: "row-2" });
    const d = createPaperclipDispatcher({ client: mockClient(postInbound) });
    const res = await d.dispatchUserReply({
      sessionKey: "opaque-session-abc",
      message: "m",
      companyIdOverride: COMPANY,
    });
    expect(res.outcome).toBe("forwarded");
    expect(postInbound).toHaveBeenCalledOnce();
    expect(postInbound.mock.calls[0]![0].companyId).toBe(COMPANY);
  });

  it("returns failed when Paperclip rejects the forward", async () => {
    const warn = vi.fn();
    // latencyMs > 0 so the classifier returns the http_5xx class rather
    // than misidentifying this as a breaker-open short-circuit (which is
    // characterised by status=503 + latencyMs=0).
    const postInbound = vi.fn().mockResolvedValue({ ok: false, status: 500, latencyMs: 12 });
    const d = createPaperclipDispatcher({ client: mockClient(postInbound), logger: { warn } });
    const res = await d.dispatchUserReply({
      sessionKey: `paperclip:${COMPANY}:x`,
      message: "m",
    });
    expect(res.outcome).toBe("failed");
    expect(res.reason).toBe("http_5xx");
    expect(warn).toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// Dispatcher TTL-bounded retry buffer (T5, 2026-04-25)
//
// The buffer is opt-in (PAPERCLIP_DISPATCHER_BUFFER_MAX > 0). With it
// enabled, replies that fail with `breaker_open` are queued instead of
// dropped, and drained on the next successful dispatch. Each test
// drives the buffer behaviour via the bufferConfig + now overrides on
// createPaperclipDispatcher so the suite is fully deterministic
// without relying on real timers or process env.
// -----------------------------------------------------------------------
import { resolveDispatcherBufferConfig } from "./paperclip-dispatcher.js";
import {
  createPaperclipMetrics,
  setActivePaperclipMetrics,
} from "./paperclip-metrics.js";

describe("createPaperclipDispatcher — TTL-bounded retry buffer", () => {
  const TICK_MS = 1_000;

  function makeBufferedDispatcher(opts: {
    postInbound: ReturnType<typeof vi.fn>;
    maxSize?: number;
    ttlMs?: number;
    nowState?: { value: number };
  }) {
    const nowState = opts.nowState ?? { value: 0 };
    const dispatcher = createPaperclipDispatcher({
      client: mockClient(opts.postInbound),
      bufferConfig: { maxSize: opts.maxSize ?? 5, ttlMs: opts.ttlMs ?? 10_000 },
      now: () => nowState.value,
    });
    return { dispatcher, nowState };
  }

  it("buffers a breaker_open failure when the buffer is enabled", async () => {
    // First call: breaker is open, dispatch fails. Second call would
    // drain — but we don't issue it, so we just assert the buffer
    // captured the failed entry.
    const postInbound = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, latencyMs: 0 });
    const { dispatcher } = makeBufferedDispatcher({ postInbound });
    const res = await dispatcher.dispatchUserReply({
      sessionKey: `paperclip:${COMPANY}:ceo`,
      message: "user reply during outage",
    });
    expect(res.outcome).toBe("failed");
    expect(res.reason).toBe("breaker_open");
    expect(dispatcher.__getBufferSize?.()).toBe(1);
  });

  it("drains the buffer on the next successful dispatch (FIFO)", async () => {
    // Breaker-blocked × 2, then breaker recovers and a fresh forwarded
    // reply arrives. The dispatcher must drain the two earlier entries
    // in FIFO order BEFORE returning, so postInbound is called 4 times
    // total: 2 failures + 1 success (current) + 2 drain successes.
    const postInbound = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, latencyMs: 0 })
      .mockResolvedValueOnce({ ok: false, status: 503, latencyMs: 0 })
      .mockResolvedValueOnce({ ok: true, status: 201, messageId: "live" })
      .mockResolvedValueOnce({ ok: true, status: 201, messageId: "drained-1" })
      .mockResolvedValueOnce({ ok: true, status: 201, messageId: "drained-2" });
    const { dispatcher } = makeBufferedDispatcher({ postInbound });

    await dispatcher.dispatchUserReply({
      sessionKey: `paperclip:${COMPANY}:a`,
      message: "first",
    });
    await dispatcher.dispatchUserReply({
      sessionKey: `paperclip:${COMPANY}:a`,
      message: "second",
    });
    expect(dispatcher.__getBufferSize?.()).toBe(2);

    const res = await dispatcher.dispatchUserReply({
      sessionKey: `paperclip:${COMPANY}:a`,
      message: "third (live)",
    });
    expect(res.outcome).toBe("forwarded");
    expect(dispatcher.__getBufferSize?.()).toBe(0);
    expect(postInbound).toHaveBeenCalledTimes(5);

    // Drain order is FIFO — the messages re-played in the order they
    // were enqueued.
    const drainCall1 = postInbound.mock.calls[3]![0];
    const drainCall2 = postInbound.mock.calls[4]![0];
    expect(drainCall1.message).toBe("first");
    expect(drainCall2.message).toBe("second");
  });

  it("evicts TTL-expired entries before draining", async () => {
    // Enqueue one reply at t=0 (failed). Advance now() past the TTL.
    // The next successful dispatch should NOT replay the stale entry
    // — pruneExpired runs before drainBuffer. Buffer ends empty.
    const postInbound = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, latencyMs: 0 })
      .mockResolvedValueOnce({ ok: true, status: 201, messageId: "live" });
    const { dispatcher, nowState } = makeBufferedDispatcher({
      postInbound,
      ttlMs: 5_000,
    });

    await dispatcher.dispatchUserReply({
      sessionKey: `paperclip:${COMPANY}:a`,
      message: "stale entry",
    });
    expect(dispatcher.__getBufferSize?.()).toBe(1);

    // Advance "time" past the TTL window. The next call's pruneExpired
    // up-front removes the stale entry; the live forward succeeds; the
    // drain finds an empty buffer and exits cleanly.
    nowState.value += 6_000;

    const res = await dispatcher.dispatchUserReply({
      sessionKey: `paperclip:${COMPANY}:a`,
      message: "live",
    });
    expect(res.outcome).toBe("forwarded");
    expect(dispatcher.__getBufferSize?.()).toBe(0);
    // postInbound was called twice: once for the failed enqueue, once
    // for the live success. The TTL-expired entry never replayed.
    expect(postInbound).toHaveBeenCalledTimes(2);
  });

  it("drops the OLDEST entry when the cap is reached (FIFO eviction)", async () => {
    // Cap = 2. Three sequential breaker_open failures: the oldest is
    // pushed out by the third. Buffer ends with the 2 newest entries.
    const postInbound = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503, latencyMs: 0 });
    const { dispatcher, nowState } = makeBufferedDispatcher({
      postInbound,
      maxSize: 2,
    });

    await dispatcher.dispatchUserReply({
      sessionKey: `paperclip:${COMPANY}:a`,
      message: "oldest",
    });
    nowState.value += TICK_MS;
    await dispatcher.dispatchUserReply({
      sessionKey: `paperclip:${COMPANY}:a`,
      message: "middle",
    });
    nowState.value += TICK_MS;
    await dispatcher.dispatchUserReply({
      sessionKey: `paperclip:${COMPANY}:a`,
      message: "newest",
    });
    expect(dispatcher.__getBufferSize?.()).toBe(2);

    // Confirm by re-attaching a successful response and observing
    // which two messages drain (in FIFO order).
    postInbound.mockReset();
    postInbound
      .mockResolvedValueOnce({ ok: true, status: 201, messageId: "live" })
      .mockResolvedValueOnce({ ok: true, status: 201, messageId: "drain-a" })
      .mockResolvedValueOnce({ ok: true, status: 201, messageId: "drain-b" });
    await dispatcher.dispatchUserReply({
      sessionKey: `paperclip:${COMPANY}:a`,
      message: "live",
    });
    expect(postInbound.mock.calls[1]![0].message).toBe("middle");
    expect(postInbound.mock.calls[2]![0].message).toBe("newest");
  });

  it("buffer disabled (maxSize=0): pre-T5 drop-on-overflow contract preserved", async () => {
    // Default behaviour: no buffering, no metric ticks beyond the
    // existing dispatch_total{outcome="failed"} counter.
    const postInbound = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503, latencyMs: 0 });
    const dispatcher = createPaperclipDispatcher({
      client: mockClient(postInbound),
      bufferConfig: { maxSize: 0, ttlMs: 120_000 },
    });
    await dispatcher.dispatchUserReply({
      sessionKey: `paperclip:${COMPANY}:a`,
      message: "dropped",
    });
    expect(dispatcher.__getBufferSize?.()).toBe(0);
  });

  it("does NOT buffer non-breaker failures (4xx/5xx are deterministic)", async () => {
    // A real upstream 500 won't be fixed by retrying — buffering it
    // would just defer the same failure. Same for 4xx (idempotency
    // collision, malformed payload, missing companyId).
    const postInbound = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, latencyMs: 47 });
    const { dispatcher } = makeBufferedDispatcher({ postInbound });
    const res = await dispatcher.dispatchUserReply({
      sessionKey: `paperclip:${COMPANY}:a`,
      message: "bad request",
    });
    expect(res.outcome).toBe("failed");
    expect(res.reason).toBe("http_5xx");
    expect(dispatcher.__getBufferSize?.()).toBe(0);
  });

  it("emits the buffer telemetry triple on drain + evict", async () => {
    // Wire a real metrics instance and read the rendered exposition.
    // This locks the contract for the avelton-os Grafana dashboard
    // and the BridgeDroppingReplies alert query.
    const metrics = createPaperclipMetrics();
    setActivePaperclipMetrics(metrics);
    try {
      const postInbound = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503, latencyMs: 0 })
        .mockResolvedValueOnce({ ok: true, status: 201, messageId: "live" })
        .mockResolvedValueOnce({ ok: true, status: 201, messageId: "drained" });
      const { dispatcher } = makeBufferedDispatcher({ postInbound });

      await dispatcher.dispatchUserReply({
        sessionKey: `paperclip:${COMPANY}:a`,
        message: "first",
      });
      await dispatcher.dispatchUserReply({
        sessionKey: `paperclip:${COMPANY}:a`,
        message: "second",
      });

      const exposition = metrics.renderExposition();
      // Gauge tracks current depth (now 0 after drain).
      expect(exposition).toContain("openclaw_dispatcher_buffer_size 0");
      // Counter shows the one successful drain.
      expect(exposition).toContain(
        'openclaw_dispatcher_buffer_drained_total{outcome="forwarded"} 1',
      );
    } finally {
      setActivePaperclipMetrics(null);
    }
  });
});

describe("resolveDispatcherBufferConfig", () => {
  it("disables the buffer by default (maxSize=0)", () => {
    const cfg = resolveDispatcherBufferConfig({});
    expect(cfg.maxSize).toBe(0);
    // TTL still has the documented default so an opt-in caller passing
    // PAPERCLIP_DISPATCHER_BUFFER_MAX alone gets the 120s window.
    expect(cfg.ttlMs).toBe(120_000);
  });

  it("parses positive integer envs", () => {
    const cfg = resolveDispatcherBufferConfig({
      PAPERCLIP_DISPATCHER_BUFFER_MAX: "100",
      PAPERCLIP_DISPATCHER_BUFFER_TTL_MS: "60000",
    });
    expect(cfg.maxSize).toBe(100);
    expect(cfg.ttlMs).toBe(60_000);
  });

  it("treats malformed / negative values as defaults (defensive)", () => {
    const cfg = resolveDispatcherBufferConfig({
      PAPERCLIP_DISPATCHER_BUFFER_MAX: "not-a-number",
      PAPERCLIP_DISPATCHER_BUFFER_TTL_MS: "-50",
    });
    expect(cfg.maxSize).toBe(0);
    expect(cfg.ttlMs).toBe(120_000);
  });
});

// classifyDispatchFailure powers the error_category label on
// `openclaw_dispatcher_dispatch_total{outcome="failed"}`. Each branch is
// pinned because the operator-side Grafana alert keys off these exact
// strings — a typo that turned `breaker_open` into `breakerOpen` would
// silently break the BridgeDroppingReplies alert. See INTEGRATION.md §5.2.
import { classifyDispatchFailure } from "./paperclip-dispatcher.js";

describe("classifyDispatchFailure", () => {
  it("recognises a breaker short-circuit by status=503 + latencyMs=0", () => {
    expect(classifyDispatchFailure(503, 0)).toBe("breaker_open");
  });

  it("treats a real upstream 503 (non-zero latency) as http_5xx", () => {
    // Distinguished from breaker_open by latencyMs > 0 — paperclip-client
    // only sets latencyMs=0 on the breaker short-circuit path.
    expect(classifyDispatchFailure(503, 47)).toBe("http_5xx");
  });

  it("classifies 5xx and 4xx into class buckets (not per-status)", () => {
    expect(classifyDispatchFailure(500, 12)).toBe("http_5xx");
    expect(classifyDispatchFailure(599, 12)).toBe("http_5xx");
    expect(classifyDispatchFailure(400, 12)).toBe("http_4xx");
    expect(classifyDispatchFailure(429, 12)).toBe("http_4xx");
  });

  it("classifies missing status as network", () => {
    expect(classifyDispatchFailure(undefined, 1500)).toBe("network");
    expect(classifyDispatchFailure(undefined, 0)).toBe("network");
  });

  it("falls back to unknown for outliers", () => {
    expect(classifyDispatchFailure(200, 12)).toBe("unknown");
    expect(classifyDispatchFailure(700, 12)).toBe("unknown");
  });
});
