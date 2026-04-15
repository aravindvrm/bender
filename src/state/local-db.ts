import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getBenderDir } from "./config.js";

type SqliteDb = InstanceType<typeof Database>;

const DB_SCHEMA_VERSION = 1;
const DB_CACHE = new Map<string, LocalProjectDb>();

type RecordOrderBy = "created_at" | "updated_at";

function nowTs(): number {
  return Date.now();
}

function parseJsonOrNull<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function clampLimit(limit?: number, fallback = 200, max = 10_000): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(limit ?? fallback)));
}

export class LocalProjectDb {
  readonly projectRoot: string;
  readonly dbPath: string;
  private db: SqliteDb | null = null;
  private initialized = false;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.dbPath = join(getBenderDir(projectRoot), "bender.db");
  }

  static forProject(projectRoot: string): LocalProjectDb {
    const existing = DB_CACHE.get(projectRoot);
    if (existing) return existing;
    const created = new LocalProjectDb(projectRoot);
    DB_CACHE.set(projectRoot, created);
    return created;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.dbPath), { recursive: true });
    const db = new Database(this.dbPath);
    this.db = db;
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    this.migrate();
    this.initialized = true;
  }

  private assertDb(): SqliteDb {
    if (!this.db) {
      throw new Error("LocalProjectDb is not initialized. Call init() first.");
    }
    return this.db;
  }

  private migrate(): void {
    const db = this.assertDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS __meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS records (
        namespace TEXT NOT NULL,
        id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, id)
      );

      CREATE INDEX IF NOT EXISTS idx_records_namespace_created
        ON records(namespace, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_records_namespace_updated
        ON records(namespace, updated_at DESC);
    `);

    const row = db.prepare("SELECT value FROM __meta WHERE key = ?").get("schema_version") as { value?: string } | undefined;
    const currentVersion = row?.value ? Number.parseInt(row.value, 10) : 0;
    if (!Number.isFinite(currentVersion) || currentVersion < DB_SCHEMA_VERSION) {
      db.prepare(
        "INSERT INTO __meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run("schema_version", String(DB_SCHEMA_VERSION));
    }
  }

  hasDatabaseFile(): boolean {
    return existsSync(this.dbPath);
  }

  getKv(key: string): string | null {
    const db = this.assertDb();
    const row = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key) as { value?: string } | undefined;
    return typeof row?.value === "string" ? row.value : null;
  }

  setKv(key: string, value: string): void {
    const db = this.assertDb();
    db.prepare(
      `INSERT INTO kv_store(key, value, updated_at)
       VALUES(?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ).run(key, value, nowTs());
  }

  deleteKv(key: string): void {
    const db = this.assertDb();
    db.prepare("DELETE FROM kv_store WHERE key = ?").run(key);
  }

  getRecord<T>(namespace: string, id: string): T | null {
    const db = this.assertDb();
    const row = db.prepare(
      "SELECT payload FROM records WHERE namespace = ? AND id = ?",
    ).get(namespace, id) as { payload?: string } | undefined;
    if (!row?.payload) return null;
    return parseJsonOrNull<T>(row.payload);
  }

  upsertRecord(
    namespace: string,
    id: string,
    payload: unknown,
    options?: { createdAt?: number; updatedAt?: number },
  ): void {
    const db = this.assertDb();
    const createdAt = typeof options?.createdAt === "number" ? options.createdAt : nowTs();
    const updatedAt = typeof options?.updatedAt === "number" ? options.updatedAt : nowTs();
    db.prepare(
      `INSERT INTO records(namespace, id, payload, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(namespace, id) DO UPDATE SET
         payload=excluded.payload,
         created_at=MIN(records.created_at, excluded.created_at),
         updated_at=excluded.updated_at`,
    ).run(namespace, id, JSON.stringify(payload), createdAt, updatedAt);
  }

  deleteRecord(namespace: string, id: string): void {
    const db = this.assertDb();
    db.prepare("DELETE FROM records WHERE namespace = ? AND id = ?").run(namespace, id);
  }

  listRecords<T>(
    namespace: string,
    options?: {
      limit?: number;
      orderBy?: RecordOrderBy;
      desc?: boolean;
    },
  ): T[] {
    const db = this.assertDb();
    const orderBy = options?.orderBy === "created_at" ? "created_at" : "updated_at";
    const direction = options?.desc === false ? "ASC" : "DESC";
    const limit = clampLimit(options?.limit, 500, 10_000);
    const rows = db.prepare(
      `SELECT payload
       FROM records
       WHERE namespace = ?
       ORDER BY ${orderBy} ${direction}
       LIMIT ?`,
    ).all(namespace, limit) as Array<{ payload?: string }>;
    const items: T[] = [];
    for (const row of rows) {
      if (!row.payload) continue;
      const parsed = parseJsonOrNull<T>(row.payload);
      if (parsed) items.push(parsed);
    }
    return items;
  }

  countRecords(namespace: string): number {
    const db = this.assertDb();
    const row = db.prepare("SELECT COUNT(*) AS count FROM records WHERE namespace = ?").get(namespace) as { count?: number } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
  }

  transaction<T>(fn: () => T): T {
    const db = this.assertDb();
    const tx = db.transaction(fn);
    return tx();
  }
}

