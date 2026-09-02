/**
 * W3C traceparent helpers for the Paperclip bridge.
 *
 * Synthesises a `version-traceId-spanId-flags` header on every outbound
 * arrow that originates from the gateway (heartbeat ticks, scheduled
 * exchange calls, service-account MCP loops). Without this, Paperclip's
 * bridge_audit rows carry null `trace_id` for those directions and
 * Tempo cannot stitch them into a trace.
 *
 * Does NOT replace an inbound traceparent when one is already present —
 * call sites should forward the caller's header if they have one (that
 * keeps a single distributed trace) and only fall back to
 * `generateTraceparent()` when starting a fresh call context.
 *
 * No `@opentelemetry/api` dependency: same rationale as spans.ts. The
 * header is trivially cheap to synthesise and this way stays testable
 * without wiring a real OTel SDK.
 */

import { randomBytes } from "node:crypto";

const TRACEPARENT_VERSION = "00";
/** `01` = sampled flag; matches the default NodeSDK emits. */
const TRACEPARENT_FLAGS = "01";

/**
 * Generate a fresh W3C traceparent header. The trace-id is 16 random
 * bytes (32 hex chars); span-id is 8 random bytes (16 hex chars). Both
 * are legal per spec (no all-zero values).
 *
 * Collision probability for trace-id across a month of gateway operation
 * is negligible (128 bits of entropy, birthday bound ~2^64 events).
 */
export function generateTraceparent(): string {
  // Reject the vanishingly unlikely all-zero value per W3C spec. The
  // loop terminates in one iteration with probability ≥ 1 − 2^-128.
  let traceId: string;
  do {
    traceId = randomBytes(16).toString("hex");
  } while (traceId === "00000000000000000000000000000000");

  let spanId: string;
  do {
    spanId = randomBytes(8).toString("hex");
  } while (spanId === "0000000000000000");

  return `${TRACEPARENT_VERSION}-${traceId}-${spanId}-${TRACEPARENT_FLAGS}`;
}

/**
 * Resolve the effective traceparent for an outbound call: forward the
 * caller-supplied value when present (preserves a distributed trace),
 * otherwise synthesise a fresh one. Returning the same shape in both
 * cases keeps call sites free of null-coalescing noise.
 */
export function resolveTraceparent(inbound?: string | null): string {
  if (typeof inbound === "string" && inbound.trim().length > 0) {
    return inbound.trim();
  }
  return generateTraceparent();
}

/**
 * Tracer accessor wired when `startPaperclipOtel()` succeeds — same
 * pattern as paperclip-spans.ts. When unset, `activeTraceparent()` is a
 * zero-allocation passthrough that returns undefined, so the caller
 * falls back to its existing synthesis path. Kept as a module-level
 * setter so the hot path (dispatchUserReply, bindUserMcp tool call)
 * never has to lazy-import @opentelemetry/api.
 */
type ActiveContextReader = () => { traceId: string; spanId: string } | null;
let activeContextReader: ActiveContextReader | null = null;

/** Wire a reader — called from paperclip-otel once @opentelemetry/api is
 * dynamically imported. `null` disables the lookup (used by tests). */
export function setActiveTraceContextReader(reader: ActiveContextReader | null): void {
  activeContextReader = reader;
}

/**
 * Read the current OTel active span and format it as a traceparent. Returns
 * undefined when no tracer is wired or no span is active. Call sites that
 * already have a caller-supplied traceparent should prefer that; this
 * helper only fills the gap between "no explicit traceparent" and "fresh
 * random trace-id" — so dispatcher hops chain onto the chat.send handler's
 * trace instead of starting a parallel one.
 */
export function activeTraceparent(): string | undefined {
  const reader = activeContextReader;
  if (!reader) return undefined;
  let ctx: { traceId: string; spanId: string } | null;
  try {
    ctx = reader();
  } catch {
    // Reader failure must not break the bridge — fall back to caller's
    // synthesis.
    return undefined;
  }
  if (!ctx) return undefined;
  const { traceId, spanId } = ctx;
  // W3C requires both ids to be non-zero. The OTel SDK emits compliant
  // values, but guard defensively — a misconfigured span could surface
  // all-zeros (spec-invalid) and we'd rather skip than ship that.
  if (
    !/^[0-9a-f]{32}$/.test(traceId) ||
    traceId === "00000000000000000000000000000000" ||
    !/^[0-9a-f]{16}$/.test(spanId) ||
    spanId === "0000000000000000"
  ) {
    return undefined;
  }
  return `${TRACEPARENT_VERSION}-${traceId}-${spanId}-${TRACEPARENT_FLAGS}`;
}
