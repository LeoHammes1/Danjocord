import Database from "better-sqlite3";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

// Vive em <pacote>/migrations — o mesmo caminho relativo funciona a partir de
// src/db (tsx) e de dist/db (build), ambos dois níveis abaixo da raiz do pacote.
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

export type Db = Database.Database;

export function openDb(path = config.dbPath): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // Ids snowflake excedem 2^53: todo INTEGER volta como BigInt, sempre.
  db.defaultSafeIntegers(true);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set(
    (db.prepare("SELECT name FROM migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(file, Date.now());
    })();
  }
}
