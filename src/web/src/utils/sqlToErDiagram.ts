/** Parse a SQL schema and produce a Mermaid erDiagram string. */

interface Column {
  name: string;
  type: string;
  isPK: boolean;
  isFK: boolean;
  isUnique: boolean;
}

interface ForeignKey {
  column: string;
  refTable: string;
}

interface Table {
  name: string;
  columns: Column[];
  foreignKeys: ForeignKey[];
}

// Map SQL types to Mermaid-friendly short types
function mapType(raw: string): string {
  const t = raw.toUpperCase().replace(/\(.*\)/, "").trim();
  if (/^(SERIAL|INT|INTEGER|BIGINT|SMALLINT|BIGSERIAL|SMALLSERIAL)$/.test(t)) return "int";
  if (/^(NUMERIC|DECIMAL|FLOAT|DOUBLE|REAL|MONEY)$/.test(t)) return "float";
  if (/^(VARCHAR|TEXT|CHAR|BPCHAR|CITEXT|NAME)$/.test(t)) return "string";
  if (/^(BOOLEAN|BOOL)$/.test(t)) return "boolean";
  if (/^(TIMESTAMP|TIMESTAMPTZ|DATE|TIME|TIMETZ|INTERVAL)$/.test(t)) return "datetime";
  if (/^(JSON|JSONB)$/.test(t)) return "json";
  if (/^(UUID)$/.test(t)) return "uuid";
  if (/^(BYTEA)$/.test(t)) return "bytes";
  return "string";
}

function stripLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function parseCreateTable(rawStmt: string): Table | null {
  const stmt = stripLineComments(rawStmt);
  const nameMatch = stmt.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s*\(/i);
  if (!nameMatch) return null;
  const tableName = nameMatch[1];

  // Extract body between first ( and matching last )
  const bodyStart = stmt.indexOf("(");
  const bodyEnd = stmt.lastIndexOf(")");
  if (bodyStart === -1 || bodyEnd === -1) return null;
  const body = stmt.slice(bodyStart + 1, bodyEnd);

  // Split on commas that are NOT inside parentheses
  const defs: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      defs.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) defs.push(current.trim());

  const columns: Column[] = [];
  const foreignKeys: ForeignKey[] = [];

  for (const def of defs) {
    const upper = def.toUpperCase().trimStart();

    // Table-level FOREIGN KEY constraint
    const fkTableMatch = def.match(/FOREIGN\s+KEY\s*\(\s*["'`]?(\w+)["'`]?\s*\)\s+REFERENCES\s+["'`]?(\w+)["'`]?/i);
    if (fkTableMatch) {
      foreignKeys.push({ column: fkTableMatch[1], refTable: fkTableMatch[2] });
      continue;
    }

    // Skip other table-level constraints
    if (/^(PRIMARY\s+KEY|UNIQUE|CHECK|CONSTRAINT|INDEX)/i.test(upper)) continue;

    // Column definition: name type ...
    const colMatch = def.match(/^\s*["'`]?(\w+)["'`]?\s+(\S+)/);
    if (!colMatch) continue;

    const colName = colMatch[1];
    const rawType = colMatch[2];
    const isPK = /\bPRIMARY\s+KEY\b/i.test(def);
    const isUnique = /\bUNIQUE\b/i.test(def) && !isPK;

    // Inline REFERENCES
    const refMatch = def.match(/\bREFERENCES\s+["'`]?(\w+)["'`]?/i);
    if (refMatch) {
      foreignKeys.push({ column: colName, refTable: refMatch[1] });
    }

    columns.push({
      name: colName,
      type: mapType(rawType),
      isPK,
      isFK: !!refMatch,
      isUnique,
    });
  }

  return { name: tableName, columns, foreignKeys };
}

export function sqlToErDiagram(sql: string): string {
  if (!sql?.trim()) return "";

  // Split into CREATE TABLE statements
  const stmts = sql
    .split(/;\s*(?:\n|$)/)
    .filter((s) => /CREATE\s+TABLE/i.test(s));

  const tables: Table[] = [];
  for (const stmt of stmts) {
    const table = parseCreateTable(stmt);
    if (table) tables.push(table);
  }

  if (tables.length === 0) return "";

  const lines: string[] = ["erDiagram"];

  for (const table of tables) {
    lines.push(`  ${table.name} {`);
    for (const col of table.columns) {
      const flags = [col.isPK ? "PK" : "", col.isFK ? "FK" : "", col.isUnique ? "UK" : ""]
        .filter(Boolean)
        .join(",");
      lines.push(`    ${col.type} ${col.name}${flags ? " " + flags : ""}`);
    }
    lines.push("  }");
  }

  // Relationships: ref_table ||--o{ this_table : "fk_column"
  for (const table of tables) {
    for (const fk of table.foreignKeys) {
      if (tables.some((t) => t.name === fk.refTable)) {
        lines.push(`  ${fk.refTable} ||--o{ ${table.name} : "${fk.column}"`);
      }
    }
  }

  return lines.join("\n");
}
