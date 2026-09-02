import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { readSecretFromFile } from "../../acp/secret-file.js";
import type {
  GatewayAuthMode,
  GatewayBindMode,
  GatewayTailscaleMode,
} from "../../config/config.js";
import {
  CONFIG_PATH,
  loadConfig,
  readConfigFileSnapshot,
  resolveStateDir,
  resolveGatewayPort,
} from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasConfiguredSecretInput } from "../../config/types.secrets.js";
import { resolveGatewayAuth } from "../../gateway/auth.js";
import { defaultGatewayBindMode, isContainerEnvironment } from "../../gateway/net.js";
import type { GatewayWsLogStyle } from "../../gateway/ws-logging.js";
import { setGatewayWsLogStyle } from "../../gateway/ws-logging.js";
import { setVerbose } from "../../globals.js";
import { resolveControlUiRootSync } from "../../infra/control-ui-assets.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import { formatPortDiagnostics, inspectPortUsage } from "../../infra/ports.js";
import { cleanStaleGatewayProcessesSync } from "../../infra/restart-stale-pids.js";
import { detectRespawnSupervisor } from "../../infra/supervisor-markers.js";
import { setConsoleSubsystemFilter, setConsoleTimestampPrefix } from "../../logging/console.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { defaultRuntime } from "../../runtime.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { formatCliCommand } from "../command-format.js";
import { inheritOptionFromParent } from "../command-options.js";
import { forceFreePortAndWait, waitForPortBindable } from "../ports.js";
import { withProgress } from "../progress.js";
import { ensureDevGatewayConfig } from "./dev.js";
import { runGatewayLoop } from "./run-loop.js";
import {
  extractGatewayMiskeys,
  maybeExplainGatewayServiceStop,
  parsePort,
  toOptionString,
} from "./shared.js";

type GatewayRunOpts = {
  port?: unknown;
  bind?: unknown;
  token?: unknown;
  auth?: unknown;
  password?: unknown;
  passwordFile?: unknown;
  tailscale?: unknown;
  tailscaleResetOnExit?: boolean;
  allowUnconfigured?: boolean;
  force?: boolean;
  verbose?: boolean;
  cliBackendLogs?: boolean;
  claudeCliLogs?: boolean;
  wsLog?: unknown;
  compact?: boolean;
  rawStream?: boolean;
  rawStreamPath?: unknown;
  dev?: boolean;
  reset?: boolean;
};

const gatewayLog = createSubsystemLogger("gateway");

const GATEWAY_RUN_VALUE_KEYS = [
  "port",
  "bind",
  "token",
  "auth",
  "password",
  "passwordFile",
  "tailscale",
  "wsLog",
  "rawStreamPath",
] as const;

const GATEWAY_RUN_BOOLEAN_KEYS = [
  "tailscaleResetOnExit",
  "allowUnconfigured",
  "dev",
  "reset",
  "force",
  "verbose",
  "cliBackendLogs",
  "claudeCliLogs",
  "compact",
  "rawStream",
] as const;

const SUPERVISED_GATEWAY_LOCK_RETRY_MS = 5000;

/**
 * EX_CONFIG (78) from sysexits.h — used for configuration errors so systemd
 * (via RestartPreventExitStatus=78) stops restarting instead of entering a
 * restart storm that can render low-resource hosts unresponsive.
 */
const EXIT_CONFIG_ERROR = 78;

const GATEWAY_AUTH_MODES: readonly GatewayAuthMode[] = [
  "none",
  "token",
  "password",
  "trusted-proxy",
];
const GATEWAY_TAILSCALE_MODES: readonly GatewayTailscaleMode[] = ["off", "serve", "funnel"];

function warnInlinePasswordFlag() {
  defaultRuntime.error(
    "Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.",
  );
}

function resolveGatewayPasswordOption(opts: GatewayRunOpts): string | undefined {
  const direct = toOptionString(opts.password);
  const file = toOptionString(opts.passwordFile);
  if (direct && file) {
    throw new Error("Use either --password or --password-file.");
  }
  if (file) {
    return readSecretFromFile(file, "Gateway password");
  }
  return direct;
}

function parseEnumOption<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
): T | null {
  if (!raw) {
    return null;
  }
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

function formatModeChoices<T extends string>(modes: readonly T[]): string {
  return modes.map((mode) => `"${mode}"`).join("|");
}

function formatModeErrorList<T extends string>(modes: readonly T[]): string {
  const quoted = modes.map((mode) => `"${mode}"`);
  if (quoted.length === 0) {
    return "";
  }
  if (quoted.length === 1) {
    return quoted[0];
  }
  if (quoted.length === 2) {
    return `${quoted[0]} or ${quoted[1]}`;
  }
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted[quoted.length - 1]}`;
}

function maybeLogPendingControlUiBuild(cfg: OpenClawConfig): void {
  if (cfg.gateway?.controlUi?.enabled === false) {
    return;
  }
  if (toOptionString(cfg.gateway?.controlUi?.root)) {
    return;
  }
  if (
    resolveControlUiRootSync({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    })
  ) {
    return;
  }
  gatewayLog.info(
    "Control UI assets are missing; first startup may spend a few seconds building them before the gateway binds. Prebuild with `pnpm ui:build` for a faster first boot.",
  );
}

function getGatewayStartGuardErrors(params: {
  allowUnconfigured?: boolean;
  configExists: boolean;
  configAuditPath: string;
  mode: string | undefined;
}): string[] {
  if (params.allowUnconfigured || params.mode === "local") {
    return [];
  }
  if (!params.configExists) {
    return [
      `Missing config. Run \`${formatCliCommand("openclaw setup")}\` or set gateway.mode=local (or pass --allow-unconfigured).`,
    ];
  }
  if (params.mode === undefined) {
    return [
      [
        "Gateway start blocked: existing config is missing gateway.mode.",
        "Treat this as suspicious or clobbered config.",
        `Re-run \`${formatCliCommand("openclaw onboard --mode local")}\` or \`${formatCliCommand("openclaw setup")}\`, set gateway.mode=local manually, or pass --allow-unconfigured.`,
      ].join(" "),
      `Config write audit: ${params.configAuditPath}`,
    ];
  }
  return [
    `Gateway start blocked: set gateway.mode=local (current: ${params.mode}) or pass --allow-unconfigured.`,
    `Config write audit: ${params.configAuditPath}`,
  ];
}

function resolveGatewayRunOptions(opts: GatewayRunOpts, command?: Command): GatewayRunOpts {
  const resolved: GatewayRunOpts = { ...opts };

  for (const key of GATEWAY_RUN_VALUE_KEYS) {
    const inherited = inheritOptionFromParent(command, key);
    if (key === "wsLog") {
      // wsLog has a child default ("auto"), so prefer inherited parent CLI value when present.
      resolved[key] = inherited ?? resolved[key];
      continue;
    }
    resolved[key] = resolved[key] ?? inherited;
  }

  for (const key of GATEWAY_RUN_BOOLEAN_KEYS) {
    const inherited = inheritOptionFromParent<boolean>(command, key);
    resolved[key] = Boolean(resolved[key] || inherited);
  }

  return resolved;
}

function isGatewayLockError(err: unknown): err is GatewayLockError {
  return (
    err instanceof GatewayLockError ||
    (!!err && typeof err === "object" && (err as { name?: string }).name === "GatewayLockError")
  );
}

function isHealthyGatewayLockError(err: unknown): boolean {
  if (!isGatewayLockError(err) || typeof err.message !== "string") {
    return false;
  }
  return (
    err.message.includes("gateway already running") ||
    err.message.includes("another gateway instance is already listening")
  );
}

async function runGatewayCommand(opts: GatewayRunOpts) {
  const isDevProfile = normalizeOptionalLowercaseString(process.env.OPENCLAW_PROFILE) === "dev";
  const devMode = Boolean(opts.dev) || isDevProfile;
  if (opts.reset && !devMode) {
    defaultRuntime.error("Use --reset with --dev.");
    defaultRuntime.exit(1);
    return;
  }

  setVerbose(Boolean(opts.verbose));
  if (opts.cliBackendLogs || opts.claudeCliLogs) {
    setConsoleSubsystemFilter(["agent/cli-backend"]);
    process.env.OPENCLAW_CLI_BACKEND_LOG_OUTPUT = "1";
  }
  const wsLogRaw = (opts.compact ? "compact" : opts.wsLog) as string | undefined;
  const wsLogStyle: GatewayWsLogStyle =
    wsLogRaw === "compact" ? "compact" : wsLogRaw === "full" ? "full" : "auto";
  if (
    wsLogRaw !== undefined &&
    wsLogRaw !== "auto" &&
    wsLogRaw !== "compact" &&
    wsLogRaw !== "full"
  ) {
    defaultRuntime.error('Invalid --ws-log (use "auto", "full", "compact")');
    defaultRuntime.exit(1);
  }
  setGatewayWsLogStyle(wsLogStyle);

  if (opts.rawStream) {
    process.env.OPENCLAW_RAW_STREAM = "1";
  }
  const rawStreamPath = toOptionString(opts.rawStreamPath);
  if (rawStreamPath) {
    process.env.OPENCLAW_RAW_STREAM_PATH = rawStreamPath;
  }

  // The heaviest part of gateway startup is loading the server module tree
  // (channels, plugins, HTTP stack, etc.). Show a spinner so the user sees
  // progress instead of a silent 15-20 s pause (especially on Windows/NTFS).
  const { startGatewayServer } = await withProgress(
    { label: "Loading gateway modules…", indeterminate: true },
    async () => import("../../gateway/server.js"),
  );

  setConsoleTimestampPrefix(true);

  if (devMode) {
    await ensureDevGatewayConfig({ reset: Boolean(opts.reset) });
  }

  gatewayLog.info("loading configuration…");
  const cfg = loadConfig();
  maybeLogPendingControlUiBuild(cfg);
  const portOverride = parsePort(opts.port);
  if (opts.port !== undefined && portOverride === null) {
    defaultRuntime.error("Invalid port");
    defaultRuntime.exit(1);
  }
  const port = portOverride ?? resolveGatewayPort(cfg);
  if (!Number.isFinite(port) || port <= 0) {
    defaultRuntime.error("Invalid port");
    defaultRuntime.exit(1);
  }
  // Only capture the *explicit* bind value here.  The container-aware
  // default is deferred until after Tailscale mode is known (see below)
  // so that Tailscale's loopback constraint is respected.
  const VALID_BIND_MODES = new Set<string>(["loopback", "lan", "auto", "custom", "tailnet"]);
  const bindExplicitRawStr = normalizeOptionalString(
    toOptionString(opts.bind) ?? cfg.gateway?.bind,
  );
  if (bindExplicitRawStr !== undefined && !VALID_BIND_MODES.has(bindExplicitRawStr)) {
    defaultRuntime.error('Invalid --bind (use "loopback", "lan", "tailnet", "auto", or "custom")');
    defaultRuntime.exit(1);
    return;
  }
  const bindExplicitRaw = bindExplicitRawStr as GatewayBindMode | undefined;
  if (process.env.OPENCLAW_SERVICE_MARKER?.trim()) {
    const stale = cleanStaleGatewayProcessesSync(port);
    if (stale.length > 0) {
      gatewayLog.info(
        `service-mode: cleared ${stale.length} stale gateway pid(s) before bind on port ${port}`,
      );
    }
  }
  if (opts.force) {
    try {
      const { killed, waitedMs, escalatedToSigkill } = await forceFreePortAndWait(port, {
        timeoutMs: 2000,
        intervalMs: 100,
        sigtermTimeoutMs: 700,
      });
      if (killed.length === 0) {
        gatewayLog.info(`force: no listeners on port ${port}`);
      } else {
        for (const proc of killed) {
          gatewayLog.info(
            `force: killed pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""} on port ${port}`,
          );
        }
        if (escalatedToSigkill) {
          gatewayLog.info(`force: escalated to SIGKILL while freeing port ${port}`);
        }
        if (waitedMs > 0) {
          gatewayLog.info(`force: waited ${waitedMs}ms for port ${port} to free`);
        }
      }
      // After killing, verify the port is actually bindable (handles TIME_WAIT).
      const bindProbeHost =
        bindExplicitRaw === "loopback"
          ? "127.0.0.1"
          : bindExplicitRaw === "lan"
            ? "0.0.0.0"
            : bindExplicitRaw === "custom"
              ? toOptionString(cfg.gateway?.customBindHost)
              : undefined;
      const bindWaitMs = await waitForPortBindable(port, {
        timeoutMs: 3000,
        intervalMs: 150,
        host: bindProbeHost,
      });
      if (bindWaitMs > 0) {
        gatewayLog.info(`force: waited ${bindWaitMs}ms for port ${port} to become bindable`);
      }
    } catch (err) {
      defaultRuntime.error(`Force: ${String(err)}`);
      defaultRuntime.exit(1);
      return;
    }
  }
  if (opts.token) {
    const token = toOptionString(opts.token);
    if (token) {
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
    }
  }
  const authModeRaw = toOptionString(opts.auth);
  const authMode = parseEnumOption(authModeRaw, GATEWAY_AUTH_MODES);
  if (authModeRaw && !authMode) {
    defaultRuntime.error(`Invalid --auth (use ${formatModeErrorList(GATEWAY_AUTH_MODES)})`);
    defaultRuntime.exit(1);
    return;
  }
  const tailscaleRaw = toOptionString(opts.tailscale);
  const tailscaleMode = parseEnumOption(tailscaleRaw, GATEWAY_TAILSCALE_MODES);
  if (tailscaleRaw && !tailscaleMode) {
    defaultRuntime.error(
      `Invalid --tailscale (use ${formatModeErrorList(GATEWAY_TAILSCALE_MODES)})`,
    );
    defaultRuntime.exit(1);
    return;
  }
  // Now that Tailscale mode is known, compute the effective bind mode.
  const effectiveTailscaleMode = tailscaleMode ?? cfg.gateway?.tailscale?.mode ?? "off";
  const bind = (bindExplicitRaw ?? defaultGatewayBindMode(effectiveTailscaleMode)) as
    | "loopback"
    | "lan"
    | "auto"
    | "custom"
    | "tailnet";

  let passwordRaw: string | undefined;
  try {
    passwordRaw = resolveGatewayPasswordOption(opts);
  } catch (err) {
    defaultRuntime.error(formatErrorMessage(err));
    defaultRuntime.exit(1);
    return;
  }
  if (toOptionString(opts.password)) {
    warnInlinePasswordFlag();
  }
  const tokenRaw = toOptionString(opts.token);

  gatewayLog.info("resolving authentication…");
  const snapshot = await readConfigFileSnapshot().catch(() => null);
  const configExists = snapshot?.exists ?? fs.existsSync(CONFIG_PATH);
  const configAuditPath = path.join(resolveStateDir(process.env), "logs", "config-audit.jsonl");
  const effectiveCfg = snapshot?.valid ? snapshot.config : cfg;
  const mode = effectiveCfg.gateway?.mode;
  const guardErrors = getGatewayStartGuardErrors({
    allowUnconfigured: opts.allowUnconfigured,
    configExists,
    configAuditPath,
    mode,
  });
  if (guardErrors.length > 0) {
    for (const error of guardErrors) {
      defaultRuntime.error(error);
    }
    defaultRuntime.exit(EXIT_CONFIG_ERROR);
    return;
  }
  const miskeys = extractGatewayMiskeys(snapshot?.parsed);
  const authOverride =
    authMode || passwordRaw || tokenRaw || authModeRaw
      ? {
          ...(authMode ? { mode: authMode } : {}),
          ...(tokenRaw ? { token: tokenRaw } : {}),
          ...(passwordRaw ? { password: passwordRaw } : {}),
        }
      : undefined;
  const resolvedAuth = resolveGatewayAuth({
    authConfig: cfg.gateway?.auth,
    authOverride,
    env: process.env,
    tailscaleMode: tailscaleMode ?? cfg.gateway?.tailscale?.mode ?? "off",
  });
  const resolvedAuthMode = resolvedAuth.mode;
  const tokenValue = resolvedAuth.token;
  const passwordValue = resolvedAuth.password;
  const hasToken = typeof tokenValue === "string" && tokenValue.trim().length > 0;
  const hasPassword = typeof passwordValue === "string" && passwordValue.trim().length > 0;
  const tokenConfigured =
    hasToken ||
    hasConfiguredSecretInput(
      authOverride?.token ?? cfg.gateway?.auth?.token,
      cfg.secrets?.defaults,
    );
  const passwordConfigured =
    hasPassword ||
    hasConfiguredSecretInput(
      authOverride?.password ?? cfg.gateway?.auth?.password,
      cfg.secrets?.defaults,
    );
  const hasSharedSecret =
    (resolvedAuthMode === "token" && tokenConfigured) ||
    (resolvedAuthMode === "password" && passwordConfigured);
  const canBootstrapToken = resolvedAuthMode === "token" && !tokenConfigured;
  const authHints: string[] = [];
  if (miskeys.hasGatewayToken) {
    authHints.push('Found "gateway.token" in config. Use "gateway.auth.token" instead.');
  }
  if (miskeys.hasRemoteToken) {
    authHints.push(
      '"gateway.remote.token" is for remote CLI calls; it does not enable local gateway auth.',
    );
  }
  if (resolvedAuthMode === "password" && !passwordConfigured) {
    defaultRuntime.error(
      [
        "Gateway auth is set to password, but no password is configured.",
        "Set gateway.auth.password (or OPENCLAW_GATEWAY_PASSWORD), or pass --password.",
        ...authHints,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    defaultRuntime.exit(EXIT_CONFIG_ERROR);
    return;
  }
  if (resolvedAuthMode === "none") {
    gatewayLog.warn(
      "Gateway auth mode=none explicitly configured; all gateway connections are unauthenticated.",
    );
  }
  if (
    bind !== "loopback" &&
    !hasSharedSecret &&
    !canBootstrapToken &&
    resolvedAuthMode !== "trusted-proxy"
  ) {
    defaultRuntime.error(
      [
        `Refusing to bind gateway to ${bind} without auth.`,
        ...(isContainerEnvironment()
          ? [
              "Container environment detected \u2014 the gateway defaults to bind=auto (0.0.0.0) for port-forwarding compatibility.",
              "Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD, or pass --token/--password to start with auth.",
            ]
          : [
              "Set gateway.auth.token/password (or OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD) or pass --token/--password.",
            ]),
        ...authHints,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    defaultRuntime.exit(EXIT_CONFIG_ERROR);
    return;
  }
  const tailscaleOverride =
    tailscaleMode || opts.tailscaleResetOnExit
      ? {
          ...(tailscaleMode ? { mode: tailscaleMode } : {}),
          ...(opts.tailscaleResetOnExit ? { resetOnExit: true } : {}),
        }
      : undefined;

  gatewayLog.info("starting...");
  // Activate the Paperclip integration once the gateway server is up.
  // Heartbeat owns a setInterval timer; the rest of the clients are
  // pure factories. Stored at module scope so the SIGTERM handler below
  // can stop it cleanly.
  const { startPaperclipIntegration } = await import(
    "../../integrations/paperclip-bootstrap.js"
  );
  const { startPaperclipOtel, stopPaperclipOtel } = await import(
    "../../integrations/paperclip-otel.js"
  );
  // OTEL has to start before the gateway server so auto-instrumentation
  // hooks Express/HTTP at boot. Skipped silently when env doesn't opt in.
  await startPaperclipOtel({ logger: gatewayLog });
  let paperclipIntegration: ReturnType<typeof startPaperclipIntegration> | null = null;

  const startLoop = async () =>
    await runGatewayLoop({
      runtime: defaultRuntime,
      lockPort: port,
      start: async ({ startupStartedAt } = {}) => {
        const server = await startGatewayServer(port, {
          bind,
          auth: authOverride,
          tailscale: tailscaleOverride,
          startupStartedAt,
        });
        if (!paperclipIntegration) {
          paperclipIntegration = startPaperclipIntegration({ logger: gatewayLog });
          const status = paperclipIntegration.describeStatus();
          gatewayLog.info(`paperclip integration: ${paperclipIntegration.describe()}`);
          // Critical-arrow check: outbound + dispatcher must be on for the
          // bridge to serve its primary purpose (Paperclip → OpenClaw
          // notifications and user-reply forwarding). A partial-env
          // install where these are off in production is usually a
          // missed env var, so emit a WARN. On development boxes this
          // would be spam — downgrade to INFO there.
          if (status.missingCritical.length > 0) {
            const env = process.env.NODE_ENV ?? "development";
            const msg = `paperclip integration missing critical arrows: ${status.missingCritical.join(", ")} (NODE_ENV=${env})`;
            if (env === "production") {
              gatewayLog.warn(msg);
            } else {
              gatewayLog.info(msg);
            }
          } else if (status.missingImportant.length > 0) {
            gatewayLog.info(
              `paperclip integration degraded — missing: ${status.missingImportant.join(", ")}`,
            );
          }
        }
        return server;
      },
    });

  // Use addListener (not once) so we don't displace any other SIGTERM /
  // SIGINT handlers the gateway server already wired during startup —
  // process.once with the same event would silently replace whichever
  // listener lost the registration race.
  //
  // Shutdown ordering matters here, in this exact sequence:
  //   1. drain in-flight dispatcher promises so their spans call .end()
  //      and the audit-row inserts complete on the Paperclip side.
  //      Without the drain, an in-flight maybeDispatchReplyToPaperclip
  //      ends with recordException(SIGTERM) on the span and the matching
  //      bridge_audit row never lands.
  //   2. AWAIT stopPaperclipOtel() so the OTLP exporter flushes the
  //      spans that drain just finalised. Previously this was
  //      `void stopPaperclipOtel()` — fire-and-forget, which let the
  //      handler return before the SDK shutdown promise resolved. Node
  //      then exited (no other open handles) and pending exports were
  //      dropped on the floor — operators saw incomplete traces in
  //      Tempo with no clear cause.
  //   3. integration.stop() to release timers (sync). Order vs OTel
  //      doesn't matter strictly — stop() doesn't touch the tracer —
  //      but doing it last keeps the "OTel sees the final span state"
  //      invariant explicit.
  //
  // The 5s drain cap matches the typical kubelet
  // terminationGracePeriodSeconds and is bounded so a slow Paperclip
  // can't pin process teardown. OTel shutdown is unbounded — we trust
  // the SDK's own internal timeout (default 30s) rather than wrapping
  // it in another race; if the collector is unreachable, dropping the
  // last batch of spans is acceptable. systemd / kubelet will SIGKILL
  // us soon enough either way.
  const stopBridge = () => {
    void (async () => {
      try {
        await paperclipIntegration?.drain(5_000);
      } catch {
        // drain() promises never reject by contract, but defend
        // against an unexpected throw — we'd rather complete teardown
        // with a missing audit row than hang on a buggy drain.
      }
      try {
        await stopPaperclipOtel();
      } catch {
        // stopPaperclipOtel() already swallows internal errors; this
        // catch is just belt-and-braces for an unexpected throw at
        // the await boundary so the rest of teardown still runs.
      }
      paperclipIntegration?.stop();
    })();
  };
  process.addListener("SIGTERM", stopBridge);
  process.addListener("SIGINT", stopBridge);

  try {
    const supervisor = detectRespawnSupervisor(process.env);
    while (true) {
      try {
        await startLoop();
        break;
      } catch (err) {
        const isGatewayAlreadyRunning =
          err instanceof GatewayLockError &&
          typeof err.message === "string" &&
          err.message.includes("gateway already running");
        if (!supervisor || !isGatewayAlreadyRunning) {
          throw err;
        }
        gatewayLog.warn(
          `gateway already running under ${supervisor}; waiting ${SUPERVISED_GATEWAY_LOCK_RETRY_MS}ms before retrying startup`,
        );
        await new Promise((resolve) => setTimeout(resolve, SUPERVISED_GATEWAY_LOCK_RETRY_MS));
      }
    }
  } catch (err) {
    if (isGatewayLockError(err)) {
      const errMessage = formatErrorMessage(err);
      defaultRuntime.error(
        `Gateway failed to start: ${errMessage}\nIf the gateway is supervised, stop it with: ${formatCliCommand("openclaw gateway stop")}`,
      );
      try {
        const diagnostics = await inspectPortUsage(port);
        if (diagnostics.status === "busy") {
          for (const line of formatPortDiagnostics(diagnostics)) {
            defaultRuntime.error(line);
          }
        }
      } catch {
        // ignore diagnostics failures
      }
      await maybeExplainGatewayServiceStop();
      defaultRuntime.exit(isHealthyGatewayLockError(err) ? 0 : 1);
      return;
    }
    defaultRuntime.error(`Gateway failed to start: ${String(err)}`);
    defaultRuntime.exit(1);
  }
}

export function addGatewayRunCommand(cmd: Command): Command {
  return cmd
    .option("--port <port>", "Port for the gateway WebSocket")
    .option(
      "--bind <mode>",
      'Bind mode ("loopback"|"lan"|"tailnet"|"auto"|"custom"). Defaults to config gateway.bind (or loopback).',
    )
    .option(
      "--token <token>",
      "Shared token required in connect.params.auth.token (default: OPENCLAW_GATEWAY_TOKEN env if set)",
    )
    .option("--auth <mode>", `Gateway auth mode (${formatModeChoices(GATEWAY_AUTH_MODES)})`)
    .option("--password <password>", "Password for auth mode=password")
    .option("--password-file <path>", "Read gateway password from file")
    .option(
      "--tailscale <mode>",
      `Tailscale exposure mode (${formatModeChoices(GATEWAY_TAILSCALE_MODES)})`,
    )
    .option(
      "--tailscale-reset-on-exit",
      "Reset Tailscale serve/funnel configuration on shutdown",
      false,
    )
    .option(
      "--allow-unconfigured",
      "Allow gateway start without enforcing gateway.mode=local in config (does not repair config)",
      false,
    )
    .option("--dev", "Create a dev config + workspace if missing (no BOOTSTRAP.md)", false)
    .option(
      "--reset",
      "Reset dev config + credentials + sessions + workspace (requires --dev)",
      false,
    )
    .option("--force", "Kill any existing listener on the target port before starting", false)
    .option("--verbose", "Verbose logging to stdout/stderr", false)
    .option(
      "--cli-backend-logs",
      "Only show CLI backend logs in the console (includes stdout/stderr)",
      false,
    )
    .option("--claude-cli-logs", "Deprecated alias for --cli-backend-logs", false)
    .option("--ws-log <style>", 'WebSocket log style ("auto"|"full"|"compact")', "auto")
    .option("--compact", 'Alias for "--ws-log compact"', false)
    .option("--raw-stream", "Log raw model stream events to jsonl", false)
    .option("--raw-stream-path <path>", "Raw stream jsonl path")
    .action(async (opts, command) => {
      await runGatewayCommand(resolveGatewayRunOptions(opts, command));
    });
}
