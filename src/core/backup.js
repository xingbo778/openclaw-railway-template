import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Export backup as .tar.gz stream
// ---------------------------------------------------------------------------
export function handleExport({ stateDir, workspaceDir, serviceName }, _req, res) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="${serviceName}-backup-${ts}.tar.gz"`,
  );

  const stateAbs = path.resolve(stateDir);
  const workspaceAbs = path.resolve(workspaceDir);
  const dataRoot = "/data";
  const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  const tar = childProcess.spawn(
    "tar",
    ["-czf", "-", "--dereference", ...paths],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  );

  tar.stderr.on("data", (d) =>
    console.warn("[export] tar stderr:", d.toString()),
  );
  tar.on("error", (err) => {
    console.error("[export] tar error:", err);
    if (!res.headersSent) res.status(500).end();
  });

  tar.stdout.pipe(res);
}

// ---------------------------------------------------------------------------
// Security helpers for import
// ---------------------------------------------------------------------------
export function isUnderDir(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

export function looksSafeTarPath(entry) {
  if (!entry) return false;
  if (entry.includes("..")) return false;
  if (entry.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(entry)) return false;
  return true;
}

export function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`Upload too large (max ${Math.round(maxBytes / 1048576)} MB)`));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
