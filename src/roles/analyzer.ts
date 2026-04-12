import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, relative } from "node:path";
import type { LanguageModel } from "ai";
import { runRoleStreaming } from "./base.js";

// ── Codebase scanner ──────────────────────────────────────────────────────────

export interface CodebaseSummary {
  fileTree: string;
  keyFiles: { path: string; content: string }[];
  packageJson: string | null;
  readmeContent: string | null;
  schemaFiles: { path: string; content: string }[];
  totalFiles: number;
  languages: string[];
}

/** Extensions we'll read as source files */
const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".cs", ".php",
  ".sql", ".prisma", ".graphql",
  ".json", ".yaml", ".yml", ".toml", ".env.example",
  ".md",
]);

/** Directories always ignored */
const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", "dist", "build",
  "out", ".cache", "__pycache__", ".venv", "venv", "vendor",
  "coverage", ".turbo", ".vercel", ".netlify", "tmp", ".bender",
]);

/** Schema-related filenames / patterns to prioritise */
const SCHEMA_PATTERNS = [
  "schema.sql", "schema.prisma", "schema.ts", "schema.js",
  "migrations", "migrate", "drizzle",
];

async function walkTree(
  dir: string,
  maxDepth: number,
  depth = 0,
): Promise<string[]> {
  if (depth > maxDepth) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const lines: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const prefix = "  ".repeat(depth);
    if (entry.isDirectory()) {
      lines.push(`${prefix}${entry.name}/`);
      lines.push(...await walkTree(join(dir, entry.name), maxDepth, depth + 1));
    } else {
      lines.push(`${prefix}${entry.name}`);
    }
  }
  return lines;
}

async function collectFiles(
  dir: string,
  projectRoot: string,
  results: { path: string; relPath: string; size: number }[],
  depth = 0,
): Promise<void> {
  if (depth > 8) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(fullPath, projectRoot, results, depth + 1);
    } else if (SOURCE_EXTS.has(extname(entry.name).toLowerCase())) {
      const s = await stat(fullPath);
      results.push({ path: fullPath, relPath: relative(projectRoot, fullPath), size: s.size });
    }
  }
}

function detectLanguages(files: { relPath: string }[]): string[] {
  const extCounts: Record<string, number> = {};
  for (const f of files) {
    const ext = extname(f.relPath).toLowerCase();
    extCounts[ext] = (extCounts[ext] ?? 0) + 1;
  }
  const extToLang: Record<string, string> = {
    ".ts": "TypeScript", ".tsx": "TypeScript",
    ".js": "JavaScript", ".jsx": "JavaScript",
    ".py": "Python", ".rb": "Ruby", ".go": "Go",
    ".rs": "Rust", ".java": "Java", ".cs": "C#", ".php": "PHP",
  };
  return [...new Set(
    Object.entries(extCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([ext]) => extToLang[ext])
      .filter(Boolean),
  )];
}

/** Decide which files are most worth reading */
function prioritiseFiles(
  files: { path: string; relPath: string; size: number }[],
): { path: string; relPath: string; size: number }[] {
  const HIGH_PRIORITY = [
    /^package\.json$/,
    /^README\.md$/i,
    /^tsconfig\.json$/,
    /schema\.(sql|prisma|ts|js)$/i,
    /^drizzle\//,
    /^prisma\//,
    /migrations?\//,
    /^src\/app\/.*route\.(ts|js)$/,
    /^src\/pages\/api\//,
    /^app\/api\//,
    /^routes?\//,
    /^src\/routes?\//,
    /^server\.(ts|js)$/,
    /^app\.(ts|js)$/,
    /^index\.(ts|js)$/,
    /^src\/index\.(ts|js)$/,
    /^src\/main\.(ts|js)$/,
    /\.(env\.example|env\.sample)$/,
    /^docker-compose\.ya?ml$/,
    /^fly\.toml$/,
    /^vercel\.json$/,
  ];

  const MED_PRIORITY = [
    /^src\/(models|db|database|schema)\//,
    /^src\/(middleware|auth|hooks)\//,
    /^src\/(components|pages|app)\//,
    /^test|spec/,
  ];

  function score(f: { relPath: string }): number {
    for (const re of HIGH_PRIORITY) if (re.test(f.relPath)) return 3;
    for (const re of MED_PRIORITY) if (re.test(f.relPath)) return 2;
    return 1;
  }

  return files
    .filter((f) => f.size < 100_000) // skip huge files
    .sort((a, b) => score(b) - score(a));
}

/** Read up to `maxFiles` files, staying within `maxTotalChars` */
async function readKeyFiles(
  files: { path: string; relPath: string; size: number }[],
  maxFiles = 60,
  maxTotalChars = 120_000,
): Promise<{ path: string; content: string }[]> {
  const result: { path: string; content: string }[] = [];
  let total = 0;
  for (const f of files.slice(0, maxFiles)) {
    if (total >= maxTotalChars) break;
    try {
      const raw = await readFile(f.path, "utf-8");
      const snippet = raw.slice(0, 8000); // cap per-file
      result.push({ path: f.relPath, content: snippet });
      total += snippet.length;
    } catch { /* binary or unreadable */ }
  }
  return result;
}

export async function scanCodebase(projectRoot: string): Promise<CodebaseSummary> {
  // File tree (max 4 levels)
  const treeLines = await walkTree(projectRoot, 4);
  const fileTree = treeLines.join("\n");

  // Collect all source files
  const allFiles: { path: string; relPath: string; size: number }[] = [];
  await collectFiles(projectRoot, projectRoot, allFiles);

  const languages = detectLanguages(allFiles);
  const prioritised = prioritiseFiles(allFiles);
  const keyFiles = await readKeyFiles(prioritised);

  // package.json shortcut
  const pkgPath = join(projectRoot, "package.json");
  const packageJson = existsSync(pkgPath) ? await readFile(pkgPath, "utf-8").catch(() => null) : null;

  // README shortcut
  const readmePath = [
    join(projectRoot, "README.md"),
    join(projectRoot, "readme.md"),
    join(projectRoot, "README.txt"),
  ].find(existsSync);
  const readmeContent = readmePath ? await readFile(readmePath, "utf-8").catch(() => null) : null;

  // Schema files
  const schemaFiles = keyFiles.filter((f) =>
    SCHEMA_PATTERNS.some((p) => f.path.toLowerCase().includes(p)),
  );

  return {
    fileTree,
    keyFiles,
    packageJson,
    readmeContent,
    schemaFiles,
    totalFiles: allFiles.length,
    languages,
  };
}

// ── Format summary for LLM ────────────────────────────────────────────────────

function formatSummaryForPrompt(summary: CodebaseSummary): string {
  const sections: string[] = [];

  sections.push(`## File Tree\n\`\`\`\n${summary.fileTree}\n\`\`\``);

  if (summary.packageJson) {
    try {
      // Include deps summary rather than full package.json
      const pkg = JSON.parse(summary.packageJson);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      sections.push(`## package.json\n\`\`\`json\n${JSON.stringify({ name: pkg.name, description: pkg.description, scripts: pkg.scripts, dependencies: Object.keys(pkg.dependencies ?? {}), devDependencies: Object.keys(pkg.devDependencies ?? {}) }, null, 2)}\n\`\`\``);
    } catch {
      sections.push(`## package.json\n\`\`\`\n${summary.packageJson.slice(0, 2000)}\n\`\`\``);
    }
  }

  if (summary.readmeContent) {
    sections.push(`## README\n${summary.readmeContent.slice(0, 3000)}`);
  }

  if (summary.schemaFiles.length > 0) {
    sections.push(
      `## Schema / Migration Files\n${summary.schemaFiles
        .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
        .join("\n\n")}`,
    );
  }

  // Remaining key files
  const nonSchema = summary.keyFiles.filter(
    (f) => !summary.schemaFiles.some((s) => s.path === f.path),
  );
  if (nonSchema.length > 0) {
    sections.push(
      `## Source Files\n${nonSchema
        .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
        .join("\n\n")}`,
    );
  }

  sections.push(`\n_Total source files in project: ${summary.totalFiles}_`);
  sections.push(`_Primary languages: ${summary.languages.join(", ") || "unknown"}_`);

  return sections.join("\n\n");
}

// ── LLM analysis ──────────────────────────────────────────────────────────────

export async function analyzeCodebase(
  model: LanguageModel,
  projectRoot: string,
  summary: CodebaseSummary,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  const codebaseContext = formatSummaryForPrompt(summary);

  return runRoleStreaming(
    model,
    "analyzer",
    `You are analyzing an existing codebase located at: ${projectRoot}\n\nHere is the codebase:\n\n${codebaseContext}`,
    `Analyze this codebase and produce the complete project brief and architecture document in the exact format specified in your instructions. Be specific — use actual file names, table names, and route paths from the code shown above.`,
    onChunk,
  );
}

// ── Parse analysis output into separate state files ───────────────────────────

export interface AnalysisResult {
  brief: string;
  architecture: string;
  conventions: string | null;
  schema: string | null;
}

export function parseAnalysisOutput(output: string): AnalysisResult {
  // Split on the horizontal rule separating brief from architecture
  const hrIdx = output.indexOf("\n---\n");
  const briefSection = hrIdx !== -1 ? output.slice(0, hrIdx).trim() : output;
  const archSection = hrIdx !== -1 ? output.slice(hrIdx + 5).trim() : "";

  // Extract conventions section from architecture
  const conventionsMatch = archSection.match(/## Conventions\n([\s\S]*?)(?=\n## |\n# |$)/);
  const conventions = conventionsMatch ? conventionsMatch[1].trim() : null;

  // Extract SQL schema
  const schemaMatch = archSection.match(/```sql\n([\s\S]*?)```/);
  const schema = schemaMatch ? schemaMatch[1].trim() : null;

  return {
    brief: briefSection,
    architecture: archSection || briefSection,
    conventions,
    schema,
  };
}
