/**
 * SQLite 打开 / 事务 / meta 读写
 *
 * 口径：
 * - WAL + busy_timeout：tick 与 GUI 并发读时不至于直接抛 database is locked
 * - writeTx：BEGIN IMMEDIATE + 失败重试（只重试 busy/locked，别的错立刻抛）
 * - meta 表统一存 JSON 字符串（暂停态、dry_run、last_tick_at、degraded 都在这）
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { migrate, currentVersion, SCHEMA_VERSION } from './schema.js'

const BUSY = /locked|busy/i
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function openDb({ dbPath, log = null } = {}) {
  if (!dbPath) throw new Error('openDb 需要 dbPath')
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  const migration = migrate(db)
  // 兼容老库 user_version 已高于当前 SCHEMA_VERSION 但缺 purpose 表的情况；幂等补建
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS purpose_hypotheses (
      key TEXT PRIMARY KEY, self_id TEXT NOT NULL, owner TEXT NOT NULL DEFAULT 'self',
      need TEXT NOT NULL, emotion TEXT NOT NULL DEFAULT '', topic TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL DEFAULT 0.3, risk REAL NOT NULL DEFAULT 0.05,
      next_step TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'hypothesis',
      seen_count INTEGER NOT NULL DEFAULT 1, last_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`)
    db.exec('CREATE INDEX IF NOT EXISTS idx_purpose_recent ON purpose_hypotheses(self_id, status, last_seen_at DESC)')
    db.exec(`CREATE TABLE IF NOT EXISTS home_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, self_id TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'tool',
      name TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'done', at INTEGER NOT NULL, meta_json TEXT
    )`)
    db.exec('CREATE INDEX IF NOT EXISTS idx_home_activity ON home_activities(self_id, at DESC)')
  } catch {}
  log?.info?.(`[autonomy] db ${dbPath} v${currentVersion(db)}${migration.applied ? '（已迁移）' : ''}`)
  return {
    db,
    file: dbPath,
    migration,
    version: () => currentVersion(db),
    schemaVersion: SCHEMA_VERSION,
    close: () => {
      try {
        db.close()
      } catch {
        /* 已关就别再吵 */
      }
    },
  }
}

/** 写事务：BEGIN IMMEDIATE + busy 重试 */
export async function writeTx(db, fn, { attempts = 3, backoff = [200, 800, 2000] } = {}) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      db.exec('BEGIN IMMEDIATE')
      const out = await fn(db)
      db.exec('COMMIT')
      return out
    } catch (e) {
      lastErr = e
      try {
        db.exec('ROLLBACK')
      } catch {
        /* 没开事务就算了 */
      }
      if (!BUSY.test(String(e?.message ?? e)) || i === attempts - 1) throw e
      await sleep(backoff[i] ?? 2000)
    }
  }
  throw lastErr
}

export function getMeta(db, key, def = null) {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
    if (!row) return def
    return JSON.parse(row.value)
  } catch {
    return def
  }
}

export function setMeta(db, key, value, at = Date.now()) {
  db.prepare(
    'INSERT INTO meta(key, value, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(key, JSON.stringify(value ?? null), at)
  return value
}

export function deleteMeta(db, key) {
  db.prepare('DELETE FROM meta WHERE key = ?').run(key)
}

/** 读多行，出错返回空数组（只读路径不因单条 SQL 失败把 tick 打死） */
export function readAll(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params)
  } catch {
    return []
  }
}

export function readOne(db, sql, params = []) {
  try {
    return db.prepare(sql).get(...params) ?? null
  } catch {
    return null
  }
}
