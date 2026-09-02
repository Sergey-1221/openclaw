import { describe, expect, it, vi } from "vitest";
import {
  PaperclipMcpError,
  createPaperclipMcpClient,
  deriveMcpUrl,
  resolvePaperclipMcpConfig,
} from "./paperclip-mcp-client.js";

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("resolvePaperclipMcpConfig + deriveMcpUrl", () => {
  it("derives /api/mcp from base URL", () => {
    const cfg = resolvePaperclipMcpConfig({
      PAPERCLIP_BASE_URL: "http://paperclip:3100",
      PAPERCLIP_AGENT_API_KEY: "k",
    });
    expect(deriveMcpUrl(cfg!)).toBe("http://paperclip:3100/api/mcp");
  });

  it("honors explicit MCP URL override", () => {
    const cfg = resolvePaperclipMcpConfig({ PAPERCLIP_MCP_URL: "https://custom/mcp" });
    expect(deriveMcpUrl(cfg!)).toBe("https://custom/mcp");
  });

  it("returns null when nothing is set", () => {
    expect(resolvePaperclipMcpConfig({})).toBeNull();
  });
});

describe("createPaperclipMcpClient", () => {
  it("returns null when config is unavailable", () => {
    expect(createPaperclipMcpClient(null)).toBeNull();
  });

  it("throws when no bearer is available", async () => {
    const fetchImpl = vi.fn();
    const client = createPaperclipMcpClient(
      { baseUrl: "http://p" }, // no apiKey, no tokenProvider
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    await expect(client!.listTools()).rejects.toThrow(/No bearer available/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("listTools uses the static apiKey and returns the tools array", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [
            { name: "paperclip_issues_list", description: "" },
            { name: "paperclip_channel_send", description: "" },
          ],
        },
      }),
    );
    const client = createPaperclipMcpClient(
      { baseUrl: "http://p", apiKey: "pcp_k" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )!;
    const tools = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["paperclip_channel_send", "paperclip_issues_list"],
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer pcp_k");
  });

  it("forwards x-on-behalf-of when tokenProvider supplies logtoSubject", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    );
    const client = createPaperclipMcpClient(
      { baseUrl: "http://p" },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        tokenProvider: async () => ({ bearer: "scoped", logtoSubject: "logto:alice" }),
      },
    )!;
    await client.listTools();
    const [, init] = fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer scoped");
    expect(headers["x-on-behalf-of"]).toBe("logto:alice");
  });

  it("appends companyId query param for board-scoped contexts", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    );
    const client = createPaperclipMcpClient(
      { baseUrl: "http://p", apiKey: "k" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )!;
    await client.listTools({ companyId: "c-1" });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://p/api/mcp?companyId=c-1");
  });

  it("callTool parses the MCP content[0].text JSON body", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: JSON.stringify({ messageId: "m-1", delivered: true }) }],
        },
      }),
    );
    const client = createPaperclipMcpClient(
      { baseUrl: "http://p", apiKey: "k" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )!;
    const res = (await client.callTool("paperclip_channel_send", {
      sessionKey: "s",
      message: "m",
    })) as { messageId: string };
    expect(res.messageId).toBe("m-1");
  });

  it("surfaces JSON-RPC error envelopes as PaperclipMcpError", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "Unknown tool: nope" },
      }),
    );
    const client = createPaperclipMcpClient(
      { baseUrl: "http://p", apiKey: "k" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )!;
    await expect(client.callTool("nope", {})).rejects.toMatchObject({
      name: "PaperclipMcpError",
      code: -32601,
    });
  });

  it("surfaces non-2xx HTTP responses as PaperclipMcpError with httpStatus", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const client = createPaperclipMcpClient(
      { baseUrl: "http://p", apiKey: "k" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )!;
    await expect(client.listTools()).rejects.toMatchObject({
      name: "PaperclipMcpError",
      httpStatus: 401,
    });
  });

  // T3 #19: response-id mismatch detection. JSON-RPC §5 requires the
  // response id to equal the request id. On a one-call-per-HTTP
  // transport like ours, mismatch indicates response misrouting or a
  // Paperclip bug. We don't throw (operator wants the dashboard signal,
  // not a hard fail on every mismatch) but we log + record a circuit
  // failure so dashboards see "rpc_id_mismatch" in the failure
  // categories.
  it("logs and records a circuit failure when the response id doesn't match the request id", async () => {
    // Mock returns a fixed numeric id `99` regardless of what client sent.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 99,
        result: { tools: [] },
      }),
    );
    const warn = vi.fn();
    const recordFailure = vi.fn();
    const circuit = {
      allow: () => true,
      recordSuccess: () => undefined,
      recordFailure,
      snapshot: () => ({
        state: "closed" as const,
        consecutiveFailures: 0,
        openedAt: null,
        lastReachableAt: null,
        lastErrorAt: null,
        lastError: null,
      }),
    };
    const client = createPaperclipMcpClient(
      { baseUrl: "http://p", apiKey: "k" },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        circuit: circuit as never,
        logger: { warn },
      },
    )!;
    // Call must still succeed (we don't throw on mismatch — see
    // implementation comment for the rationale).
    const tools = await client.listTools();
    expect(tools).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/response id mismatch/i);
    expect(recordFailure).toHaveBeenCalledWith("rpc_id_mismatch");
  });

  it("does NOT log a mismatch warning when the response id matches", async () => {
    // Capture the sent id and echo it back — the happy path must
    // never trigger the mismatch warning.
    let sentId: unknown = null;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { id: unknown };
      sentId = body.id;
      return jsonResponse({ jsonrpc: "2.0", id: sentId, result: { tools: [] } });
    });
    const warn = vi.fn();
    const recordFailure = vi.fn();
    const circuit = {
      allow: () => true,
      recordSuccess: () => undefined,
      recordFailure,
      snapshot: () => ({
        state: "closed" as const,
        consecutiveFailures: 0,
        openedAt: null,
        lastReachableAt: null,
        lastErrorAt: null,
        lastError: null,
      }),
    };
    const client = createPaperclipMcpClient(
      { baseUrl: "http://p", apiKey: "k" },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        circuit: circuit as never,
        logger: { warn },
      },
    )!;
    await client.listTools();
    expect(warn).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
  });

  // JSON-RPC id contract: must be a v4 UUID string and unique across
  // back-to-back calls. The previous implementation used a sequential
  // counter, which collided past 2^53 in long-lived processes and reused
  // ids across hot-restarts. This test pins both invariants — a regression
  // back to a counter would fail on the UUID-shape assertion immediately.
  it("emits unique UUID v4 ids per request (no sequential counter)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ jsonrpc: "2.0", id: "any", result: { tools: [] } }),
    );
    const client = createPaperclipMcpClient(
      { baseUrl: "http://p", apiKey: "k" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )!;
    await client.listTools();
    await client.listTools();
    await client.listTools();

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const ids = fetchImpl.mock.calls.map((call) => {
      const [, init] = call as unknown as [unknown, RequestInit];
      const body = JSON.parse(init.body as string) as { id: unknown };
      return body.id;
    });
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      expect(typeof id).toBe("string");
      expect(id as string).toMatch(uuidRe);
    }
    // Uniqueness: a Set of size 3 proves no duplicates.
    expect(new Set(ids).size).toBe(3);
  });
});
