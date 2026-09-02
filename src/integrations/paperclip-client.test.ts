import { describe, expect, it, vi } from "vitest";
import {
  createPaperclipClient,
  deriveInboundUrl,
  resolvePaperclipClientConfig,
  type PaperclipClientConfig,
} from "./paperclip-client.js";
import type { PaperclipCircuit, CircuitSnapshot } from "./paperclip-circuit.js";

describe("resolvePaperclipClientConfig", () => {
  it("returns null when neither PAPERCLIP_BASE_URL nor PAPERCLIP_INBOUND_URL is set", () => {
    expect(resolvePaperclipClientConfig({})).toBeNull();
  });

  it("picks up both base and explicit inbound URL, plus the token", () => {
    const cfg = resolvePaperclipClientConfig({
      PAPERCLIP_BASE_URL: "http://paperclip:3100",
      PAPERCLIP_INBOUND_URL: "http://paperclip:3100/custom/inbound",
      PAPERCLIP_INBOUND_TOKEN: "tkn",
    });
    expect(cfg).toEqual({
      baseUrl: "http://paperclip:3100",
      inboundUrl: "http://paperclip:3100/custom/inbound",
      inboundToken: "tkn",
    });
  });
});

describe("deriveInboundUrl", () => {
  it("honors explicit override", () => {
    const cfg: PaperclipClientConfig = {
      baseUrl: "http://paperclip:3100",
      inboundUrl: "https://custom/inbound",
    };
    expect(deriveInboundUrl(cfg)).toBe("https://custom/inbound");
  });

  it("derives from base URL", () => {
    expect(deriveInboundUrl({ baseUrl: "http://paperclip:3100/" })).toBe(
      "http://paperclip:3100/api/integrations/openclaw/inbound",
    );
  });

  it("returns null when nothing is set", () => {
    expect(deriveInboundUrl({})).toBeNull();
  });
});

describe("createPaperclipClient", () => {
  it("returns null when no base URL is configured", () => {
    expect(createPaperclipClient(null)).toBeNull();
  });

  it("posts inbound payload with bearer auth and returns messageId on 201", async () => {
    const fetchImpl = vi.fn(async (_url, _init) => {
      return new Response(JSON.stringify({ id: "row-1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    const client = createPaperclipClient(
      {
        baseUrl: "http://paperclip:3100",
        inboundToken: "secret",
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(client).not.toBeNull();

    const res = await client!.postInbound({
      companyId: "11111111-1111-1111-1111-111111111111",
      sessionKey: "paperclip:x:y",
      message: "hi",
      inReplyToCorrelationId: "corr-1",
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(201);
    expect(res.messageId).toBe("row-1");
    expect(res.idempotent).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe("http://paperclip:3100/api/integrations/openclaw/inbound");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
  });

  it("recognizes the 200 idempotent replay shape", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ id: "row-99", idempotent: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = createPaperclipClient(
      { baseUrl: "http://paperclip:3100", inboundToken: "tkn" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const res = await client!.postInbound({
      companyId: "c",
      sessionKey: "s",
      message: "m",
      idempotencyKey: "00000000-0000-0000-0000-000000000001",
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.idempotent).toBe(true);
    expect(res.messageId).toBe("row-99");
  });

  it("retries on 5xx, then gives up with ok=false", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return new Response("boom", { status: 502 });
    });
    const client = createPaperclipClient(
      { baseUrl: "http://paperclip:3100", inboundToken: "tkn" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const res = await client!.postInbound({ companyId: "c", sessionKey: "s", message: "m" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(502);
    // 1 initial + 2 retries = 3 calls.
    expect(calls).toBe(3);
  });

  it("does not retry on 4xx", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return new Response("bad", { status: 400 });
    });
    const client = createPaperclipClient(
      { baseUrl: "http://paperclip:3100", inboundToken: "tkn" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const res = await client!.postInbound({ companyId: "c", sessionKey: "s", message: "m" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(calls).toBe(1);
  });

  it("short-circuits without a network call when the circuit is open", async () => {
    // Hand the client a fake circuit whose allow() returns false. The
    // short-circuit branch in paperclip-client.ts must then:
    //   1. Return { ok: false, status: 503, latencyMs: 0 }
    //   2. NOT invoke fetchImpl at all
    //   3. NOT call recordFailure — the breaker already decided.
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch should not have been called while breaker is open");
    });
    const snapshot: CircuitSnapshot = {
      state: "open",
      consecutiveFailures: 10,
      openedAt: new Date().toISOString(),
      lastReachableAt: null,
      lastErrorAt: new Date().toISOString(),
      lastError: "upstream_down",
    };
    const fakeCircuit: PaperclipCircuit = {
      allow: vi.fn(() => false),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      snapshot: () => snapshot,
    };
    const client = createPaperclipClient(
      { baseUrl: "http://paperclip:3100", inboundToken: "tkn" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, circuit: fakeCircuit },
    );
    const res = await client!.postInbound({
      companyId: "c",
      sessionKey: "s",
      message: "m",
    });
    expect(res).toEqual({ ok: false, status: 503, latencyMs: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fakeCircuit.allow).toHaveBeenCalledOnce();
    expect(fakeCircuit.recordFailure).not.toHaveBeenCalled();
    expect(fakeCircuit.recordSuccess).not.toHaveBeenCalled();
  });

  it("exposes the circuit snapshot via client.circuit()", () => {
    const client = createPaperclipClient({
      baseUrl: "http://paperclip:3100",
      inboundToken: "tkn",
    });
    expect(client).not.toBeNull();
    const snap = client!.circuit().snapshot();
    expect(snap.state).toBe("closed");
    expect(snap.consecutiveFailures).toBe(0);
  });
});
