import { describe, expect, it } from "vitest";
import {
  createPaperclipCircuit,
  resolveCircuitConfig,
  type CircuitConfig,
} from "./paperclip-circuit.js";

describe("resolveCircuitConfig", () => {
  it("returns sensible defaults on an empty env", () => {
    const cfg = resolveCircuitConfig({});
    expect(cfg.failureThreshold).toBe(5);
    expect(cfg.cooldownMs).toBe(30_000);
  });

  it("honours env overrides when numeric", () => {
    const cfg = resolveCircuitConfig({
      PAPERCLIP_OUTBOUND_CIRCUIT_FAILURE_THRESHOLD: "3",
      PAPERCLIP_OUTBOUND_CIRCUIT_COOLDOWN_MS: "5000",
    });
    expect(cfg.failureThreshold).toBe(3);
    expect(cfg.cooldownMs).toBe(5000);
  });

  it("falls back to defaults on non-numeric env", () => {
    const cfg = resolveCircuitConfig({
      PAPERCLIP_OUTBOUND_CIRCUIT_FAILURE_THRESHOLD: "not-a-number",
      PAPERCLIP_OUTBOUND_CIRCUIT_COOLDOWN_MS: "",
    });
    expect(cfg.failureThreshold).toBe(5);
    expect(cfg.cooldownMs).toBe(30_000);
  });

  it("rejects zero and negative values", () => {
    const cfg = resolveCircuitConfig({
      PAPERCLIP_OUTBOUND_CIRCUIT_FAILURE_THRESHOLD: "0",
      PAPERCLIP_OUTBOUND_CIRCUIT_COOLDOWN_MS: "-100",
    });
    expect(cfg.failureThreshold).toBe(5);
    expect(cfg.cooldownMs).toBe(30_000);
    expect(cfg.halfOpenIdleMs).toBe(60_000);
  });
});

describe("createPaperclipCircuit", () => {
  const cfg: CircuitConfig = { failureThreshold: 3, cooldownMs: 1_000, halfOpenIdleMs: 60_000 };

  it("starts closed and allows traffic", () => {
    const c = createPaperclipCircuit(cfg);
    expect(c.allow(0)).toBe(true);
    expect(c.snapshot().state).toBe("closed");
    expect(c.snapshot().consecutiveFailures).toBe(0);
  });

  it("opens exactly at the failure threshold", () => {
    const c = createPaperclipCircuit(cfg);
    c.recordFailure("err", 0);
    c.recordFailure("err", 0);
    expect(c.snapshot().state).toBe("closed");
    c.recordFailure("err", 0);
    expect(c.snapshot().state).toBe("open");
    expect(c.snapshot().consecutiveFailures).toBe(3);
  });

  it("rejects traffic while open and within cooldown", () => {
    const c = createPaperclipCircuit(cfg);
    for (let i = 0; i < 3; i++) c.recordFailure("err", 100);
    expect(c.allow(100)).toBe(false);
    expect(c.allow(500)).toBe(false);
    expect(c.allow(999)).toBe(false);
  });

  it("transitions to half_open after cooldown", () => {
    const c = createPaperclipCircuit(cfg);
    for (let i = 0; i < 3; i++) c.recordFailure("err", 0);
    expect(c.snapshot().state).toBe("open");
    // Exactly at cooldown boundary: allow + transition.
    expect(c.allow(1_000)).toBe(true);
    expect(c.snapshot().state).toBe("half_open");
  });

  it("closes on success from half_open", () => {
    const c = createPaperclipCircuit(cfg);
    for (let i = 0; i < 3; i++) c.recordFailure("err", 0);
    c.allow(1_500); // → half_open
    c.recordSuccess(1_600);
    expect(c.snapshot().state).toBe("closed");
    expect(c.snapshot().consecutiveFailures).toBe(0);
    expect(c.snapshot().lastReachableAt).not.toBeNull();
    expect(c.snapshot().lastError).toBeNull();
  });

  it("re-opens when a half_open probe fails", () => {
    const c = createPaperclipCircuit(cfg);
    for (let i = 0; i < 3; i++) c.recordFailure("err", 0);
    c.allow(1_500); // → half_open
    c.recordFailure("probe-failed", 1_600);
    expect(c.snapshot().state).toBe("open");
    expect(c.snapshot().consecutiveFailures).toBe(4);
  });

  it("recordSuccess resets the failure tally even from closed state", () => {
    const c = createPaperclipCircuit(cfg);
    c.recordFailure("err", 0);
    c.recordFailure("err", 0);
    expect(c.snapshot().consecutiveFailures).toBe(2);
    c.recordSuccess(100);
    expect(c.snapshot().consecutiveFailures).toBe(0);
    expect(c.snapshot().state).toBe("closed");
  });

  it("snapshot serialises timestamps as ISO strings", () => {
    const c = createPaperclipCircuit(cfg);
    c.recordFailure("boom", 1_700_000_000_000);
    const snap = c.snapshot();
    expect(snap.lastError).toBe("boom");
    expect(snap.lastErrorAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snap.openedAt).toBeNull();
    expect(snap.lastReachableAt).toBeNull();
  });

  it("snapshot.openedAt populated only once breaker opens", () => {
    const c = createPaperclipCircuit({ failureThreshold: 2, cooldownMs: 1_000, halfOpenIdleMs: 60_000 });
    c.recordFailure("err", 1_000);
    expect(c.snapshot().openedAt).toBeNull();
    c.recordFailure("err", 2_000);
    expect(c.snapshot().openedAt).toBe(new Date(2_000).toISOString());
  });
});
