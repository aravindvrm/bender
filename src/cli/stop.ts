import {
  clearDashboardPid,
  findPidsListeningOnPort,
  isProcessRunning,
  readDashboardPid,
  stopProcessGracefully,
} from "./serverProcess.js";
import * as ui from "./ui.js";

const API_PORT = 3142;

export async function stopCommand(): Promise<void> {
  const pid = await readDashboardPid();
  let stoppedAny = false;

  if (pid && isProcessRunning(pid)) {
    ui.info(`Stopping dashboard process ${pid}...`);
    const result = await stopProcessGracefully(pid);
    if (result.stopped) {
      stoppedAny = true;
      ui.success(result.forced
        ? `Stopped dashboard process ${pid} (forced).`
        : `Stopped dashboard process ${pid}.`);
    } else {
      ui.error(`Failed to stop dashboard process ${pid}.`);
    }
  }

  if (!stoppedAny) {
    const portPids = await findPidsListeningOnPort(API_PORT);
    const candidates = portPids.filter((candidate) => candidate !== process.pid);
    if (candidates.length > 0) {
      for (const candidate of candidates) {
        ui.info(`Stopping process ${candidate} on port ${API_PORT}...`);
        const result = await stopProcessGracefully(candidate);
        if (result.stopped) {
          stoppedAny = true;
          ui.success(result.forced
            ? `Stopped process ${candidate} on port ${API_PORT} (forced).`
            : `Stopped process ${candidate} on port ${API_PORT}.`);
        }
      }
    }
  }

  await clearDashboardPid();

  if (!stoppedAny) {
    ui.info("No running Bender dashboard process found.");
  }
}
