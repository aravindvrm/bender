#!/usr/bin/env node
/**
 * Smoke-test the freshly packaged Bender.app:
 *
 *  1. Spawn the backend from inside app.asar via Electron-as-Node
 *     (ELECTRON_RUN_AS_NODE=1 + process.execPath = the Bender binary).
 *  2. Poll /api/health until it returns { ok: true } or we time out.
 *  3. Kill the child cleanly and exit 0 on success, non-zero on failure.
 *
 * This catches the two bug classes that bit us during the v0.2.0 / v0.2.1
 * cycle, both of which built a green DMG but produced an app that wouldn't
 * launch:
 *   - Bundle SyntaxErrors (e.g. duplicate __dirname declarations)
 *   - Backend spawn ENOENT in packaged contexts
 *
 * Runs from `npm run desktop:pack:verify`, and as a post-step of
 * `desktop:pack:dmg` / `desktop:pack:dir`.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const HEALTH_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const KILL_GRACE_MS = 3_000;

function readOutputDir() {
  // Mirrors the package.json `build.directories.output` template expansion.
  // electron-builder substitutes ${env.HOME}; we do the same here.
  return process.env.BENDER_DIST_DESKTOP
    ?? join(homedir(), ".bender-dist-desktop");
}

function locateAppBundle(outputDir) {
  // electron-builder writes the .app to <output>/mac-<arch>/Bender.app.
  for (const sub of ["mac-arm64", "mac", "mac-x64"]) {
    const candidate = join(outputDir, sub, "Bender.app");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`No Bender.app found under ${outputDir}/mac-*/`);
}

function findFreePort() {
  return new Promise((resolveP, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr !== "object" || addr === null) {
        reject(new Error("Could not determine free port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolveP(port));
    });
  });
}

async function pollHealth(port, deadline, child) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Backend exited prematurely with code ${child.exitCode} before becoming healthy`,
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        const json = await res.json();
        if (json && json.ok === true) return;
      }
    } catch {
      // not up yet — keep polling
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Health endpoint did not return ok within ${HEALTH_TIMEOUT_MS}ms`);
}

/**
 * Spawn a one-shot Electron-as-Node child that imports @napi-rs/keyring,
 * does a round-trip with a sentinel account, and exits 0 on success. Any
 * non-zero exit / missing-module error fails the verifier. Uses a
 * throwaway service+account so it can't collide with real bender entries.
 */
async function checkKeychainLoad(electronBin, appBundle) {
  const probeAccount = `__verify_probe_${Date.now()}__`;
  const probeScript = `
    const { Entry } = require('@napi-rs/keyring');
    const e = new Entry('bender-verify', '${probeAccount}');
    e.setPassword('ok');
    if (e.getPassword() !== 'ok') { console.error('keyring readback mismatch'); process.exit(2); }
    e.deletePassword();
    if (e.getPassword() !== null) { console.error('keyring delete failed'); process.exit(3); }
    console.log('keyring ok');
  `;
  return new Promise((resolveP, reject) => {
    // Run the probe via -e so we don't have to copy a script into the asar.
    // Set NODE_PATH so Electron-as-Node can find the unpacked native module
    // wherever electron-builder put it.
    const resourcesDir = join(appBundle, "Contents", "Resources");
    const child = spawn(electronBin, ["-e", probeScript], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_PATH: join(resourcesDir, "app.asar.unpacked", "node_modules") + ":" +
                   join(resourcesDir, "app.asar", "node_modules"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => { stdout += b; });
    child.stderr.on("data", (b) => { stderr += b; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 && stdout.includes("keyring ok")) {
        process.stdout.write(`[verify] keychain native module loads cleanly\n`);
        resolveP();
      } else {
        reject(new Error(
          `keychain probe failed (exit ${code})\n` +
          (stdout ? `stdout: ${stdout.trim()}\n` : "") +
          (stderr ? `stderr: ${stderr.trim()}\n` : ""),
        ));
      }
    });
  });
}

function killChild(child) {
  return new Promise((resolveP) => {
    if (child.exitCode !== null || child.killed) {
      resolveP();
      return;
    }
    let settled = false;
    const onExit = () => {
      if (settled) return;
      settled = true;
      resolveP();
    };
    child.once("exit", onExit);
    try { child.kill(); } catch { /* ignore */ }
    setTimeout(() => {
      if (settled) return;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, KILL_GRACE_MS);
  });
}

async function main() {
  const outputDir = resolve(readOutputDir());
  const appBundle = locateAppBundle(outputDir);
  const electronBin = join(appBundle, "Contents", "MacOS", "Bender");
  const backendScript = join(
    appBundle, "Contents", "Resources", "app.asar",
    "dist-bundle", "desktop", "backend.js",
  );
  if (!existsSync(electronBin)) throw new Error(`Missing binary: ${electronBin}`);

  const port = await findFreePort();
  process.stdout.write(`[verify] spawning backend from ${appBundle}\n`);
  process.stdout.write(`[verify] using port ${port}\n`);

  // First, smoke-test that the OS keychain native module loads from inside
  // the packaged app. If @napi-rs/keyring is mis-externalized or its
  // platform binary isn't shipped, every secret operation fails silently
  // at runtime and credentials revert to plaintext. Catch that here.
  await checkKeychainLoad(electronBin, appBundle);

  const stdoutChunks = [];
  const stderrChunks = [];
  const child = spawn(electronBin, [backendScript], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      BENDER_PORT: String(port),
      BENDER_DESKTOP_MODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => stdoutChunks.push(b));
  child.stderr.on("data", (b) => stderrChunks.push(b));

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  try {
    await pollHealth(port, deadline, child);
    process.stdout.write(`[verify] /api/health ok\n`);
  } catch (err) {
    const out = Buffer.concat(stdoutChunks).toString("utf-8").trim();
    const errText = Buffer.concat(stderrChunks).toString("utf-8").trim();
    process.stderr.write(`[verify] FAILED: ${err.message}\n`);
    if (out) process.stderr.write(`[verify] stdout:\n${out}\n`);
    if (errText) process.stderr.write(`[verify] stderr:\n${errText}\n`);
    await killChild(child);
    process.exit(1);
  }

  await killChild(child);
  process.stdout.write(`[verify] packaged DMG smoke test passed\n`);
}

main().catch((err) => {
  process.stderr.write(`[verify] unexpected error: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
