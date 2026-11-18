/** D-007 · 旧限制解除 + 防刷屏（2026-11-05） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startPlugin, withServices, makeClock, mockMemory } from './helpers.mjs'

const PERSONA = 'self:test-d007'

function open(cfg = {}, clock = makeClock()) {
  return startPlugin({
    cfg: { enabled: true, dryRun: true, minTickGapMinutes: 0, allowedKinds: ['read_archive'], ...cfg },
    services: withServices({ memory: mockMemory({ lastUserMessageAt: null }) }),
    clock,
  })
}

test('D-007 / quietHours 默认取消：23:45 也能跑', async (t) => {
  const env = open(
    { allowedKinds: ['send_qq'], outgoing: { ownerAllowlist: ['qq:owner'] }, urge: { thetaLow: 0.1 } },
    makeClock('2026-11-01T23:45:00+08:00'),
  )
  t.after(env.cleanup)
  const r = await env.api.tick()
  assert.notEqual(r.code, 'QUIET_HOURS')
  assert.equal(r.code, 'DRY_RUN')
})

test('D-007 / 配额默认 null：10 条真实完成也不 DAILY_CAP', async (t) => {
  const env = open()
  t.after(env.cleanup)
  const now = env.clock.now()
  const ins = env.api.db.prepare('INSERT INTO actions(id,self_id,kind,status,risk,result_json,created_at,ended_at) VALUES(?,?,?,?,?,?,?,?)')
  for (let i = 0; i < 10; i++) ins.run(`q-${i}`, env.api.selfId(), 'read_archive', 'done', 'low', null, now - 11 * 60_000, now - 11 * 60_000)
  const r = await env.api.tick()
  assert.notEqual(r.code, 'DAILY_CAP')
  assert.equal(r.code, 'DRY_RUN')
})

test('D-007 / 防刷屏：每小时第 21 条被 RATE_LIMIT_HOUR 拦', async (t) => {
  const env = open()
  t.after(env.cleanup)
  const now = env.clock.now()
  const ins = env.api.db.prepare('INSERT INTO actions(id,self_id,kind,status,risk,result_json,created_at,ended_at) VALUES(?,?,?,?,?,?,?,?)')
  for (let i = 0; i < 20; i++) ins.run(`r-${i}`, env.api.selfId(), 'read_archive', 'done', 'low', null, now - 60_000, now - 60_000)
  const r = await env.api.tick()
  assert.equal(r.code, 'RATE_LIMIT_HOUR')
})

test('D-007 / thetaLow 默认 0：不再 LOW_URGE 硬闸', async (t) => {
  const env = open({ allowedKinds: ['send_qq'], outgoing: { ownerAllowlist: ['qq:owner'] } })
  t.after(env.cleanup)
  const r = await env.api.tick()
  assert.notEqual(r.code, 'LOW_URGE')
})

test('D-007 / model.dailyCap 默认 null：不 MODEL_BUDGET', async (t) => {
  const env = open({ allowedKinds: ['find_sticker'] })
  t.after(env.cleanup)
  const now = env.clock.now()
  env.api.db.prepare('INSERT INTO tick_runs(at,self_id,trigger,outcome,code,model_calls) VALUES(?,?,?,?,?,?)')
    .run(now - 60_000, env.api.selfId(), 'interval', 'ran', 'OK', 100)
  const r = await env.api.tick()
  assert.notEqual(r.code, 'MODEL_BUDGET')
})
