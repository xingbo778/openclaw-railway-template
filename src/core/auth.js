import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Per-IP sliding-window rate limiter (no external deps)
// ---------------------------------------------------------------------------
export function createRateLimiter({ windowMs = 60_000, maxAttempts = 50 } = {}) {
  const attempts = new Map();

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of attempts) {
      if (now - data.windowStart > windowMs) {
        attempts.delete(ip);
      }
    }
  }, windowMs);

  // Don't keep Node alive just for the cleanup timer.
  if (cleanupInterval.unref) cleanupInterval.unref();

  return {
    attempts,
    cleanupInterval,

    isRateLimited(ip) {
      const now = Date.now();
      const data = attempts.get(ip);
      if (!data || now - data.windowStart > windowMs) {
        attempts.set(ip, { windowStart: now, count: 1 });
        return false;
      }
      data.count++;
      return data.count > maxAttempts;
    },
  };
}

// ---------------------------------------------------------------------------
// Basic-auth middleware factory
// ---------------------------------------------------------------------------
export function createSetupAuth({ getPassword, rateLimiter, realm = "Setup" }) {
  return function requireSetupAuth(req, res, next) {
    const password = getPassword();
    if (!password) {
      return res
        .status(500)
        .type("text/plain")
        .send(
          "SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.",
        );
    }

    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    if (rateLimiter.isRateLimited(ip)) {
      return res.status(429).type("text/plain").send("Too many requests. Try again later.");
    }

    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme !== "Basic" || !encoded) {
      res.set("WWW-Authenticate", `Basic realm="${realm}"`);
      return res.status(401).send("Auth required");
    }

    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    const pw = idx >= 0 ? decoded.slice(idx + 1) : "";
    const passwordHash = crypto.createHash("sha256").update(pw).digest();
    const expectedHash = crypto.createHash("sha256").update(password).digest();
    const isValid = crypto.timingSafeEqual(passwordHash, expectedHash);

    if (!isValid) {
      res.set("WWW-Authenticate", `Basic realm="${realm}"`);
      return res.status(401).send("Invalid password");
    }
    return next();
  };
}

// ---------------------------------------------------------------------------
// Verify auth from WebSocket upgrade request (Basic header or subprotocol)
// ---------------------------------------------------------------------------
export function createWsAuthVerifier(getPassword) {
  return function verifyWsAuth(req) {
    const password = getPassword();
    if (!password) return false;

    // Check Authorization header (Basic auth)
    const authHeader = req.headers["authorization"] || "";
    if (authHeader.startsWith("Basic ")) {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
      const pw = decoded.includes(":") ? decoded.split(":").slice(1).join(":") : decoded;
      const passwordHash = crypto.createHash("sha256").update(pw).digest();
      const expectedHash = crypto.createHash("sha256").update(password).digest();
      if (crypto.timingSafeEqual(passwordHash, expectedHash)) return true;
    }

    // Check WebSocket subprotocol for browser clients
    const protocols = (req.headers["sec-websocket-protocol"] || "")
      .split(",")
      .map((s) => s.trim());
    for (const proto of protocols) {
      if (proto.startsWith("auth-")) {
        try {
          const decoded = Buffer.from(proto.slice(5), "base64").toString("utf8");
          const pw = decoded.includes(":") ? decoded.split(":").slice(1).join(":") : decoded;
          const passwordHash = crypto.createHash("sha256").update(pw).digest();
          const expectedHash = crypto.createHash("sha256").update(password).digest();
          if (crypto.timingSafeEqual(passwordHash, expectedHash)) return true;
        } catch { /* invalid base64 */ }
      }
    }
    return false;
  };
}
