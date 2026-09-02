import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPaperclipOtel, stopPaperclipOtel } from "./paperclip-otel.js";

// The SDK is deliberately an optional runtime dep — not listed in
// package.json. The "module not found" branch is therefore the path
// this repo actually exercises, and these tests pin that behavior so
// nobody silently regresses it by accidentally adding a `@opentelemetry/*`
// dep that isn't operator-opt-in.

function makeLogger() {
  return {
    warn: vi.fn<(msg: string, ...args: unknown[]) => void>(),
    info: vi.fn<(msg: string, ...args: unknown[]) => void>(),
    error: vi.fn<(msg: string, ...args: unknown[]) => void>(),
  };
}

describe("startPaperclipOtel", () => {
  beforeEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_DEPLOYMENT_ENVIRONMENT;
  });

  afterEach(async () => {
    // Always reset module state so the idempotency test can't be
    // perturbed by a prior it() leaving `started=true` behind.
    await stopPaperclipOtel();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  it("is disabled and reports a stable reason when OTEL_EXPORTER_OTLP_ENDPOINT is unset", async () => {
    const logger = makeLogger();
    const result = await startPaperclipOtel({ logger });
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("OTEL_EXPORTER_OTLP_ENDPOINT not set");
    // No logging needed in the disabled path — keeps quiet deployments quiet.
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("reports the missing-packages reason and warns when SDK modules are absent", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector:4318";
    const logger = makeLogger();
    const result = await startPaperclipOtel({ logger });
    // In this repo the @opentelemetry/* packages are not installed, so
    // startPaperclipOtel should surface the clear reason string without
    // throwing.
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("@opentelemetry packages not installed");
    expect(logger.warn).toHaveBeenCalledOnce();
    const msg = String(logger.warn.mock.calls[0]?.[0] ?? "");
    expect(msg).toMatch(/@opentelemetry/);
    expect(msg).toMatch(/missing/i);
  });

  it("stopPaperclipOtel is safe to call when OTel was never started (no-op)", async () => {
    // Nothing throws; returns undefined. Guards against boot-sequence
    // failures where SIGTERM fires before startPaperclipOtel resolves.
    await expect(stopPaperclipOtel()).resolves.toBeUndefined();
  });

  it("stopPaperclipOtel can be called repeatedly without raising", async () => {
    await stopPaperclipOtel();
    await stopPaperclipOtel();
    await expect(stopPaperclipOtel()).resolves.toBeUndefined();
  });

  it("falls back to a default console logger when none supplied (does not throw)", async () => {
    // No opts — the function must still handle the missing-package path
    // using its internal console-based logger. This test simply asserts
    // that passing zero arguments does not throw.
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector:4318";
    try {
      const result = await startPaperclipOtel();
      expect(result.enabled).toBe(false);
      expect(result.reason).toBe("@opentelemetry packages not installed");
      expect(consoleWarn).toHaveBeenCalled();
    } finally {
      consoleWarn.mockRestore();
    }
  });
});
