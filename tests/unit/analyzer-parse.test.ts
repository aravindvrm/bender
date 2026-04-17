import { describe, expect, it } from "vitest";
import { parseAnalysisOutput } from "../../src/roles/analyzer.js";

describe("parseAnalysisOutput", () => {
  it("extracts schema and api sections even when schema is not fenced SQL", () => {
    const raw = [
      "# Project Brief",
      "",
      "## What This Is",
      "A concise brief.",
      "",
      "---",
      "",
      "# Architecture",
      "",
      "## Stack",
      "- **Framework**: Express",
      "",
      "## Database Schema",
      "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL);",
      "",
      "## API Routes",
      "- GET /health: health check",
      "- POST /users: create user",
      "",
      "## Conventions",
      "- Naming: camelCase",
    ].join("\n");

    const parsed = parseAnalysisOutput(raw);
    expect(parsed.brief).toContain("# Project Brief");
    expect(parsed.architecture).toContain("# Architecture");
    expect(parsed.schema).toContain("CREATE TABLE users");
    expect(parsed.apiContracts).toContain("GET /health");
    expect(parsed.conventions).toContain("Naming");
  });

  it("falls back to architecture heading split without horizontal rule", () => {
    const raw = [
      "# Project Brief",
      "",
      "This repo handles card processing.",
      "",
      "# Architecture",
      "",
      "## Database Schema",
      "```sql",
      "CREATE TABLE cards (id INTEGER PRIMARY KEY, title TEXT);",
      "```",
      "",
      "## API",
      "- GET /cards: list cards",
    ].join("\n");

    const parsed = parseAnalysisOutput(raw);
    expect(parsed.brief).toContain("# Project Brief");
    expect(parsed.architecture).toContain("# Architecture");
    expect(parsed.schema).toContain("CREATE TABLE cards");
    expect(parsed.apiContracts).toContain("/cards");
  });
});

