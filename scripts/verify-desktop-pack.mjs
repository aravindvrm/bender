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
 * Spawn a one-shot Electron-as-Node child that imports @napi-rs/keyring
 * and instantiates an Entry, then attempts a round-trip with a sentinel
 * account.
 *
 * What we strictly verify (build-failing): the native module loads from
 * inside the packaged context. This catches the externalization regression
 * we actually care about — if @napi-rs/keyring drops out of the bundle's
 * external list, runtime credential ops would silently fall back to
 * plaintext.
 *
 * What we treat as best-effort (warning, not failure): the actual write/
 * read/delete round-trip. macOS CI runners have no default user keychain
 * so any setPassword() throws "A default keychain could not be found."
 * That's expected on CI and not something we should fail the build on —
 * a real user's machine has a default keychain, and isKeychainAvailable()
 * gracefully falls back to plaintext when one isn't present anyway.
 */
async function checkKeychainLoad(electronBin, appBundle) {
  const probeAccount = `__verify_probe_${Date.now()}__`;
  const probeScript = `
    let mod;
    try {
      mod = require('@napi-rs/keyring');
    } catch (err) {
      console.error('LOAD_FAILED:', err && err.message ? err.message : err);
      process.exit(10);
    }
    if (!mod.Entry) {
      console.error('LOAD_FAILED: Entry constructor missing from @napi-rs/keyring exports');
      process.exit(11);
    }
    let entry;
    try {
      entry = new mod.Entry('bender-verify', '${probeAccount}');
    } catch (err) {
      console.error('CONSTRUCT_FAILED:', err && err.message ? err.message : err);
      process.exit(12);
    }
    console.log('LOAD_OK');
    // Best-effort round-trip. CI macOS runners lack a default keychain;
    // treat failures here as a warning, not a build error.
    try {
      entry.setPassword('ok');
      const got = entry.getPassword();
      entry.deletePassword();
      if (got === 'ok') {
        console.log('ROUNDTRIP_OK');
      } else {
        console.error('ROUNDTRIP_MISMATCH: read', got);
      }
    } catch (err) {
      console.error('ROUNDTRIP_UNAVAILABLE:', err && err.message ? err.message : err);
    }
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
      // Strict requirement: the native module loads and an Entry can be
      // constructed. That alone proves the bundle externalization is
      // intact.
      if (code === 0 && stdout.includes("LOAD_OK")) {
        if (stdout.includes("ROUNDTRIP_OK")) {
          process.stdout.write(`[verify] keychain native module loads, round-trip succeeded\n`);
        } else {
          // Round-trip not available (typical on CI without a default keychain).
          // Surface as a warning so it's visible in build logs, but don't fail.
          process.stdout.write(`[verify] keychain native module loads cleanly (round-trip skipped — no default keychain available)\n`);
        }
        resolveP();
      } else {
        reject(new Error(
          `keychain native module failed to load (exit ${code})\n` +
          (stdout ? `stdout: ${stdout.trim()}\n` : "") +
          (stderr ? `stderr: ${stderr.trim()}\n` : ""),
        ));
      }
    });
  });
}

async function checkSqliteLoad(electronBin, appBundle) {
  const probeScript = `
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    const row = db.prepare('SELECT 1 AS v').get();
    if (!row || row.v !== 1) { console.error('sqlite readback mismatch'); process.exit(2); }
    db.close();
    console.log('sqlite ok');
  `;
  return new Promise((resolveP, reject) => {
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
      if (code === 0 && stdout.includes("sqlite ok")) {
        process.stdout.write(`[verify] better-sqlite3 native module loads cleanly\n`);
        resolveP();
      } else {
        reject(new Error(
          `better-sqlite3 probe failed (exit ${code})\n` +
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
  await checkSqliteLoad(electronBin, appBundle);

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
