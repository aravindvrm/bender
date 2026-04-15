import type { Express } from "express";
import { readEffectiveConfig } from "../../state/config.js";
import { executeTerminalCommand, validateTerminalCommand } from "../services/terminal.js";

interface TerminalRouteDeps {
  getProject: () => string;
}

export function registerTerminalRoutes(app: Express, deps: TerminalRouteDeps): void {
  app.post("/api/terminal/exec", async (req, res) => {
    const { command, confirmDangerous } = req.body as { command?: string; confirmDangerous?: boolean };
    const validation = validateTerminalCommand(command);
    if (!validation.ok) {
      res.status(validation.status).json({ error: validation.error });
      return;
    }

    let projectRoot: string;
    try {
      projectRoot = deps.getProject();
    } catch {
      res.status(400).json({ error: "No project selected" });
      return;
    }

    const effectiveConfig = await readEffectiveConfig(projectRoot);
    const terminalExecEnabled = effectiveConfig.security?.terminalExec?.enabled ?? true;
    if (!terminalExecEnabled) {
      res.status(403).json({ error: "Terminal execution is disabled in config (security.terminalExec.enabled)." });
      return;
    }

    const requireDangerousConfirmation = effectiveConfig.security?.terminalExec?.requireDangerousConfirmation ?? true;
    if (validation.dangerous && requireDangerousConfirmation && !confirmDangerous) {
      res.status(400).json({ error: "Command requires confirmation. Re-run with confirmDangerous=true." });
      return;
    }

    const output = await executeTerminalCommand(validation.command, projectRoot);
    res.json(output);
  });
}
