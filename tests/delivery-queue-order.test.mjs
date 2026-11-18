/** 队列保序/重试/超时：修复 queued 被吞 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'

const PERSONA = 'self:test-order'

function open() {
  const tmp = makeTempDir('autonomy-order-')
  const homeDir = join(tmp.dir, 'home')
  const calls = { create: [], resume: [], followup: [], get: [], dispose: [] }
  let agent
  const mk = () => {
    agent = { status: 'idle', async followup(m) { calls.followup.push(m); return { ok: true } }, dispose() {} }
    return { agent }
  }
  const agents = { calls, get: (id) => { calls.get.push(id); return agent && agent.status === 'running' ? { agent } : null }, create: (a) => (calls.create.push(a), mk()), resume: (a) => (calls.resume.push(a), mk()) }
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: false, minTickGapMinutes: 0, home: { enabled: true, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60, deliverLog: join(tmp.dir, 'deliver.log'), drainRetryMs: 10, deliveryTimeoutMin: 1 } },
    services: { ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }), agents, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } },
    clock: makeClock(),
  })
  return { env, calls, get agent() { return agent }, cleanup: () => { env.cleanup(); tmp.cleanup() } }
}
const textOf = (m) => (Array.isArray(m.content) ? m.content.map((c) => c.text ?? '').join(' ') : String(m.content))
const wait = async (ms = 0) => {
  const t = Date.now() + Math.max(20, ms)
  while (Date.now() < t) await new Promise((r) => setImmediate(r))
}

async function setup() {
  const ctx = open()
  const home = await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.calls.followup.length = 0
  return { ...ctx, sid: home.sessionId }
}

test('order / agent running 时入队，turn/end 后自动投且不重复', async (t) => {
  const ctx = await setup()
  t.after(ctx.cleanup)
  ctx.agent.status = 'running'
  const r1 = await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: '排队-1' })
  const r2 = await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: '排队-2' })
  assert.equal(r1.queued, true)
  assert.equal(r2.queued, true)
  ctx.agent.status = 'idle'
  ctx.env.api.home.observeSessionEvent({ header: { id: ctx.sid } }, { type: 'turn/end', data: { ok: true } })
  await wait(50)
  await ctx.env.api.home.drainDeliverQueue()
  const texts = ctx.calls.followup.map(textOf)
  assert.deepEqual(texts, ['排队-1', '排队-2'])
  assert.equal(texts.filter((x) => x === '排队-1').length, 1)
})

test('order / 队列非空时新消息不反超', async (t) => {
  const ctx = await setup()
  t.after(ctx.cleanup)
  ctx.agent.status = 'running'
  await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: '早' })
  const r2 = await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: '晚' })
  assert.equal(r2.queued, true, '队列非空必须先入队')
  assert.equal(ctx.calls.followup.length, 0, '不能直投反超')
  ctx.agent.status = 'idle'
  await wait(50)
  await ctx.env.api.home.drainDeliverQueue()
  assert.deepEqual(ctx.calls.followup.map(textOf), ['早', '晚'])
})

test('order / 超时未投 → failedDeliveries + 日志，不静默', async (t) => {
  const ctx = await setup()
  t.after(ctx.cleanup)
  ctx.agent.status = 'running'
  await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: '会超时' })
  ctx.env.clock.advance(2 * 60_000)
  await wait(50)
  await ctx.env.api.home.drainDeliverQueue()
  assert.equal(ctx.calls.followup.length, 0)
  const st = ctx.env.api.home.status(PERSONA)
  assert.equal(st.failedDeliveries, 1)
  assert.equal(st.lastDeliverError.code, 'E_DELIVER_TIMEOUT')
})
