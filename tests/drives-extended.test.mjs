import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CORE_DRIVE_NAMES, EXTRA_DRIVE_NAMES, defaultDriveRows, loadDrives, toMap, driveConflict } from '../lib/core/drives.js'
import { driveAffinity } from '../lib/core/score.js'

const DIR = mkdtempSync(join(tmpdir(), 'autonomy-drives-'))
const db = new DatabaseSync(join(DIR, 'a.db'))
db.exec('CREATE TABLE drives(self_id TEXT, name TEXT, value REAL, baseline REAL, growth REAL, updated_at INTEGER, UNIQUE(self_id,name))')

test('默认只 4 驱力；extended 才给 9 个', () => {
  assert.equal(defaultDriveRows(Date.now()).length, 4)
  const ext = defaultDriveRows(Date.now(), { extended: true })
  assert.equal(ext.length, 9)
  assert.deepEqual(ext.map((x) => x.name), [...CORE_DRIVE_NAMES, ...EXTRA_DRIVE_NAMES])
  const rows = loadDrives(db, 'self:x', Date.now(), { extended: true })
  assert.equal(rows.length, 9)
  const map = toMap(rows)
  assert.ok('rest' in map && 'order' in map)
  assert.ok(driveConflict(map) >= 0)
})

test('扩展权重只在 map 带扩展键时生效，不影响旧 4 驱力', () => {
  const core = { curiosity: 0.8, social: 0.2, mastery: 0.2, care: 0.2 }
  const ext = { ...core, rest: 0.2, approval: 0.2, affiliation: 0.2, rebellion: 0.2, order: 0.2 }
  const a = driveAffinity('send_qq', core)
  const b = driveAffinity('send_qq', ext)
  assert.ok(Number.isFinite(a) && Number.isFinite(b))
  assert.ok(Math.abs(a - 0.2) < 1e-9, '旧映射 social .7 + care .3，归一后 0.2')
  assert.ok(Math.abs(b - 0.2) < 1e-9)
})
test.after(() => { try { rmSync(DIR, { recursive: true, force: true }) } catch {} })
