// ---------------------------------------------------------------------------
// Generic Railway Gateway Wrapper — orchestrator
//
// Loads a service config + hooks, then wires up:
//   Express → auth → proxy → gateway lifecycle → TUI → console → backup
//
// Usage:
//   SERVICE_CONFIG=../../services/openclaw/config.js node src/core/server.js
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import { createDebugLogger, runCmd, buildRedactor, resolveToken } from "./utils.js";
import { createRateLimiter, createSetupAuth, createWsAuthVerifier } from "./auth.js";
import { createGatewayManager } from "./gateway.js";
import { createProxy } from "./proxy.js";
import { createConsoleHandler } from "./console.js";
import { createTuiManager } from "./tui.js";
import { handleExport } from "./backup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 1. Load service config + hooks
// ---------------------------------------------------------------------------
const SERVICE_CONFIG_PATH =
  process.env.SERVICE_CONFIG ||
  path.resolve(__dirname, "../../services/openclaw/config.js");

const serviceConfig = (await import(SERVICE_CONFIG_PATH)).default;

const HOOKS_PATH = SERVICE_CONFIG_PATH.replace(/config\.js$/, "hooks.js");
let hooks = {};
try {
  hooks = (await import(HOOKS_PATH)).default;
} catch {
  console.warn(`[wrapper] No hooks found at ${HOOKS_PATH}, using defaults`);
}

console.log(`[wrapper] Service: ${serviceConfig.name} (${serviceConfig.slug})`);

// ---------------------------------------------------------------------------
// 2. Resolve environment
// ---------------------------------------------------------------------------
const env = serviceConfig.env;

// Run legacy migration if hook exists
const STATE_DIR =
  process.env[env.stateDir.key]?.trim() ||
  env.stateDir.default ||
  path.join(os.homedir(), `.${serviceConfig.slug}`);

const WORKSPACE_DIR =
  process.env[env.workspaceDir.key]?.trim() ||
  env.workspaceDir.default ||
  path.join(STATE_DIR, "workspace");

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();
const DEBUG = process.env[env.debug?.key]?.toLowerCase() === "true";
const debug = createDebugLogger(DEBUG);

const INTERNAL_GATEWAY_PORT = Number.parseInt(
  process.env.INTERNAL_GATEWAY_PORT ?? String(serviceConfig.gateway.defaultPort || 18789),
  10,
);
const INTERNAL_GATEWAY_HOST =
  process.env.INTERNAL_GATEWAY_HOST ?? (serviceConfig.gateway.defaultHost || "127.0.0.1");

const ENTRY = process.env[env.entry?.key]?.trim() || env.entry?.default || "";
const NODE_CMD = process.env[env.node?.key]?.trim() || env.node?.default || "node";

const ENABLE_WEB_TUI = process.env.ENABLE_WEB_TUI?.toLowerCase() === "true";
const TUI_IDLE_TIMEOUT_MS = Number.parseInt(process.env.TUI_IDLE_TIMEOUT_MS ?? "300000", 10);
const TUI_MAX_SESSION_MS = Number.parseInt(process.env.TUI_MAX_SESSION_MS ?? "1800000", 10);

// Resolve gateway token
const GATEWAY_TOKEN = resolveToken({
  envKey: env.gatewayToken?.key || `${serviceConfig.slug.toUpperCase()}_GATEWAY_TOKEN`,
  stateDir: STATE_DIR,
});
process.env[env.gatewayToken?.key || `${serviceConfig.slug.toUpperCase()}_GATEWAY_TOKEN`] = GATEWAY_TOKEN;

// Build redactor from service secret patterns
const redactSecrets = buildRedactor(serviceConfig.secretPatterns || []);

// ---------------------------------------------------------------------------
// 3. Shared context object passed to hooks and console commands
// ---------------------------------------------------------------------------
function clawArgs(args) {
  return [ENTRY, ...args];
}

function boundRunCmd(cmd, args, opts = {}) {
  return runCmd(cmd, args, {
    ...opts,
    env: {
      [env.stateDir.key]: STATE_DIR,
      [env.workspaceDir.key]: WORKSPACE_DIR,
      ...opts.env,
    },
  });
}

const ctx = {
  serviceConfig,
  stateDir: STATE_DIR,
  workspaceDir: WORKSPACE_DIR,
  token: GATEWAY_TOKEN,
  node: NODE_CMD,
  entry: ENTRY,
  port: INTERNAL_GATEWAY_PORT,
  host: INTERNAL_GATEWAY_HOST,
  wrapperPort: PORT,
  debug,
  runCmd: boundRunCmd,
  clawArgs,
};

// ---------------------------------------------------------------------------
// 4. Run legacy migration
// ---------------------------------------------------------------------------
if (hooks.migrateLegacy) {
  hooks.migrateLegacy(ctx, serviceConfig);
}

// ---------------------------------------------------------------------------
// 5. Create subsystems
// ---------------------------------------------------------------------------
const gateway = createGatewayManager({
  serviceConfig,
  ctx,
  runCmd: boundRunCmd,
  hooks,
});

const GATEWAY_TARGET = gateway.target;

// Resolve public assets directory — prefer service-specific, fall back to src/public
const serviceDir = path.dirname(SERVICE_CONFIG_PATH);
const servicePublicDir = path.join(serviceDir, "public");
const corePublicDir = path.join(__dirname, "..", "public");
const publicDir = fs.existsSync(servicePublicDir) ? servicePublicDir : corePublicDir;

const loadingHtmlPath = path.join(publicDir, "loading.html");

const { proxy, loadingHtml } = createProxy({
  gatewayTarget: GATEWAY_TARGET,
  token: GATEWAY_TOKEN,
  loadingHtmlPath,
});

const rateLimiter = createRateLimiter();
const requireSetupAuth = createSetupAuth({
  getPassword: () => SETUP_PASSWORD,
  rateLimiter,
  realm: `${serviceConfig.name} Setup`,
});

const verifyWsAuth = createWsAuthVerifier(() => SETUP_PASSWORD);

const consoleHandler = createConsoleHandler({
  serviceConfig,
  gateway,
  ctx,
  runCmd: boundRunCmd,
  redactSecrets,
});

// ---------------------------------------------------------------------------
// 6. Express app
// ---------------------------------------------------------------------------
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// ---- Health endpoints (no auth) ----
app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

app.get("/healthz", async (_req, res) => {
  let gatewayStatus = "unconfigured";
  if (gateway.isConfigured()) {
    gatewayStatus = gateway.isReady ? "ready" : "starting";
  }
  res.json({ ok: true, gateway: gatewayStatus });
});

// ---- Setup wizard ----
app.get("/setup", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(publicDir, "setup.html"));
});

// Serve static assets from public dir
app.use("/setup/public", express.static(publicDir));

// ---- Status API ----
let cachedServiceInfo = null;

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  if (!cachedServiceInfo && hooks.getServiceInfo) {
    try {
      cachedServiceInfo = await hooks.getServiceInfo(ctx);
    } catch {
      cachedServiceInfo = { version: "unknown", channelsHelp: "" };
    }
  }

  res.json({
    configured: gateway.isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    serviceName: serviceConfig.name,
    serviceVersion: cachedServiceInfo?.version || "unknown",
    channelsAddHelp: cachedServiceInfo?.channelsHelp || "",
    authGroups: serviceConfig.authGroups || [],
    channels: serviceConfig.channels || [],
    tuiEnabled: ENABLE_WEB_TUI,
  });
});

// ---- Run onboarding ----
app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    if (gateway.isConfigured()) {
      await gateway.ensure();
      return res.json({
        ok: true,
        output: "Already configured.\nUse Reset setup if you want to rerun onboarding.\n",
      });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};

    // Validate payload
    if (hooks.validatePayload) {
      const validationError = hooks.validatePayload(serviceConfig, payload);
      if (validationError) {
        return res.status(400).json({ ok: false, output: validationError });
      }
    }

    // Build onboard args
    let onboardArgs;
    if (hooks.buildOnboardArgs) {
      onboardArgs = hooks.buildOnboardArgs(ctx, payload);
    } else {
      onboardArgs = ["onboard", "--non-interactive"];
    }

    const onboard = await boundRunCmd(NODE_CMD, clawArgs(onboardArgs));

    let extra = "";
    extra += `\n[setup] Onboarding exit=${onboard.code} configured=${gateway.isConfigured()}\n`;

    const ok = onboard.code === 0 && gateway.isConfigured();

    if (ok) {
      // Run afterOnboard hook
      if (hooks.afterOnboard) {
        extra += await hooks.afterOnboard(ctx, payload);
      }

      extra += "\n[setup] Starting gateway...\n";
      await gateway.restart();
      extra += "[setup] Gateway started.\n";
    }

    return res.status(ok ? 200 : 500).json({
      ok,
      output: `${onboard.output}${extra}`,
    });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return res.status(500).json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

// ---- Console ----
app.post("/setup/api/console/run", requireSetupAuth, consoleHandler);

// ---- Export ----
app.get("/setup/export", requireSetupAuth, async (req, res) => {
  handleExport({ stateDir: STATE_DIR, workspaceDir: WORKSPACE_DIR, serviceName: serviceConfig.slug }, req, res);
});

// ---- Service-specific setup routes (from hooks) ----
if (hooks.setupRoutes) {
  hooks.setupRoutes(app, { requireAuth: requireSetupAuth, ctx, gateway });
}

// ---- TUI ----
app.get("/tui", requireSetupAuth, (_req, res) => {
  if (!ENABLE_WEB_TUI) {
    return res.status(403).type("text/plain").send("Web TUI is disabled. Set ENABLE_WEB_TUI=true to enable it.");
  }
  if (!gateway.isConfigured()) return res.redirect("/setup");
  res.sendFile(path.join(publicDir, "tui.html"));
});

// ---- Control UI rewrite (service-specific) ----
if (hooks.controlUiRewrite) {
  app.use((req, res, next) => {
    const handled = hooks.controlUiRewrite(req, res, GATEWAY_TOKEN);
    if (!handled) return next();
  });
}

// ---- Catch-all: proxy to gateway ----
app.use(async (req, res) => {
  if (!gateway.isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (gateway.isConfigured()) {
    if (!gateway.isReady) {
      try {
        await gateway.ensure();
      } catch {
        return res.status(503).type("text/html").send(loadingHtml);
      }
      if (!gateway.isReady) {
        return res.status(503).type("text/html").send(loadingHtml);
      }
    }
  }

  // Control UI token injection (if service defines a controlUiPath)
  const controlUiPath = serviceConfig.gateway.controlUiPath;
  if (controlUiPath && req.path === controlUiPath && !req.query.token) {
    return res.redirect(`${controlUiPath}?token=${GATEWAY_TOKEN}`);
  }

  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

// ---------------------------------------------------------------------------
// 7. Start server
// ---------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(`[wrapper] listening on port ${PORT}`);
  console.log(`[wrapper] setup wizard: http://localhost:${PORT}/setup`);
  console.log(`[wrapper] web TUI: ${ENABLE_WEB_TUI ? "enabled" : "disabled"}`);
  console.log(`[wrapper] configured: ${gateway.isConfigured()}`);

  // Harden filesystem
  if (hooks.hardenFs) hooks.hardenFs(ctx);

  // Auto-start gateway if already configured
  if (gateway.isConfigured()) {
    (async () => {
      if (hooks.onBoot) {
        try { await hooks.onBoot(ctx); } catch (err) {
          console.warn(`[wrapper] onBoot hook failed: ${err.message}`);
        }
      }
      await gateway.ensure();
    })().catch((err) => {
      console.error(`[wrapper] failed to start gateway at boot: ${err.message}`);
    });
  }
});

// ---------------------------------------------------------------------------
// 8. WebSocket upgrades
// ---------------------------------------------------------------------------
let tuiManager = null;

if (ENABLE_WEB_TUI) {
  tuiManager = createTuiManager({
    serviceConfig,
    ctx,
    idleTimeoutMs: TUI_IDLE_TIMEOUT_MS,
    maxSessionMs: TUI_MAX_SESSION_MS,
    verifyAuth: verifyWsAuth,
  });
}

server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // TUI WebSocket
  if (url.pathname === "/tui/ws") {
    if (!ENABLE_WEB_TUI || !tuiManager) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    tuiManager.handleUpgrade(req, socket, head);
    return;
  }

  // Gateway WebSocket proxy
  if (!gateway.isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await gateway.ensure();
  } catch (err) {
    console.warn(`[websocket] gateway not ready: ${err.message}`);
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, {
    target: GATEWAY_TARGET,
    headers: {
      Authorization: `Bearer ${GATEWAY_TOKEN}`,
      Origin: GATEWAY_TARGET,
    },
  });
});

// ---------------------------------------------------------------------------
// 9. Graceful shutdown
// ---------------------------------------------------------------------------
async function gracefulShutdown(signal) {
  console.log(`[wrapper] received ${signal}, shutting down`);

  if (rateLimiter.cleanupInterval) clearInterval(rateLimiter.cleanupInterval);
  if (tuiManager) tuiManager.clearSession();

  server.close();
  await gateway.shutdown();
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
