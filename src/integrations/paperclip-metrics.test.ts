import { describe, expect, it } from "vitest";
import {
  createPaperclipMetrics,
  getActivePaperclipMetrics,
  setActivePaperclipMetrics,
} from "./paperclip-metrics.js";
import type { CircuitSnapshot } from "./paperclip-circuit.js";

function makeCircuit(state: CircuitSnapshot["state"], consecutiveFailures = 0): CircuitSnapshot {
  return {
    state,
    consecutiveFailures,
    openedAt: null,
    lastReachableAt: null,
    lastErrorAt: null,
    lastError: null,
  };
}

describe("paperclip-metrics counters", () => {
  it("increments request counters by (direction, outcome, errorCategory)", () => {
    const m = createPaperclipMetrics();
    m.recordRequest("outbound", "ok");
    m.recordRequest("outbound", "ok");
    m.recordRequest("outbound", "error", "http_500");
    const body = m.renderExposition();
    expect(body).toContain(
      'openclaw_bridge_requests_total{direction="outbound",outcome="ok",error_category="none"} 2',
    );
    expect(body).toContain(
      'openclaw_bridge_requests_total{direction="outbound",outcome="error",error_category="http_500"} 1',
    );
  });

  it("renders an empty counter block when no requests recorded", () => {
    const m = createPaperclipMetrics();
    const body = m.renderExposition();
    expect(body).toContain("# TYPE openclaw_bridge_requests_total counter");
    // No counter lines should follow the header.
    expect(body).not.toMatch(/openclaw_bridge_requests_total\{/);
  });

  it("dispatcher counter tallies per-(outcome, error_category)", () => {
    const m = createPaperclipMetrics();
    m.recordDispatch("forwarded");
    m.recordDispatch("forwarded");
    m.recordDispatch("skipped");
    // No category supplied → "unknown" so a regression that drops the
    // categorisation in the dispatcher path is visible (rather than
    // silently bucketed into a generic "failed" series).
    m.recordDispatch("failed");
    // Categorised failures land in distinct series so operators can tell
    // breaker-induced drops from upstream-induced drops in Grafana.
    m.recordDispatch("failed", "breaker_open");
    m.recordDispatch("failed", "breaker_open");
    m.recordDispatch("failed", "http_5xx");
    const body = m.renderExposition();
    // Forwarded/skipped collapse to error_category="none" — the
    // category dimension only carries information for failures.
    expect(body).toContain(
      'openclaw_dispatcher_dispatch_total{outcome="forwarded",error_category="none"} 2',
    );
    expect(body).toContain(
      'openclaw_dispatcher_dispatch_total{outcome="skipped",error_category="none"} 1',
    );
    expect(body).toContain(
      'openclaw_dispatcher_dispatch_total{outcome="failed",error_category="unknown"} 1',
    );
    expect(body).toContain(
      'openclaw_dispatcher_dispatch_total{outcome="failed",error_category="breaker_open"} 2',
    );
    expect(body).toContain(
      'openclaw_dispatcher_dispatch_total{outcome="failed",error_category="http_5xx"} 1',
    );
  });
});

describe("paperclip-metrics latency summary", () => {
  it("computes p50/p95/p99 over recorded samples", () => {
    const m = createPaperclipMetrics();
    for (let i = 1; i <= 100; i++) m.recordLatency("outbound", i);
    const body = m.renderExposition();
    // p50 of 1..100 = 50.5
    expect(body).toMatch(/openclaw_bridge_latency_ms\{direction="outbound",quantile="0.5"\} 50\.5/);
    expect(body).toMatch(/openclaw_bridge_latency_ms_count\{direction="outbound"\} 100/);
  });

  it("emits nothing (no lines) when a direction has zero samples", () => {
    const m = createPaperclipMetrics();
    const body = m.renderExposition();
    expect(body).not.toMatch(/openclaw_bridge_latency_ms\{/);
    expect(body).toContain("# TYPE openclaw_bridge_latency_ms summary");
  });

  it("does not record negative or NaN latencies", () => {
    const m = createPaperclipMetrics();
    m.recordLatency("outbound", -5);
    m.recordLatency("outbound", Number.NaN);
    m.recordLatency("outbound", Number.POSITIVE_INFINITY);
    m.recordLatency("outbound", 42);
    const body = m.renderExposition();
    expect(body).toMatch(/openclaw_bridge_latency_ms_count\{direction="outbound"\} 1/);
  });

  it("bounds the sample buffer per direction", () => {
    const m = createPaperclipMetrics();
    // Push more than the cap (MAX_LATENCY_SAMPLES=1024) to prove eviction.
    for (let i = 0; i < 2000; i++) m.recordLatency("outbound", i);
    const body = m.renderExposition();
    const match = body.match(/openclaw_bridge_latency_ms_count\{direction="outbound"\} (\d+)/);
    expect(match).not.toBeNull();
    const count = Number(match![1]);
    expect(count).toBeLessThanOrEqual(1024);
    expect(count).toBeGreaterThan(0);
  });

  it("quantile on a single sample returns that sample", () => {
    const m = createPaperclipMetrics();
    m.recordLatency("heartbeat", 42);
    const body = m.renderExposition();
    expect(body).toMatch(/openclaw_bridge_latency_ms\{direction="heartbeat",quantile="0.5"\} 42/);
    expect(body).toMatch(/openclaw_bridge_latency_ms\{direction="heartbeat",quantile="0.99"\} 42/);
  });
});

describe("paperclip-metrics circuit gauge", () => {
  it("maps circuit state to 0/1/2", () => {
    const m = createPaperclipMetrics();
    let body = m.renderExposition(() => makeCircuit("closed", 0));
    expect(body).toContain('openclaw_bridge_circuit_state{arrow="paperclip_outbound"} 0');
    body = m.renderExposition(() => makeCircuit("half_open", 3));
    expect(body).toContain('openclaw_bridge_circuit_state{arrow="paperclip_outbound"} 1');
    expect(body).toContain(
      'openclaw_bridge_circuit_consecutive_failures{arrow="paperclip_outbound"} 3',
    );
    body = m.renderExposition(() => makeCircuit("open", 5));
    expect(body).toContain('openclaw_bridge_circuit_state{arrow="paperclip_outbound"} 2');
  });

  it("emits default zero values when no circuit provided", () => {
    const m = createPaperclipMetrics();
    const body = m.renderExposition();
    // Gauge must always be present so Prometheus doesn't gap the series.
    expect(body).toContain('openclaw_bridge_circuit_state{arrow="paperclip_outbound"} 0');
    expect(body).toContain(
      'openclaw_bridge_circuit_consecutive_failures{arrow="paperclip_outbound"} 0',
    );
  });

  it("tolerates a throwing circuit provider", () => {
    const m = createPaperclipMetrics();
    const body = m.renderExposition(() => {
      throw new Error("boom");
    });
    // Falls through to zeroed gauge rather than crashing the scraper.
    expect(body).toContain('openclaw_bridge_circuit_state{arrow="paperclip_outbound"} 0');
  });
});

describe("paperclip-metrics label escaping", () => {
  it("escapes quotes, backslashes, and newlines in error categories", () => {
    const m = createPaperclipMetrics();
    // Simulate a weird error category that shouldn't escape the label.
    m.recordRequest("outbound", "error", 'http_500"injection\n\\');
    const body = m.renderExposition();
    // Expect escape sequences: \" for quote, \n for newline, \\ for backslash.
    expect(body).toContain(
      'openclaw_bridge_requests_total{direction="outbound",outcome="error",error_category="http_500\\"injection\\n\\\\"} 1',
    );
  });
});

describe("paperclip-metrics exposition format", () => {
  it("emits all four metric TYPE headers even when empty", () => {
    const m = createPaperclipMetrics();
    const body = m.renderExposition();
    expect(body).toContain("# TYPE openclaw_bridge_requests_total counter");
    expect(body).toContain("# TYPE openclaw_bridge_latency_ms summary");
    expect(body).toContain("# TYPE openclaw_dispatcher_dispatch_total counter");
    expect(body).toContain("# TYPE openclaw_bridge_circuit_state gauge");
  });

  it("ends with a newline so prometheus's parser is happy", () => {
    const m = createPaperclipMetrics();
    const body = m.renderExposition();
    expect(body.endsWith("\n")).toBe(true);
  });

  it("orders counter lines deterministically", () => {
    const m1 = createPaperclipMetrics();
    const m2 = createPaperclipMetrics();
    // Record in different orders — rendered output must be identical
    // so snapshot-style assertions don't flake.
    m1.recordRequest("heartbeat", "ok");
    m1.recordRequest("outbound", "error", "http_500");
    m2.recordRequest("outbound", "error", "http_500");
    m2.recordRequest("heartbeat", "ok");
    expect(m1.renderExposition()).toBe(m2.renderExposition());
  });
});

describe("paperclip-metrics active-instance singleton", () => {
  it("set/get round-trip works and returns null after clear", () => {
    const m = createPaperclipMetrics();
    setActivePaperclipMetrics(m);
    expect(getActivePaperclipMetrics()).toBe(m);
    setActivePaperclipMetrics(null);
    expect(getActivePaperclipMetrics()).toBeNull();
  });
});

describe("paperclip-metrics reset", () => {
  it("clears all counters, samples, and auth cache-hit state", () => {
    const m = createPaperclipMetrics();
    m.recordRequest("outbound", "ok");
    m.recordLatency("outbound", 100);
    m.recordDispatch("forwarded");
    m.recordAuthCacheHit("open");
    m.setHeartbeatConsecutiveFailures(3);
    m.reset();
    const body = m.renderExposition();
    expect(body).not.toMatch(/openclaw_bridge_requests_total\{/);
    expect(body).not.toMatch(/openclaw_bridge_latency_ms\{/);
    expect(body).not.toMatch(/openclaw_dispatcher_dispatch_total\{/);
    expect(body).not.toMatch(/openclaw_paperclip_auth_cache_hits_total\{/);
    expect(body).toContain("openclaw_paperclip_heartbeat_consecutive_failures 0");
    expect(m.getHeartbeatConsecutiveFailures()).toBe(0);
  });
});

describe("paperclip-metrics heartbeat gauge", () => {
  it("defaults to 0 and reflects explicit setter updates", () => {
    const m = createPaperclipMetrics();
    expect(m.getHeartbeatConsecutiveFailures()).toBe(0);
    expect(m.renderExposition()).toContain(
      "openclaw_paperclip_heartbeat_consecutive_failures 0",
    );
    m.setHeartbeatConsecutiveFailures(7);
    expect(m.getHeartbeatConsecutiveFailures()).toBe(7);
    expect(m.renderExposition()).toContain(
      "openclaw_paperclip_heartbeat_consecutive_failures 7",
    );
  });

  it("clamps negative and fractional inputs to a non-negative integer", () => {
    const m = createPaperclipMetrics();
    m.setHeartbeatConsecutiveFailures(-5);
    expect(m.getHeartbeatConsecutiveFailures()).toBe(0);
    m.setHeartbeatConsecutiveFailures(3.9);
    // Math.trunc(3.9) = 3.
    expect(m.getHeartbeatConsecutiveFailures()).toBe(3);
  });
});

describe("paperclip-metrics auth cache hits", () => {
  it("partitions hits by breaker_state label", () => {
    const m = createPaperclipMetrics();
    m.recordAuthCacheHit("closed");
    m.recordAuthCacheHit("closed");
    m.recordAuthCacheHit("closed");
    m.recordAuthCacheHit("half_open");
    m.recordAuthCacheHit("open");
    m.recordAuthCacheHit("open");
    const body = m.renderExposition();
    expect(body).toContain(
      'openclaw_paperclip_auth_cache_hits_total{breaker_state="closed"} 3',
    );
    expect(body).toContain(
      'openclaw_paperclip_auth_cache_hits_total{breaker_state="half_open"} 1',
    );
    expect(body).toContain(
      'openclaw_paperclip_auth_cache_hits_total{breaker_state="open"} 2',
    );
  });

  it("emits the TYPE header even with zero hits (scrape stability)", () => {
    const m = createPaperclipMetrics();
    const body = m.renderExposition();
    expect(body).toContain(
      "# TYPE openclaw_paperclip_auth_cache_hits_total counter",
    );
    // No data lines.
    expect(body).not.toMatch(/openclaw_paperclip_auth_cache_hits_total\{/);
  });
});
