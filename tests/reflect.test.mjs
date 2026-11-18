/**
 * 反思触发器（阶段 3：只记账，不调模型）
 * - 纯函数：阈值 / 日报 / 节流 / 去重
 * - tick 集成：pending 行、审计、不重复
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { decideReflection, reflectionProgress } from '../lib/core/reflect.js'
import { startPlugin, withServices, row, count } from './helpers.mjs'

const NOW = Date.parse('2026-11-01T12:00:00+08:00')
const H = 3600_000
const act = (id, importance, ageH = 1) => ({ id, importance, created_at: NOW - ageH * H })

test('decideReflection：已有 pending 时不再堆', () => {
  const out = decideReflection({ now: NOW, cfg: { importanceThreshold: 1 }, actions: [act('a1', 5)], hasPending: true })
  assert.equal(out, null)
})

test('decideReflection：距上次反思不足 minGapHours 不触发', () => {
  const out = decideReflection({
    now: NOW,
    cfg: { importanceThreshold: 1, minGapHours: 20 },
    actions: [act('a1', 5, 2)],
    lastReflectionAt: NOW - 1 * H,
  })
  assert.equal(out, null)
})

test('decideReflection：importance 累加过阈值 → IMPORTANCE_THRESHOLD，证据取 top5', () => {
  const actions = [act('a1', 5), act('a2', 4), act('a3', 3), act('a4', 2), act('a5', 1), act('a6', 1)]
  const out = decideReflection({ now: NOW, cfg: { importanceThreshold: 12 }, actions })
  assert.ok(out)
  assert.equal(out.trigger, 'IMPORTANCE_THRESHOLD')
  assert.equal(out.importance, 16)
  assert.equal(out.evidence.length, 5, '证据最多 5 条')
  assert.equal(String(out.evidence[0]), 'a1', '证据按 importance 降序')
})

test('decideReflection：不够阈值但满 24h 且有行动 → DAILY', () => {
  const out = decideReflection({
    now: NOW,
    cfg: { importanceThreshold: 999, dailyMinActions: 3 },
    actions: [act('a1', 1), act('a2', 1), act('a3', 1)],
    lastReflectionAt: NOW - 25 * H,
  })
  assert.equal(out.trigger, 'DAILY')
})

test('decideReflection：窗口外的老行动不算；没行动不触发', () => {
  const out = decideReflection({
    now: NOW,
    cfg: { importanceThreshold: 1 },
    actions: [act('old', 99, 24 * 10)],
    windowStart: NOW - 24 * H,
  })
  assert.equal(out, null)
  assert.equal(decideReflection({ now: NOW, cfg: { importanceThreshold: 1 }, actions: [] }), null)
})

test('reflectionProgress：告诉你还差多少', () => {
  const p = reflectionProgress({ now: NOW, cfg: { importanceThreshold: 12 }, actions: [act('a1', 5)] })
  assert.equal(p.importance, 5)
  assert.equal(p.threshold, 12)
  assert.equal(p.remaining, 7)
  assert.equal(p.pending, false)
})

// ── tick 集成 ─────────────────────────────────────────
// 这里把阈值调到「永不主动行动」（thetaLow=0.99），只为隔离出反思记账这条链路。

function openReflect(cfg = {}) {
  return startPlugin({
    cfg: {
      enabled: true,
      dryRun: true,
      minTickGapMinutes: 0,
      allowedKinds: ['read_archive'],
      urge: { thetaLow: 0.99, thetaHigh: 0.99, delta: 0.01 },
      reflect: { importanceThreshold: 2, minGapHours: 1, dailyMinActions: 99 },
      ...cfg,
    },
    services: withServices(),
  })
}

/** 直接往库里塞一条已完成行动（不经过 tick，专门喂反思阈值） */
function seedAction(env, { id, importance = 1, at = env.clock.now() - 60_000 }) {
  env.api.db
    .prepare(
      `INSERT INTO actions(id, self_id, kind, status, risk, importance, created_at, ended_at)
       VALUES(?,?,?,'done','low',?,?,?)`,
    )
    .run(id, env.api.selfId(), 'read_archive', importance, at, at)
}

test('tick：importance 够阈值 → 落一条 pending 反思 + 审计，且不重复', async (t) => {
  const env = openReflect()
  t.after(env.cleanup)

  seedAction(env, { id: 'seed-1', importance: 1 })
  await env.api.tick()
  assert.equal(count(env.api, 'reflections'), 0, '1 < 阈值 2，还不该反思')

  seedAction(env, { id: 'seed-2', importance: 1 })
  env.clock.advance(10 * 60_000)
  await env.api.tick()

  const all = env.api.db.prepare('SELECT * FROM reflections ORDER BY id').all()
  assert.equal(all.length, 1, '累计到阈值 → 一条 pending')

  const r = all[0]
  assert.equal(r.status, 'pending')
  assert.equal(r.trigger, 'IMPORTANCE_THRESHOLD')
  assert.ok(Number(r.importance) >= 2)
  assert.equal(r.text, null, '阶段 3 不生成正文（不调模型）')
  const evidence = JSON.parse(r.evidence_json)
  assert.ok(Array.isArray(evidence) && evidence.length >= 2)

  const log = row(env.api, "SELECT * FROM action_log WHERE event='reflect_due' ORDER BY id DESC LIMIT 1")
  assert.ok(log, '要有 reflect_due 审计')
  assert.equal(log.code, 'REFLECT_DUE')

  // 再跑一次：pending 已存在，不许堆第二条
  env.clock.advance(10 * 60_000)
  await env.api.tick()
  assert.equal(count(env.api, 'reflections'), 1)

  const modelCalls = row(env.api, 'SELECT COALESCE(SUM(model_calls),0) AS n FROM tick_runs')?.n ?? 0
  assert.equal(Number(modelCalls), 0, '反思记账不该产生模型调用')

  const status = env.api.status()
  assert.equal(status.reflections.pending, 1)
  assert.equal(status.reflections.lastTrigger, 'IMPORTANCE_THRESHOLD')
})

test('tick：不够阈值但跨天 → DAILY 触发', async (t) => {
  const env = openReflect({ reflect: { importanceThreshold: 999, minGapHours: 1, dailyMinActions: 1 } })
  t.after(env.cleanup)

  seedAction(env, { id: 'seed-daily', importance: 1 })
  await env.api.tick()

  const r = env.api.db.prepare('SELECT * FROM reflections ORDER BY id DESC LIMIT 1').get()
  assert.ok(r, '应触发一条反思')
  assert.equal(r.trigger, 'DAILY')
  assert.equal(r.text, null)
})

test('tick：minGapHours 内不重复触发（换一种触发源也不行）', async (t) => {
  const env = openReflect({ reflect: { importanceThreshold: 2, minGapHours: 20, dailyMinActions: 1 } })
  t.after(env.cleanup)

  seedAction(env, { id: 'seed-a', importance: 2 })
  await env.api.tick()

  const first = env.api.db.prepare('SELECT * FROM reflections ORDER BY id LIMIT 1').get()
  assert.ok(first)

  // 模拟阶段 4 处理过这条；紧接着不该又冒一条
  env.api.db.prepare("UPDATE reflections SET status='generated' WHERE id=?").run(first.id)
  env.clock.advance(10 * 60_000)
  await env.api.tick()

  assert.equal(count(env.api, 'reflections'), 1, '20h 内不该再触发（minGapHours）')
})
