// ---------------------------------------------------------------------------
// Debug console framework — dispatches allowlisted commands
// ---------------------------------------------------------------------------

/**
 * Create a console command handler from service config.
 *
 * Each command in serviceConfig.consoleCommands should have:
 *   { id: string, type?: "lifecycle"|"cli", run?: (ctx, arg) => {code, output} }
 *
 * Lifecycle commands ("gateway.restart", "gateway.stop", "gateway.start")
 * are handled by the gateway manager automatically.
 */
export function createConsoleHandler({
  serviceConfig,
  gateway,
  ctx,
  runCmd,
  redactSecrets,
}) {
  const commands = serviceConfig.consoleCommands || [];
  const allowedIds = new Set(commands.map((c) => c.id));

  // Build a lookup map
  const commandMap = new Map();
  for (const cmd of commands) {
    commandMap.set(cmd.id, cmd);
  }

  return async function handleConsoleRun(req, res) {
    try {
      const { command, arg } = req.body || {};

      if (!command || !allowedIds.has(command)) {
        return res.status(400).json({
          ok: false,
          error: `Command not allowed: ${command || "(empty)"}`,
        });
      }

      let result;

      // Built-in gateway lifecycle commands
      if (command === "gateway.restart") {
        await gateway.restart();
        result = { code: 0, output: "Gateway restarted successfully\n" };
      } else if (command === "gateway.stop") {
        gateway.stop();
        result = { code: 0, output: "Gateway stopped\n" };
      } else if (command === "gateway.start") {
        await gateway.ensure();
        result = { code: 0, output: "Gateway started successfully\n" };
      } else {
        // Delegate to service-defined command handler
        const cmd = commandMap.get(command);
        if (cmd?.run) {
          result = await cmd.run(ctx, arg);
        } else {
          return res.status(500).json({
            ok: false,
            error: "Command allowlisted but not implemented",
          });
        }
      }

      const output = redactSecrets(result.output || "");
      return res.json({
        ok: result.code === 0,
        output,
        exitCode: result.code,
      });
    } catch (err) {
      console.error("[/setup/api/console/run] error:", err);
      return res.status(500).json({
        ok: false,
        error: `Internal error: ${String(err)}`,
      });
    }
  };
}
