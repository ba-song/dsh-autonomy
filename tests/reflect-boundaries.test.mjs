/**
 * 反思边界测试（阶段 4）：阈值/日报/minGap/窗口/pending 的边界值
 * 纯函数 + 一条 tick 级「pending 不堆」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { decideReflection, reflectionProgress } from '../lib/core/reflect.js'
import { startPlugin, withServices, row, count } from './helpers.mjs'

const NOW = Date.parse('2026-11-01T12:00:00+08:00')
const H = 3600_000
const act = (id, importance, at = NOW - H) => ({ id, importance, created_at: at })

test('阈值边界：importance 正好等于阈值 → 触发；差 1 → 不触发', () => {
  const cfg = { importanceThreshold: 12, minGapHours: 20, dailyMinActions: 99 }
  const exact = decideReflection({ now: NOW, cfg, actions: [act('a', 5), act('b', 7)] })
  assert.ok(exact, '12 >= 12 应触发')
  assert.equal(exact.trigger, 'IMPORTANCE_THRESHOLD')
  assert.equal(exact.importance, 12)

  const below = decideReflection({ now: NOW, cfg, actions: [act('a', 5), act('b', 6)] })
  assert.equal(below, null, '11 < 12 不该触发')
})

test('日报边界：正好 24h → DAILY；差 1ms → 不触发', () => {
  const cfg = { importanceThreshold: 999, minGapHours: 0, dailyMinActions: 1 }
  const actions = [act('a', 0)]

  const exact = decideReflection({ now: NOW, cfg, actions, lastReflectionAt: NOW - 24 * H })
  assert.ok(exact)
  assert.equal(exact.trigger, 'DAILY')

  const justUnder = decideReflection({ now: NOW, cfg, actions, lastReflectionAt: NOW - 24 * H + 1 })
  assert.equal(justUnder, null, '24h 差 1ms 不该触发')
})

test('minGap 边界：正好到点允许；差 1ms 拒绝', () => {
  const cfg = { importanceThreshold: 1, minGapHours: 20, dailyMinActions: 99 }
  const actions = [act('a', 5)]

  const allowed = decideReflection({ now: NOW, cfg, actions, lastReflectionAt: NOW - 20 * H })
  assert.ok(allowed, '正好 20h 应允许')

  const blocked = decideReflection({ now: NOW, cfg, actions, lastReflectionAt: NOW - 20 * H + 1 })
  assert.equal(blocked, null, '差 1ms 不该允许')
})

test('窗口边界：窗口起点那一刻的行动算，早 1ms 不算', () => {
  const cfg = { importanceThreshold: 5, minGapHours: 0, dailyMinActions: 99 }
  const windowStart = NOW - 6 * H

  const atStart = decideReflection({ now: NOW, cfg, actions: [act('a', 5, windowStart)], windowStart })
  assert.ok(atStart, 'created_at == windowStart 应计入')

  const before = decideReflection({ now: NOW, cfg, actions: [act('a', 5, windowStart - 1)], windowStart })
  assert.equal(before, null, '早 1ms 不计入')
})

test('日报与 importance 无关：0 重要度、满行动数也触发', () => {
  const cfg = { importanceThreshold: 999, minGapHours: 0, dailyMinActions: 3 }
  const out = decideReflection({
    now: NOW,
    cfg,
    actions: [act('a', 0), act('b', 0), act('c', 0)],
    lastReflectionAt: NOW - 25 * H,
  })
  assert.ok(out)
  assert.equal(out.trigger, 'DAILY')
  assert.equal(out.importance, 0)
})

test('pending 优先：有 pending 时即使远超阈值也不触发', () => {
  const cfg = { importanceThreshold: 1, minGapHours: 0, dailyMinActions: 1 }
  const out = decideReflection({ now: NOW, cfg, actions: [act('a', 99)], hasPending: true })
  assert.equal(out, null)
})

test('进度边界：超过阈值时 remaining 不为负', () => {
  const p = reflectionProgress({ now: NOW, cfg: { importanceThreshold: 12 }, actions: [act('a', 20)] })
  assert.equal(p.importance, 20)
  assert.equal(p.remaining, 0)
  assert.equal(p.pending, false)

  const withPending = reflectionProgress({ now: NOW, cfg: { importanceThreshold: 12 }, actions: [act('a', 3)], hasPending: true })
  assert.equal(withPending.pending, true)
})

// ── tick 级：pending 不堆（minGap=0 也一样） ─────────────

function openReflect() {
  return startPlugin({
    cfg: {
      enabled: true,
      dryRun: true,
      minTickGapMinutes: 0,
      allowedKinds: ['read_archive'],
      urge: { thetaLow: 0.99, thetaHigh: 0.99, delta: 0.01 },
      reflect: { importanceThreshold: 2, minGapHours: 0, dailyMinActions: 99 },
    },
    services: withServices(),
  })
}

function seedAction(env, id, importance) {
  const at = env.clock.now() - 60_000
  env.api.db
    .prepare(
      `INSERT INTO actions(id, self_id, kind, status, risk, importance, created_at, ended_at)
       VALUES(?,?,?,'done','low',?,?,?)`,
    )
    .run(id, env.api.selfId(), 'read_archive', importance, at, at)
}

test('tick 边界：pending 已存在时，再来新行动也不堆第二条', async (t) => {
  const env = openReflect()
  t.after(env.cleanup)

  seedAction(env, 's1', 2)
  await env.api.tick()
  assert.equal(count(env.api, 'reflections'), 1)

  // 再来两条够阈值的行动，minGap=0 也过，但 pending 未消费 → 不得新增
  seedAction(env, 's2', 2)
  seedAction(env, 's3', 2)
  env.clock.advance(5 * 60_000)
  await env.api.tick()
  env.clock.advance(5 * 60_000)
  await env.api.tick()

  assert.equal(count(env.api, 'reflections'), 1, 'pending 不堆')
  const p = row(env.api, "SELECT status FROM reflections ORDER BY id DESC LIMIT 1")
  assert.equal(p.status, 'pending')
})
