import { afterEach, describe, expect, it } from "vitest";
import {
  activeTraceparent,
  generateTraceparent,
  resolveTraceparent,
  setActiveTraceContextReader,
} from "./paperclip-traceparent.js";

// W3C traceparent format: version-traceId-spanId-flags
// version   = 2 hex
// traceId   = 32 hex (128 bits), not all-zero
// spanId    = 16 hex (64 bits), not all-zero
// flags     = 2 hex
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

describe("generateTraceparent", () => {
  it("produces a W3C-compliant header", () => {
    const tp = generateTraceparent();
    const m = TRACEPARENT_RE.exec(tp);
    expect(m).not.toBeNull();
    const [, version, traceId, spanId, flags] = m!;
    expect(version).toBe("00");
    expect(flags).toBe("01");
    // Reject the all-zero trace-id / span-id that the spec forbids.
    expect(traceId).not.toBe("00000000000000000000000000000000");
    expect(spanId).not.toBe("0000000000000000");
  });

  it("generates a fresh trace id on each call (effectively unique)", () => {
    const n = 200;
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) seen.add(generateTraceparent());
    // Collisions at this scale would indicate something is very wrong
    // with the entropy source — 128-bit trace id, birthday bound ~2^64.
    expect(seen.size).toBe(n);
  });
});

describe("resolveTraceparent", () => {
  it("returns the inbound header untouched when one is supplied", () => {
    const inbound = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    expect(resolveTraceparent(inbound)).toBe(inbound);
  });

  it("trims whitespace from the inbound header", () => {
    const inbound = "  00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01  ";
    expect(resolveTraceparent(inbound)).toBe(inbound.trim());
  });

  it("falls back to a fresh header when inbound is undefined", () => {
    const tp = resolveTraceparent(undefined);
    expect(TRACEPARENT_RE.test(tp)).toBe(true);
  });

  it("falls back to a fresh header when inbound is null", () => {
    const tp = resolveTraceparent(null);
    expect(TRACEPARENT_RE.test(tp)).toBe(true);
  });

  it("falls back to a fresh header when inbound is an empty/whitespace string", () => {
    expect(TRACEPARENT_RE.test(resolveTraceparent(""))).toBe(true);
    expect(TRACEPARENT_RE.test(resolveTraceparent("   "))).toBe(true);
  });
});

describe("activeTraceparent", () => {
  afterEach(() => {
    setActiveTraceContextReader(null);
  });

  it("returns undefined when no reader is wired (OTel disabled)", () => {
    // Fresh module state — no reader set. Used as the steady-state path
    // for deployments that skipped the observability zone.
    expect(activeTraceparent()).toBeUndefined();
  });

  it("returns a W3C-compliant traceparent built from the wired reader", () => {
    setActiveTraceContextReader(() => ({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    }));
    const tp = activeTraceparent();
    expect(tp).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
  });

  it("returns undefined when the reader reports no active span", () => {
    setActiveTraceContextReader(() => null);
    expect(activeTraceparent()).toBeUndefined();
  });

  it("rejects spec-invalid all-zero trace-id", () => {
    setActiveTraceContextReader(() => ({
      traceId: "00000000000000000000000000000000",
      spanId: "00f067aa0ba902b7",
    }));
    expect(activeTraceparent()).toBeUndefined();
  });

  it("rejects spec-invalid all-zero span-id", () => {
    setActiveTraceContextReader(() => ({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "0000000000000000",
    }));
    expect(activeTraceparent()).toBeUndefined();
  });

  it("rejects a malformed (wrong-length) trace-id", () => {
    setActiveTraceContextReader(() => ({
      // 30 hex chars — OTel bug surfacing as malformed output; we must
      // skip rather than ship a spec-invalid header that Tempo would drop.
      traceId: "4bf92f3577b34da6a3ce929d0e0e47",
      spanId: "00f067aa0ba902b7",
    }));
    expect(activeTraceparent()).toBeUndefined();
  });

  it("swallows a reader that throws (broken OTel must not break the bridge)", () => {
    setActiveTraceContextReader(() => {
      throw new Error("tracer blew up");
    });
    expect(activeTraceparent()).toBeUndefined();
  });
});
