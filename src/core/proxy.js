import httpProxy from "http-proxy";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Create and configure the reverse proxy
// ---------------------------------------------------------------------------
export function createProxy({ gatewayTarget, token, loadingHtmlPath }) {
  // Load loading page once at startup
  let loadingHtml = null;
  try {
    loadingHtml = fs.readFileSync(loadingHtmlPath, "utf8");
  } catch {
    loadingHtml = `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="5"/><title>Starting</title></head><body><p>Service is starting. This page will refresh automatically.</p></body></html>`;
  }

  const proxy = httpProxy.createProxyServer({
    target: gatewayTarget,
    ws: true,
    xfwd: true,
    proxyTimeout: 120_000,
    timeout: 120_000,
    changeOrigin: true,
  });

  // Prevent proxy errors from crashing the wrapper.
  proxy.on("error", (err, _req, res) => {
    console.error("[proxy]", err);
    if (res && typeof res.headersSent !== "undefined" && !res.headersSent) {
      res.writeHead(503, { "Content-Type": "text/html" });
      res.end(loadingHtml || "Gateway unavailable. Retrying...");
    }
  });

  // Inject auth token into proxied HTTP requests
  proxy.on("proxyReq", (proxyReq) => {
    proxyReq.setHeader("Authorization", `Bearer ${token}`);
    proxyReq.setHeader("Origin", gatewayTarget);
  });

  // Inject auth token into proxied WebSocket upgrades
  proxy.on("proxyReqWs", (proxyReq) => {
    proxyReq.setHeader("Authorization", `Bearer ${token}`);
    proxyReq.setHeader("Origin", gatewayTarget);
  });

  return { proxy, loadingHtml };
}
