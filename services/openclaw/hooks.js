// ---------------------------------------------------------------------------
// OpenClaw lifecycle hooks
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";

const AUTH_SECRET_FLAG_MAP = {
  "openai-api-key":      "--openai-api-key",
  apiKey:                "--anthropic-api-key",
  "openrouter-api-key":  "--openrouter-api-key",
  "ai-gateway-api-key":  "--ai-gateway-api-key",
  "moonshot-api-key":    "--moonshot-api-key",
  "kimi-code-api-key":   "--kimi-code-api-key",
  "gemini-api-key":      "--gemini-api-key",
  "zai-api-key":         "--zai-api-key",
  "minimax-api":         "--minimax-api-key",
  "minimax-api-lightning": "--minimax-api-key",
  "synthetic-api-key":   "--synthetic-api-key",
  "opencode-zen":        "--opencode-zen-api-key",
};

const hooks = {
  // ---- Build onboarding CLI args ----
  buildOnboardArgs(ctx, payload) {
    const args = [
      "onboard",
      "--non-interactive",
      "--accept-risk",
      "--json",
      "--no-install-daemon",
      "--skip-health",
      "--workspace", ctx.workspaceDir,
      "--gateway-bind", "loopback",
      "--gateway-port", String(ctx.port),
      "--gateway-auth", "token",
      "--gateway-token", ctx.token,
      "--flow", payload.flow || "quickstart",
    ];

    if (payload.authChoice) {
      args.push("--auth-choice", payload.authChoice);

      const secret = (payload.authSecret || "").trim();
      const flag = AUTH_SECRET_FLAG_MAP[payload.authChoice];
      if (flag && secret) {
        args.push(flag, secret);
      }

      if (payload.authChoice === "token" && secret) {
        args.push("--token-provider", "anthropic", "--token", secret);
      }
    }

    return args;
  },

  // ---- Validate setup payload ----
  validatePayload(serviceConfig, payload) {
    if (payload.flow && !serviceConfig.validFlows.includes(payload.flow)) {
      return `Invalid flow: ${payload.flow}. Must be one of: ${serviceConfig.validFlows.join(", ")}`;
    }
    if (payload.authChoice && !serviceConfig.validAuthChoices.includes(payload.authChoice)) {
      return `Invalid authChoice: ${payload.authChoice}`;
    }
    const stringFields = [
      "telegramToken", "discordToken",
      "slackBotToken", "slackAppToken",
      "authSecret", "model",
    ];
    for (const field of stringFields) {
      if (payload[field] !== undefined && typeof payload[field] !== "string") {
        return `Invalid ${field}: must be a string`;
      }
    }
    return null;
  },

  // ---- After onboard succeeds: configure gateway, channels, etc. ----
  async afterOnboard(ctx, payload) {
    let extra = "";

    // Set gateway config
    const configCmds = [
      { path: "gateway.controlUi.allowInsecureAuth", value: "true" },
      { path: "gateway.auth.token", value: ctx.token },
      { path: "gateway.trustedProxies", value: '["127.0.0.1"]', json: true },
    ];

    for (const c of configCmds) {
      const args = ["config", "set"];
      if (c.json) args.push("--json");
      args.push(c.path, c.value);
      const r = await ctx.runCmd(ctx.node, ctx.clawArgs(args));
      extra += `[config] ${c.path} exit=${r.code}\n`;
    }

    // Set model if specified
    if (payload.model?.trim()) {
      extra += `[setup] Setting model to ${payload.model.trim()}...\n`;
      const r = await ctx.runCmd(ctx.node, ctx.clawArgs(["models", "set", payload.model.trim()]));
      extra += `[models set] exit=${r.code}\n${r.output || ""}`;
    }

    // Configure channels
    async function configureChannel(name, cfgObj) {
      const set = await ctx.runCmd(
        ctx.node,
        ctx.clawArgs(["config", "set", "--json", `channels.${name}`, JSON.stringify(cfgObj)]),
      );
      const get = await ctx.runCmd(
        ctx.node,
        ctx.clawArgs(["config", "get", `channels.${name}`]),
      );
      return (
        `\n[${name} config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}` +
        `\n[${name} verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`
      );
    }

    if (payload.telegramToken?.trim()) {
      extra += await configureChannel("telegram", {
        enabled: true,
        dmPolicy: "pairing",
        botToken: payload.telegramToken.trim(),
        groupPolicy: "allowlist",
        streamMode: "partial",
      });
    }

    if (payload.discordToken?.trim()) {
      extra += await configureChannel("discord", {
        enabled: true,
        token: payload.discordToken.trim(),
        groupPolicy: "allowlist",
        dm: { policy: "pairing" },
      });
    }

    if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
      extra += await configureChannel("slack", {
        enabled: true,
        botToken: payload.slackBotToken?.trim() || undefined,
        appToken: payload.slackAppToken?.trim() || undefined,
      });
    }

    return extra;
  },

  // ---- Before gateway starts: sync token to config file ----
  async beforeGatewayStart(ctx) {
    console.log(`[gateway] ========== GATEWAY START TOKEN SYNC ==========`);
    console.log(`[gateway] Syncing wrapper token to config (length: ${ctx.token.length})`);
    ctx.debug(`[gateway] Token preview: ${ctx.token.slice(0, 16)}...`);

    const syncResult = await ctx.runCmd(
      ctx.node,
      ctx.clawArgs(["config", "set", "gateway.auth.token", ctx.token]),
    );

    console.log(`[gateway] Sync result: exit code ${syncResult.code}`);
    if (syncResult.output?.trim()) {
      console.log(`[gateway] Sync output: ${syncResult.output}`);
    }
  },

  // ---- On first boot: run doctor --fix ----
  async onBoot(ctx) {
    console.log("[wrapper] running openclaw doctor --fix...");
    const dr = await ctx.runCmd(ctx.node, ctx.clawArgs(["doctor", "--fix"]));
    console.log(`[wrapper] doctor --fix exit=${dr.code}`);
    if (dr.output) console.log(dr.output);
  },

  // ---- Get service info (version, channels help) ----
  async getServiceInfo(ctx) {
    const [version, channelsHelp] = await Promise.all([
      ctx.runCmd(ctx.node, ctx.clawArgs(["--version"])),
      ctx.runCmd(ctx.node, ctx.clawArgs(["channels", "add", "--help"])),
    ]);
    return {
      version: version.output.trim(),
      channelsHelp: channelsHelp.output,
    };
  },

  // ---- Custom setup routes (devices, pairing, doctor, debug, etc.) ----
  setupRoutes(app, { requireAuth, ctx, gateway }) {
    // Debug info
    app.get("/setup/api/debug", requireAuth, async (_req, res) => {
      const v = await ctx.runCmd(ctx.node, ctx.clawArgs(["--version"]));
      const help = await ctx.runCmd(ctx.node, ctx.clawArgs(["channels", "add", "--help"]));
      res.json({
        wrapper: {
          node: process.version,
          port: ctx.wrapperPort,
          stateDir: ctx.stateDir,
          workspaceDir: ctx.workspaceDir,
          configPath: gateway.configFilePath(),
          gatewayTokenFromEnv: Boolean(process.env[ctx.serviceConfig.env.gatewayToken.key]?.trim()),
          gatewayTokenPersisted: fs.existsSync(
            `${ctx.stateDir}/gateway.token`,
          ),
          railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
        },
        openclaw: {
          entry: ctx.entry,
          node: ctx.node,
          version: v.output.trim(),
          channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
        },
      });
    });

    // Pairing approve
    app.post("/setup/api/pairing/approve", requireAuth, async (req, res) => {
      const { channel, code } = req.body || {};
      if (!channel || !code) {
        return res.status(400).json({ ok: false, error: "Missing channel or code" });
      }
      const r = await ctx.runCmd(
        ctx.node,
        ctx.clawArgs(["pairing", "approve", String(channel), String(code)]),
      );
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: r.output });
    });

    // Devices list
    app.get("/setup/api/devices", requireAuth, async (_req, res) => {
      const result = await ctx.runCmd(
        ctx.node,
        ctx.clawArgs(["devices", "list", "--json", "--token", ctx.token]),
      );
      const raw = result.output || "";
      let data = null;
      try { data = JSON.parse(raw); } catch {
        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        if (start >= 0 && end > start) {
          try { data = JSON.parse(raw.slice(start, end + 1)); } catch { data = null; }
        }
      }
      return res.json({ ok: result.code === 0 || Boolean(data), data, raw });
    });

    // Devices approve
    app.post("/setup/api/devices/approve", requireAuth, async (req, res) => {
      const { requestId } = req.body || {};
      const args = ["devices", "approve"];
      if (requestId) {
        const trimmed = String(requestId).trim();
        if (!/^[A-Za-z0-9-]+$/.test(trimmed)) {
          return res.status(400).json({ ok: false, error: "Invalid requestId format" });
        }
        args.push(trimmed);
      } else {
        args.push("--latest");
      }
      args.push("--token", ctx.token);
      const result = await ctx.runCmd(ctx.node, ctx.clawArgs(args));
      return res.status(result.code === 0 ? 200 : 500).json({ ok: result.code === 0, output: result.output });
    });

    // Doctor
    app.post("/setup/api/doctor", requireAuth, async (_req, res) => {
      const result = await ctx.runCmd(ctx.node, ctx.clawArgs(["doctor", "--non-interactive", "--repair"]));
      return res.status(result.code === 0 ? 200 : 500).json({ ok: result.code === 0, output: result.output });
    });

    // Reset
    app.post("/setup/api/reset", requireAuth, async (_req, res) => {
      try {
        fs.rmSync(gateway.configFilePath(), { force: true });
        res.type("text/plain").send("OK - deleted config file. You can rerun setup now.");
      } catch (err) {
        res.status(500).type("text/plain").send(String(err));
      }
    });
  },

  // ---- Control UI rewrite: auto-inject token into /openclaw requests ----
  controlUiRewrite(req, res, token) {
    if (
      req.method === "GET" &&
      (req.path === "/openclaw" || req.path.startsWith("/openclaw/")) &&
      !req.query.token &&
      !req.headers.authorization &&
      !req.headers.upgrade
    ) {
      const sep = req.url.includes("?") ? "&" : "?";
      return res.redirect(307, `${req.url}${sep}token=${encodeURIComponent(token)}`);
    }
    return false; // not handled
  },

  // ---- Harden filesystem on startup ----
  hardenFs(ctx) {
    try {
      fs.mkdirSync(path.join(ctx.stateDir, "credentials"), { recursive: true, mode: 0o700 });
    } catch {}
    try { fs.chmodSync(ctx.stateDir, 0o700); } catch {}
    try { fs.chmodSync(path.join(ctx.stateDir, "credentials"), 0o700); } catch {}
  },

  // ---- Legacy migration ----
  migrateLegacy(ctx, serviceConfig) {
    // Migrate legacy env vars
    for (const prefix of serviceConfig.legacyEnvPrefixes || []) {
      for (const [key, val] of Object.entries(process.env)) {
        if (key.startsWith(prefix)) {
          const newKey = key.replace(prefix, "OPENCLAW_");
          if (!process.env[newKey]) {
            process.env[newKey] = val;
            console.warn(`[migration] ${key} → ${newKey}`);
          }
        }
      }
    }

    // Migrate legacy config files
    for (const legacyFile of serviceConfig.legacyConfigFiles || []) {
      const legacyPath = path.join(ctx.stateDir, legacyFile);
      const newPath = path.join(ctx.stateDir, serviceConfig.configFile);
      try {
        if (fs.existsSync(legacyPath) && !fs.existsSync(newPath)) {
          fs.renameSync(legacyPath, newPath);
          console.warn(`[migration] ${legacyFile} → ${serviceConfig.configFile}`);
        }
      } catch {}
    }
  },
};

export default hooks;
