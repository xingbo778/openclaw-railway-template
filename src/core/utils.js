import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Debug helper – only logs when DEBUG flag is set
// ---------------------------------------------------------------------------
export function createDebugLogger(flag) {
  return flag ? (...args) => console.log(...args) : () => {};
}

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// runCmd – spawn a command, capture combined stdout+stderr, return {code, output}
// ---------------------------------------------------------------------------
export function runCmd(cmd, args, opts = {}) {
  const { env: extraEnv, ...spawnOpts } = opts;
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...spawnOpts,
      env: { ...process.env, ...extraEnv },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

// ---------------------------------------------------------------------------
// redactSecrets – best-effort secret redaction from output strings
// ---------------------------------------------------------------------------
export function buildRedactor(patterns) {
  return function redactSecrets(text) {
    if (!text) return text;
    let s = String(text);
    for (const pat of patterns) {
      s = s.replace(pat, "[REDACTED]");
    }
    return s;
  };
}

// ---------------------------------------------------------------------------
// resolveToken – resolve a stable bearer token from env → file → generate
// ---------------------------------------------------------------------------
export function resolveToken({ envKey, stateDir, fileName = "gateway.token" }) {
  const envTok = process.env[envKey]?.trim();
  if (envTok) return envTok;

  const tokenPath = `${stateDir}/${fileName}`;
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch (err) {
    console.warn(
      `[gateway-token] could not read existing token: ${err.code || err.message}`,
    );
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.warn(
      `[gateway-token] could not persist token: ${err.code || err.message}`,
    );
  }
  return generated;
}
