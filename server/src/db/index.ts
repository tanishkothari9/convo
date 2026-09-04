/**
 * The database handle.
 *
 * Uses Node's built-in `node:sqlite`, so Convo has no native build step. The
 * surface used here (prepare/all/get/run/exec, positional and named params) is
 * the common subset of SQLite drivers, and every query is written as plain SQL
 * with explicit tenant scoping — moving to Postgres is a driver swap, not a
 * rewrite. See DECISIONS.md.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { env } from '../env.js'
import { log } from '../lib/logger.js'

export type Row = Record<string, unknown>

let handle: DatabaseSync | null = null

export function db(): DatabaseSync {
  if (handle) return handle
  mkdirSync(dirname(env.databasePath), { recursive: true })
  handle = new DatabaseSync(env.databasePath)
  handle.exec('PRAGMA journal_mode = WAL')
  handle.exec('PRAGMA foreign_keys = ON')
  handle.exec('PRAGMA busy_timeout = 5000')
  const schema = readFileSync(resolve(import.meta.dirname, 'schema.sql'), 'utf8')
  handle.exec(schema)
  log.info('database ready', { path: env.databasePath })
  return handle
}

export function all<T = Row>(sql: string, params: unknown[] = []): T[] {
  return db().prepare(sql).all(...(params as never[])) as T[]
}

export function get<T = Row>(sql: string, params: unknown[] = []): T | undefined {
  return db().prepare(sql).get(...(params as never[])) as T | undefined
}

export function run(sql: string, params: unknown[] = []): { changes: number } {
  const result = db().prepare(sql).run(...(params as never[]))
  return { changes: Number(result.changes) }
}

/**
 * Runs `fn` inside a transaction. Nested calls join the outer transaction, so
 * a gate that already holds one can call a repository freely.
 */
let depth = 0
export function transaction<T>(fn: () => T): T {
  if (depth > 0) return fn()
  depth += 1
  db().exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db().exec('COMMIT')
    return result
  } catch (error) {
    try {
      db().exec('ROLLBACK')
    } catch {
      /* the transaction was already closed */
    }
    throw error
  } finally {
    depth -= 1
  }
}

export function closeDb(): void {
  handle?.close()
  handle = null
}
