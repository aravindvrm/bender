import { resolve } from "node:path";
import { startServer } from "./server.js";
import * as ui from "./ui.js";

export async function reviewCommand(projectDir?: string): Promise<void> {
  const initialProject = projectDir ? resolve(projectDir) : undefined;

  ui.header("Bender Review — Dashboard");
  ui.info("Starting local server...\n");

  await startServer(initialProject);

  ui.success("Server running on http://localhost:3142");
  console.log();
  if (initialProject) {
    ui.info(`Project: ${initialProject}`);
  } else {
    ui.info("No project selected. Open or create one from the dashboard.");
  }
  console.log();
  ui.info("Press Ctrl+C to stop.\n");

  await new Promise(() => {});
}
