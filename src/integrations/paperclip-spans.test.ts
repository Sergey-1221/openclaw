import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordCircuitTransitionSpan,
  recordSpanEvent,
  setBridgeSpansLogger,
  setBridgeTracer,
  withBridgeSpan,
} from "./paperclip-spans.js";

// ---------------------------------------------------------------------------
// Span test doubles
// ---------------------------------------------------------------------------

interface RecordedAttr {
  key: string;
  value: string | number | boolean;
}
interface RecordedEvent {
  name: string;
  attrs?: Record<string, string | number | boolean>;
}
interface RecordedSpan {
  name: string;
  startAttributes?: Record<string, string | number | boolean>;
  attributes: RecordedAttr[];
  events: RecordedEvent[];
  status?: { code: number; message?: string };
  exception?: unknown;
  ended: boolean;
}

function makeTracer() {
  const spans: RecordedSpan[] = [];
  const tracer = {
    startSpan(
      name: string,
      options?: { attributes?: Record<string, string | number | boolean> },
    ) {
      const rec: RecordedSpan = {
        name,
        startAttributes: options?.attributes,
        attributes: [],
        events: [],
        ended: false,
      };
      spans.push(rec);
      return {
        setAttribute(key: string, value: string | number | boolean) {
          rec.attributes.push({ key, value });
        },
        setStatus(status: { code: number; message?: string }) {
          rec.status = status;
        },
        recordException(err: unknown) {
          rec.exception = err;
        },
        addEvent(n: string, a?: Record<string, string | number | boolean>) {
          rec.events.push({ name: n, attrs: a });
        },
        end() {
          rec.ended = true;
        },
      };
    },
  };
  return { tracer, spans };
}

describe("withBridgeSpan — passthrough when no tracer wired", () => {
  afterEach(() => {
    setBridgeTracer(null);
  });

  it("returns the fn result unchanged when tracer is null", async () => {
    setBridgeTracer(null);
    const result = await withBridgeSpan(
      "paperclip.test",
      { "bridge.direction": "outbound" },
      async () => ({ ok: true, status: 200 }),
    );
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("provides a no-op span context (addEvent is callable but inert) when tracer is null", async () => {
    setBridgeTracer(null);
    const result = await withBridgeSpan(
      "paperclip.test",
      {},
      async (ctx) => {
        // Must not throw even though there is no real span behind it.
        ctx.addEvent("some-event", { foo: "bar" });
        return "done";
      },
    );
    expect(result).toBe("done");
  });
});

describe("withBridgeSpan — with an active tracer", () => {
  afterEach(() => {
    setBridgeTracer(null);
  });

  it("filters undefined attribute values from the initial attribute bag", async () => {
    const { tracer, spans } = makeTracer();
    setBridgeTracer(tracer);
    await withBridgeSpan(
      "paperclip.outbound",
      {
        "bridge.direction": "outbound",
        "bridge.company_id": "c-1",
        "bridge.session_key": undefined,
        "http.url": "http://paperclip:3100/api/integrations/openclaw/inbound",
      },
      async () => ({ ok: true }),
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]!.startAttributes).toEqual({
      "bridge.direction": "outbound",
      "bridge.company_id": "c-1",
      "http.url": "http://paperclip:3100/api/integrations/openclaw/inbound",
    });
  });

  it("annotates postInbound-shaped results (ok/status/latency) and sets OK status", async () => {
    const { tracer, spans } = makeTracer();
    setBridgeTracer(tracer);
    await withBridgeSpan("paperclip.outbound", {}, async () => ({
      ok: true,
      status: 201,
      latencyMs: 42,
    }));
    const span = spans[0]!;
    expect(span.attributes).toContainEqual({ key: "bridge.ok", value: true });
    expect(span.attributes).toContainEqual({ key: "http.status_code", value: 201 });
    expect(span.attributes).toContainEqual({ key: "bridge.latency_ms", value: 42 });
    expect(span.status?.code).toBe(1); // STATUS_OK
    expect(span.ended).toBe(true);
  });

  it("annotates ok=false results with error status and preserves errorCategory attribute", async () => {
    const { tracer, spans } = makeTracer();
    setBridgeTracer(tracer);
    await withBridgeSpan("paperclip.outbound", {}, async () => ({
      ok: false,
      status: 502,
      errorCategory: "http_5xx",
    }));
    const span = spans[0]!;
    expect(span.attributes).toContainEqual({ key: "bridge.ok", value: false });
    expect(span.attributes).toContainEqual({ key: "bridge.error_category", value: "http_5xx" });
    expect(span.status?.code).toBe(2); // STATUS_ERROR
  });

  it("annotates dispatcher-shaped results: outcome=forwarded → OK", async () => {
    const { tracer, spans } = makeTracer();
    setBridgeTracer(tracer);
    await withBridgeSpan("paperclip.dispatch", {}, async () => ({
      outcome: "forwarded",
    }));
    const span = spans[0]!;
    expect(span.attributes).toContainEqual({ key: "bridge.outcome", value: "forwarded" });
    expect(span.status?.code).toBe(1);
  });

  it("annotates dispatcher-shaped results: outcome=skipped with reason", async () => {
    const { tracer, spans } = makeTracer();
    setBridgeTracer(tracer);
    await withBridgeSpan("paperclip.dispatch", {}, async () => ({
      outcome: "skipped",
      reason: "not-paperclip",
    }));
    const span = spans[0]!;
    expect(span.attributes).toContainEqual({ key: "bridge.outcome", value: "skipped" });
    expect(span.attributes).toContainEqual({ key: "bridge.error_category", value: "not-paperclip" });
    // skipped is benign — still OK so the trace doesn't turn red.
    expect(span.status?.code).toBe(1);
  });

  it("annotates dispatcher outcome=failed as ERROR", async () => {
    const { tracer, spans } = makeTracer();
    setBridgeTracer(tracer);
    await withBridgeSpan("paperclip.dispatch", {}, async () => ({
      outcome: "failed",
      reason: "circuit_open",
    }));
    const span = spans[0]!;
    expect(span.status?.code).toBe(2);
  });

  it("records exception and ERROR status when the callback throws, and rethrows", async () => {
    const { tracer, spans } = makeTracer();
    setBridgeTracer(tracer);
    const boom = new Error("kaboom");
    await expect(
      withBridgeSpan("paperclip.outbound", {}, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    const span = spans[0]!;
    expect(span.exception).toBe(boom);
    expect(span.status?.code).toBe(2);
    expect(span.status?.message).toBe("kaboom");
    expect(span.ended).toBe(true);
  });

  it("addEvent from BridgeSpanContext reaches the underlying span", async () => {
    const { tracer, spans } = makeTracer();
    setBridgeTracer(tracer);
    await withBridgeSpan("paperclip.dispatch", {}, async (ctx) => {
      ctx.addEvent("dispatch_failed", { reason: "timeout" });
      return { outcome: "failed" };
    });
    expect(spans[0]!.events).toEqual([
      { name: "dispatch_failed", attrs: { reason: "timeout" } },
    ]);
  });

  it("falls back to passthrough (no span) when tracer.startSpan throws", async () => {
    const warnSink = { warn: vi.fn() };
    setBridgeSpansLogger(warnSink);
    const brokenTracer = {
      startSpan() {
        throw new Error("tracer broken");
      },
    };
    setBridgeTracer(brokenTracer);
    // The fn must still run and its result propagate.
    const result = await withBridgeSpan(
      "paperclip.outbound",
      {},
      async () => ({ ok: true }),
    );
    expect(result).toEqual({ ok: true });
    expect(warnSink.warn).toHaveBeenCalledOnce();
    expect(String(warnSink.warn.mock.calls[0]?.[0])).toMatch(/paperclip\.outbound/);
  });

  it("swallows errors from addEvent so a broken tracer can't break callers", async () => {
    const throwingTracer = {
      startSpan() {
        return {
          setAttribute: () => undefined,
          setStatus: () => undefined,
          recordException: () => undefined,
          addEvent: () => {
            throw new Error("addEvent broken");
          },
          end: () => undefined,
        };
      },
    };
    setBridgeTracer(throwingTracer);
    // Callback reaches into a broken addEvent — withBridgeSpan must still
    // return the callback's value without propagating the span's error.
    const result = await withBridgeSpan(
      "paperclip.dispatch",
      {},
      async (ctx) => {
        ctx.addEvent("dispatch_failed", { reason: "x" });
        return { outcome: "forwarded" };
      },
    );
    expect(result).toEqual({ outcome: "forwarded" });
  });
});

describe("recordSpanEvent", () => {
  it("is a no-op on a null span", () => {
    // Does not throw; returns void synchronously.
    expect(() => recordSpanEvent(null, "circuit_opened", { arrow: "x" })).not.toThrow();
  });

  it("routes the event to span.addEvent when the span has one", () => {
    const events: RecordedEvent[] = [];
    const span = {
      setAttribute: () => undefined,
      setStatus: () => undefined,
      recordException: () => undefined,
      end: () => undefined,
      addEvent(name: string, attrs?: Record<string, string | number | boolean>) {
        events.push({ name, attrs });
      },
    };
    recordSpanEvent(span, "threshold_reached", { arrow: "paperclip_outbound" });
    expect(events).toEqual([
      { name: "threshold_reached", attrs: { arrow: "paperclip_outbound" } },
    ]);
  });

  it("swallows errors thrown by addEvent", () => {
    const span = {
      setAttribute: () => undefined,
      setStatus: () => undefined,
      recordException: () => undefined,
      end: () => undefined,
      addEvent: () => {
        throw new Error("nope");
      },
    };
    expect(() => recordSpanEvent(span, "threshold_reached", {})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// recordCircuitTransitionSpan — operator-visible breaker trips
// ---------------------------------------------------------------------------

describe("recordCircuitTransitionSpan", () => {
  afterEach(() => {
    setBridgeTracer(null);
  });

  it("is a no-op when no tracer is wired", () => {
    setBridgeTracer(null);
    expect(() =>
      recordCircuitTransitionSpan("paperclip_outbound", {
        from: "closed",
        to: "open",
        reason: "threshold_reached",
        at: 1_000,
      }),
    ).not.toThrow();
  });

  it("creates a one-shot span with arrow + transition attributes", () => {
    const { tracer, spans } = makeTracer();
    setBridgeTracer(tracer);

    recordCircuitTransitionSpan("paperclip_auth", {
      from: "closed",
      to: "open",
      reason: "threshold_reached",
      at: 12_345,
    });

    expect(spans).toHaveLength(1);
    const s = spans[0]!;
    expect(s.name).toBe("openclaw.paperclip.circuit.transition");
    expect(s.startAttributes).toMatchObject({
      "bridge.direction": "circuit",
      "bridge.arrow": "paperclip_auth",
      "bridge.circuit.from": "closed",
      "bridge.circuit.to": "open",
      "bridge.circuit.reason": "threshold_reached",
      "peer.service": "paperclip",
    });
    // Span is closed immediately so it doesn't drag latency series.
    expect(s.ended).toBe(true);
  });

  it("paints transitions to=open as ERROR and others as OK", () => {
    const { tracer, spans } = makeTracer();
    setBridgeTracer(tracer);

    // open → ERROR (operator's interest signal)
    recordCircuitTransitionSpan("paperclip_outbound", {
      from: "closed",
      to: "open",
      reason: "threshold_reached",
      at: 1,
    });
    // half_open → OK (recovery probing, not a fault)
    recordCircuitTransitionSpan("paperclip_outbound", {
      from: "open",
      to: "half_open",
      reason: "cooldown_expired",
      at: 2,
    });
    // closed via probe → OK (full recovery)
    recordCircuitTransitionSpan("paperclip_outbound", {
      from: "half_open",
      to: "closed",
      reason: "probe_success",
      at: 3,
    });
    // closed via idle_timeout → OK (auto-recovery without a probe; the
    // status code is the differentiator, the reason attribute carries
    // the "why")
    recordCircuitTransitionSpan("paperclip_outbound", {
      from: "half_open",
      to: "closed",
      reason: "idle_timeout",
      at: 4,
    });

    expect(spans).toHaveLength(4);
    expect(spans[0]!.status?.code).toBe(2); // STATUS_ERROR
    expect(spans[1]!.status?.code).toBe(1); // STATUS_OK
    expect(spans[2]!.status?.code).toBe(1);
    expect(spans[3]!.status?.code).toBe(1);
    // idle_timeout reason must be carried in the attribute even though
    // the status is OK — that's how operators distinguish "self-healed"
    // from "probe verified" in trace search.
    expect(spans[3]!.startAttributes?.["bridge.circuit.reason"]).toBe("idle_timeout");
  });

  it("logs and swallows tracer.startSpan failures", () => {
    const warn = vi.fn();
    setBridgeSpansLogger({ warn });
    setBridgeTracer({
      startSpan() {
        throw new Error("tracer broken");
      },
    });
    expect(() =>
      recordCircuitTransitionSpan("paperclip_mcp", {
        from: "closed",
        to: "open",
        reason: "threshold_reached",
        at: 0,
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    setBridgeSpansLogger({ warn: () => undefined });
  });
});
