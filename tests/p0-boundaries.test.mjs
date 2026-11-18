/**
 * P0 边界证据：F8 越权 / F9 白名单 / F10 无证据
 * 附带补齐 F13 模型预算门、F17 租约回收、F19 日上限的可执行证据。
 *
 * 全部 mock，不真实外发；外发类只在「测试显式打开 sendEnabled」时走到执行器。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startPlugin, withServices, mockMemory, makeClock, row, count } from './helpers.mjs'

const NOON = '2026-11-01T12:00:00+08:00'

function openOutgoing({ cfg = {}, memory = null, clock = null } = {}) {
  const clk = clock ?? makeClock(NOON)
  const mem = memory ?? mockMemory({ lastUserMessageAt: clk.now() - 2 * 3600_000 })
  return startPlugin({
    cfg: {
      enabled: true,
      dryRun: false,
      sendEnabled: true,
      minTickGapMinutes: 0,
      allowedKinds: ['send_qq'],
      outgoing: { ownerAllowlist: ['qq:owner'] },
      quietHours: { enabled: true, start: '23:30', end: '08:00' },
      ownerActiveEnabled: true,
      urge: { thetaLow: 0.1, thetaHigh: 0.62, delta: 0.08 },
      ...cfg,
    },
    services: withServices({ memory: mem }),
    clock: clk,
  })
}

// ── F8 越权 ───────────────────────────────────────────

test('F8-a 越权：未知 kind 不能注册执行器', async (t) => {
  const env = startPlugin({ cfg: { enabled: false }, services: withServices() })
  t.after(env.cleanup)

  assert.throws(() => env.api.registerExecutor('rm_rf', async () => ({ ok: true })), /未知行动 kind/)
  assert.throws(() => env.api.registerExecutor('__proto__', async () => ({ ok: true })), /未知行动 kind/)
})

test('F8-b 越权：高风险真实执行器在未放行时拒绝注册', async (t) => {
  const env = startPlugin({
    cfg: { enabled: true, dryRun: true, allowedKinds: ['send_qq'], outgoing: { ownerAllowlist: ['qq:owner'] } },
    services: withServices(),
  })
  t.after(env.cleanup)

  // 单段式真实现
  assert.throws(() => env.api.registerExecutor('send_qq', async () => ({ ok: true })), /高风险/)
  // 两段式同样要过同一道闸
  assert.throws(
    () => env.api.registerExecutor('send_qq', { prepare: async () => ({}), deliver: async () => ({ ok: true }) }, { twoPhase: true }),
    /高风险/,
  )
  // 低风险 kind 不受影响
  assert.doesNotThrow(() => env.api.registerExecutor('read_archive', async () => ({ ok: true })))
})

test('F8-c 越权：未开 sendEnabled 时高风险行动被拒，执行器 0 调用', async (t) => {
  const env = openOutgoing({ cfg: { sendEnabled: false } })
  t.after(env.cleanup)

  let calls = 0
  env.api.registerExecutor('send_qq', async () => {
    calls += 1
    return { ok: true, evidence: [{ type: 'episode', id: 'e1' }] }
  }, { mock: true })

  const r = await env.api.tick()
  assert.equal(r.code, 'SEND_DISABLED')
  assert.equal(calls, 0, '政策闸必须在执行器之前')

  const a = row(env.api, 'SELECT * FROM actions ORDER BY rowid DESC LIMIT 1')
  assert.equal(a.status, 'aborted')
  assert.equal(a.error, 'SEND_DISABLED')
})

test('F8-d 越权：配置里的未知 kind 被过滤；暂停工具拒绝未知 kind', async (t) => {
  const env = startPlugin({
    cfg: { enabled: false, allowedKinds: ['rm_rf', 'read_archive'] },
    services: withServices(),
  })
  t.after(env.cleanup)

  assert.deepEqual(env.api.cfg.allowedKinds, ['read_archive'], '未知 kind 不得进候选')

  const pauseTool = env.registered.find((d) => d.name === 'dy_life_pause')
  const out = await pauseTool.execute({ scope: 'kind', kind: 'rm_rf', on: true })
  assert.equal(out.ok, false)
  assert.ok(JSON.parse(out.detail).error.includes('未知行动 kind'))

  const ok = await pauseTool.execute({ scope: 'kind', kind: 'read_archive', on: true })
  assert.equal(ok.ok, true)
})

// ── F9 白名单 / 主人信号 ──────────────────────────────

test('F9-a 白名单：默认空 = 禁止一切外发（NO_ALLOWLIST）', async (t) => {
  const env = openOutgoing({ cfg: { outgoing: { ownerAllowlist: [] } } })
  t.after(env.cleanup)

  let calls = 0
  env.api.registerExecutor('send_qq', async () => {
    calls += 1
    return { ok: true, evidence: [{ type: 'episode', id: 'e1' }] }
  }, { mock: true })

  const r = await env.api.tick()
  assert.equal(r.code, 'NO_ALLOWLIST')
  assert.equal(calls, 0)
  assert.equal(count(env.api, 'actions'), 0, '白名单门在建 action 之前')
})

test('F9-b 白名单：安静时段内即使有白名单也不发', async (t) => {
  const clock = makeClock('2026-11-01T23:45:00+08:00')
  const env = openOutgoing({
    clock,
    memory: mockMemory({ lastUserMessageAt: clock.now() - 2 * 3600_000 }),
  })
  t.after(env.cleanup)

  const r = await env.api.tick()
  assert.equal(r.code, 'QUIET_HOURS')
  assert.equal(count(env.api, 'actions'), 0)
})

test('F9-c 白名单：主人信号缺失 → 保守跳过（OWNER_ACTIVE）', async (t) => {
  const env = openOutgoing({ memory: mockMemory({ lastUserMessageAt: null }) })
  t.after(env.cleanup)

  const r = await env.api.tick()
  assert.equal(r.code, 'OWNER_ACTIVE')
  assert.equal(count(env.api, 'actions'), 0)
})

test('F9-d 白名单：主人刚说过话 → 不插话（OWNER_ACTIVE）', async (t) => {
  const clock = makeClock(NOON)
  const env = openOutgoing({
    clock,
    memory: mockMemory({ lastUserMessageAt: clock.now() - 5 * 60_000 }),
  })
  t.after(env.cleanup)

  const r = await env.api.tick()
  assert.equal(r.code, 'OWNER_ACTIVE')
})

// ── F10 无证据 ────────────────────────────────────────

test('F10-a 两段式：prepare 无证据 → 失败，deliver 一次都没调', async (t) => {
  const env = openOutgoing()
  t.after(env.cleanup)

  let delivered = 0
  env.api.registerExecutor(
    'send_qq',
    {
      prepare: async () => ({ ok: true, content: '随口编的一句', evidence: [] }),
      deliver: async () => {
        delivered += 1
        return { ok: true, result: { sent: true } }
      },
    },
    { twoPhase: true, mock: true },
  )

  const r = await env.api.tick()
  assert.equal(r.code, 'NO_EVIDENCE')
  assert.equal(delivered, 0, '没有证据就不许 deliver')

  const a = row(env.api, 'SELECT * FROM actions ORDER BY rowid DESC LIMIT 1')
  assert.equal(a.status, 'failed')
  assert.equal(a.error, 'NO_EVIDENCE')
  assert.equal(a.evidence_json, null)
})

test('F10-b 两段式：有证据 → deliver 一次，证据落库', async (t) => {
  const env = openOutgoing()
  t.after(env.cleanup)

  let delivered = 0
  let gotContent = null
  env.api.registerExecutor(
    'send_qq',
    {
      prepare: async () => ({
        ok: true,
        content: '刚刚翻到上次没说完的那句话，你还记得吗',
        evidence: [{ type: 'episode', id: 'ep_42' }],
      }),
      deliver: async (_ctx, payload) => {
        delivered += 1
        gotContent = payload?.content
        return { ok: true, result: { sent: true } }
      },
    },
    { twoPhase: true, mock: true },
  )

  const r = await env.api.tick()
  assert.equal(r.outcome, 'ran')
  assert.equal(delivered, 1)
  assert.ok(String(gotContent).includes('上次没说完'))

  const a = row(env.api, 'SELECT * FROM actions ORDER BY rowid DESC LIMIT 1')
  assert.equal(a.status, 'done')
  const evidence = JSON.parse(a.evidence_json)
  assert.deepEqual(evidence, [{ type: 'episode', id: 'ep_42' }])
})

test('F10-c 单段式外发的兜底门：返回 ok 但没证据 → 判失败（并说明应改两段式）', async (t) => {
  const env = openOutgoing()
  t.after(env.cleanup)

  env.api.registerExecutor(
    'send_qq',
    async () => ({ ok: true, result: { sent: true } }), // 单段式：发都发了才检查，属于兜底
    { mock: true },
  )

  const r = await env.api.tick()
  assert.equal(r.code, 'NO_EVIDENCE')

  const a = row(env.api, 'SELECT * FROM actions ORDER BY rowid DESC LIMIT 1')
  assert.equal(a.status, 'failed')
  assert.equal(a.error, 'NO_EVIDENCE')
})

// ── 顺带补齐：F13 / F17 / F19 ─────────────────────────

test('F13 模型预算：当日额度用尽 → MODEL_BUDGET，不选需要模型的行动', async (t) => {
  const env = startPlugin({
    cfg: {
      enabled: true,
      dryRun: true,
      minTickGapMinutes: 0,
      allowedKinds: ['write_diary'],
      urge: { thetaLow: 0.1, thetaHigh: 0.62, delta: 0.08 },
      model: { maxPerTick: 1, dailyCap: 0 },
    },
    services: withServices(),
  })
  t.after(env.cleanup)

  const r = await env.api.tick()
  assert.equal(r.code, 'MODEL_BUDGET')
  assert.equal(count(env.api, 'actions'), 0)
})

test('F17 租约回收：过期 running 在下一次 tick 前变 failed(stale_lease)', async (t) => {
  const env = startPlugin({
    cfg: { enabled: true, dryRun: true, minTickGapMinutes: 0, allowedKinds: ['read_archive'] },
    services: withServices(),
  })
  t.after(env.cleanup)

  const staleAt = env.clock.now() - 10 * 60_000
  env.api.db
    .prepare(
      `INSERT INTO actions(id, self_id, kind, status, risk, lease_until, started_at, created_at)
       VALUES('stale-1', ?, 'read_archive', 'running', 'low', ?, ?, ?)`,
    )
    .run(env.api.selfId(), staleAt, staleAt, staleAt)

  await env.api.tick()
  const a = row(env.api, "SELECT status,error FROM actions WHERE id='stale-1'")
  assert.equal(a.status, 'failed')
  assert.equal(a.error, 'stale_lease')
})

test('F19 日上限：当天已发满 → DAILY_CAP（外发类先被配额拦）', async (t) => {
  const env = openOutgoing({ cfg: { caps: { send_qq: { perDay: 1 } } } })
  t.after(env.cleanup)

  const now = env.clock.now()
  env.api.db
    .prepare(
      `INSERT INTO actions(id, self_id, kind, status, risk, ended_at, created_at)
       VALUES('done-1', ?, 'send_qq', 'done', 'high', ?, ?)`,
    )
    .run(env.api.selfId(), now - 60_000, now - 60_000)

  const r = await env.api.tick()
  assert.equal(r.code, 'DAILY_CAP')
})
