/**
 * tick 主路径 + P0 失败路径
 * 覆盖：T1/T2/T3/T5，F1/F2/F4/F5/F6/F16/F18/F20/F21（+ F3 在 policy.test）
 * 全部用临时库 + mock executor；不碰真实通道。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startPlugin, withServices, makeClock, makeTempDir, mockMemory, row, count } from './helpers.mjs'
import { setMeta } from '../lib/store/db.js'

const baseCfg = { enabled: true, dryRun: true, minTickGapMinutes: 0 }

function open(cfg = {}, extra = {}) {
  return startPlugin({
    cfg: { ...baseCfg, ...cfg },
    services: extra.services ?? withServices(),
    clock: extra.clock ?? makeClock(),
    random: extra.random ?? Math.random,
  })
}

test('T1 / 正常 tick：选中 read_archive 并执行（mock）', async (t) => {
  const env = open({ dryRun: false, allowedKinds: ['read_archive'] })
  t.after(env.cleanup)

  let calls = 0
  env.api.registerExecutor(
    'read_archive',
    async () => {
      calls += 1
      return { ok: true, result: { note: 'done' } }
    },
    { mock: true },
  )

  const r = await env.api.tick()
  assert.equal(r.outcome, 'ran')
  assert.equal(r.code, 'OK')
  assert.equal(r.kind, 'read_archive')
  assert.equal(calls, 1)

  const a = row(env.api, 'SELECT * FROM actions ORDER BY created_at DESC, rowid DESC LIMIT 1')
  assert.equal(a.kind, 'read_archive')
  assert.equal(a.status, 'done')
  assert.equal(a.attempt, 1)

  const tr = row(env.api, 'SELECT * FROM tick_runs ORDER BY id DESC LIMIT 1')
  assert.equal(tr.outcome, 'ran')
  assert.equal(tr.trigger, 'interval')
})

test('T2 / dry_run：决策照做，executor 一次都不调', async (t) => {
  const env = open({ dryRun: true, allowedKinds: ['read_archive'] })
  t.after(env.cleanup)

  let calls = 0
  env.api.registerExecutor(
    'read_archive',
    async () => {
      calls += 1
      return { ok: true, result: {} }
    },
    { mock: true },
  )

  const r = await env.api.tick()
  assert.equal(r.code, 'DRY_RUN')
  assert.equal(calls, 0, 'dry_run 不许调执行器')

  const a = row(env.api, 'SELECT * FROM actions ORDER BY created_at DESC, rowid DESC LIMIT 1')
  assert.equal(a.status, 'done')
  assert.equal(JSON.parse(a.result_json).dryRun, true)

  const log = row(env.api, "SELECT * FROM action_log WHERE event='dry_run' ORDER BY id DESC LIMIT 1")
  assert.ok(log, '要留一条 dry_run 审计')
})

test('T3 / decision_json：打分明细 + 门信息可复盘', async (t) => {
  const env = open({ dryRun: true, allowedKinds: ['read_archive', 'organize_memory'] })
  t.after(env.cleanup)

  await env.api.tick()
  const a = row(env.api, 'SELECT decision_json, reason FROM actions ORDER BY created_at DESC, rowid DESC LIMIT 1')
  const d = JSON.parse(a.decision_json)

  assert.equal(typeof d.score, 'number')
  assert.equal(typeof d.parts.driveAffinity, 'number')
  assert.equal(typeof d.parts.novelty, 'number')
  assert.ok(Array.isArray(d.ranked) && d.ranked.length >= 1)
  assert.equal(typeof d.thetaLow, 'number')
  assert.equal(d.dryRun, true)
  assert.ok(typeof a.reason === 'string' && a.reason.length > 0)
})

test('T5 / 成功写 episode（mock memory）：actionId/source 可对得上', async (t) => {
  const memory = mockMemory()
  const env = open({ dryRun: false, allowedKinds: ['read_archive'] }, { services: withServices({ memory }) })
  t.after(env.cleanup)

  env.api.registerExecutor(
    'read_archive',
    async () => ({ ok: true, result: { note: 'ok' }, episodeText: '翻到一段旧档案，想起上次没说完的话。' }),
    { mock: true },
  )

  const r = await env.api.tick()
  assert.equal(r.outcome, 'ran')
  assert.equal(r.episodeRef, 'ep_1')
  assert.equal(memory.calls.addEpisode.length, 1)
  const ep = memory.calls.addEpisode[0]
  assert.equal(ep.source, 'autonomy')
  assert.equal(ep.actionId, r.actionId)
  assert.ok(ep.text.includes('旧档案'))
  // v1.2：写 episode 必须带写专用身份（不能是用户 header）
  assert.deepEqual(ep.header, { origin: 'plugin', plugin: 'dsh-autonomy' })

  const a = row(env.api, 'SELECT episode_ref FROM actions WHERE id=?', r.actionId)
  assert.equal(a.episode_ref, 'ep_1')
})

test('F1 / 冷却：连着两次 tick，第二次 TICK_GAP 且不产生新行动', async (t) => {
  const env = startPlugin({
    cfg: { enabled: true, dryRun: true, allowedKinds: ['read_archive'] }, // 默认冷却 5 分钟
    services: withServices(),
  })
  t.after(env.cleanup)

  const r1 = await env.api.tick()
  assert.notEqual(r1.code, 'TICK_GAP')
  const actionsAfter1 = count(env.api, 'actions')

  const r2 = await env.api.tick()
  assert.equal(r2.code, 'TICK_GAP')
  assert.equal(count(env.api, 'actions'), actionsAfter1, '冷却期间不许再建行动')
})

test('F1b / 同 kind 冷却：6 分钟后再 tick，被 MIN_GAP 挡下（不是 NO_CANDIDATE）', async (t) => {
  const env = open({ allowedKinds: ['read_archive'] })
  t.after(env.cleanup)

  const r1 = await env.api.tick()
  assert.notEqual(r1.code, 'MIN_GAP')

  // B1：dry_run 不占真实配额/冷却。这里把第一条改成「真实完成」，专门测 MIN_GAP 本身。
  env.api.db.prepare("UPDATE actions SET result_json='{\"real\":true}' WHERE status='done'").run()

  // 6 分钟：已过 tick 间隔(5)，但没到 read_archive 的同 kind 冷却(30)
  env.clock.advance(6 * 60_000)
  const r2 = await env.api.tick()
  assert.equal(r2.code, 'MIN_GAP')
  assert.equal(count(env.api, 'actions'), 1, '冷却期不许再建行动')
})

test('F2 / 安静时段：23:45 的外发类行动被 QUIET_HOURS 拦下', async (t) => {
  const clock = makeClock('2026-11-01T23:45:00+08:00')
  const memory = mockMemory({ lastUserMessageAt: clock.now() - 2 * 3600_000 })
  const env = startPlugin({
    cfg: {
      enabled: true,
      dryRun: true,
      minTickGapMinutes: 0,
      allowedKinds: ['send_qq'],
      outgoing: { ownerAllowlist: ['qq:owner'] },
      quietHours: { enabled: true, start: '23:30', end: '08:00' },
      ownerActiveEnabled: true,
      urge: { thetaLow: 0.1, thetaHigh: 0.62, delta: 0.08 },
    },
    services: withServices({ memory }),
    clock,
  })
  t.after(env.cleanup)

  const r = await env.api.tick()
  assert.equal(r.code, 'QUIET_HOURS')
  assert.equal(count(env.api, 'actions'), 0, '被安静时段拦下不该留行动行')
})

test('F2b / 主人信号缺失：外发类保守跳过（OWNER_ACTIVE），不靠猜', async (t) => {
  const clock = makeClock('2026-11-01T12:00:00+08:00')
  const memory = mockMemory({ lastUserMessageAt: null })
  const env = startPlugin({
    cfg: {
      enabled: true,
      dryRun: true,
      minTickGapMinutes: 0,
      allowedKinds: ['send_qq'],
      outgoing: { ownerAllowlist: ['qq:owner'] },
      quietHours: { enabled: true, start: '23:30', end: '08:00' },
      ownerActiveEnabled: true,
      urge: { thetaLow: 0.1, thetaHigh: 0.62, delta: 0.08 },
    },
    services: withServices({ memory }),
    clock,
  })
  t.after(env.cleanup)

  const r = await env.api.tick()
  assert.equal(r.code, 'OWNER_ACTIVE')
})

test('F4 / 暂停：pause(all) 之后跑 5 次 tick，全 PAUSED、0 行动', async (t) => {
  const env = open({ allowedKinds: ['read_archive'] })
  t.after(env.cleanup)

  const p = env.api.pause({ scope: 'all', on: true, by: 'test' })
  assert.equal(p.ok, true)

  const codes = []
  for (let i = 0; i < 5; i++) {
    env.clock.advance(60_000)
    codes.push((await env.api.tick()).code)
  }
  assert.deepEqual(codes, ['PAUSED', 'PAUSED', 'PAUSED', 'PAUSED', 'PAUSED'])
  assert.equal(count(env.api, 'actions'), 0)
  assert.equal(count(env.api, 'tick_runs'), 5, '每次 tick 都要留一行')
})

test('F5 / 暂停持久化：重启（重开同一个库）后仍然暂停', async (t) => {
  const { dir, cleanup } = makeTempDir()
  t.after(cleanup)

  const env1 = startPlugin({ dir, cfg: { ...baseCfg, allowedKinds: ['read_archive'] }, services: withServices() })
  env1.api.pause({ scope: 'all', on: true, by: 'test' })
  env1.close()

  const env2 = startPlugin({ dir, cfg: { ...baseCfg, allowedKinds: ['read_archive'] }, services: withServices() })
  t.after(env2.close)

  const status = env2.api.status()
  assert.equal(status.paused.all, true, '重启后仍是暂停态')

  const r = await env2.api.tick()
  assert.equal(r.code, 'PAUSED')
  assert.equal(count(env2.api, 'actions'), 0)
})

test('F6 / 失败退避 + 熔断：30 次 tick 只尝试 3 次，不重试风暴', async (t) => {
  const env = startPlugin({
    cfg: {
      enabled: true,
      dryRun: false,
      minTickGapMinutes: 0,
      allowedKinds: ['read_archive'],
      backoff: { baseSec: 60, factor: 2, capSec: 21_600 },
      circuit: { fails: 3, openMinutes: 360 },
      // 失败会扣驱动力，这里把阈值调低，专门测「退避 + 熔断」本身
      urge: { thetaLow: 0.15, thetaHigh: 0.62, delta: 0.08 },
    },
    services: withServices(),
    random: () => 0.99,
  })
  t.after(env.cleanup)

  let calls = 0
  env.api.registerExecutor(
    'read_archive',
    async () => {
      calls += 1
      throw new Error('通道炸了（测试用）')
    },
    { mock: true },
  )

  const codes = []
  for (let i = 0; i < 30; i++) {
    const r = await env.api.tick()
    codes.push(r.code)
    env.clock.advance(10_000)
  }

  assert.equal(calls, 3, `30 次 tick 只该真的试 3 次，实际 ${calls}`)
  assert.ok(codes.includes('BACKOFF'), '要有退避跳过')
  assert.ok(codes.includes('CIRCUIT_OPEN'), '连续 3 次失败后要熔断')
  assert.equal(count(env.api, 'actions'), 3, '失败也要留审计行')
})

test('F16 / 单飞：并发两次 tick，第二次 IN_FLIGHT，只落一条行动', async (t) => {
  const env = open({ dryRun: false, allowedKinds: ['read_archive'] })
  t.after(env.cleanup)

  let release
  const gate = new Promise((r) => {
    release = r
  })
  let calls = 0
  env.api.registerExecutor(
    'read_archive',
    async () => {
      calls += 1
      await gate
      return { ok: true, result: {} }
    },
    { mock: true },
  )

  const p1 = env.api.tick()
  const p2 = env.api.tick() // 第一次还没 await 完，应该被单飞挡住

  const r2 = await p2
  assert.equal(r2.code, 'IN_FLIGHT')

  release()
  const r1 = await p1
  assert.equal(r1.code, 'OK')
  assert.equal(calls, 1)
  assert.equal(count(env.api, 'actions'), 1)
})

test('F18 / 不补跑：last_tick 是 8 小时前，也只跑 1 轮', async (t) => {
  const env = open({ allowedKinds: ['read_archive'] })
  t.after(env.cleanup)

  setMeta(env.api.db, 'last_tick_at', { at: env.clock.now() - 8 * 3600_000 }, env.clock.now())

  const before = count(env.api, 'tick_runs')
  const r = await env.api.tick()
  assert.notEqual(r.code, 'TICK_GAP')

  assert.equal(count(env.api, 'tick_runs') - before, 1, '只补 1 轮，不补 8 小时')
  assert.equal(count(env.api, 'actions'), 1)
})

test('F20 / 异常不崩：executor 抛错 → tick 返回 failed，不抛给宿主', async (t) => {
  const env = open({ dryRun: false, allowedKinds: ['read_archive'] })
  t.after(env.cleanup)

  env.api.registerExecutor(
    'read_archive',
    async () => {
      throw new Error('boom')
    },
    { mock: true },
  )

  await assert.doesNotReject(async () => {
    const r = await env.api.tick()
    assert.equal(r.outcome, 'failed')
    assert.equal(r.code, 'EXECUTOR_FAILED')
  })

  const a = row(env.api, 'SELECT * FROM actions ORDER BY rowid DESC LIMIT 1')
  assert.equal(a.status, 'failed')
  assert.ok(String(a.error).includes('boom'))

  // 崩完还能正常查状态（说明没把连接/状态搞坏）
  assert.equal(env.api.status().ok, true)

  // 第二次 tick 应该是退避，而不是立刻再打一次
  const r2 = await env.api.tick()
  assert.equal(r2.code, 'BACKOFF')
})

test('F21 / 降级：服务缺失 → 强制 dry_run，send/diary 不进候选', async (t) => {
  const env = startPlugin({
    cfg: {
      enabled: true,
      dryRun: false, // 故意想真跑
      minTickGapMinutes: 0,
      allowedKinds: ['read_archive', 'send_qq', 'write_diary'],
    },
    services: {}, // 没有 dyPersona / dyMemory
  })
  t.after(env.cleanup)

  let calls = 0
  env.api.registerExecutor(
    'read_archive',
    async () => {
      calls += 1
      return { ok: true, result: {} }
    },
    { mock: true },
  )

  const r = await env.api.tick()
  assert.equal(r.code, 'DRY_RUN', '服务不全时必须强制 dry_run')
  assert.equal(calls, 0, '强制 dry_run 时执行器不许被调用')

  const a = row(env.api, 'SELECT decision_json FROM actions ORDER BY rowid DESC LIMIT 1')
  const d = JSON.parse(a.decision_json)
  const blocked = Object.fromEntries(d.blocked.map((b) => [b.kind, b.code]))
  assert.equal(blocked.send_qq, 'NEEDS_SERVICES')
  assert.equal(blocked.write_diary, 'NEEDS_SERVICES')
  assert.equal(d.servicesReady, false)

  const status = env.api.status()
  assert.equal(status.dryRun, true)
  assert.equal(status.servicesReady, false)
  assert.ok(status.degraded.includes('persona'))
  assert.ok(status.degraded.includes('memory'))
})

test('F21b / 降级且只剩需要服务的 kind → NEEDS_SERVICES，不硬凑', async (t) => {
  const env = startPlugin({
    cfg: { enabled: true, dryRun: true, minTickGapMinutes: 0, allowedKinds: ['send_qq'] },
    services: {},
  })
  t.after(env.cleanup)

  const r = await env.api.tick()
  assert.equal(r.code, 'NEEDS_SERVICES')
})

test('默认关：enabled=false 时 tick 直接 DISABLED，不留行动', async (t) => {
  const env = startPlugin({ cfg: { enabled: false }, services: withServices() })
  t.after(env.cleanup)

  const r = await env.api.tick()
  assert.equal(r.outcome, 'disabled')
  assert.equal(r.code, 'DISABLED')
  assert.equal(count(env.api, 'actions'), 0)
})

test('smoke / 工具已注册：dy_life_status + dy_life_pause', async (t) => {
  const env = open({ allowedKinds: ['read_archive'] })
  t.after(env.cleanup)

  const names = env.registered.map((d) => d.name)
  assert.ok(names.includes('dy_life_status'))
  assert.ok(names.includes('dy_life_pause'))

  const statusTool = env.registered.find((d) => d.name === 'dy_life_status')
  const out = await statusTool.execute({})
  assert.equal(out.ok, true)
  const detail = JSON.parse(out.detail)
  assert.equal(detail.stage, 'offline-mock-only')
  assert.equal(typeof detail.drives.curiosity, 'number')
  assert.equal(detail.dryRun, true)

  const pauseTool = env.registered.find((d) => d.name === 'dy_life_pause')
  const p = await pauseTool.execute({ scope: 'kind', kind: 'read_archive', on: true, by: 'test' })
  assert.equal(p.ok, true)
  assert.equal(env.api.status().paused.kinds.read_archive, true)

  const r = await env.api.tick()
  assert.equal(r.code, 'PAUSED_KIND', '唯一 kind 被暂停 → 原因要说准，不能只说没候选')
})
