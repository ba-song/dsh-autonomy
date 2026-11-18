import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../lib/store/db.js'
import { savePurposeSeeds, loadPurposeSeeds, hypothesisKey } from '../lib/core/purpose-store.js'

test('purpose 假设：去重提置信、过期、按置信排序', () => {
  const { db } = openDb({ dbPath: ':memory:' })
  const now = 1_800_000_000_000
  const seed = { owner: 'self', need: 'learn', emotion: 'curious', topic: '抖音私信', evidence: '看到新消息', confidence: 0.5, risk: 0.05, nextStep: '查一下' }
  assert.equal(savePurposeSeeds(db, 'self:x', [seed], { now }), 1)
  assert.equal(savePurposeSeeds(db, 'self:x', [seed], { now: now + 1000 }), 1)
  let rows = loadPurposeSeeds(db, 'self:x', 5, now + 2000)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].seenCount, 2)
  assert.ok(rows[0].confidence > 0.5)
  // TTL 后过期（不再命中就不会续期）
  rows = loadPurposeSeeds(db, 'self:x', 5, now + 20 * 86400000)
  assert.equal(rows.length, 0)
  assert.equal(hypothesisKey(seed).includes('learn'), true)
})
