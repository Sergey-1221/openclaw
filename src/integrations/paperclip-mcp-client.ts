/**
 * Avelton-claw → Paperclip MCP JSON-RPC client.
 *
 * A minimal remote-MCP client that speaks JSON-RPC 2.0 over HTTP to
 * Paperclip's MCP endpoint (POST /api/mcp). OpenClaw agents invoke
 * Paperclip tools through this client — list/call semantics mirror the
 * MCP protocol, so the return shape is the usual `tools/list` and
 * `tools/call` response vocabulary.
 *
 * Auth:
 *   - Legacy path: a static agent API key (PAPERCLIP_AGENT_API_KEY).
 *     All calls use that bearer, and the caller sees every tool in the
 *     global catalog. Suitable for the bridge service-account.
 *   - Per-user path: pass a `tokenProvider` that resolves a Paperclip
 *     bearer per invocation (typically driven by `paperclip-auth` —
 *     the Logto id_token → exchange flow). The client forwards
 *     `x-on-behalf-of` when a `logtoSubject` is supplied so Paperclip
 *     records the underlying human in its audit log.
 *
 * Error handling:
 *   - Network/timeout/non-2xx → throws PaperclipMcpError. Callers own
 *     retry policy (we don't retry here because `tools/call` may have
 *     side effects; replaying a POST is unsafe without an
 *     idempotencyKey convention).
 *   - JSON-RPC error envelopes → surfaced as PaperclipMcpError with
 *     the JSON-RPC code so callers can distinguish "bad method" from
 *     "bad HTTP".
 */

import { randomUUID } from "node:crypto";
import { withBridgeSpan } from "./paperclip-spans.js";
import { getActivePaperclipMetrics } from "./paperclip-metrics.js";
import type { PaperclipCircuit } from "./paperclip-circuit.js";

type Logger = {
  warn(msg: string, ...args: unknown[]): void;
};

export const DEFAULT_MCP_TIMEOUT_MS = 10_000;

export class PaperclipMcpError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "PaperclipMcpError";
  }
}

export interface PaperclipMcpConfig {
  /** Paperclip base URL, e.g. `http://paperclip:3100`. */
  baseUrl?: string;
  /** Explicit override for the MCP endpoint. */
  mcpUrl?: string;
  /** Static bearer for the legacy service-account auth path. */
  apiKey?: string;
}

export interface PaperclipMcpCallContext {
  /** Paperclip bearer token when using the per-user exchange flow. */
  bearer?: string;
  /** Logto subject of the human the call is on-behalf-of. */
  logtoSubject?: string;
  /** Optional W3C traceparent to propagate. */
  traceparent?: string;
  /** Optional companyId query param — required for board users. */
  companyId?: string;
}

export interface ResolvedTokenContext {
  bearer: string;
  logtoSubject?: string;
}

/** Token provider contract — caller resolves the bearer per-call. */
export type TokenProvider = (
  hint: { logtoSubject?: string; scopes?: string[] },
) => Promise<ResolvedTokenContext> | ResolvedTokenContext;

export function resolvePaperclipMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
): PaperclipMcpConfig | null {
  const mcpUrl = env.PAPERCLIP_MCP_URL?.trim();
  const baseUrl = env.PAPERCLIP_BASE_URL?.trim();
  const apiKey = env.PAPERCLIP_AGENT_API_KEY?.trim();
  if (!mcpUrl && !baseUrl) return null;
  return { baseUrl, mcpUrl, apiKey };
}

export function deriveMcpUrl(cfg: PaperclipMcpConfig): string | null {
  if (cfg.mcpUrl) return cfg.mcpUrl;
  if (!cfg.baseUrl) return null;
  const trimmed = cfg.baseUrl.replace(/\/+$/, "");
  return `${trimmed}/api/mcp`;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface PaperclipMcpClient {
  listTools(ctx?: PaperclipMcpCallContext): Promise<McpToolDescriptor[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    ctx?: PaperclipMcpCallContext,
  ): Promise<unknown>;
}

interface InternalDeps {
  logger?: Logger;
  fetchImpl?: typeof fetch;
  tokenProvider?: TokenProvider;
  timeoutMs?: number;
  /**
   * Optional circuit breaker for the MCP arrow. When present, `jsonRpc`
   * checks `circuit.allow()` before each call and fail-fasts when the
   * breaker is open. A runaway agent tool-call loop against a degraded
   * Paperclip would otherwise exhaust connection pools — the breaker
   * caps the cost of that failure mode.
   *
   * 4xx responses (bad bearer, missing scope) never trip the breaker —
   * those are deterministic per-request failures, not health signals.
   * 5xx, JSON-RPC server errors, and network/timeouts count as failures.
   */
  circuit?: PaperclipCircuit | null;
}

export function createPaperclipMcpClient(
  config?: PaperclipMcpConfig | null,
  deps: InternalDeps = {},
): PaperclipMcpClient | null {
  const cfg = config ?? resolvePaperclipMcpConfig();
  if (!cfg) return null;
  const url: string | null = deriveMcpUrl(cfg);
  if (!url) return null;
  // Capture post-narrowing URL so closures below keep `string` typing.
  const baseUrl: string = url;

  const fetchFn = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;

  async function resolveBearer(
    ctx: PaperclipMcpCallContext | undefined,
  ): Promise<ResolvedTokenContext | null> {
    if (ctx?.bearer) {
      // Caller already threaded a bearer — no work. Not span-wrapped
      // because there's nothing latency-wise to measure.
      return { bearer: ctx.bearer, logtoSubject: ctx.logtoSubject };
    }
    if (deps.tokenProvider) {
      // Wrap the provider call in a child span so Tempo shows it as a
      // grandchild of the enclosing MCP span. Without this, the
      // per-call latency of token exchange + cache lookup is opaque and
      // operators can't tell whether a slow MCP call is slow because
      // of the tool or because of the bearer resolution.
      return await withBridgeSpan(
        "openclaw.paperclip.auth.resolve_bearer",
        {
          "bridge.direction": "outbound",
          "bridge.company_id": ctx?.companyId,
          "peer.service": "paperclip",
        },
        async () => {
          const resolved = await deps.tokenProvider!({ logtoSubject: ctx?.logtoSubject });
          return resolved;
        },
      );
    }
    if (cfg!.apiKey) {
      return { bearer: cfg!.apiKey };
    }
    return null;
  }

  async function jsonRpc(
    method: string,
    params: Record<string, unknown> | undefined,
    ctx: PaperclipMcpCallContext | undefined,
  ): Promise<unknown> {
    return withBridgeSpan(
      `openclaw.paperclip.mcp.${method}`,
      {
        "bridge.direction": "outbound",
        "bridge.company_id": ctx?.companyId,
        "bridge.has_traceparent": ctx?.traceparent != null,
        "http.url": baseUrl,
        "peer.service": "paperclip",
      },
      async () => {
        const startedAt = Date.now();
        const metrics = getActivePaperclipMetrics();
        try {
          const result = await jsonRpcImpl(method, params, ctx);
          metrics?.recordRequest("mcp", "ok");
          metrics?.recordLatency("mcp", Date.now() - startedAt);
          return result;
        } catch (err) {
          const latencyMs = Date.now() - startedAt;
          let errorCategory = "unknown";
          let outcome: "error" | "timeout" = "error";
          if (err instanceof PaperclipMcpError && typeof err.httpStatus === "number") {
            errorCategory = `http_${err.httpStatus}`;
          } else if (err instanceof PaperclipMcpError && typeof err.code === "number") {
            errorCategory = `rpc_${err.code}`;
          } else if (err instanceof Error && err.name === "AbortError") {
            errorCategory = "network";
            outcome = "timeout";
          } else {
            errorCategory = "network";
          }
          metrics?.recordRequest("mcp", outcome, errorCategory);
          metrics?.recordLatency("mcp", latencyMs);
          throw err;
        }
      },
    );
  }

  async function jsonRpcImpl(
    method: string,
    params: Record<string, unknown> | undefined,
    ctx: PaperclipMcpCallContext | undefined,
  ): Promise<unknown> {
    const bearerCtx = await resolveBearer(ctx);
    if (!bearerCtx) {
      throw new PaperclipMcpError(
        "No bearer available for Paperclip MCP call — set PAPERCLIP_AGENT_API_KEY or supply a tokenProvider/ctx.bearer",
      );
    }
    // Fail-fast when the MCP breaker is open. Unlike the exchange path,
    // MCP has no cache — a closed breaker + open failure is the only
    // backpressure signal available.
    if (deps.circuit && !deps.circuit.allow()) {
      throw new PaperclipMcpError("Paperclip MCP circuit open — not calling");
    }
    // JSON-RPC 2.0 spec allows id to be a string, number, or null. We use
    // a random UUID per request rather than a sequential counter so a
    // long-lived gateway process can't collide ids past Number.MAX_SAFE_INTEGER
    // (2^53), and a hot-restart of the gateway can't reuse an id that's
    // still in flight on Paperclip's side. The collision risk on UUIDv4
    // is negligible (122 bits) compared to either failure mode.
    const id = randomUUID();
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });

    // companyId goes in the query string for board-user tokens; agent
    // keys carry their companyId implicitly, so the param is harmless.
    const targetUrl: string = ctx?.companyId ? `${baseUrl}?companyId=${encodeURIComponent(ctx.companyId)}` : baseUrl;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearerCtx.bearer}`,
    };
    if (bearerCtx.logtoSubject) headers["x-on-behalf-of"] = bearerCtx.logtoSubject;
    if (ctx?.traceparent) headers.traceparent = ctx.traceparent;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(targetUrl, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        // 5xx — count toward the breaker; 4xx — caller bug, don't.
        if (res.status >= 500) {
          deps.circuit?.recordFailure(`http_${res.status}`);
        }
        throw new PaperclipMcpError(
          `Paperclip MCP ${method} failed HTTP ${res.status}: ${text}`,
          undefined,
          res.status,
        );
      }
      const parsed = (await res.json()) as {
        jsonrpc: string;
        // string | number | null per JSON-RPC 2.0 §4. Paperclip echoes
        // whatever id we sent (UUID string today), but we keep the wider
        // union so older Paperclip releases that down-convert ids to a
        // numeric form remain decodeable.
        id: string | number | null;
        result?: unknown;
        error?: { code: number; message: string };
      };
      // JSON-RPC §5: response id MUST equal request id (same type, same
      // value). The MCP HTTP transport is one-call-per-HTTP so we do
      // not multiplex — a mismatch indicates a misrouted response, an
      // intermediary buffer corruption, or a Paperclip bug. Without
      // detection, the caller silently consumes the wrong response and
      // the operator sees "wrong tool result" with no audit trail.
      // We log + record a breaker failure (not throw) so a single
      // mismatch doesn't fail the call — but the failure category
      // surfaces in `openclaw_bridge_circuit_consecutive_failures` and
      // operators can investigate in their dashboard.
      if (parsed.id !== id) {
        deps.logger?.warn(
          `Paperclip MCP ${method}: response id mismatch (sent=${id}, got=${String(parsed.id)}) — ` +
            `this should never happen on a one-call-per-HTTP transport. Possible misrouted ` +
            `response, intermediary buffer corruption, or Paperclip MCP-server bug.`,
        );
        deps.circuit?.recordFailure("rpc_id_mismatch");
        // Continue rather than throw: the body might still carry a
        // useful result, and surfacing as a noisy throw on every
        // response would convert a debugging signal into a hard
        // failure. The metric + log is enough.
      }
      if (parsed.error) {
        // JSON-RPC server errors (-32000..-32099 range by spec). Negative
        // codes below -32000 indicate server-side faults analogous to
        // HTTP 5xx; the rest are caller bugs. Only the fault range trips
        // the breaker so a "tool not found" doesn't blackhole everyone.
        if (typeof parsed.error.code === "number" && parsed.error.code <= -32000 && parsed.error.code >= -32099) {
          deps.circuit?.recordFailure(`rpc_${parsed.error.code}`);
        }
        throw new PaperclipMcpError(
          `Paperclip MCP ${method}: ${parsed.error.message}`,
          parsed.error.code,
        );
      }
      // Success — close the breaker.
      deps.circuit?.recordSuccess();
      return parsed.result;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof PaperclipMcpError) throw err;
      // Network/abort — always a breaker-worthy failure.
      deps.circuit?.recordFailure(
        err instanceof Error && err.name === "AbortError" ? "timeout" : "network",
      );
      throw new PaperclipMcpError(`Paperclip MCP ${method}: ${String(err)}`);
    }
  }

  async function listTools(ctx?: PaperclipMcpCallContext): Promise<McpToolDescriptor[]> {
    const result = (await jsonRpc("tools/list", {}, ctx)) as {
      tools?: McpToolDescriptor[];
    } | null;
    return result?.tools ?? [];
  }

  async function callTool(
    name: string,
    args: Record<string, unknown>,
    ctx?: PaperclipMcpCallContext,
  ): Promise<unknown> {
    const result = (await jsonRpc(
      "tools/call",
      { name, arguments: args },
      ctx,
    )) as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | null;

    // MCP tools wrap their JSON return in a single "text" content entry.
    const text = result?.content?.[0]?.text;
    if (typeof text === "string") {
      try {
        const parsed = JSON.parse(text);
        if (result?.isError) {
          throw new PaperclipMcpError(
            `Paperclip MCP tool ${name} reported error: ${text}`,
          );
        }
        return parsed;
      } catch (err) {
        if (err instanceof PaperclipMcpError) throw err;
        // Not JSON — return the raw string so the caller can surface it.
        return text;
      }
    }
    return result;
  }

  return { listTools, callTool };
}
