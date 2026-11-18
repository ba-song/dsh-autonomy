/** C4b · 回合失败跟踪 + 启动延迟 + 30s 单次重试 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'
import { createHomeWakeLoop, HOME_WAKE_PROMPT } from '../lib/run/home.js'

const PERSONA = 'self:test-c4b'

function fakeAgents() {
  const calls = { create: [], resume: [], followup: [], get: [], dispose: [] }
  const handle = () => ({
    agent: {
      status: 'idle',
      async followup(m) { calls.followup.push(m); return { ok: true } },
      dispose() { calls.dispose.push('agent') },
    },
  })
  return { calls, get: (id) => (calls.get.push(id), null), create: (a) => (calls.create.push(a), handle()), resume: (a) => (calls.resume.push(a), handle()) }
}

function scheduler() {
  let jobs = []
  let id = 0
  return {
    get jobs() { return jobs },
    setTimeout(fn, ms) { const j = { id: ++id, fn, ms }; jobs.push(j); return j.id },
    clearTimeout(x) { jobs = jobs.filter((j) => j.id !== x) },
    fire() { const j = jobs.shift(); return j ? j.fn() : null },
  }
}

function open({ home = {} } = {}) {
  const tmp = makeTempDir('autonomy-c4b-')
  const homeDir = join(tmp.dir, 'home')
  const agents = fakeAgents()
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: false, minTickGapMinutes: 0, home: { enabled: true, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60, startupDelayMs: 15_000, ...home } },
    services: { ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }), agents, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } },
    clock: makeClock(),
  })
  const sch = scheduler()
  const loop = createHomeWakeLoop({ home: env.api.home, db: env.api.db, cfg: env.api.cfg, clock: env.clock.now, persona: { displayName: () => '汐', emotionState: () => ({ label: '平静', intensity: 0.2 }) }, random: () => 0.5, scheduler: sch, getPersonaId: () => PERSONA })
  const cleanup = () => { loop.dispose(); env.cleanup(); tmp.cleanup() }
  return { env, agents, loop, sch, cleanup }
}

const turnError = (env, sid, code = 'TRANSPORT') =>
  env.api.home.observeSessionEvent({ header: { id: sid } }, { type: 'turn/end', data: { reason: { kind: 'error', code, message: 'provider blew up' } } })

test('C4b / turn error 改写 lastWake，不自动再叫', async (t) => {
  const { env, loop, sch, cleanup } = open()
  t.after(cleanup)
  loop.start()
  const r = await sch.fire()
  assert.equal(r.code, 'AWAKENED')
  const sid = r.sessionId

  turnError(env, sid)
  const meta = JSON.parse(env.api.db.prepare("SELECT value FROM meta WHERE key='home.lastWake'").get().value)
  assert.equal(meta.ok, false)
  assert.equal(meta.code, 'TURN_ERROR')
  assert.ok(meta.error.includes('provider'))
  const st = loop.status()
  assert.equal(st.lastTurnError.code, 'TRANSPORT')
})

test('C4b / TRANSPORT → 30s 后重试一次', async (t) => {
  const { env, agents, loop, sch, cleanup } = open()
  t.after(cleanup)
  loop.start()
  const r = await sch.fire()
  turnError(env, r.sessionId)
  assert.ok(loop.status().retryPending)
  assert.equal(sch.jobs[0].ms, 30_000)

  const r2 = await sch.fire()
  assert.equal(r2.code, 'AWAKENED')
  assert.equal(agents.calls.followup.length, 2, 'seed? 不，普通叫醒共 2 次')
  assert.equal(loop.status().retryPending, false)
})

test('C4b / 第二次 turn error 不再重试（不无限）', async (t) => {
  const { env, loop, sch, cleanup } = open()
  t.after(cleanup)
  loop.start()
  const r = await sch.fire()
  turnError(env, r.sessionId)
  await sch.fire() // retry 成功
  turnError(env, r.sessionId, 'TRANSPORT')
  const retries = sch.jobs.filter((j) => j.ms === 30_000)
  assert.equal(retries.length, 0, '同一次唤醒只重试一次')
  assert.equal(loop.status().retryPending, false)
})

test('C4b / 启动补醒延迟 15s（可配）', async (t) => {
  const { env, loop, sch, cleanup } = open({ home: { startupDelayMs: 20_000 } })
  t.after(cleanup)
  loop.start()
  assert.equal(sch.jobs[0].ms, 20_000)
  assert.equal(loop.status().startupDelayMs, 20_000)
})

test('C4b / pause 时不重试', async (t) => {
  const { env, loop, sch, cleanup } = open()
  t.after(cleanup)
  loop.start()
  const r = await sch.fire()
  env.api.db.prepare("INSERT INTO meta(key,value,updated_at) VALUES('pause.all',?,?)")
    .run(JSON.stringify({ on: true, until: null }), env.clock.now())
  turnError(env, r.sessionId)
  assert.equal(sch.jobs.filter((j) => j.ms === 30_000).length, 0)
  assert.equal(loop.status().retryPending, false)
})

test('C4b / 正常 completed 不改写 lastWake', async (t) => {
  const { env, loop, sch, cleanup } = open()
  t.after(cleanup)
  loop.start()
  const r = await sch.fire()
  env.api.home.observeSessionEvent({ header: { id: r.sessionId } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const meta = JSON.parse(env.api.db.prepare("SELECT value FROM meta WHERE key='home.lastWake'").get().value)
  assert.equal(meta.ok, true)
  assert.equal(meta.code, 'AWAKENED')
})
