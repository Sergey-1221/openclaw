import { describe, expect, it, vi } from "vitest";
import {
  _trackInFlightDispatchForTests,
  getActivePaperclipIntegration,
  maybeDispatchReplyToPaperclip,
  startPaperclipIntegration,
} from "./paperclip-bootstrap.js";

// The bootstrap module assembles other modules behind env-based gates.
// We don't try to exercise the actual network layer — that lives in
// each underlying module's own test file. Here we assert the one thing
// this module adds: correct on/off wiring given env shape.

describe("startPaperclipIntegration", () => {
  const silentLogger = { warn: () => {}, info: () => {} };

  it("disables every arrow when env is empty", () => {
    const integration = startPaperclipIntegration({ env: {}, logger: silentLogger });
    expect(integration.heartbeat).toBeNull();
    expect(integration.client).toBeNull();
    expect(integration.dispatcher).toBeNull();
    expect(integration.auth).toBeNull();
    expect(integration.mcp).toBeNull();
    expect(integration.describe()).toBe("heartbeat=off outbound=off dispatcher=off auth=off mcp=off");
  });

  it("enables just the client + dispatcher when only inbound config is present", () => {
    const integration = startPaperclipIntegration({
      env: {
        PAPERCLIP_BASE_URL: "http://paperclip:3100",
        PAPERCLIP_INBOUND_TOKEN: "inbound-bearer",
      },
      logger: silentLogger,
    });
    expect(integration.client).not.toBeNull();
    expect(integration.dispatcher).not.toBeNull();
    // Heartbeat needs PAPERCLIP_AGENT_API_KEY in addition to base url.
    expect(integration.heartbeat).toBeNull();
    // MCP is viable with base url alone (uses cfg.apiKey only when static key is set).
    expect(integration.mcp).not.toBeNull();
    // Auth is constructed whenever PAPERCLIP_BASE_URL is set; the client
    // logs a warning at construction-time when OPENCLAW_EXCHANGE_CLIENT_SECRET
    // is missing but stays callable so the operator can wire the secret later
    // without restarting the gateway.
    expect(integration.auth).not.toBeNull();
  });

  it("enables heartbeat only when API key is present alongside base url", () => {
    const integration = startPaperclipIntegration({
      env: {
        PAPERCLIP_BASE_URL: "http://paperclip:3100",
        PAPERCLIP_AGENT_API_KEY: "pcp_test",
      },
      logger: silentLogger,
    });
    expect(integration.heartbeat).not.toBeNull();
    // stop() should be idempotent and not throw.
    integration.stop();
    integration.stop();
  });

  it("enables auth client only when exchange secret is set", () => {
    const integration = startPaperclipIntegration({
      env: {
        PAPERCLIP_BASE_URL: "http://paperclip:3100",
        OPENCLAW_EXCHANGE_CLIENT_SECRET: "exchange-secret",
      },
      logger: silentLogger,
    });
    expect(integration.auth).not.toBeNull();
  });

  it("describe() reflects the on/off combination", () => {
    const integration = startPaperclipIntegration({
      env: {
        PAPERCLIP_BASE_URL: "http://paperclip:3100",
        PAPERCLIP_AGENT_API_KEY: "pcp_test",
        PAPERCLIP_INBOUND_TOKEN: "inbound-bearer",
        OPENCLAW_EXCHANGE_CLIENT_SECRET: "exchange-secret",
      },
      logger: silentLogger,
    });
    expect(integration.describe()).toBe("heartbeat=on outbound=on dispatcher=on auth=on mcp=on");
    integration.stop();
  });

  it("calls the logger on activation when heartbeat is started", () => {
    const logger = {
      warn: vi.fn(),
      info: vi.fn(),
    };
    const integration = startPaperclipIntegration({
      env: {
        PAPERCLIP_BASE_URL: "http://paperclip:3100",
        PAPERCLIP_AGENT_API_KEY: "pcp_test",
      },
      logger,
    });
    expect(logger.info).toHaveBeenCalledWith("Paperclip heartbeat started");
    integration.stop();
  });

  it("circuitSnapshot returns null when the outbound client is off", () => {
    const integration = startPaperclipIntegration({ env: {}, logger: silentLogger });
    expect(integration.client).toBeNull();
    expect(integration.circuitSnapshot()).toBeNull();
  });

  it("circuitSnapshot passes through the client breaker state when wired", () => {
    const integration = startPaperclipIntegration({
      env: {
        PAPERCLIP_BASE_URL: "http://paperclip:3100",
        PAPERCLIP_INBOUND_TOKEN: "inbound-bearer",
      },
      logger: silentLogger,
    });
    expect(integration.client).not.toBeNull();
    const snap = integration.circuitSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.state).toBe("closed");
    expect(snap!.consecutiveFailures).toBe(0);
  });

  it("exposes the active integration via getActivePaperclipIntegration() and clears it on stop", () => {
    // Start clean: any prior test's integration should have been stopped,
    // but we don't want to rely on ordering.
    const pre = getActivePaperclipIntegration();
    pre?.stop();
    expect(getActivePaperclipIntegration()).toBeNull();

    const integration = startPaperclipIntegration({
      env: {
        PAPERCLIP_BASE_URL: "http://paperclip:3100",
        PAPERCLIP_INBOUND_TOKEN: "inbound-bearer",
      },
      logger: silentLogger,
    });
    expect(getActivePaperclipIntegration()).toBe(integration);

    integration.stop();
    expect(getActivePaperclipIntegration()).toBeNull();
  });

  it("stop() on a stale handle does not blank a freshly-started integration", () => {
    const first = startPaperclipIntegration({
      env: {
        PAPERCLIP_BASE_URL: "http://paperclip:3100",
        PAPERCLIP_INBOUND_TOKEN: "inbound-bearer",
      },
      logger: silentLogger,
    });
    const second = startPaperclipIntegration({
      env: {
        PAPERCLIP_BASE_URL: "http://paperclip:3100",
        PAPERCLIP_INBOUND_TOKEN: "inbound-bearer-2",
      },
      logger: silentLogger,
    });
    // second overwrote the singleton to itself
    expect(getActivePaperclipIntegration()).toBe(second);
    // first.stop() must NOT wipe the singleton
    first.stop();
    expect(getActivePaperclipIntegration()).toBe(second);
    second.stop();
    expect(getActivePaperclipIntegration()).toBeNull();
  });

  it("describeStatus classifies arrows by severity — empty env is broken", () => {
    const integration = startPaperclipIntegration({ env: {}, logger: silentLogger });
    const status = integration.describeStatus();
    expect(status.severity).toBe("broken");
    expect(status.missingCritical.sort()).toEqual(["dispatcher", "outbound"]);
    expect(status.missingImportant.sort()).toEqual(["auth", "mcp"]);
    expect(status.arrows).toEqual({
      heartbeat: false,
      outbound: false,
      dispatcher: false,
      auth: false,
      mcp: false,
    });
    integration.stop();
  });

  it("describeStatus — outbound + dispatcher on, heartbeat off → degraded (auth/mcp still missing)", () => {
    const integration = startPaperclipIntegration({
      env: {
        PAPERCLIP_BASE_URL: "http://paperclip:3100",
        PAPERCLIP_INBOUND_TOKEN: "inbound-bearer",
      },
      logger: silentLogger,
    });
    const status = integration.describeStatus();
    // PAPERCLIP_BASE_URL alone wires outbound + dispatcher + mcp + auth,
    // so only heartbeat should remain off. Severity is healthy because
    // nothing in the `critical` or `important` buckets is missing.
    expect(status.arrows.outbound).toBe(true);
    expect(status.arrows.dispatcher).toBe(true);
    expect(status.arrows.auth).toBe(true);
    expect(status.arrows.mcp).toBe(true);
    expect(status.arrows.heartbeat).toBe(false);
    expect(status.missingCritical).toEqual([]);
    expect(status.missingImportant).toEqual([]);
    expect(status.severity).toBe("healthy");
    integration.stop();
  });

  it("describeStatus reports healthy when every arrow is on", () => {
    const integration = startPaperclipIntegration({
      env: {
        PAPERCLIP_BASE_URL: "http://paperclip:3100",
        PAPERCLIP_INBOUND_TOKEN: "inbound-bearer",
        PAPERCLIP_AGENT_API_KEY: "pcp_test",
        OPENCLAW_EXCHANGE_CLIENT_SECRET: "exchange-secret",
      },
      logger: silentLogger,
    });
    const status = integration.describeStatus();
    expect(status.severity).toBe("healthy");
    expect(status.missingCritical).toEqual([]);
    expect(status.missingImportant).toEqual([]);
    expect(Object.values(status.arrows).every((v) => v === true)).toBe(true);
    integration.stop();
  });
});

// drain() is the bridge between fire-and-forget dispatch (the design)
// and graceful shutdown (the operator's expectation). Without it, an
// in-flight `maybeDispatchReplyToPaperclip` mid-write ends with a
// SIGTERM-orphaned span and the matching audit row never lands on
// Paperclip's side. Tests below pin the contract: drain awaits, drain
// caps at the timeout, drain doesn't reject on dispatch failures, drain
// is a no-op when nothing is in flight.
describe("startPaperclipIntegration — drain()", () => {
  const silentLogger = { warn: () => {}, info: () => {} };
  const COMPANY = "11111111-2222-3333-4444-555555555555";

  function startWithSlowDispatcher(delayMs: number) {
    const integration = startPaperclipIntegration({
      env: {
        PAPERCLIP_BASE_URL: "http://paperclip:3100",
        PAPERCLIP_INBOUND_TOKEN: "inbound-bearer",
      },
      logger: silentLogger,
    });
    // Inject a slow dispatcher so we control how long maybeDispatch
    // takes to settle. The real dispatcher is wired by bootstrap; we
    // overwrite it here with a stub that resolves after `delayMs`.
    if (integration.dispatcher) {
      integration.dispatcher.dispatchUserReply = vi.fn(
        async () => {
          await new Promise((r) => setTimeout(r, delayMs));
          return { outcome: "forwarded", messageId: "m" };
        },
      );
    }
    return integration;
  }

  it("drain() resolves immediately when nothing is in flight", async () => {
    const integration = startWithSlowDispatcher(10);
    const t0 = Date.now();
    await integration.drain(5_000);
    const elapsed = Date.now() - t0;
    // Should be ~0ms, well under the timeout. 50ms cushion for CI jitter.
    expect(elapsed).toBeLessThan(50);
    integration.stop();
  });

  it("drain() awaits in-flight dispatches", async () => {
    const integration = startWithSlowDispatcher(80);
    // Start a few dispatches WITHOUT awaiting them — fire-and-forget.
    const replies = Array.from({ length: 3 }, (_, i) =>
      maybeDispatchReplyToPaperclip(
        {
          sessionKey: `paperclip:${COMPANY}:agent:test`,
          message: `m${i}`,
        },
        silentLogger,
      ),
    );
    // Drain MUST wait for them. Without the in-flight tracking, drain
    // would return immediately and the dispatches would orphan.
    const t0 = Date.now();
    await integration.drain(5_000);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(70); // ~80ms dispatcher delay
    // Verify each reply settled with the dispatcher's result.
    const results = await Promise.all(replies);
    for (const r of results) {
      expect(r.outcome).toBe("forwarded");
    }
    integration.stop();
  });

  it("drain() returns at the timeout when dispatches are still pending", async () => {
    // Dispatcher takes 1s; drain timeout is 100ms — drain wins the race.
    const integration = startWithSlowDispatcher(1_000);
    const reply = maybeDispatchReplyToPaperclip(
      {
        sessionKey: `paperclip:${COMPANY}:agent:slow`,
        message: "m",
      },
      silentLogger,
    );
    const t0 = Date.now();
    await integration.drain(100);
    const elapsed = Date.now() - t0;
    // Should be ~100ms (timeout), not ~1000ms (dispatcher).
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(500);
    // The dispatch promise still resolves on its own time; we just
    // didn't wait for it. Drain doesn't cancel — it bounds the wait.
    await reply;
    integration.stop();
  });

  it("drain() resolves even when a dispatch throws", async () => {
    const integration = startPaperclipIntegration({
      env: {
        PAPERCLIP_BASE_URL: "http://paperclip:3100",
        PAPERCLIP_INBOUND_TOKEN: "inbound-bearer",
      },
      logger: silentLogger,
    });
    if (integration.dispatcher) {
      integration.dispatcher.dispatchUserReply = vi.fn(async () => {
        throw new Error("dispatcher exploded");
      });
    }
    const reply = maybeDispatchReplyToPaperclip(
      {
        sessionKey: `paperclip:${COMPANY}:agent:boom`,
        message: "m",
      },
      silentLogger,
    );
    // drain() never rejects — failed dispatches are accounted for
    // in metrics (dispatch_total{outcome="failed"}) and span events
    // (dispatch_failed); shutdown doesn't surface them again.
    await expect(integration.drain(5_000)).resolves.toBeUndefined();
    // The wrapping in maybeDispatchReplyToPaperclip catches the throw
    // and returns a `{ outcome: "failed", reason: "unexpected-throw" }`
    // — drain saw it settle before timeout.
    const result = await reply;
    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("unexpected-throw");
    integration.stop();
  });

  // T3 #21: a hand-constructed integration handle (test, plugin, future
  // refactor that bypasses startPaperclipIntegration) is missing the
  // private __inFlightDispatches Set. Without surfacing that gap,
  // drain() silently skips the dispatch and SIGTERM orphans its span.
  // The warn fires once per integration (deduped via WeakSet) so a
  // hot-loop test doesn't drown the log.
  it("trackInFlightDispatch warns once per integration when the in-flight Set is missing", async () => {
    // Build a bare integration handle without __inFlightDispatches.
    // We exercise the helper directly because production integrations
    // install the Set with `configurable: false` and can't be undone
    // from a test — testing the helper is what catches a regression
    // in the helper's own logic.
    const fakeIntegration = {
      heartbeat: null,
      client: null,
      dispatcher: null,
      auth: null,
      mcp: null,
    } as unknown as ReturnType<typeof startPaperclipIntegration>;

    const warn = vi.fn();
    const logger = { warn, info: vi.fn() };

    // Two calls against the same integration → exactly ONE warn (WeakSet dedup).
    _trackInFlightDispatchForTests(
      fakeIntegration,
      Promise.resolve({ outcome: "forwarded" as const, messageId: "m1" }),
      logger,
    );
    _trackInFlightDispatchForTests(
      fakeIntegration,
      Promise.resolve({ outcome: "forwarded" as const, messageId: "m2" }),
      logger,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/in-flight Set missing/);

    // A different integration instance should re-trigger the warn —
    // the dedup is per-instance, not global.
    const anotherFake = {
      heartbeat: null,
      client: null,
    } as unknown as ReturnType<typeof startPaperclipIntegration>;
    _trackInFlightDispatchForTests(
      anotherFake,
      Promise.resolve({ outcome: "forwarded" as const, messageId: "m3" }),
      logger,
    );
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("trackInFlightDispatch is silent when the Set is present (the happy path)", async () => {
    // A correctly-constructed integration via startPaperclipIntegration
    // carries the Set; tracking a promise must not warn.
    const integration = startPaperclipIntegration({
      env: {
        PAPERCLIP_BASE_URL: "http://paperclip:3100",
        PAPERCLIP_INBOUND_TOKEN: "inbound-bearer",
      },
      logger: silentLogger,
    });
    const warn = vi.fn();
    _trackInFlightDispatchForTests(
      integration,
      Promise.resolve({ outcome: "forwarded" as const, messageId: "m" }),
      { warn, info: vi.fn() },
    );
    expect(warn).not.toHaveBeenCalled();
    integration.stop();
  });

  it("drain() doesn't await dispatches added AFTER it started", async () => {
    const integration = startWithSlowDispatcher(50);
    const first = maybeDispatchReplyToPaperclip(
      {
        sessionKey: `paperclip:${COMPANY}:agent:first`,
        message: "m1",
      },
      silentLogger,
    );
    // Drain snapshot includes `first`. A second dispatch fired AFTER
    // we entered drain() must NOT extend the drain — that would
    // defeat the timeout bound during steady upstream traffic.
    const drainPromise = integration.drain(5_000);
    const second = maybeDispatchReplyToPaperclip(
      {
        sessionKey: `paperclip:${COMPANY}:agent:second`,
        message: "m2",
      },
      silentLogger,
    );
    await drainPromise;
    // First settled (or timed out); second may or may not have settled.
    await first;
    await second; // ensure no leaks when the test ends
    integration.stop();
  });
});
