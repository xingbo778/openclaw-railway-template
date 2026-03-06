# OpenClaw Railway Template

One-click deploy **[OpenClaw](https://github.com/openclaw/openclaw)** on [Railway](https://railway.app) — with a web-based setup wizard, persistent storage, and zero CLI required.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/openclaw)

---

## What You Get

| Feature | Description |
|---------|-------------|
| **OpenClaw Gateway** | Full gateway + Control UI at `/` and `/openclaw` |
| **Setup Wizard** | Password-protected web UI at `/setup` for onboarding |
| **Debug Console** | Run allowlisted openclaw commands without SSH |
| **Config Editor** | Edit `openclaw.json` in-browser with automatic backups |
| **Device Pairing** | Approve pairing requests via UI |
| **Import / Export** | `.tar.gz` backup and restore (up to 250 MB) |
| **Custom Providers** | Add Ollama, vLLM, LM Studio, or any OpenAI-compatible endpoint |
| **Health Monitoring** | Public `/healthz` endpoint, auto-doctor on failures |
| **Version Control** | Auto-detect latest stable release or pin a specific tag |

## Quick Start

1. **Deploy** — click the Railway button above (or create a project from this repo)
2. **Set variables** — at minimum, set `SETUP_PASSWORD` in Railway Variables
3. **Open the wizard** — visit `https://<your-app>.up.railway.app/setup`
4. **Complete setup** — choose an auth provider, add channel tokens (Telegram / Discord / Slack)
5. **Chat** — head to `/openclaw`

> Railway will automatically create a volume at `/data`, build from the Dockerfile, and assign a public domain.

## Architecture

```
Browser ──► Railway (public domain)
              │
              ▼
         Express wrapper (PORT 8080)
              │
              ├── /setup/*  ──► Setup Wizard (Basic auth via SETUP_PASSWORD)
              ├── /healthz  ──► Health probe (no auth)
              └── /*        ──► http-proxy ──► OpenClaw Gateway (localhost:18789)
                                               (Bearer token auto-injected)
```

The wrapper manages the full OpenClaw lifecycle:

- **Unconfigured** — no `openclaw.json` → all traffic redirects to `/setup`
- **Configured** — spawns `openclaw gateway run`, waits for readiness, then proxies

State is persisted on the Railway volume at `/data` so config, credentials, and workspace survive redeploys.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `SETUP_PASSWORD` | Password to access the `/setup` wizard |

### Recommended

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_STATE_DIR` | `/data/.openclaw` | Config and credentials directory |
| `OPENCLAW_WORKSPACE_DIR` | `/data/workspace` | Agent workspace directory |
| `OPENCLAW_GATEWAY_TOKEN` | *(auto-generated)* | Stable auth token for the gateway — set this so the token survives redeploys |
| `OPENCLAW_VERSION` | *(auto-detect)* | Pin a specific release tag (e.g. `v2026.2.19`) |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Wrapper HTTP port |
| `INTERNAL_GATEWAY_PORT` | `18789` | Internal gateway port |
| `OPENCLAW_ENTRY` | `/openclaw/dist/entry.js` | Path to openclaw entry point |
| `OPENCLAW_TEMPLATE_DEBUG` | `false` | Enable verbose logging (includes sensitive tokens) |
| `OPENCLAW_TRUST_PROXY_ALL` | `false` | Trust all proxies (Railway is auto-detected) |

### Legacy (auto-migrated)

`CLAWDBOT_*` and `MOLTBOT_*` variables are automatically migrated to their `OPENCLAW_*` equivalents at startup.

## Version Control

When `OPENCLAW_VERSION` is **not set**, the Dockerfile auto-detects the latest stable release via a 3-tier cascade:

1. **GitHub Releases API** — `/releases/latest` (excludes pre-releases and drafts)
2. **`git ls-remote` tag sort** — fallback when API is unreachable
3. **`main` branch** — last resort, with a warning in build logs

To pin a version, set `OPENCLAW_VERSION=v2026.2.19` in Railway Variables and redeploy. See [docs/OPENCLAW-VERSION-CONTROL.md](docs/OPENCLAW-VERSION-CONTROL.md) for details.

## Getting Chat Tokens

### Telegram

1. Message **@BotFather** on Telegram
2. Run `/newbot` and follow the prompts
3. Copy the token (e.g. `123456789:AA...`) into the setup wizard

### Discord

1. Create an application at the [Developer Portal](https://discord.com/developers/applications)
2. Open **Bot** tab → **Add Bot** → copy the **Bot Token**
3. Enable **MESSAGE CONTENT INTENT** (required)
4. Invite the bot via OAuth2 URL Generator (scopes: `bot`, `applications.commands`)

## Troubleshooting

### "disconnected (1008): pairing required"

Visit `/setup` → **Pairing Helper** → refresh pending devices → approve. Or use the Debug Console: run `openclaw.devices.list`, then `openclaw.devices.approve` with the `requestId`.

### 502 Bad Gateway / "Application failed to respond"

1. Check `/healthz` for gateway status
2. Open `/setup` → Debug Console → run `openclaw doctor`
3. Check `/setup/api/debug` for full diagnostics
4. Ensure the volume is mounted at `/data` and env vars are set

### Gateway won't start

1. Verify `OPENCLAW_STATE_DIR=/data/.openclaw` and `OPENCLAW_WORKSPACE_DIR=/data/workspace`
2. Run `openclaw doctor --fix` in the Debug Console
3. Check `/setup/api/debug` for error details

### Token mismatch

Set `OPENCLAW_GATEWAY_TOKEN` in Railway Variables to keep the token stable across redeploys. If already set, use the Config Editor to verify `gateway.auth.token` matches.

### Build failures

Check Railway build logs — the auto-detection tier is logged clearly. If the latest release is broken, pin a known-good version: `OPENCLAW_VERSION=v2026.2.15`.

### Import fails

- **"File too large"** — reduce workspace size before exporting
- **"Requires /data paths"** — ensure `OPENCLAW_STATE_DIR` and `OPENCLAW_WORKSPACE_DIR` are under `/data`

## Local Development

```bash
# Docker build & run
docker build -t openclaw-railway-template .
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -v $(pwd)/.tmpdata:/data \
  openclaw-railway-template

# Open http://localhost:8080/setup (password: test)
```

```bash
# Without Docker (requires openclaw installed or OPENCLAW_ENTRY set)
export SETUP_PASSWORD=test
export OPENCLAW_STATE_DIR=/tmp/openclaw-test/.openclaw
export OPENCLAW_WORKSPACE_DIR=/tmp/openclaw-test/workspace
npm run dev
```

```bash
# Syntax check
npm run lint

# Pin a version at build time
docker build --build-arg OPENCLAW_VERSION=v2026.2.19 -t openclaw-test .
```

## Documentation

- [CLAUDE.md](CLAUDE.md) — Developer documentation and architecture internals
- [CONTRIBUTING.md](CONTRIBUTING.md) — Contribution guidelines
- [docs/OPENCLAW-VERSION-CONTROL.md](docs/OPENCLAW-VERSION-CONTROL.md) — Version auto-detection details
- [docs/MIGRATION_FROM_MOLTBOT.md](docs/MIGRATION_FROM_MOLTBOT.md) — Migration from legacy templates
- [docs/STARTUP-IMPROVEMENTS.md](docs/STARTUP-IMPROVEMENTS.md) — Gateway startup and reliability notes

## Support

- **Issues**: [github.com/codetitlan/openclaw-railway-template/issues](https://github.com/codetitlan/openclaw-railway-template/issues)
- **Discord**: [discord.com/invite/clawd](https://discord.com/invite/clawd)
- **OpenClaw Docs**: [docs.openclaw.com](https://docs.openclaw.com)

## License

[MIT](LICENSE) — Copyright (c) 2026 Codetitlan Community

## Credits

Based on [clawdbot-railway-template](https://github.com/vignesh07/clawdbot-railway-template). Smart Railway proxy detection by [@ArtificialSight](https://github.com/ArtificialSight) (PR #12).
