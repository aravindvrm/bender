import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { getBenderHomeDir, getBenderHomePath } from "./paths.js";

type SqliteDb = InstanceType<typeof Database>;

const DB_SCHEMA_VERSION = 1;
const DB_CACHE = new Map<string, HomeDb>();

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

export class HomeDb {
  readonly dbPath: string;
  private db: SqliteDb | null = null;
  private initialized = false;

  constructor(dbPath = getBenderHomePath("bender-home.db")) {
    this.dbPath = dbPath;
  }

  static current(): HomeDb {
    const homeDir = getBenderHomeDir();
    const existing = DB_CACHE.get(homeDir);
    if (existing) return existing;
    const created = new HomeDb(getBenderHomePath("bender-home.db"));
    DB_CACHE.set(homeDir, created);
    return created;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.migrate();
    this.initialized = true;
  }

  private assertDb(): SqliteDb {
    if (!this.db) {
      throw new Error("HomeDb is not initialized. Call init() first.");
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
    `);
    const row = db.prepare("SELECT value FROM __meta WHERE key = ?").get("schema_version") as { value?: string } | undefined;
    const currentVersion = row?.value ? Number.parseInt(row.value, 10) : 0;
    if (!Number.isFinite(currentVersion) || currentVersion < DB_SCHEMA_VERSION) {
      db.prepare(
        "INSERT INTO __meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run("schema_version", String(DB_SCHEMA_VERSION));
    }
  }

  getJson<T>(key: string): T | null {
    const db = this.assertDb();
    const row = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key) as { value?: string } | undefined;
    if (typeof row?.value !== "string") return null;
    return parseJsonOrNull<T>(row.value);
  }

  setJson(key: string, value: unknown): void {
    const db = this.assertDb();
    db.prepare(
      `INSERT INTO kv_store(key, value, updated_at)
       VALUES(?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ).run(key, JSON.stringify(value), nowTs());
  }

  delete(key: string): void {
    const db = this.assertDb();
    db.prepare("DELETE FROM kv_store WHERE key = ?").run(key);
  }
}

