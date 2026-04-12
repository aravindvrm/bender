import { resolve } from "node:path";
import { StateManager } from "../state/manager.js";
import { startServer } from "./server.js";
import * as ui from "./ui.js";

export async function reviewCommand(projectRoot: string): Promise<void> {
  const state = new StateManager(projectRoot);

  if (!state.isInitialized()) {
    ui.error("No .bender/ directory found. Run `bender init` first.");
    return;
  }

  ui.header("Bender Review — Dashboard");
  ui.info("Starting local server...\n");

  await startServer(projectRoot);

  ui.success("API server running on http://localhost:3142");
  ui.success("Open http://localhost:3141 for the dashboard");
  console.log();
  ui.info("Press Ctrl+C to stop.\n");

  // Keep process alive
  await new Promise(() => {});
}
