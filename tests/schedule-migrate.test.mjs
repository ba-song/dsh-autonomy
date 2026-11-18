/** 轮换迁移 schedule 提醒 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'

const PERSONA = 'self:test-schedmigrate'

function fakeSchedule({ records = [], failCreate = new Set() } = {}) {
  const calls = { list: [], create: [], delete: [] }
  return {
    calls,
    async list(input) { calls.list.push(input); return records },
    async create(sessionId, request) { calls.create.push({ sessionId, request }); if (failCreate.has(request.title)) throw new Error('create boom'); return { id: `new-${request.title}` } },
    async delete(input) { calls.delete.push(input); return { deleted: true } },
  }
}

function open({ schedule = fakeSchedule(), failAgentCreate = false } = {}) {
  const tmp = makeTempDir('autonomy-schedmigrate-')
  const homeDir = join(tmp.dir, 'home')
  const h = () => ({ agent: { status: 'idle', async followup() { return { ok: true } }, dispose() {} } })
  const agents = { failAgentCreate, get: () => null, create: () => { if (agents.failAgentCreate) throw new Error('agent create boom'); return h() }, resume: () => h() }
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: false, home: { enabled: true, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60, logPath: join(tmp.dir, 'a.log'), deliverLog: join(tmp.dir, 'd.log') } },
    services: { ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }), agents, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) }, ...(schedule ? { schedule } : {}) },
    clock: makeClock('2026-11-07T10:00:00+08:00'),
  })
  return { env, tmp, schedule, agents, cleanup: () => { env.cleanup(); tmp.cleanup() } }
}

const future = (ctx, ms) => new Date(ctx.env.clock.now() + ms).toISOString()

test('schedule migrate / 3 条未到期迁移、过期跳过、审计计数', async (t) => {
  const now = Date.parse('2026-11-07T10:00:00+08:00')
  const sched = fakeSchedule({ records: [
    { id: 'a1', kind: 'at', title: 't1', prompt: 'p1', scheduledAt: new Date(now + 3600_000).toISOString() },
    { id: 'a2', kind: 'every', title: 't2', prompt: 'p2', everySeconds: 3600, scheduledAt: new Date(now + 1800_000).toISOString() },
    { id: 'a3', kind: 'daily', title: 't3', prompt: 'p3', time: '09:00', timeZone: 'Asia/Shanghai', scheduledAt: new Date(now + 7200_000).toISOString() },
    { id: 'a4', kind: 'at', title: 'old', prompt: 'old', scheduledAt: new Date(now - 1000).toISOString() },
  ] })
  const ctx = open({ schedule: sched })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  const r = await ctx.env.api.home.rotateHome({ personaId: PERSONA, reason: 'manual', force: true })
  assert.equal(r.code, 'ROTATED')
  assert.equal(sched.calls.create.length, 3)
  assert.equal(sched.calls.delete.length, 3)
  const audit = JSON.parse(ctx.env.api.db.prepare("SELECT data_json FROM action_log WHERE event='schedule_migrate' ORDER BY id DESC LIMIT 1").get().data_json)
  assert.deepEqual({ moved: audit.moved, failed: audit.failed, skipped: audit.skipped }, { moved: 3, failed: 0, skipped: 1 })
  assert.equal(JSON.stringify(audit).includes('p1'), false)
})

test('schedule migrate / create 失败保留旧提醒、不阻断轮换', async (t) => {
  const now = Date.parse('2026-11-07T10:00:00+08:00')
  const sched = fakeSchedule({ records: [
    { id: 'b1', kind: 'at', title: 'bad', prompt: 'p', scheduledAt: new Date(now + 3600_000).toISOString() },
    { id: 'b2', kind: 'at', title: 'good', prompt: 'p', scheduledAt: new Date(now + 3600_000).toISOString() },
  ], failCreate: new Set(['bad']) })
  const ctx = open({ schedule: sched })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  const r = await ctx.env.api.home.rotateHome({ personaId: PERSONA, force: true })
  assert.equal(r.code, 'ROTATED')
  const deleted = sched.calls.delete.map((x) => x.id)
  assert.equal(deleted.includes('b1'), false)
  assert.equal(deleted.includes('b2'), true)
  const audit = JSON.parse(ctx.env.api.db.prepare("SELECT data_json FROM action_log WHERE event='schedule_migrate' ORDER BY id DESC LIMIT 1").get().data_json)
  assert.equal(audit.moved, 1)
  assert.equal(audit.failed, 1)
})

test('schedule migrate / 服务缺失跳过并写审计，轮换成功', async (t) => {
  const ctx = open({ schedule: null })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  const r = await ctx.env.api.home.rotateHome({ personaId: PERSONA, force: true })
  assert.equal(r.code, 'ROTATED')
  const row = ctx.env.api.db.prepare("SELECT data_json FROM action_log WHERE event='schedule_migrate' ORDER BY id DESC LIMIT 1").get()
  assert.ok(row)
  assert.equal(JSON.parse(row.data_json).code, 'UNAVAILABLE')
})

test('schedule migrate / 未执行 rotate 时不动提醒', async (t) => {
  const sched = fakeSchedule({ records: [] })
  const ctx = open({ schedule: sched })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(sched.calls.list.length, 0)
  assert.equal(sched.calls.create.length, 0)
})


test('schedule migrate / 换房失败时不动提醒', async (t) => {
  const sched = fakeSchedule({ records: [{ id: 'c1', kind: 'at', title: 't', prompt: 'p', scheduledAt: new Date(Date.parse('2026-11-07T10:00:00+08:00') + 3600_000).toISOString() }] })
  const ctx = open({ schedule: sched })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.agents.failAgentCreate = true
  const r = await ctx.env.api.home.rotateHome({ personaId: PERSONA, force: true })
  assert.equal(r.code, 'HOME_CREATE_FAILED')
  assert.equal(sched.calls.list.length, 0)
  assert.equal(sched.calls.create.length, 0)
})
