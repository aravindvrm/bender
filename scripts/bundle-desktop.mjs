#!/usr/bin/env node
/**
 * Bundle the desktop entry points (main, backend, cli) into self-contained
 * JS files using esbuild. Inlines all JS dependencies so the packaged DMG
 * does not need to ship `node_modules` (avoids ~5GB of cloud SDKs that
 * `promptfoo` pulls in transitively, and avoids the chromium-pickle-js
 * ASAR header overflow that hits when node_modules is bundled).
 *
 * Native modules (anything with a `.node` binary) and `electron` itself
 * MUST be external — they are loaded at runtime from the unpacked location.
 *
 * Output layout (under dist-bundle/) mirrors the tsc layout (dist/) so
 * runtime path resolution like `__dirname/../llm/prompts/` keeps working.
 */
import { build } from "esbuild";
import { rm, mkdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const outDir = join(root, "dist-bundle");
const distDir = join(root, "dist");

// Externals: packages with native binaries or that must not be bundled.
// `promptfoo` is external because it brings ~5GB of cloud SDKs we don't ship;
// the desktop bundle lazy-loads it at runtime and degrades gracefully.
const external = [
  "electron",
  "better-sqlite3",
  "fsevents",
  "sharp",
  "@img/sharp-darwin-arm64",
  "@img/sharp-darwin-x64",
  "@img/sharp-linux-x64",
  "@img/sharp-linux-arm64",
  "@img/sharp-win32-x64",
  "onnxruntime-node",
  "@anthropic-ai/claude-agent-sdk",
  "@napi-rs/canvas",
  "promptfoo",
];

const entries = [
  { in: join(root, "src/cli/index.ts"),       out: join(outDir, "cli/index.js") },
  { in: join(root, "src/desktop/main.ts"),    out: join(outDir, "desktop/main.js") },
  { in: join(root, "src/desktop/backend.ts"), out: join(outDir, "desktop/backend.js") },
];

async function bundleAll() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  for (const entry of entries) {
    process.stdout.write(`bundling ${entry.in}\n`);
    await build({
      entryPoints: [entry.in],
      outfile: entry.out,
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      sourcemap: false,
      minify: false,
      external,
      // Provide `require` for any CJS deps that need it. Don't declare
      // __dirname/__filename here — esbuild auto-shims those when it sees
      // them, and a second declaration triggers a SyntaxError at runtime.
      banner: {
        js: [
          "import { createRequire as __benderCreateRequire } from 'node:module';",
          "const require = __benderCreateRequire(import.meta.url);",
        ].join("\n"),
      },
      logLevel: "warning",
    });
  }

  // Web frontend: copy from dist/web → dist-bundle/web
  const webSrc = join(distDir, "web");
  const webDst = join(outDir, "web");
  if (existsSync(webSrc)) {
    await cp(webSrc, webDst, { recursive: true });
    process.stdout.write(`copied dist/web → dist-bundle/web\n`);
  } else {
    process.stderr.write(`warning: dist/web not found — run vite build first\n`);
  }

  // LLM prompts: copy src/llm/prompts → dist-bundle/llm/prompts
  const promptsSrc = join(root, "src/llm/prompts");
  const promptsDst = join(outDir, "llm/prompts");
  if (existsSync(promptsSrc)) {
    await cp(promptsSrc, promptsDst, { recursive: true });
    process.stdout.write(`copied src/llm/prompts → dist-bundle/llm/prompts\n`);
  }

  process.stdout.write("desktop bundle complete\n");
}

bundleAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
