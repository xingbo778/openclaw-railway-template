import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sleep } from "./utils.js";

// ---------------------------------------------------------------------------
// Gateway process lifecycle manager
// ---------------------------------------------------------------------------
export function createGatewayManager({
  serviceConfig,
  ctx,           // { stateDir, workspaceDir, token, node, entry, port, host, debug }
  runCmd,
  hooks,
}) {
  const cfg = serviceConfig;
  const GATEWAY_TARGET = `http://${ctx.host}:${ctx.port}`;

  let gatewayProc = null;
  let gatewayStarting = null;
  let gatewayHealthy = false;
  let shuttingDown = false;

  // Debug breadcrumbs
  let lastGatewayError = null;
  let lastGatewayExit = null;

  function clawArgs(args) {
    return [ctx.entry, ...args];
  }

  function configFilePath() {
    return (
      process.env[cfg.env.configPath?.key]?.trim() ||
      path.join(ctx.stateDir, cfg.configFile)
    );
  }

  function isConfigured() {
    try {
      return fs.existsSync(configFilePath());
    } catch {
      return false;
    }
  }

  // ---- Health check: poll HTTP endpoints ----
  async function waitForReady(opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const start = Date.now();
    const endpoints = cfg.gateway.healthEndpoints || ["/", "/health"];

    while (Date.now() - start < timeoutMs) {
      for (const endpoint of endpoints) {
        try {
          const res = await fetch(`${GATEWAY_TARGET}${endpoint}`, { method: "GET" });
          if (res) {
            console.log(`[gateway] ready at ${endpoint}`);
            return true;
          }
        } catch (err) {
          if (err.code !== "ECONNREFUSED" && err.cause?.code !== "ECONNREFUSED") {
            const msg = err.code || err.message;
            if (msg !== "fetch failed" && msg !== "UND_ERR_CONNECT_TIMEOUT") {
              console.warn(`[gateway] health check error: ${msg}`);
            }
          }
        }
      }
      await sleep(250);
    }
    console.error(`[gateway] failed to become ready after ${timeoutMs / 1000} seconds`);
    return false;
  }

  // ---- TCP probe (lightweight up/down check) ----
  async function probe() {
    const net = await import("node:net");
    return await new Promise((resolve) => {
      const sock = net.createConnection({
        host: ctx.host,
        port: ctx.port,
        timeout: 750,
      });
      const done = (ok) => {
        try { sock.destroy(); } catch {}
        resolve(ok);
      };
      sock.on("connect", () => done(true));
      sock.on("timeout", () => done(false));
      sock.on("error", () => done(false));
    });
  }

  // ---- Start ----
  async function start() {
    if (gatewayProc) return;
    if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

    fs.mkdirSync(ctx.stateDir, { recursive: true });
    fs.mkdirSync(ctx.workspaceDir, { recursive: true });

    // Clean up stale lock files
    const lockFiles = (cfg.gateway.lockFiles || []).map((f) =>
      f.startsWith("/") ? f : path.join(ctx.stateDir, f),
    );
    // Also check /tmp
    if (cfg.gateway.lockFiles) {
      for (const f of cfg.gateway.lockFiles) {
        lockFiles.push(`/tmp/${cfg.slug}-${f}`);
      }
    }
    for (const lockPath of lockFiles) {
      try { fs.rmSync(lockPath, { force: true }); } catch {}
    }

    // Run beforeGatewayStart hook
    if (hooks?.beforeGatewayStart) {
      await hooks.beforeGatewayStart({ ...ctx, runCmd, clawArgs, configFilePath });
    }

    // Build gateway args from service config
    const gatewayCtx = { ...ctx, configFilePath: configFilePath() };
    const args = cfg.gateway.buildArgs(gatewayCtx);

    const env = {
      ...process.env,
      [cfg.env.stateDir.key]: ctx.stateDir,
      [cfg.env.workspaceDir.key]: ctx.workspaceDir,
    };

    gatewayProc = childProcess.spawn(ctx.node, clawArgs(args), {
      stdio: "inherit",
      env,
    });

    const safeArgs = args.map((arg, i) =>
      args[i - 1] === "--token" ? "[REDACTED]" : arg,
    );
    console.log(`[gateway] starting with command: ${ctx.node} ${clawArgs(safeArgs).join(" ")}`);
    console.log(`[gateway] STATE_DIR: ${ctx.stateDir}`);
    console.log(`[gateway] WORKSPACE_DIR: ${ctx.workspaceDir}`);
    console.log(`[gateway] config path: ${configFilePath()}`);

    gatewayProc.on("error", (err) => {
      console.error(`[gateway] spawn error: ${String(err)}`);
      lastGatewayError = String(err);
      gatewayProc = null;
    });

    gatewayProc.on("exit", (code, signal) => {
      console.error(`[gateway] exited code=${code} signal=${signal}`);
      lastGatewayExit = { code, signal, at: new Date().toISOString() };
      gatewayProc = null;
      gatewayHealthy = false;
      if (!shuttingDown && isConfigured()) {
        console.log("[gateway] scheduling auto-restart in 2s...");
        setTimeout(() => {
          if (!shuttingDown && !gatewayProc && isConfigured()) {
            ensure().catch((err) => {
              console.error(`[gateway] auto-restart failed: ${err.message}`);
            });
          }
        }, 2000);
      }
    });
  }

  // ---- Ensure running ----
  async function ensure() {
    if (!isConfigured()) return { ok: false, reason: "not configured" };
    if (gatewayProc) return { ok: true };
    if (!gatewayStarting) {
      gatewayStarting = (async () => {
        await start();
        const ready = await waitForReady({ timeoutMs: 60_000 });
        if (!ready) throw new Error("Gateway did not become ready in time");
      })().finally(() => {
        gatewayStarting = null;
      });
    }
    await gatewayStarting;
    return { ok: true };
  }

  // ---- Restart ----
  async function restart() {
    if (gatewayProc) {
      try { gatewayProc.kill("SIGTERM"); } catch (err) {
        console.warn(`[gateway] kill error: ${err.message}`);
      }
      await sleep(750);
      gatewayProc = null;
    }
    return ensure();
  }

  // ---- Stop ----
  function stop() {
    if (gatewayProc) {
      try { gatewayProc.kill("SIGTERM"); } catch {}
      gatewayProc = null;
    }
  }

  // ---- Graceful shutdown ----
  async function shutdown() {
    shuttingDown = true;
    if (gatewayProc) {
      try {
        gatewayProc.kill("SIGTERM");
        await Promise.race([
          new Promise((resolve) => gatewayProc?.on("exit", resolve)),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
        if (gatewayProc && !gatewayProc.killed) {
          gatewayProc.kill("SIGKILL");
        }
      } catch (err) {
        console.warn(`[wrapper] error killing gateway: ${err.message}`);
      }
    }
  }

  return {
    get target() { return GATEWAY_TARGET; },
    get proc() { return gatewayProc; },
    get isStarting() { return gatewayStarting !== null; },
    get isReady() { return gatewayProc !== null && gatewayStarting === null; },
    get lastError() { return lastGatewayError; },
    get lastExit() { return lastGatewayExit; },

    isConfigured,
    configFilePath,
    clawArgs,
    start,
    ensure,
    restart,
    stop,
    probe,
    waitForReady,
    shutdown,
  };
}
