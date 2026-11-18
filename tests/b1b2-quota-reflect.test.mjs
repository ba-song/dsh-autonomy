/**
 * B1 / B2 回归测试（2026-11-05）
 *
 * B1：演练/模拟（result_json.dryRun===true 或 simulated===true）不占真实配额；
 *     审计照留，真实行动才计入 doneToday/doneThisHour/lastDoneAt，模拟数单列 simulated*。
 * B2：pending 超过 pendingTtlHours（默认 24h）未消费 → expired，不再永久挡住后续反思；
 *     作废幂等、TTL 内不动、作废后新反思能正常触发。
 *
 * 全部临时库 + 假时钟 + mock 服务，不碰生产库/真实通道。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startPlugin, withServices, makeClock, row, count } from './helpers.mjs'
import { kindStats } from '../lib/run/actions.js'

const H = 3600_000

function open(cfg = {}, extra = {}) {
  return startPlugin({
    cfg: {
      enabled: true,
      dryRun: true,
      minTickGapMinutes: 0,
      allowedKinds: ['read_archive'],
      urge: { thetaLow: 0.2, thetaHigh: 0.9, delta: 0.01 },
      ...cfg,
    },
    services: extra.services ?? withServices(),
    clock: extra.clock ?? makeClock(),
  })
}

function insertAction(env, { id, kind = 'read_archive', result = null, endedAt }) {
  env.api.db
    .prepare(
      `INSERT INTO actions(id, self_id, kind, status, risk, result_json, created_at, ended_at)
       VALUES(?,?,?,?,? ,?,?,?)`,
    )
    .run(id, env.api.selfId(), kind, 'done', 'low', result == null ? null : JSON.stringify(result), endedAt, endedAt)
}

// ── B1 ────────────────────────────────────────────────

test('B1 / kindStats：dry_run 与 simulated 不计真实配额，模拟数单列', (t) => {
  const env = open({ enabled: false })
  t.after(env.cleanup)
  const now = env.clock.now()

  insertAction(env, { id: 'dry-1', result: { dryRun: true, simulated: true, kind: 'read_archive' }, endedAt: now - 1_000 })
  insertAction(env, { id: 'dry-2', result: { dryRun: true, simulated: true, kind: 'read_archive' }, endedAt: now - 2_000 })
  insertAction(env, { id: 'mock-1', result: { simulated: true, mock: true, dryRun: false }, endedAt: now - 3_000 })
  insertAction(env, { id: 'real-1', result: { real: true }, endedAt: now - 4_000 })
  insertAction(env, { id: 'legacy-1', result: null, endedAt: now - 5_000 })

  const stats = kindStats(env.api.db, env.api.selfId(), 'read_archive', { now, tz: 'Asia/Shanghai' })
  assert.equal(stats.doneToday, 2, '只有 real-1 + legacy-1 算真实完成')
  assert.equal(stats.simulatedToday, 3, 'dry-1/dry-2/mock-1 算模拟')
  assert.equal(stats.lastDoneAt, now - 4_000, 'lastDoneAt 只取真实行动（minGap 不被演练挡住）')
  assert.equal(stats.lastSimulatedAt, now - 1_000)
  assert.equal(stats.doneThisHour, 2)
  assert.equal(stats.simulatedThisHour, 3)
})

test('B1 / tick：dry_run 连跑 3 次不触发 DAILY_CAP，真实配额仍 0', async (t) => {
  const env = open({
    dryRun: true,
    caps: { read_archive: { perDay: 1, minGapMin: 0 } },
  })
  t.after(env.cleanup)

  for (let i = 0; i < 3; i++) {
    const r = await env.api.tick()
    assert.equal(r.code, 'DRY_RUN', `第 ${i + 1} 次仍是演练`)
    env.clock.advance(60_000)
  }

  assert.equal(count(env.api, 'actions'), 3, '审计照留 3 条')
  const stats = kindStats(env.api.db, env.api.selfId(), 'read_archive', { now: env.clock.now(), tz: 'Asia/Shanghai' })
  assert.equal(stats.doneToday, 0, '演练不占 perDay')
  assert.equal(stats.simulatedToday, 3, '模拟单独记 3')
  const lastTick = row(env.api, 'SELECT code FROM tick_runs ORDER BY id DESC LIMIT 1')
  assert.notEqual(lastTick.code, 'DAILY_CAP', '演练不能把自己挡在配额门外')
})

test('B1 / tick：真实行动才计入配额（达到 perDay 后 DAILY_CAP）', async (t) => {
  const env = open({
    dryRun: false,
    caps: { read_archive: { perDay: 1, minGapMin: 0 } },
  })
  t.after(env.cleanup)

  let calls = 0
  env.api.registerExecutor('read_archive', async () => {
    calls += 1
    return { ok: true, result: { real: true } }
  })

  const r1 = await env.api.tick()
  assert.equal(r1.code, 'OK')
  assert.equal(calls, 1)
  const stats = kindStats(env.api.db, env.api.selfId(), 'read_archive', { now: env.clock.now(), tz: 'Asia/Shanghai' })
  assert.equal(stats.doneToday, 1, '真实完成计入配额')
  assert.equal(stats.simulatedToday, 0)

  env.clock.advance(60_000)
  const r2 = await env.api.tick()
  assert.equal(r2.code, 'DAILY_CAP', '真实配额满后照常拦')
  assert.equal(calls, 1, '被配额拦下不调执行器')
})

// ── B2 ────────────────────────────────────────────────

function openReflect(extra = {}) {
  return open(
    {
      dryRun: true,
      urge: { thetaLow: 0.99, thetaHigh: 0.99, delta: 0.01 },
      reflect: { importanceThreshold: 2, minGapHours: 1, dailyMinActions: 99, pendingTtlHours: 24 },
      ...extra,
    },
  )
}

function seedAction(env, { id, importance = 2, at = env.clock.now() }) {
  env.api.db
    .prepare(
      `INSERT INTO actions(id, self_id, kind, status, risk, importance, created_at, ended_at)
       VALUES(?,?,?,'done','low',?,?,?)`,
    )
    .run(id, env.api.selfId(), 'read_archive', importance, at, at)
}

test('B2 / pending 超时 → expired，同一 tick 能触发新反思；再次 tick 不重复作废', async (t) => {
  const env = openReflect()
  t.after(env.cleanup)

  seedAction(env, { id: 'seed-1' })
  await env.api.tick()
  assert.equal(count(env.api, 'reflections'), 1, '先落一条 pending')
  assert.equal(row(env.api, 'SELECT status FROM reflections ORDER BY id DESC LIMIT 1').status, 'pending')

  env.clock.advance(25 * H)
  await env.api.tick()

  const rows = env.api.db.prepare('SELECT id, at, status FROM reflections ORDER BY id').all()
  assert.equal(rows.length, 2, '旧 pending 作废 + 新反思触发')
  assert.equal(rows[0].status, 'expired', '超 24h 未消费 → expired')
  assert.equal(rows[1].status, 'pending', '作废后新反思能正常触发')

  const log = row(env.api, "SELECT code, note FROM action_log WHERE event='reflect_expired' ORDER BY id DESC LIMIT 1")
  assert.ok(log, '作废要留审计')
  assert.equal(log.code, 'REFLECT_EXPIRED')

  // 再 tick：新 pending 还没超时，不许把它也作废，也不许再堆
  env.clock.advance(60_000)
  await env.api.tick()
  assert.equal(count(env.api, 'reflections'), 2, '不会重复消费/重复堆')
  assert.equal(row(env.api, "SELECT COUNT(1) AS n FROM reflections WHERE status='expired'").n, 1)
  const st = env.api.status().reflections
  assert.equal(st.pendingCount, 1)
  assert.equal(st.expiredCount, 1)
})

test('B2 / TTL 内 pending 保持不动（不会提前作废）', async (t) => {
  const env = openReflect()
  t.after(env.cleanup)

  seedAction(env, { id: 'seed-1' })
  await env.api.tick()
  assert.equal(count(env.api, 'reflections'), 1)

  env.clock.advance(23 * H)
  await env.api.tick()
  assert.equal(count(env.api, 'reflections'), 1, '23h < 24h，不新增也不作废')
  assert.equal(row(env.api, 'SELECT status FROM reflections ORDER BY id DESC LIMIT 1').status, 'pending')
  assert.equal(Number(row(env.api, "SELECT COUNT(1) AS n FROM reflections WHERE status='expired'").n), 0)
  assert.equal(Number(row(env.api, "SELECT COUNT(1) AS n FROM action_log WHERE event='reflect_expired'").n), 0)
})
