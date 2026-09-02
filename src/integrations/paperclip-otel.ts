/**
 * OpenTelemetry initialization for the Avelton-claw side of the bridge.
 *
 * Symmetrical to paperclip-avelton/server/src/observability/otel.ts —
 * both ends emit to the same OTLP collector so a single trace covers
 * the OpenClaw → Paperclip → DB call path.
 *
 * Activated only when OTEL_EXPORTER_OTLP_ENDPOINT is set. The
 * @opentelemetry/* packages are loaded via dynamic import so that
 * deployments without observability don't pay the dependency cost. To
 * enable tracing, an operator installs:
 *
 *   pnpm add @opentelemetry/api @opentelemetry/sdk-node \
 *            @opentelemetry/exporter-trace-otlp-http \
 *            @opentelemetry/auto-instrumentations-node \
 *            @opentelemetry/resources @opentelemetry/semantic-conventions
 *
 * The W3C traceparent header that already flows through paperclip-client
 * (postInbound) and the inbound /hooks/paperclip handler is then
 * stitched into a real distributed trace in Tempo/Jaeger.
 */

import { setBridgeTracer, setBridgeSpansLogger } from "./paperclip-spans.js";
import { setActiveTraceContextReader } from "./paperclip-traceparent.js";

type Logger = {
  info?(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error?(msg: string, ...args: unknown[]): void;
};

let started = false;
let activeShutdown: (() => Promise<void>) | null = null;

export interface OtelStartResult {
  enabled: boolean;
  reason?: string;
}

/**
 * Initialise the OpenTelemetry NodeSDK if env opts in. Idempotent —
 * subsequent calls are no-ops. Returns immediately on success; SDK
 * runs in the background. Stop the SDK with stopPaperclipOtel() when
 * the gateway shuts down.
 */
export async function startPaperclipOtel(opts: { logger?: Logger } = {}): Promise<OtelStartResult> {
  if (started) return { enabled: true, reason: "already-started" };
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    return { enabled: false, reason: "OTEL_EXPORTER_OTLP_ENDPOINT not set" };
  }
  const logger: Logger = opts.logger ?? {
    warn: (msg, ...args) => console.warn("[paperclip-otel]", msg, ...args),
    info: (msg, ...args) => console.info("[paperclip-otel]", msg, ...args),
    error: (msg, ...args) => console.error("[paperclip-otel]", msg, ...args),
  };

  try {
    // Dynamic, untyped imports keep the integration portable across
    // deployments that may or may not have every @opentelemetry package
    // installed. The `as unknown` casts are deliberate — we accept the
    // upstream types are open-ended at this boundary.
    const modules = await Promise.all([
      // @opentelemetry/auto-instrumentations-node may not be installed
      // in minimal deployments; the catch below handles ERR_MODULE_NOT_FOUND.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      import("@opentelemetry/sdk-node" as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      import("@opentelemetry/exporter-trace-otlp-http" as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      import("@opentelemetry/auto-instrumentations-node" as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      import("@opentelemetry/resources" as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      import("@opentelemetry/semantic-conventions" as any),
    ]);
    const [sdkNode, otlpHttp, autoInstr, resourcesMod, semconv] = modules as unknown as [
      { NodeSDK: new (cfg: unknown) => { start: () => void; shutdown: () => Promise<void> } },
      { OTLPTraceExporter: new (cfg: { url: string }) => unknown },
      { getNodeAutoInstrumentations: (cfg?: unknown) => unknown[] },
      { Resource: new (attrs: Record<string, string>) => unknown },
      { SemanticResourceAttributes: { SERVICE_NAME: string; DEPLOYMENT_ENVIRONMENT: string } },
    ];
    const { NodeSDK } = sdkNode;
    const { OTLPTraceExporter } = otlpHttp;
    const { getNodeAutoInstrumentations } = autoInstr;
    const { Resource } = resourcesMod;
    const { SemanticResourceAttributes } = semconv;

    const serviceName = process.env.OTEL_SERVICE_NAME ?? "openclaw-gateway";
    const deployment = process.env.OTEL_DEPLOYMENT_ENVIRONMENT ?? process.env.NODE_ENV ?? "development";

    const sdk = new NodeSDK({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
        [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: deployment,
      }),
      traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` }),
      instrumentations: [
        getNodeAutoInstrumentations({
          // Per-fs-call spans are noise; keep the gateway's bridge spans
          // visible without thousands of file-read parents wrapping them.
          "@opentelemetry/instrumentation-fs": { enabled: false },
        }),
      ],
    });

    sdk.start();
    started = true;
    activeShutdown = () => sdk.shutdown();

    // Wire the bridge tracer so `withBridgeSpan(...)` call sites start
    // emitting named spans with our canonical attributes. The OTel API
    // package is imported dynamically here for the same reason as the
    // SDK — keep it optional.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (await import("@opentelemetry/api" as any)) as unknown as {
        trace: {
          getTracer: (name: string, version?: string) => unknown;
          getActiveSpan: () => {
            spanContext: () => { traceId: string; spanId: string };
          } | undefined;
        };
      };
      setBridgeTracer(api.trace.getTracer("paperclip-bridge") as never);
      setBridgeSpansLogger(logger);
      // Wire the active-context reader so outbound bridge calls that run
      // inside a gateway handler span (e.g. chat.send → dispatcher)
      // inherit the handler's trace_id/span_id when forming their
      // traceparent, instead of starting a parallel root trace.
      setActiveTraceContextReader(() => {
        const span = api.trace.getActiveSpan();
        if (!span) return null;
        const ctx = span.spanContext();
        return { traceId: ctx.traceId, spanId: ctx.spanId };
      });
    } catch (err) {
      logger.warn(
        `OTel tracer wiring failed — business-context spans will no-op: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    logger.info?.(`OpenTelemetry tracing enabled — endpoint=${endpoint} service=${serviceName} deployment=${deployment}`);
    return { enabled: true };
  } catch (err) {
    const isModuleNotFound =
      typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "ERR_MODULE_NOT_FOUND";
    if (isModuleNotFound) {
      logger.warn(
        "OTEL_EXPORTER_OTLP_ENDPOINT is set but @opentelemetry/* packages are missing. Install them to enable tracing.",
      );
      return { enabled: false, reason: "@opentelemetry packages not installed" };
    }
    logger.error?.("Failed to initialise OpenTelemetry", err);
    return { enabled: false, reason: "init failed" };
  }
}

/**
 * Stop the OTEL SDK. Safe to call when tracing is disabled or already
 * stopped — the function no-ops in those cases. Returns the shutdown
 * promise for callers that want to await draining.
 */
export async function stopPaperclipOtel(): Promise<void> {
  if (!activeShutdown) return;
  try {
    await activeShutdown();
  } catch {
    // Swallow — SDK shutdown errors during process exit shouldn't
    // mask the original termination reason.
  } finally {
    activeShutdown = null;
    started = false;
    // Drop the bridge tracer so any in-flight `withBridgeSpan` calls
    // degrade to passthrough instead of reaching into a torn-down SDK.
    setBridgeTracer(null);
    setActiveTraceContextReader(null);
  }
}
