/**
 * Bridge span helpers — OpenTelemetry spans for the Avelton-claw side of
 * the Paperclip bridge. Symmetric with
 * paperclip-avelton/server/src/observability/spans.ts so a trace in Tempo
 * groups both sides of a hop under consistent attributes
 * (`bridge.direction`, `bridge.correlation_id`, `bridge.error_category`,
 * and the OTel-standard `http.*` / `peer.*` keys).
 *
 * Same design constraints as the Paperclip side:
 *   1. @opentelemetry/api is optional — `setBridgeTracer()` wires a real
 *      tracer once `startPaperclipOtel()` succeeds; otherwise every
 *      `withBridgeSpan()` is a zero-allocation passthrough.
 *   2. No throws: a broken tracer must not break the bridge.
 *   3. The shape of MinimalSpan / MinimalTracer mirrors the surface
 *      of @opentelemetry/api we actually use, so this file stays typed
 *      without depending on the package at compile time.
 */

type Logger = {
  warn(msg: string, ...args: unknown[]): void;
  info?(msg: string, ...args: unknown[]): void;
};

const noopLogger: Logger = { warn: () => undefined };

let warnSink: Logger = noopLogger;

export function setBridgeSpansLogger(logger: Logger): void {
  warnSink = logger;
}

export type SpanAttributes = Record<string, string | number | boolean | undefined>;

/**
 * Direction vocabulary. Mirrors `BridgeDirection` in Paperclip. The
 * Avelton-claw side emits outbound (postInbound, exchange, heartbeat,
 * mcp-call) spans; Paperclip emits the inverse directions on its side,
 * so when a span's direction is "outbound" *here* Paperclip records
 * "inbound" for the corresponding hop. Keep both sides in sync — the
 * Tempo dashboards join on `bridge.correlation_id` and assume the
 * vocabulary is stable.
 */
export type BridgeDirection = "outbound" | "inbound" | "exchange" | "circuit";

export interface StandardBridgeAttributes {
  "bridge.direction"?: BridgeDirection;
  "bridge.company_id"?: string;
  "bridge.correlation_id"?: string;
  "bridge.session_key"?: string;
  "bridge.error_category"?: string;
  "bridge.has_traceparent"?: boolean;
  "http.url"?: string;
  "http.status_code"?: number;
  "peer.service"?: string;
}

export type SpanStatusCode = "ok" | "error";

interface MinimalSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  recordException(err: unknown): void;
  addEvent?(name: string, attrs?: Record<string, string | number | boolean>): void;
  end(): void;
}

interface MinimalTracer {
  startSpan(
    name: string,
    options?: { attributes?: Record<string, string | number | boolean> },
  ): MinimalSpan;
}

let activeTracer: MinimalTracer | null = null;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

/**
 * Wire a tracer from `@opentelemetry/api`'s `trace.getTracer(...)` once
 * OTel is initialised. Passing null disables span emission.
 */
export function setBridgeTracer(tracer: MinimalTracer | null): void {
  activeTracer = tracer;
}

/**
 * Context passed into the `withBridgeSpan` callback, exposing the
 * narrow subset of span operations call sites actually need. Zero
 * overhead when no tracer is wired — `addEvent` becomes a no-op.
 * Callers can keep their old `() => ...` signature and simply ignore
 * the argument.
 */
export interface BridgeSpanContext {
  addEvent(name: string, attrs?: Record<string, string | number | boolean>): void;
}

const NOOP_SPAN_CONTEXT: BridgeSpanContext = {
  addEvent: () => undefined,
};

/**
 * Run `fn` inside a span named `name`. Zero overhead when no tracer is
 * wired — the wrapper degrades to `return fn()`. The span's status is
 * marked from the resolved value when it has an `{ ok, status, ... }`
 * shape (the POSTInbound / exchange / MCP result conventions).
 *
 * The callback receives a `BridgeSpanContext` so call sites can attach
 * events (e.g. dispatcher "dispatch_failed") without plumbing the raw
 * `MinimalSpan` through. Callers that don't need events keep using
 * `() => fn()` — TS tolerates the unused parameter.
 */
export async function withBridgeSpan<T>(
  name: string,
  attrs: SpanAttributes,
  fn: (ctx: BridgeSpanContext) => Promise<T>,
): Promise<T> {
  const tracer = activeTracer;
  if (!tracer) {
    return fn(NOOP_SPAN_CONTEXT);
  }

  let span: MinimalSpan;
  try {
    const cleanAttrs = filterDefinedAttributes(attrs);
    span = tracer.startSpan(name, { attributes: cleanAttrs });
  } catch (err) {
    warnSink.warn(
      `withBridgeSpan: tracer.startSpan threw for ${name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return fn(NOOP_SPAN_CONTEXT);
  }

  const ctx: BridgeSpanContext = {
    addEvent(eventName, eventAttrs) {
      try {
        span.addEvent?.(eventName, eventAttrs);
      } catch {
        // A broken tracer must not break the bridge.
      }
    },
  };

  try {
    const value = await fn(ctx);
    annotateResult(span, value);
    return value;
  } catch (err) {
    try {
      span.recordException(err);
      span.setStatus({ code: STATUS_ERROR, message: errorMessage(err) });
    } catch {
      // ignore
    }
    throw err;
  } finally {
    try {
      span.end();
    } catch {
      // ignore
    }
  }
}

/**
 * Synchronous span-event helper — used by the circuit breaker to attach
 * state-transition events to the current span, if any. No-op when no
 * tracer is wired.
 *
 * Note: without the OTel active-span API, we have no way to find the
 * *current* span from here; the caller must pass the target span
 * explicitly or — in the typical case — emit the event directly from
 * inside its own `withBridgeSpan` body.
 *
 * This helper is therefore intentionally narrow: it exists so the
 * circuit breaker can log a structured line AND (when it already holds
 * a `MinimalSpan` reference via the tracer) attach an event. In
 * practice the circuit breaker's log is the primary signal; OTel is
 * complementary.
 */
export function recordSpanEvent(
  span: MinimalSpan | null,
  name: string,
  attrs: Record<string, string | number | boolean> = {},
): void {
  if (!span) return;
  try {
    span.addEvent?.(name, attrs);
  } catch {
    // ignore
  }
}

/**
 * Standalone span emitted on every circuit-breaker transition.
 *
 * Why a span and not just a log line: the circuit breaker's `onTransition`
 * listener has no current OTel span to attach an event to (transitions
 * fire from `allow()` which is sometimes inside a request span and
 * sometimes from background bookkeeping). A one-shot span instead is
 * universally visible — it appears as its own row in Tempo regardless of
 * call context, and operators investigating "the bridge tripped at
 * 12:34" can find it by name without grepping logs.
 *
 * The span is started and ended immediately (zero-duration) so it
 * doesn't pollute latency series; the relevant data lives in
 * attributes. The `arrow` label distinguishes which breaker tripped
 * (paperclip_outbound / paperclip_auth / paperclip_mcp) and matches the
 * label on the Prometheus circuit_state gauge so a Grafana panel and a
 * Tempo trace can be cross-referenced one-to-one.
 *
 * Crucially the span fires on EVERY transition reason, including the
 * easy-to-miss `idle_timeout` (half_open → closed when no probe
 * arrived during the idle window). Without it, a quiet bridge that
 * silently auto-recovers leaves no Tempo footprint, and an operator
 * later trying to answer "did the breaker reset cleanly?" has only the
 * Prometheus gauge to consult — which can't tell them whether the
 * transition was a deliberate probe or an idle-timeout no-op.
 *
 * No-op when no tracer is wired (OTel disabled).
 */
export function recordCircuitTransitionSpan(
  arrow: string,
  transition: {
    from: string;
    to: string;
    reason: string;
    at: number;
  },
): void {
  const tracer = activeTracer;
  if (!tracer) return;
  let span: MinimalSpan;
  try {
    span = tracer.startSpan("openclaw.paperclip.circuit.transition", {
      attributes: {
        "bridge.direction": "circuit",
        "bridge.arrow": arrow,
        "bridge.circuit.from": transition.from,
        "bridge.circuit.to": transition.to,
        "bridge.circuit.reason": transition.reason,
        // Open and idle_timeout are the operator-relevant transitions —
        // mark them as ERROR / OK respectively so Tempo's filter-by-status
        // surfaces them. cooldown_expired and probe_success are normal
        // recovery noise.
        "peer.service": "paperclip",
      },
    });
  } catch (err) {
    warnSink.warn(
      `recordCircuitTransitionSpan: tracer.startSpan threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  try {
    // An open transition is the operator's interest signal — paint the
    // span red. idle_timeout, cooldown_expired and probe_success are
    // recovery / probing transitions, kept OK so the search "errors
    // only" returns just trips, not the cleanup that follows.
    span.setStatus({
      code: transition.to === "open" ? STATUS_ERROR : STATUS_OK,
    });
  } catch {
    // ignore
  }
  try {
    span.end();
  } catch {
    // ignore
  }
}

function annotateResult(span: MinimalSpan, value: unknown): void {
  if (value && typeof value === "object") {
    const obj = value as {
      ok?: boolean;
      status?: number;
      latencyMs?: number;
      errorCategory?: string | null;
      outcome?: string;
      reason?: string;
    };
    if (typeof obj.ok === "boolean") {
      try {
        span.setAttribute("bridge.ok", obj.ok);
        if (typeof obj.status === "number") {
          span.setAttribute("http.status_code", obj.status);
        }
        if (typeof obj.latencyMs === "number") {
          span.setAttribute("bridge.latency_ms", obj.latencyMs);
        }
        if (typeof obj.errorCategory === "string" && obj.errorCategory.length > 0) {
          span.setAttribute("bridge.error_category", obj.errorCategory);
        }
        span.setStatus({ code: obj.ok ? STATUS_OK : STATUS_ERROR });
      } catch {
        // ignore
      }
      return;
    }
    // Dispatcher-style result shape: `{ outcome, reason? }`. Treat
    // "forwarded" and "skipped" as OK (skipped is a benign no-op when
    // the session isn't Paperclip); "failed" is an error so the span
    // shows red in Tempo.
    if (typeof obj.outcome === "string") {
      try {
        span.setAttribute("bridge.outcome", obj.outcome);
        if (typeof obj.reason === "string" && obj.reason.length > 0) {
          span.setAttribute("bridge.error_category", obj.reason);
        }
        span.setStatus({
          code: obj.outcome === "failed" ? STATUS_ERROR : STATUS_OK,
        });
      } catch {
        // ignore
      }
      return;
    }
  }
  try {
    span.setStatus({ code: STATUS_OK });
  } catch {
    // ignore
  }
}

function filterDefinedAttributes(attrs: SpanAttributes): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
