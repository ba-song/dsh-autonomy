/**
 * store 层测试：建表 / PRAGMA user_version 迁移 / meta 往返 / 事务
 * 用临时文件库（不用 :memory:，要验证重开同一文件时迁移幂等）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { makeTempDir } from './helpers.mjs'
import { openDb, getMeta, setMeta, writeTx } from '../lib/store/db.js'
import { SCHEMA_VERSION, currentVersion, migrate } from '../lib/store/schema.js'

test('建库：七张业务表都在，版本号写对', (t) => {
  const { dir, cleanup } = makeTempDir()
  t.after(cleanup)

  const info = openDb({ dbPath: join(dir, 'autonomy.db') })
  t.after(info.close)

  const tables = info.db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all()
    .map((r) => r.name)

  for (const t of ['meta', 'drives', 'goals', 'actions', 'action_log', 'tick_runs', 'reflections']) {
    assert.ok(tables.includes(t), `缺表 ${t}`)
  }
  assert.ok(tables.includes('reflections'), 'v2 起要建 reflections（阶段 3）')

  assert.equal(currentVersion(info.db), SCHEMA_VERSION)
  assert.equal(info.migration.applied, true)
  assert.equal(info.migration.from, 0)
})

test('迁移 v1 → v3：老库自动补 reflections / purpose 表', (t) => {
  const { dir, cleanup } = makeTempDir()
  t.after(cleanup)
  const dbPath = join(dir, 'autonomy.db')

  const a = openDb({ dbPath })
  a.db.exec('DROP TABLE reflections')
  a.db.exec('PRAGMA user_version = 1')
  a.close()

  const b = openDb({ dbPath })
  t.after(b.close)

  const tables = b.db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all()
    .map((r) => r.name)
  assert.ok(tables.includes('reflections'), 'v1 老库要补出 reflections')
  assert.equal(currentVersion(b.db), SCHEMA_VERSION)
  assert.equal(b.migration.from, 1)
  assert.equal(b.migration.applied, true)
  assert.deepEqual(b.migration.steps, [2, 3])
})

test('迁移幂等：同一个库重开不重复迁移、不报错', (t) => {
  const { dir, cleanup } = makeTempDir()
  t.after(cleanup)
  const dbPath = join(dir, 'autonomy.db')

  const a = openDb({ dbPath })
  a.close()

  const b = openDb({ dbPath })
  t.after(b.close)

  assert.equal(b.migration.applied, false, '已是 v1，不该再迁移')
  assert.equal(currentVersion(b.db), SCHEMA_VERSION)
  // 手工再跑一次 migrate 也不能炸
  const again = migrate(b.db)
  assert.equal(again.applied, false)
})

test('meta：JSON 往返 + 覆盖写', (t) => {
  const { dir, cleanup } = makeTempDir()
  t.after(cleanup)
  const info = openDb({ dbPath: join(dir, 'autonomy.db') })
  t.after(info.close)

  assert.equal(getMeta(info.db, 'nope', { fallback: true }).fallback, true)

  setMeta(info.db, 'pause.all', { on: true, until: null }, 1000)
  let v = getMeta(info.db, 'pause.all')
  assert.equal(v.on, true)
  assert.equal(v.until, null)

  setMeta(info.db, 'pause.all', { on: false }, 2000)
  v = getMeta(info.db, 'pause.all')
  assert.equal(v.on, false)

  const rowData = info.db.prepare(`SELECT updated_at FROM meta WHERE key='pause.all'`).get()
  assert.equal(rowData.updated_at, 2000)
})

test('writeTx：提交生效、抛错回滚', async (t) => {
  const { dir, cleanup } = makeTempDir()
  t.after(cleanup)
  const info = openDb({ dbPath: join(dir, 'autonomy.db') })
  t.after(info.close)

  await writeTx(info.db, (db) => {
    setMeta(db, 'a', { n: 1 }, 1)
  })
  assert.equal(getMeta(info.db, 'a').n, 1)

  await assert.rejects(
    writeTx(info.db, (db) => {
      setMeta(db, 'b', { n: 2 }, 2)
      throw new Error('rollback me')
    }),
  )
  assert.equal(getMeta(info.db, 'b', null), null, '抛错要把写入回滚掉')
})

test('索引：关键查询路径有索引', (t) => {
  const { dir, cleanup } = makeTempDir()
  t.after(cleanup)
  const info = openDb({ dbPath: join(dir, 'autonomy.db') })
  t.after(info.close)

  const idx = info.db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'`)
    .all()
    .map((r) => r.name)

  for (const name of ['idx_goals_open', 'idx_actions_recent', 'idx_actions_kind', 'idx_actions_running', 'idx_log_at', 'idx_tick_at']) {
    assert.ok(idx.includes(name), `缺索引 ${name}`)
  }
})
