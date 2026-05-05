#!/usr/bin/env node
/**
 * Build the promptfoo runtime-deps tarball.
 *
 * Reads `extensions/promptfoo/version.json` for the upstream version
 * pin, runs `npm install promptfoo@<version> --omit=dev` into a temp
 * dir, tars + gzips the resulting node_modules tree, and writes the
 * tarball to dist-extensions/.
 *
 * Output layout (matches what runtime-deps.ts expects to extract into
 * `~/.bender/runtime-deps/promptfoo/<bundleVersion>/`):
 *
 *   tarball root
 *   └── node_modules/
 *       ├── promptfoo/
 *       └── …transitive deps
 *
 * After build, prints a JSON object on stdout describing the artifact
 * (path, sha256, sizeBytes, bundleVersion, upstreamVersion). The CI
 * workflow consumes this for the release-asset metadata.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const versionFile = join(root, "extensions/promptfoo/version.json");
const outDir = join(root, "dist-extensions");

async function readVersion() {
  const raw = await readFile(versionFile, "utf-8");
  const parsed = JSON.parse(raw);
  if (typeof parsed.bundleVersion !== "number" || typeof parsed.upstreamVersion !== "string") {
    throw new Error(`${versionFile} must contain { bundleVersion: number, upstreamVersion: string }`);
  }
  return parsed;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolveP, reject) => {
    // Both child stdout and stderr go to our stderr (fd 2), so we keep this
    // script's stdout reserved for the final JSON metadata. CI consumers
    // pipe stdout into jq; any leakage here would corrupt the parse.
    const proc = spawn(cmd, args, { stdio: ["ignore", 2, 2], ...opts });
    proc.once("error", reject);
    proc.once("exit", (code) => {
      if (code === 0) resolveP();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function sha256(filePath) {
  const buf = await readFile(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

async function main() {
  const { bundleVersion, upstreamVersion } = await readVersion();

  const workDir = await mkdtemp(join(tmpdir(), "bender-promptfoo-bundle-"));
  process.stderr.write(`[bundle] workDir = ${workDir}\n`);

  // npm needs a package.json to install into. Make a minimal one.
  await writeFile(
    join(workDir, "package.json"),
    JSON.stringify({ name: "bender-promptfoo-bundle", private: true, version: "0.0.0" }, null, 2),
    "utf-8",
  );

  process.stderr.write(`[bundle] installing promptfoo@${upstreamVersion}…\n`);
  // --omit=optional drops promptfoo's enormous list of provider-specific
  // SDKs (AWS Bedrock, Azure, Watson, fal.ai, HuggingFace transformers,
  // playwright-chromium, etc.) — they're loaded lazily only when their
  // matching provider is invoked, and we only use anthropic/openai/google.
  // This brings the bundle from ~460 MB to ~150 MB.
  await run(
    "npm",
    [
      "install",
      `promptfoo@${upstreamVersion}`,
      "--omit=dev",
      "--omit=optional",
      "--no-audit",
      "--no-fund",
      "--no-save",
      "--ignore-scripts",
    ],
    { cwd: workDir },
  );

  if (!existsSync(join(workDir, "node_modules", "promptfoo"))) {
    throw new Error("Install completed but node_modules/promptfoo is missing");
  }

  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `promptfoo-v${bundleVersion}.tar.gz`);
  await rm(outPath, { force: true });

  process.stderr.write(`[bundle] creating tarball ${outPath}…\n`);
  // -C workDir, then ./node_modules so the archive root contains
  // node_modules/ directly (matches runtime-deps.ts extraction layout).
  await run("tar", ["-czf", outPath, "-C", workDir, "./node_modules"]);

  const { size: sizeBytes } = await stat(outPath);
  const hash = await sha256(outPath);

  await rm(workDir, { recursive: true, force: true }).catch(() => {});

  const meta = {
    artifact: outPath,
    bundleVersion,
    upstreamVersion,
    sizeBytes,
    sha256: hash,
    url: `https://github.com/aravindvrm/bender/releases/download/promptfoo-bundle-v${bundleVersion}/promptfoo-v${bundleVersion}.tar.gz`,
  };
  process.stdout.write(JSON.stringify(meta, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`[bundle] failed: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
