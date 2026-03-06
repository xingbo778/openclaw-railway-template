import pty from "node-pty";
import { WebSocketServer } from "ws";

// ---------------------------------------------------------------------------
// Web TUI — PTY over WebSocket
// ---------------------------------------------------------------------------
export function createTuiManager({
  serviceConfig,
  ctx,                  // { node, entry, stateDir, workspaceDir }
  idleTimeoutMs = 300_000,
  maxSessionMs = 1_800_000,
  verifyAuth,           // (req) => boolean
  tuiCommand,           // optional override; default: clawArgs(["tui"])
}) {
  const cfg = serviceConfig;
  let activeTuiSession = null;

  function clawArgs(args) {
    return [ctx.entry, ...args];
  }

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, req) => {
    const clientIp = req.socket?.remoteAddress || "unknown";
    console.log(`[tui] session started from ${clientIp}`);

    let ptyProcess = null;
    let idleTimer = null;
    let maxSessionTimer = null;

    activeTuiSession = {
      ws,
      pty: null,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    };

    function resetIdleTimer() {
      if (activeTuiSession) activeTuiSession.lastActivity = Date.now();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.log("[tui] session idle timeout");
        ws.close(4002, "Idle timeout");
      }, idleTimeoutMs);
    }

    function spawnPty(cols, rows) {
      if (ptyProcess) return;

      console.log(`[tui] spawning PTY with ${cols}x${rows}`);
      const cmd = tuiCommand || clawArgs(["tui"]);
      ptyProcess = pty.spawn(ctx.node, cmd, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: ctx.workspaceDir,
        env: {
          ...process.env,
          [cfg.env.stateDir.key]: ctx.stateDir,
          [cfg.env.workspaceDir.key]: ctx.workspaceDir,
          TERM: "xterm-256color",
        },
      });

      if (activeTuiSession) activeTuiSession.pty = ptyProcess;

      idleTimer = setTimeout(() => {
        console.log("[tui] session idle timeout");
        ws.close(4002, "Idle timeout");
      }, idleTimeoutMs);

      maxSessionTimer = setTimeout(() => {
        console.log("[tui] max session duration reached");
        ws.close(4002, "Max session duration");
      }, maxSessionMs);

      ptyProcess.onData((data) => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        console.log(`[tui] PTY exited code=${exitCode} signal=${signal}`);
        if (ws.readyState === ws.OPEN) ws.close(1000, "Process exited");
      });
    }

    ws.on("message", (message) => {
      resetIdleTimer();
      try {
        const msg = JSON.parse(message.toString());
        if (msg.type === "resize" && msg.cols && msg.rows) {
          const cols = Math.min(Math.max(msg.cols, 10), 500);
          const rows = Math.min(Math.max(msg.rows, 5), 200);
          if (!ptyProcess) {
            spawnPty(cols, rows);
          } else {
            ptyProcess.resize(cols, rows);
          }
        } else if (msg.type === "input" && msg.data && ptyProcess) {
          ptyProcess.write(msg.data);
        }
      } catch (err) {
        console.warn(`[tui] invalid message: ${err.message}`);
      }
    });

    ws.on("close", () => {
      console.log("[tui] session closed");
      clearTimeout(idleTimer);
      clearTimeout(maxSessionTimer);
      if (ptyProcess) {
        try { ptyProcess.kill(); } catch {}
      }
      activeTuiSession = null;
    });

    ws.on("error", (err) => {
      console.error(`[tui] WebSocket error: ${err.message}`);
    });
  });

  return {
    wss,
    get activeSession() { return activeTuiSession; },
    clearSession() {
      if (activeTuiSession) {
        try {
          activeTuiSession.ws.close(1001, "Server shutting down");
          if (activeTuiSession.pty) activeTuiSession.pty.kill();
        } catch {}
        activeTuiSession = null;
      }
    },

    handleUpgrade(req, socket, head) {
      if (!verifyAuth(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"TUI\"\r\n\r\n");
        socket.destroy();
        return;
      }
      if (activeTuiSession) {
        socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    },
  };
}
