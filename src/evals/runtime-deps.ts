/**
 * Runtime-extension installer.
 *
 * Heavy optional features (currently: promptfoo for evals) live as
 * tarballs on GitHub Releases instead of inside the DMG. This module
 * downloads, verifies, and unpacks them under
 * `~/.bender/runtime-deps/<id>/<bundleVersion>/`.
 *
 * Tar extraction shells out to the system `tar` binary — available on
 * macOS, Linux, and Windows 10+. Avoids adding a 100 KB dep just for
 * unpacking.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";

import { getBenderHomePath } from "../state/paths.js";
import {
  RUNTIME_EXTENSIONS,
  UNPUBLISHED_SHA256,
  type RuntimeExtensionId,
  type RuntimeExtensionManifest,
} from "./runtime-deps-manifest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InstallStatus =
  | { state: "installed"; bundleVersion: number; upstreamVersion: string; installedAt: string }
  | { state: "missing" }
  | { state: "stale"; installedBundleVersion: number; expectedBundleVersion: number };

export interface InstallProgress {
  phase: "downloading" | "verifying" | "extracting" | "finalizing";
  bytesDownloaded?: number;
  totalBytes?: number;
}

export class ExtensionUnpublishedError extends Error {
  constructor(id: string) {
    super(`Extension '${id}' has no published bundle yet — manifest is still using the placeholder sha256.`);
    this.name = "ExtensionUnpublishedError";
  }
}

export class ExtensionDownloadError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ExtensionDownloadError";
  }
}

export class ExtensionChecksumError extends Error {
  constructor(public readonly expected: string, public readonly actual: string) {
    super(`Tarball SHA-256 mismatch: expected ${expected}, got ${actual}`);
    this.name = "ExtensionChecksumError";
  }
}

export class ExtensionDiskSpaceError extends Error {
  constructor(public readonly requiredBytes: number, public readonly availableBytes: number) {
    super(
      `Insufficient disk space: need ${formatBytesShort(requiredBytes)}, ` +
      `have ${formatBytesShort(availableBytes)} free in the install directory.`,
    );
    this.name = "ExtensionDiskSpaceError";
  }
}

function formatBytesShort(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Root for all runtime-installed extensions. */
export function runtimeDepsRoot(): string {
  return getBenderHomePath("runtime-deps");
}

/** Per-extension root: `~/.bender/runtime-deps/<id>/`. */
export function extensionRoot(id: string): string {
  return join(runtimeDepsRoot(), id);
}

/** Versioned install dir: `~/.bender/runtime-deps/<id>/<bundleVersion>/`. */
export function extensionInstallDir(id: string, bundleVersion: number): string {
  return join(extensionRoot(id), String(bundleVersion));
}

/** Path to `node_modules/<pkg>` inside an installed extension. */
export function extensionNodeModulesPath(id: string, bundleVersion: number, pkg: string): string {
  return join(extensionInstallDir(id, bundleVersion), "node_modules", pkg);
}

function manifestPath(id: string, bundleVersion: number): string {
  return join(extensionInstallDir(id, bundleVersion), "manifest.json");
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

interface InstalledManifest {
  bundleVersion: number;
  upstreamVersion: string;
  installedAt: string;
  sha256: string;
}

export async function getInstallStatus(id: RuntimeExtensionId): Promise<InstallStatus> {
  const expected = RUNTIME_EXTENSIONS[id];
  const dir = extensionInstallDir(id, expected.bundleVersion);
  if (!existsSync(dir)) {
    const installed = await findInstalledBundleVersion(id);
    if (installed === null) return { state: "missing" };
    return {
      state: "stale",
      installedBundleVersion: installed,
      expectedBundleVersion: expected.bundleVersion,
    };
  }
  try {
    const raw = await readFile(manifestPath(id, expected.bundleVersion), "utf-8");
    const m = JSON.parse(raw) as InstalledManifest;
    return {
      state: "installed",
      bundleVersion: m.bundleVersion,
      upstreamVersion: m.upstreamVersion,
      installedAt: m.installedAt,
    };
  } catch {
    // Dir exists but manifest unreadable — treat as missing so reinstall works.
    return { state: "missing" };
  }
}

async function findInstalledBundleVersion(id: string): Promise<number | null> {
  const root = extensionRoot(id);
  if (!existsSync(root)) return null;
  try {
    const entries = await readdir(root);
    const versions = entries
      .map((e) => Number.parseInt(e, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (versions.length === 0) return null;
    return Math.max(...versions);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Download, verify, and unpack a runtime extension. Idempotent: if the
 * matching bundleVersion is already installed, this is a no-op.
 *
 * The tarball lives at a stable path (`<root>/.partial-vN.tar.gz`) so a
 * second attempt after a failed download can resume via HTTP Range
 * instead of re-fetching the whole 40 MB. Extraction goes into a
 * Date.now()-suffixed staging dir that's atomically renamed into the
 * final location on success.
 *
 * Pre-checks free disk space (compressed + extracted + headroom). If
 * the checksum fails after a full download, the partial is deleted so
 * the next attempt restarts from scratch.
 */
export async function installExtension(
  id: RuntimeExtensionId,
  onProgress?: (p: InstallProgress) => void,
): Promise<void> {
  const ext = RUNTIME_EXTENSIONS[id];

  if (ext.sha256 === UNPUBLISHED_SHA256) {
    throw new ExtensionUnpublishedError(id);
  }

  const status = await getInstallStatus(id);
  if (status.state === "installed") return;

  const finalDir = extensionInstallDir(id, ext.bundleVersion);
  const stagingDir = `${finalDir}.staging-${Date.now()}`;
  // Stable partial path so resume works across attempts. Versioned so a
  // bumped bundleVersion doesn't try to resume against a stale tarball.
  const tarPath = join(extensionRoot(id), `.partial-v${ext.bundleVersion}.tar.gz`);

  await mkdir(extensionRoot(id), { recursive: true });
  await ensureDiskSpace(extensionRoot(id), ext.sizeBytes);

  try {
    onProgress?.({ phase: "downloading", bytesDownloaded: 0, totalBytes: ext.sizeBytes });
    await downloadTarball(ext, tarPath, (bytesDownloaded, totalBytes) => {
      onProgress?.({ phase: "downloading", bytesDownloaded, totalBytes });
    });

    onProgress?.({ phase: "verifying" });
    try {
      await verifyChecksum(tarPath, ext.sha256);
    } catch (err) {
      // Bad bytes (corruption, truncation, mid-stream proxy edits): drop
      // the partial so the next attempt starts clean instead of resuming
      // a poisoned file forever.
      await rm(tarPath, { force: true }).catch(() => {});
      throw err;
    }

    onProgress?.({ phase: "extracting" });
    await mkdir(stagingDir, { recursive: true });
    await extractTarball(tarPath, stagingDir);

    onProgress?.({ phase: "finalizing" });
    await writeManifest(stagingDir, ext);
    await rename(stagingDir, finalDir);

    // Success: drop the now-redundant tarball and any older bundle dirs.
    await rm(tarPath, { force: true }).catch(() => {});
    await pruneOldVersions(id, ext.bundleVersion).catch(() => {});
  } catch (err) {
    // Keep the partial tarball on download/network failures so the next
    // attempt can resume — only the staging dir gets cleaned up.
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function ensureDiskSpace(rootDir: string, compressedBytes: number): Promise<void> {
  // Heuristic: tarball + extracted tree (~7x for promptfoo) + headroom.
  // Better to over-reserve than land mid-extract with ENOSPC.
  const required = compressedBytes * 8;
  try {
    const fs = await statfs(rootDir);
    const available = Number(fs.bavail) * Number(fs.bsize);
    if (Number.isFinite(available) && available < required) {
      throw new ExtensionDiskSpaceError(required, available);
    }
  } catch (err) {
    if (err instanceof ExtensionDiskSpaceError) throw err;
    // statfs unsupported (older Node, exotic filesystem): skip the check
    // and let extraction surface the failure naturally.
  }
}

async function downloadTarball(
  ext: RuntimeExtensionManifest,
  destPath: string,
  onBytes: (bytes: number, total: number | undefined) => void,
): Promise<void> {
  // Resume: if a partial tarball exists, ask for the remaining range.
  // Servers without Range support respond 200 with the full body — we
  // detect that and start over.
  let existing = 0;
  if (existsSync(destPath)) {
    try {
      existing = (await stat(destPath)).size;
      if (ext.sizeBytes > 0 && existing >= ext.sizeBytes) {
        // Fully downloaded already — skip the network round trip and
        // let the caller verify the checksum.
        onBytes(existing, ext.sizeBytes);
        return;
      }
    } catch {
      existing = 0;
    }
  }

  const headers: Record<string, string> = {};
  if (existing > 0) headers["Range"] = `bytes=${existing}-`;

  let res: Response;
  try {
    res = await fetch(ext.url, { redirect: "follow", headers });
  } catch (err) {
    throw new ExtensionDownloadError(`Network error fetching ${ext.url}`, err);
  }
  if (!res.ok || !res.body) {
    throw new ExtensionDownloadError(`HTTP ${res.status} fetching ${ext.url}`);
  }

  const isPartial = res.status === 206;
  const totalHeader = res.headers.get("content-length");
  const remoteLength = totalHeader ? Number.parseInt(totalHeader, 10) : NaN;
  const totalBytes = isPartial && Number.isFinite(remoteLength) ? existing + remoteLength : remoteLength;
  const total = Number.isFinite(totalBytes) ? totalBytes : ext.sizeBytes;

  // 200 means the server ignored our Range header — drop any partial
  // bytes and start clean instead of corrupting the tarball.
  const appendMode = isPartial && existing > 0;
  if (!appendMode && existing > 0) existing = 0;

  let downloaded = existing;
  const out = createWriteStream(destPath, appendMode ? { flags: "a" } : {});
  const body = Readable.fromWeb(res.body as never);
  body.on("data", (chunk: Buffer) => {
    downloaded += chunk.length;
    onBytes(downloaded, Number.isFinite(total) ? total : undefined);
  });
  await pipeline(body, out);
}

async function verifyChecksum(tarPath: string, expected: string): Promise<void> {
  const hash = createHash("sha256");
  const buf = await readFile(tarPath);
  hash.update(buf);
  const actual = hash.digest("hex");
  if (actual !== expected) throw new ExtensionChecksumError(expected, actual);
}

async function extractTarball(tarPath: string, destDir: string): Promise<void> {
  await new Promise<void>((resolveP, reject) => {
    const proc = spawn("tar", ["-xzf", tarPath, "-C", destDir], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (b) => { stderr += b.toString(); });
    proc.once("error", reject);
    proc.once("exit", (code) => {
      if (code === 0) resolveP();
      else reject(new Error(`tar exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function writeManifest(installDir: string, ext: RuntimeExtensionManifest): Promise<void> {
  const m: InstalledManifest = {
    bundleVersion: ext.bundleVersion,
    upstreamVersion: ext.upstreamVersion,
    sha256: ext.sha256,
    installedAt: new Date().toISOString(),
  };
  await writeFile(join(installDir, "manifest.json"), JSON.stringify(m, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Uninstall / prune
// ---------------------------------------------------------------------------

export async function uninstallExtension(id: RuntimeExtensionId): Promise<void> {
  const root = extensionRoot(id);
  if (!existsSync(root)) return;
  await rm(root, { recursive: true, force: true });
}

/** Remove version dirs that don't match `keepVersion`. Best-effort. */
export async function pruneOldVersions(id: RuntimeExtensionId, keepVersion: number): Promise<void> {
  const root = extensionRoot(id);
  if (!existsSync(root)) return;
  const entries = await readdir(root);
  for (const entry of entries) {
    const n = Number.parseInt(entry, 10);
    if (!Number.isFinite(n) || n === keepVersion) continue;
    await rm(join(root, entry), { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Disk usage
// ---------------------------------------------------------------------------

export async function getInstalledSizeBytes(id: RuntimeExtensionId): Promise<number | null> {
  const root = extensionRoot(id);
  if (!existsSync(root)) return null;
  try {
    return await directorySize(root);
  } catch {
    return null;
  }
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(p);
    else if (entry.isFile()) total += (await stat(p)).size;
  }
  return total;
}
