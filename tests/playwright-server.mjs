import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.PLAYWRIGHT_SERVER_PORT ?? "4173");
const tempProject = await mkdtemp(join(tmpdir(), "bender-pw-project-"));
const tempHome = await mkdtemp(join(tmpdir(), "bender-pw-home-"));
process.env.BENDER_HOME_DIR = tempHome;

const { startServer } = await import("../dist/cli/server.js");

let server = null;
let shuttingDown = false;

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (server?.listening) {
      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve(undefined);
        });
      });
    }
  } finally {
    await rm(tempProject, { recursive: true, force: true });
    await rm(tempHome, { recursive: true, force: true });
    delete process.env.BENDER_HOME_DIR;
    process.exit(code);
  }
}

process.on("SIGINT", () => { void shutdown(0); });
process.on("SIGTERM", () => { void shutdown(0); });
process.on("uncaughtException", (err) => {
  console.error(err);
  void shutdown(1);
});

server = await startServer(tempProject, port);
console.log(`[playwright-server] listening on http://127.0.0.1:${port}`);

await new Promise(() => {
  // Keep process alive until Playwright terminates it.
});

