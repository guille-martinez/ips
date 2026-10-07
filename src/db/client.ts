import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

export type DB = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const globalForDb = globalThis as unknown as { __ipsDb?: DB };

/** Opens the SQLite DB (WAL, so the web app and the worker can share it) and applies migrations. */
export function getDb(): DB {
  if (globalForDb.__ipsDb) return globalForDb.__ipsDb;
  const file = path.resolve(process.env.IPS_DB_PATH ?? "./data/ips.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema }) as DB;
  migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  globalForDb.__ipsDb = db;
  return db;
}

export { schema };
