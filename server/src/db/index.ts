/**
 * The database handle.
 *
 * Uses Node's built-in `node:sqlite`, so Convo has no native build step. The
 * surface used here (prepare/all/get/run/exec, positional and named params) is
 * the common subset of SQLite drivers, and every query is written as plain SQL
 * with explicit tenant scoping — moving to Postgres is a driver swap, not a
 * rewrite. See DECISIONS.md.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { env } from "../env.js";
import { log } from "../lib/logger.js";

export type Row = Record<string, unknown>;

let handle: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (handle) return handle;
  mkdirSync(dirname(env.databasePath), { recursive: true });
  handle = new DatabaseSync(env.databasePath);
  handle.exec("PRAGMA journal_mode = WAL");
  handle.exec("PRAGMA foreign_keys = ON");
  handle.exec("PRAGMA busy_timeout = 5000");
  /*
   * Two one-way migrations, in the order a database would meet them.
   */
  const shaped = handle
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='conversations'",
    )
    .get() as { sql?: string } | undefined;
  const shape = shaped?.sql ?? "";

  /*
   * 1. Per-brand chat → the marketplace.
   *
   * The conversation used to belong to a brand and now belongs to the
   * platform, which changes the shape of five tables rather than adding a
   * column to them. SQLite cannot drop a NOT NULL, so those tables are rebuilt
   * — and since the surface they served (a separate chat per brand) is being
   * removed, there is nothing in them worth carrying across. Catalogues,
   * brands, users, keys, provider connections and the ledger all survive.
   */
  if (shape && !/customer_session_id/i.test(shape)) {
    log.warn("rebuilding conversation tables for the marketplace shape");
    handle.exec("PRAGMA foreign_keys = OFF");
    for (const table of [
      "seen_products",
      "cart_items",
      "carts",
      "orders",
      "messages",
      "conversations",
    ]) {
      handle.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    handle.exec("PRAGMA foreign_keys = ON");
  } else if (/customer_session_id\s+TEXT NOT NULL UNIQUE/i.test(shape)) {
    /*
     * 2. One chat per shopper → many.
     *
     * Nothing is dropped this time. The UNIQUE has to go so a shopper can hold
     * more than one conversation, and SQLite cannot drop a constraint, so both
     * tables are rebuilt in place and their rows copied across. Child tables go
     * on referencing `conversations` by name, so messages, provenance and
     * orders are untouched — which matters, because orders are money.
     *
     * The cart moves from the conversation to the shopper at the same time. It
     * can only be a straight copy: the UNIQUE being removed here is exactly
     * what guaranteed one conversation, and therefore at most one open cart,
     * per shopper. There is nothing to merge.
     */
    log.warn("migrating to many conversations per shopper");
    handle.exec("PRAGMA foreign_keys = OFF");
    handle.exec(`
      BEGIN;
      CREATE TABLE conversations_new (
        id                  TEXT PRIMARY KEY,
        customer_session_id TEXT NOT NULL,
        title               TEXT,
        started_at          TEXT NOT NULL,
        last_active_at      TEXT NOT NULL,
        archived_at         TEXT
      );
      INSERT INTO conversations_new (id, customer_session_id, started_at, last_active_at)
        SELECT id, customer_session_id, started_at, last_active_at FROM conversations;
      DROP TABLE conversations;
      ALTER TABLE conversations_new RENAME TO conversations;

      CREATE TABLE carts_new (
        id                  TEXT PRIMARY KEY,
        customer_session_id TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'open',
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );
      INSERT INTO carts_new (id, customer_session_id, status, created_at, updated_at)
        SELECT c.id, v.customer_session_id, c.status, c.created_at, c.updated_at
          FROM carts c JOIN conversations v ON v.id = c.conversation_id;
      DROP TABLE carts;
      ALTER TABLE carts_new RENAME TO carts;
      COMMIT;
    `);
    handle.exec("PRAGMA foreign_keys = ON");
  }

  // Orders gained the mandate that authorised them; existing rows have none.
  try {
    handle.exec("ALTER TABLE orders ADD COLUMN mandate_id TEXT");
  } catch {
    // Already there. SQLite has no IF NOT EXISTS for ADD COLUMN.
  }

  // The schema is idempotent apart from ALTER TABLE, which SQLite has no
  // IF NOT EXISTS for. Those statements are split out and allowed to fail on
  // an already-migrated database; anything else failing is a real error.
  const schema = readFileSync(
    resolve(import.meta.dirname, "schema.sql"),
    "utf8",
  );
  const statements = schema.split(/;\s*$/m);
  let batch = "";
  for (const statement of statements) {
    if (/^\s*ALTER TABLE/im.test(statement)) {
      if (batch.trim()) handle.exec(batch);

      // Backfill the split roles from the flag they replaced. Idempotent: it only
      // touches rows where neither role has been set yet. Guarded because a
      // process that started mid-write can reach here before its own ALTER landed.
      try {
        handle.exec(`
      UPDATE provider_connections
         SET is_catalog_source = is_active,
             is_payment_processor = is_active
       WHERE is_catalog_source = 0 AND is_payment_processor = 0 AND is_active = 1
    `);
      } catch (error) {
        log.warn("role backfill skipped", {
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
      batch = "";
      try {
        handle.exec(statement);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (!/duplicate column name/i.test(message)) throw error;
      }
      continue;
    }
    batch += statement + ";\n";
  }
  if (batch.trim()) handle.exec(batch);

  // Backfill the split roles from the flag they replaced. Idempotent: it only
  // touches rows where neither role has been set yet. Guarded because a
  // process that started mid-write can reach here before its own ALTER landed.
  try {
    handle.exec(`
      UPDATE provider_connections
         SET is_catalog_source = is_active,
             is_payment_processor = is_active
       WHERE is_catalog_source = 0 AND is_payment_processor = 0 AND is_active = 1
    `);
  } catch (error) {
    log.warn("role backfill skipped", {
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
  log.info("database ready", { path: env.databasePath });
  return handle;
}

export function all<T = Row>(sql: string, params: unknown[] = []): T[] {
  return db()
    .prepare(sql)
    .all(...(params as never[])) as T[];
}

export function get<T = Row>(
  sql: string,
  params: unknown[] = [],
): T | undefined {
  return db()
    .prepare(sql)
    .get(...(params as never[])) as T | undefined;
}

export function run(sql: string, params: unknown[] = []): { changes: number } {
  const result = db()
    .prepare(sql)
    .run(...(params as never[]));
  return { changes: Number(result.changes) };
}

/**
 * Runs `fn` inside a transaction. Nested calls join the outer transaction, so
 * a gate that already holds one can call a repository freely.
 */
let depth = 0;
export function transaction<T>(fn: () => T): T {
  if (depth > 0) return fn();
  depth += 1;
  db().exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db().exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db().exec("ROLLBACK");
    } catch {
      /* the transaction was already closed */
    }
    throw error;
  } finally {
    depth -= 1;
  }
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}
