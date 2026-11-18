/** dyHome.deliver：统一私聊投递串行队列 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'

const PERSONA = 'self:test-deliver'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function agents({ followupImpl = null, createThrows = false } = {}) {
  const calls = { create: [], resume: [], followup: [], get: [], dispose: [] }
  const h = () => ({ agent: { status: 'idle', async followup(m) { calls.followup.push(m); if (followupImpl) return followupImpl(m); return { ok: true } }, dispose() { calls.dispose.push(1) } } })
  return { calls, get: (id) => (calls.get.push(id), null), create: (a) => { calls.create.push(a); if (createThrows) throw new Error('create boom'); return h() }, resume: (a) => (calls.resume.push(a), h()) }
}

function open({ max = 50, followupImpl = null, createThrows = false } = {}) {
  const tmp = makeTempDir('autonomy-deliver-')
  const homeDir = join(tmp.dir, 'home')
  const ag = agents({ followupImpl, createThrows })
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: false, minTickGapMinutes: 0, home: { enabled: true, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60, deliveryQueueMax: max, deliverLog: join(tmp.dir, 'deliver.log') } },
    services: { ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }), agents: ag, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } },
    clock: makeClock(),
  })
  return { env, ag, homeDir, cleanup: () => { env.cleanup(); tmp.cleanup() } }
}

const textOf = (m) => (Array.isArray(m.content) ? m.content.map((c) => c.text ?? '').join(' ') : String(m.content))

test('deliver / 正常投递：content 数组 + source 字段 + UUID', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const r = await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c1', contactName: '主人', text: '在吗' })
  assert.equal(r.ok, true)
  assert.equal(r.delivered, true)
  assert.equal(ctx.ag.calls.followup.length, 1)
  const m = ctx.ag.calls.followup[0]
  assert.match(m.id, UUID)
  assert.ok(Array.isArray(m.content))
  assert.equal(textOf(m), '在吗')
  assert.equal(m.source.kind, 'user')
  assert.equal(m.source.channelInbound, true)
  assert.equal(m.source.channel, 'qq')
  assert.equal(m.source.contactId, 'c1')
  assert.equal(m.source.contactName, '主人')
})

test('deliver / 忙时排队且顺序正确', async (t) => {
  let release
  const gate = new Promise((r) => { release = r })
  const ctx = open({ followupImpl: () => gate })
  t.after(ctx.cleanup)
  // 先叫醒，制造 awakeInFlight（followup 卡住）
  const awakeP = ctx.env.api.home.awake({ personaId: PERSONA })
  await new Promise((r) => setImmediate(r))
  const r1 = await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c1', text: '第一条' })
  const r2 = await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c1', text: '第二条' })
  assert.equal(r1.queued, true)
  assert.equal(r1.position, 1)
  assert.equal(r2.position, 2)
  release()
  await awakeP
  await ctx.env.api.home.drainDeliverQueue()
  const msgs = ctx.ag.calls.followup.map(textOf)
  assert.equal(msgs.filter((x) => x === '第一条').length, 1)
  assert.equal(msgs.indexOf('第一条') < msgs.indexOf('第二条'), true, '队列顺序')
})

test('deliver / 队列满拒绝', async (t) => {
  let release
  const gate = new Promise((r) => { release = r })
  const ctx = open({ max: 2, followupImpl: () => gate })
  t.after(ctx.cleanup)
  const p = ctx.env.api.home.awake({ personaId: PERSONA })
  await new Promise((r) => setImmediate(r))
  await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: 'a' })
  await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: 'b' })
  const r = await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: 'c' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'QUEUE_FULL')
  release()
  await p
})

test('deliver / pause 拒绝', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  ctx.env.api.db.prepare("INSERT INTO meta(key,value,updated_at) VALUES('pause.all',?,?)")
    .run(JSON.stringify({ on: true, until: null }), ctx.env.clock.now())
  const r = await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: 'x' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'PAUSED')
})

test('deliver / handover 只生效一次，超长截断', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const long = 'h'.repeat(25_000)
  await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: '一', handoverText: long })
  await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: '二', handoverText: '第二段不该出现' })
  const notes = ctx.ag.calls.followup.filter((m) => m.source?.kind === 'handoff-note')
  assert.equal(notes.length, 1, 'handover 只一次')
  assert.ok(textOf(notes[0]).length <= 20_100)
  assert.ok(textOf(notes[0]).includes('已截断'))
})

test('deliver / group 拒绝 E_GROUP_NOT_UNIFIED', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const r = await ctx.env.provided.dyHome.deliver({ channel: 'qq', kind: 'group', contactId: 'g', text: 'x' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_GROUP_NOT_UNIFIED')
})

test('deliver / owner 插队到 normal 前（owner 内部 FIFO）', async (t) => {
  let release
  const gate = new Promise((r) => { release = r })
  const ctx = open({ followupImpl: () => gate })
  t.after(ctx.cleanup)
  const p = ctx.env.api.home.awake({ personaId: PERSONA })
  await new Promise((r) => setImmediate(r))
  await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: 'normal-1' })
  await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: 'normal-2' })
  const o1 = await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'owner', text: 'owner-1', priority: 'owner' })
  const o2 = await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'owner', text: 'owner-2', priority: 'owner' })
  assert.equal(o1.priority, 'owner')
  release()
  await p
  await ctx.env.api.home.drainDeliverQueue()
  const msgs = ctx.ag.calls.followup.map(textOf)
  const order = msgs.filter((x) => ['owner-1', 'owner-2', 'normal-1', 'normal-2'].includes(x))
  assert.deepEqual(order, ['owner-1', 'owner-2', 'normal-1', 'normal-2'])
})

test('deliver / owner pending 时 awake 不发起（OWNER_PENDING）', async (t) => {
  let release
  const gate = new Promise((r) => { release = r })
  const ctx = open({ followupImpl: () => gate })
  t.after(ctx.cleanup)
  const p = ctx.env.api.home.awake({ personaId: PERSONA })
  await new Promise((r) => setImmediate(r))
  await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'owner', text: 'owner', priority: 'owner' })
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'OWNER_PENDING')
  release()
  await p
})

test('deliver / status.pendingDeliveries = {owner,normal}', async (t) => {
  let release
  const gate = new Promise((r) => { release = r })
  const ctx = open({ followupImpl: () => gate })
  t.after(ctx.cleanup)
  const p = ctx.env.api.home.awake({ personaId: PERSONA })
  await new Promise((r) => setImmediate(r))
  await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: 'n1' })
  await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: 'n2' })
  await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'o', text: 'o1', priority: 'owner' })
  const st = ctx.env.api.home.status(PERSONA)
  assert.deepEqual(st.pendingDeliveries, { owner: 1, normal: 2 })
  assert.equal(st.ownerDelivering, false)
  release()
  await p
})

test('deliver / 忙时 owner 也排队，不打断当前回合', async (t) => {
  let release
  const gate = new Promise((r) => { release = r })
  const ctx = open({ followupImpl: () => gate })
  t.after(ctx.cleanup)
  const p = ctx.env.api.home.awake({ personaId: PERSONA })
  await new Promise((r) => setImmediate(r))
  const r = await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'owner', text: 'owner', priority: 'owner' })
  assert.equal(r.queued, true)
  assert.equal(ctx.ag.calls.followup.length, 1, '叫醒回合还在跑，没被打断')
  release()
  await p
  await ctx.env.api.home.drainDeliverQueue()
  assert.equal(ctx.ag.calls.followup.length, 2)
})


test('deliver / followup 抛错重试 3 次后 E_DELIVER_FAILED（不静默丢）', async (t) => {
  let n = 0
  const ctx = open({ followupImpl: () => { n += 1; throw new Error('boom') } })
  t.after(ctx.cleanup)
  const r = await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: '重要消息', priority: 'owner' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_DELIVER_FAILED')
  assert.equal(n, 3)
  const st = ctx.env.api.home.status(PERSONA)
  assert.equal(st.failedDeliveries, 1)
  assert.equal(st.lastDeliverError.code, 'E_DELIVER_FAILED')
  const log = readFileSync(join(ctx.homeDir, '..', 'deliver.log'), 'utf8')
  assert.ok(log.includes('status=fail'))
})

test('deliver / 缓存 handle 失效 → agents.get 拿不到 → ensureHome resume', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  const r = await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: '重启后消息' })
  await ctx.env.api.home.drainDeliverQueue()
  assert.ok(r.delivered === true || r.queued === true)
  assert.equal(ctx.ag.calls.resume.length, 1, '缓存失效后应重新 resume')
  assert.equal(ctx.ag.calls.followup.some((m) => textOf(m) === '重启后消息'), true)
})

test('deliver / 拿不到 agent → E_AGENT_UNAVAILABLE，不投', async (t) => {
  const ctx = open({ createThrows: true })
  t.after(ctx.cleanup)
  const r = await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: '没有家' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_AGENT_UNAVAILABLE')
  assert.equal(ctx.ag.calls.followup.length, 0)
})

test('deliver / 成功才 delivered=true；排队返回 QUEUED', async (t) => {
  let release
  const gate = new Promise((r) => { release = r })
  const ctx = open({ followupImpl: () => gate })
  t.after(ctx.cleanup)
  const p = ctx.env.api.home.awake({ personaId: PERSONA })
  await new Promise((r) => setImmediate(r))
  const q = await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: '排队' })
  assert.equal(q.delivered, false)
  assert.equal(q.code, 'QUEUED')
  release()
  await p
  await ctx.env.api.home.drainDeliverQueue()
  assert.equal(ctx.ag.calls.followup.some((m) => textOf(m) === '排队'), true)
})

test('deliver / handover 只在整条消息投递成功后才算用掉', async (t) => {
  let call = 0
  const ctx = open({
    followupImpl: () => {
      call += 1
      if (call >= 2 && call <= 4) throw new Error('message boom') // 第 1 条是 handoff note；随后 3 次正文失败
      return { ok: true }
    },
  })
  t.after(ctx.cleanup)
  const first = await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: '一', handoverText: '交接一' })
  assert.equal(first.ok, false)
  assert.equal(first.code, 'E_DELIVER_FAILED')
  const second = await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: '二', handoverText: '交接二' })
  assert.equal(second.delivered, true)
  const notes = ctx.ag.calls.followup.filter((m) => m.source?.kind === 'handoff-note')
  assert.equal(notes.length, 2, '第一次正文失败，handover 未算用掉；第二次应再发')
})
