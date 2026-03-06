// ---------------------------------------------------------------------------
// OpenClaw service definition
// ---------------------------------------------------------------------------

const config = {
  name: "OpenClaw",
  slug: "openclaw",

  // ---- Environment variable mapping ----
  env: {
    stateDir:     { key: "OPENCLAW_STATE_DIR",       default: "/data/.openclaw" },
    workspaceDir: { key: "OPENCLAW_WORKSPACE_DIR",   default: "/data/workspace" },
    gatewayToken: { key: "OPENCLAW_GATEWAY_TOKEN" },
    configPath:   { key: "OPENCLAW_CONFIG_PATH" },
    entry:        { key: "OPENCLAW_ENTRY",           default: "/openclaw/dist/entry.js" },
    node:         { key: "OPENCLAW_NODE",            default: "node" },
    debug:        { key: "OPENCLAW_TEMPLATE_DEBUG" },
    trustProxy:   { key: "OPENCLAW_TRUST_PROXY_ALL" },
  },

  // ---- Config file ----
  configFile: "openclaw.json",
  legacyConfigFiles: ["moltbot.json", "clawdbot.json"],
  legacyEnvPrefixes: ["CLAWDBOT_", "MOLTBOT_"],

  // ---- Gateway ----
  gateway: {
    defaultPort: 18789,
    defaultHost: "127.0.0.1",
    lockFiles: ["gateway.lock"],
    healthEndpoints: ["/openclaw", "/openclaw", "/", "/health"],
    controlUiPath: "/openclaw",

    buildArgs(ctx) {
      return [
        "gateway", "run",
        "--bind", "loopback",
        "--port", String(ctx.port),
        "--auth", "token",
        "--token", ctx.token,
        "--allow-unconfigured",
      ];
    },
  },

  // ---- Auth providers (rendered by setup wizard) ----
  authGroups: [
    {
      value: "openai", label: "OpenAI", hint: "Codex OAuth + API key",
      options: [
        { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
        { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
        { value: "openai-api-key", label: "OpenAI API key" },
      ],
    },
    {
      value: "anthropic", label: "Anthropic", hint: "Claude Code CLI + API key",
      options: [
        { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
        { value: "token", label: "Anthropic token (paste setup-token)" },
        { value: "apiKey", label: "Anthropic API key" },
      ],
    },
    {
      value: "google", label: "Google", hint: "Gemini API key + OAuth",
      options: [
        { value: "gemini-api-key", label: "Google Gemini API key" },
        { value: "google-antigravity", label: "Google Antigravity OAuth" },
        { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" },
      ],
    },
    {
      value: "openrouter", label: "OpenRouter", hint: "API key",
      options: [{ value: "openrouter-api-key", label: "OpenRouter API key" }],
    },
    {
      value: "ai-gateway", label: "Vercel AI Gateway", hint: "API key",
      options: [
        { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" },
      ],
    },
    {
      value: "moonshot", label: "Moonshot AI", hint: "Kimi K2 + Kimi Code",
      options: [
        { value: "moonshot-api-key", label: "Moonshot AI API key" },
        { value: "kimi-code-api-key", label: "Kimi Code API key" },
      ],
    },
    {
      value: "zai", label: "Z.AI (GLM 4.7)", hint: "API key",
      options: [{ value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }],
    },
    {
      value: "minimax", label: "MiniMax", hint: "M2.1 (recommended)",
      options: [
        { value: "minimax-api", label: "MiniMax M2.1" },
        { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" },
      ],
    },
    {
      value: "qwen", label: "Qwen", hint: "OAuth",
      options: [{ value: "qwen-portal", label: "Qwen OAuth" }],
    },
    {
      value: "copilot", label: "Copilot", hint: "GitHub + local proxy",
      options: [
        { value: "github-copilot", label: "GitHub Copilot (GitHub device login)" },
        { value: "copilot-proxy", label: "Copilot Proxy (local)" },
      ],
    },
    {
      value: "synthetic", label: "Synthetic", hint: "Anthropic-compatible (multi-model)",
      options: [{ value: "synthetic-api-key", label: "Synthetic API key" }],
    },
    {
      value: "opencode-zen", label: "OpenCode Zen", hint: "API key",
      options: [
        { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" },
      ],
    },
  ],

  // ---- Valid auth choices (flat list for validation) ----
  validAuthChoices: [
    "codex-cli", "openai-codex", "openai-api-key",
    "claude-cli", "token", "apiKey",
    "gemini-api-key", "google-antigravity", "google-gemini-cli",
    "openrouter-api-key", "ai-gateway-api-key",
    "moonshot-api-key", "kimi-code-api-key",
    "zai-api-key",
    "minimax-api", "minimax-api-lightning",
    "qwen-portal",
    "github-copilot", "copilot-proxy",
    "synthetic-api-key",
    "opencode-zen",
  ],

  validFlows: ["quickstart", "advanced", "manual"],

  // ---- Channels ----
  channels: [
    { id: "telegram", label: "Telegram", fields: [{ key: "telegramToken", label: "Bot Token" }] },
    { id: "discord",  label: "Discord",  fields: [{ key: "discordToken", label: "Bot Token" }] },
    {
      id: "slack", label: "Slack",
      fields: [
        { key: "slackBotToken", label: "Bot Token" },
        { key: "slackAppToken", label: "App Token" },
      ],
    },
  ],

  // ---- Secret redaction patterns ----
  secretPatterns: [
    /(sk-[A-Za-z0-9_-]{10,})/g,
    /(gho_[A-Za-z0-9_]{10,})/g,
    /(xox[baprs]-[A-Za-z0-9-]{10,})/g,
    /(\d{5,}:[A-Za-z0-9_-]{10,})/g,        // Telegram bot tokens
    /(AA[A-Za-z0-9_-]{10,}:\S{10,})/g,
  ],

  // ---- Console commands ----
  consoleCommands: buildConsoleCommands(),
};

// ---------------------------------------------------------------------------
// Console command definitions
// ---------------------------------------------------------------------------
function buildConsoleCommands() {
  // Helper: run an openclaw CLI subcommand
  function cli(subArgs) {
    return async (ctx, _arg) => ctx.runCmd(ctx.node, ctx.clawArgs(subArgs));
  }

  return [
    // Gateway lifecycle (handled by core)
    { id: "gateway.restart", label: "Restart Gateway", type: "lifecycle" },
    { id: "gateway.stop",    label: "Stop Gateway",    type: "lifecycle" },
    { id: "gateway.start",   label: "Start Gateway",   type: "lifecycle" },

    // OpenClaw CLI — read-only / safe
    { id: "openclaw.version", label: "Version",  run: cli(["--version"]) },
    { id: "openclaw.status",  label: "Status",   run: cli(["status"]) },
    { id: "openclaw.health",  label: "Health",   run: cli(["health"]) },
    { id: "openclaw.doctor",  label: "Doctor",   run: cli(["doctor"]) },

    {
      id: "openclaw.logs.tail", label: "Tail Logs",
      run: async (ctx, arg) => {
        const count = arg?.trim() || "50";
        if (!/^\d+$/.test(count)) return { code: 1, output: "Invalid tail count (must be a number)" };
        return ctx.runCmd(ctx.node, ctx.clawArgs(["logs", "--tail", count]));
      },
    },

    {
      id: "openclaw.config.get", label: "Get Config",
      run: async (ctx, arg) => {
        const cfgPath = arg?.trim();
        if (!cfgPath) return { code: 1, output: "Config path required (e.g., gateway.port)" };
        return ctx.runCmd(ctx.node, ctx.clawArgs(["config", "get", cfgPath]));
      },
    },

    { id: "openclaw.devices.list", label: "List Devices", run: cli(["devices", "list"]) },

    {
      id: "openclaw.devices.approve", label: "Approve Device",
      run: async (ctx, arg) => {
        const requestId = arg?.trim();
        if (!requestId) return { code: 1, output: "Device requestId required" };
        if (!/^[A-Za-z0-9_-]+$/.test(requestId)) return { code: 1, output: "Invalid requestId format" };
        return ctx.runCmd(ctx.node, ctx.clawArgs(["devices", "approve", requestId]));
      },
    },

    { id: "openclaw.plugins.list", label: "List Plugins", run: cli(["plugins", "list"]) },

    {
      id: "openclaw.plugins.enable", label: "Enable Plugin",
      run: async (ctx, arg) => {
        const name = arg?.trim();
        if (!name) return { code: 1, output: "Plugin name required" };
        if (!/^[A-Za-z0-9_-]+$/.test(name)) return { code: 1, output: "Invalid plugin name format" };
        return ctx.runCmd(ctx.node, ctx.clawArgs(["plugins", "enable", name]));
      },
    },

    {
      id: "openclaw.agents.add", label: "Add Agent",
      run: async (ctx, arg) => {
        if (!arg?.trim()) return { code: 1, output: "Agent config required (JSON with id and workspace)" };
        try {
          const cfg = JSON.parse(arg);
          const args = ["agents", "add", cfg.id];
          if (cfg.workspace) args.push("--workspace", cfg.workspace);
          return ctx.runCmd(ctx.node, ctx.clawArgs(args));
        } catch (e) { return { code: 1, output: `Invalid JSON: ${e.message}` }; }
      },
    },

    { id: "openclaw.agents.list", label: "List Agents", run: cli(["agents", "list"]) },

    {
      id: "openclaw.agents.set-identity", label: "Set Agent Identity",
      run: async (ctx, arg) => {
        if (!arg?.trim()) return { code: 1, output: "Identity config required" };
        try {
          const cfg = JSON.parse(arg);
          const args = ["agents", "set-identity", "--agent", cfg.agent];
          if (cfg.name) args.push("--name", cfg.name);
          if (cfg.emoji) args.push("--emoji", cfg.emoji);
          if (cfg.theme) args.push("--theme", cfg.theme);
          return ctx.runCmd(ctx.node, ctx.clawArgs(args));
        } catch (e) { return { code: 1, output: `Invalid JSON: ${e.message}` }; }
      },
    },

    {
      id: "openclaw.agents.bind", label: "Bind Agent",
      run: async (ctx, arg) => {
        if (!arg?.trim()) return { code: 1, output: "Bind config required" };
        try {
          const cfg = JSON.parse(arg);
          return ctx.runCmd(ctx.node, ctx.clawArgs(["agents", "bind", "--agent", cfg.agent, "--bind", cfg.bind]));
        } catch (e) { return { code: 1, output: `Invalid JSON: ${e.message}` }; }
      },
    },

    {
      id: "openclaw.models.set", label: "Set Model",
      run: async (ctx, arg) => {
        if (!arg?.trim()) return { code: 1, output: "Model config required" };
        try {
          const cfg = JSON.parse(arg);
          const args = ["models", "set"];
          if (cfg.agent) args.push("--agent", cfg.agent);
          args.push(cfg.model);
          return ctx.runCmd(ctx.node, ctx.clawArgs(args));
        } catch (e) { return { code: 1, output: `Invalid JSON: ${e.message}` }; }
      },
    },

    {
      id: "openclaw.config.set", label: "Set Config",
      run: async (ctx, arg) => {
        if (!arg?.trim()) return { code: 1, output: "Config path and value required" };
        try {
          const cfg = JSON.parse(arg);
          const isComplex = typeof cfg.value === "object";
          const args = ["config", "set"];
          if (isComplex) args.push("--json");
          args.push(cfg.path);
          args.push(isComplex ? JSON.stringify(cfg.value) : cfg.value);
          return ctx.runCmd(ctx.node, ctx.clawArgs(args));
        } catch (e) { return { code: 1, output: `Invalid JSON: ${e.message}` }; }
      },
    },

    {
      id: "openclaw.agent.message", label: "Agent Message",
      run: async (ctx, arg) => {
        if (!arg?.trim()) return { code: 1, output: "Agent and message required" };
        try {
          const cfg = JSON.parse(arg);
          return ctx.runCmd(ctx.node, ctx.clawArgs(["agent", "--agent", cfg.agent, "--message", cfg.message]));
        } catch (e) { return { code: 1, output: `Invalid JSON: ${e.message}` }; }
      },
    },
  ];
}

export default config;
