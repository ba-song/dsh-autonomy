/** 骰子唤醒（按 11-02 设计重建） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'
import { diceBonusOf, isPeakHour, diceChanceOf, rollDice, DICE_DEFAULTS } from '../lib/run/dice.js'
import { createHomeWakeLoop } from '../lib/run/home.js'

const PERSONA = 'self:test-dice'

function fakeAgents() {
  const calls = { create: [], resume: [], followup: [], get: [], dispose: [] }
  const handle = () => ({ agent: { status: 'idle', async followup(m) { calls.followup.push(m); return { ok: true } }, dispose() { calls.dispose.push(1) } } })
  return { calls, get: (id) => (calls.get.push(id), null), create: (a) => (calls.create.push(a), handle()), resume: (a) => (calls.resume.push(a), handle()) }
}

function scheduler() {
  let jobs = []
  let id = 0
  return { get jobs() { return jobs }, setTimeout(fn, ms) { const j = { id: ++id, fn, ms }; jobs.push(j); return j.id }, clearTimeout(x) { jobs = jobs.filter((j) => j.id !== x) }, fire() { const j = jobs.shift(); return j ? j.fn() : null } }
}

function open({ dice = {}, random = () => 0.99, clock = makeClock() } = {}) {
  const tmp = makeTempDir('autonomy-dice-')
  const homeDir = join(tmp.dir, 'home')
  const agents = fakeAgents()
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: false, minTickGapMinutes: 0, home: { enabled: true, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60, dice: { enabled: true, ...dice } } },
    services: { ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }), agents, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } },
    clock,
  })
  const sch = scheduler()
  const loop = createHomeWakeLoop({ home: env.api.home, db: env.api.db, cfg: env.api.cfg, clock: env.clock.now, random, scheduler: sch, getPersonaId: () => PERSONA, persona: { displayName: () => '汐', emotionState: () => ({ label: '平静', intensity: 0.2 }) } })
  const cleanup = () => { loop.dispose(); env.cleanup(); tmp.cleanup() }
  return { env, agents, loop, sch, cleanup }
}

const meta = (env, key) => {
  const r = env.api.db.prepare('SELECT value FROM meta WHERE key=?').get(key)
  return r ? JSON.parse(r.value) : null
}

test('骰子 / 默认关：不掷、不写 meta，到点直接醒', async (t) => {
  const { env, agents, loop, sch, cleanup } = open({ dice: { enabled: false } })
  t.after(cleanup)
  loop.start()
  const r = await sch.fire()
  assert.equal(r.code, 'AWAKENED')
  assert.equal(agents.calls.followup.length, 1)
  assert.equal(meta(env, 'home.dice.lastRoll'), null)
  assert.equal(meta(env, 'home.dice.misses'), null)
  assert.equal(env.api.home.status(PERSONA).dice.enabled, false)
})

test('骰子 / bonus：累积、上限、命中归零', () => {
  const cfg = { ...DICE_DEFAULTS }
  assert.equal(diceBonusOf(cfg, 0), 0)
  assert.equal(diceBonusOf(cfg, 2), 0.3)
  assert.equal(diceBonusOf(cfg, 10), 0.45)
  assert.equal(diceBonusOf(cfg, -3), 0)
})

test('骰子 / 峰时、周末、clamp', () => {
  const monday10 = Date.parse('2026-11-02T10:00:00+08:00')
  const monday20 = Date.parse('2026-11-02T20:00:00+08:00')
  const saturday10 = Date.parse('2026-11-07T10:00:00+08:00')
  const cfg = { ...DICE_DEFAULTS }
  assert.equal(isPeakHour(monday10, cfg.peakHours, 'Asia/Shanghai'), true)
  assert.equal(isPeakHour(monday20, cfg.peakHours, 'Asia/Shanghai'), false)
  assert.equal(isPeakHour(saturday10, cfg.peakHours, 'Asia/Shanghai'), false)
  const peakChance = diceChanceOf({ cfg, now: monday10, misses: 0, tz: 'Asia/Shanghai' })
  const valleyChance = diceChanceOf({ cfg, now: monday20, misses: 0, tz: 'Asia/Shanghai' })
  assert.ok(peakChance < valleyChance)
  assert.equal(diceChanceOf({ cfg: { ...cfg, baseChance: 0.99 }, now: monday20, misses: 0 }), 0.95)
  assert.equal(diceChanceOf({ cfg: { ...cfg, baseChance: 0.01, peakChanceDelta: -0.5 }, now: monday10, misses: 0 }), 0.05)
})

test('骰子 / miss：0 次 awake、lastWake 不写、misses+1、排下一轮', async (t) => {
  const { env, agents, loop, sch, cleanup } = open({ random: () => 0.99 })
  t.after(cleanup)
  loop.start()
  const r = await sch.fire()
  assert.equal(r.code, 'DICE_MISS')
  assert.equal(agents.calls.create.length, 0)
  assert.equal(agents.calls.followup.length, 0)
  assert.equal(meta(env, 'home.lastWake'), null, '骰子没中不能写 lastWake')
  assert.equal(meta(env, 'home.dice.misses'), 1)
  assert.equal(meta(env, 'home.dice.lastRoll').hit, false)
  assert.ok(sch.jobs.length >= 1, '要继续排下一轮')
})

test('骰子 / hit：1 次 awake、misses 归零', async (t) => {
  const { env, agents, loop, sch, cleanup } = open({ random: () => 0.01 })
  t.after(cleanup)
  loop.start()
  const r = await sch.fire()
  assert.equal(r.code, 'AWAKENED')
  assert.equal(agents.calls.followup.length, 1)
  assert.equal(meta(env, 'home.dice.misses'), 0)
  assert.equal(meta(env, 'home.dice.lastRoll').hit, true)
})

test('骰子 / enabled=false 完全回归（不掷不写）', async (t) => {
  const { env, agents, loop, sch, cleanup } = open({ dice: { enabled: false }, random: () => 0.99 })
  t.after(cleanup)
  loop.start()
  await sch.fire()
  assert.equal(agents.calls.followup.length, 1)
  assert.equal(meta(env, 'home.dice.lastRoll'), null)
})

test('骰子 / status.dice：enabled/lastRoll/misses/bonus', async (t) => {
  const { env, loop, sch, cleanup } = open({ random: () => 0.99 })
  t.after(cleanup)
  loop.start()
  await sch.fire()
  const d = env.api.home.status(PERSONA).dice
  assert.equal(d.enabled, true)
  assert.equal(d.misses, 1)
  assert.equal(d.bonus, 0.15)
  assert.equal(d.lastRoll.hit, false)
  assert.equal(typeof d.lastRoll.chance, 'number')
})

test('骰子 / pause：先挡，不掷、不累积 miss', async (t) => {
  const { env, loop, cleanup } = open({ random: () => 0.99 })
  t.after(cleanup)
  env.api.db.prepare("INSERT INTO meta(key,value,updated_at) VALUES('pause.all',?,?)")
    .run(JSON.stringify({ on: true, until: null }), env.clock.now())
  const r = await loop.tickOnce('wake')
  assert.equal(r.code, 'PAUSED')
  assert.equal(meta(env, 'home.dice.lastRoll'), null)
  assert.equal(meta(env, 'home.dice.misses'), null)
})


test('骰子 / 静默区间内：不掷、不醒、不累积 misses，status quiet', async (t) => {
  const clock = makeClock('2026-11-02T03:00:00+08:00')
  const { env, agents, loop, cleanup } = open({ dice: { quietHours: { enabled: true, start: '00:00', end: '08:00' } }, random: () => 0.01, clock })
  t.after(cleanup)
  const r = await loop.tickOnce('wake')
  assert.equal(r.code, 'DICE_QUIET')
  assert.equal(agents.calls.followup.length, 0)
  assert.equal(meta(env, 'home.dice.lastRoll'), null)
  assert.equal(meta(env, 'home.dice.misses'), null)
  const q = env.api.home.status(PERSONA).dice.quiet
  assert.equal(q.enabled, true)
  assert.equal(q.active, true)
  assert.equal(q.start, '00:00')
  assert.equal(q.end, '08:00')
})

test('骰子 / 08:00 后恢复正常（区间外照常掷）', async (t) => {
  const clock = makeClock('2026-11-02T09:00:00+08:00')
  const { env, loop, cleanup } = open({ dice: { quietHours: { enabled: true, start: '00:00', end: '08:00' } }, random: () => 0.01, clock })
  t.after(cleanup)
  const r = await loop.tickOnce('wake')
  assert.equal(r.code, 'AWAKENED')
  assert.equal(env.api.home.status(PERSONA).dice.quiet.active, false)
})

test('骰子 / 跨日区间 23:00–07:00：02:00 静默、08:00 正常', async (t) => {
  const cfg = { quietHours: { enabled: true, start: '23:00', end: '07:00' } }
  const night = open({ dice: cfg, random: () => 0.01, clock: makeClock('2026-11-02T02:00:00+08:00') })
  t.after(night.cleanup)
  assert.equal((await night.loop.tickOnce('wake')).code, 'DICE_QUIET')

  const morning = open({ dice: cfg, random: () => 0.01, clock: makeClock('2026-11-02T08:00:00+08:00') })
  t.after(morning.cleanup)
  assert.equal((await morning.loop.tickOnce('wake')).code, 'AWAKENED')
})

test('骰子 / 非法静默配置降级为关', async (t) => {
  const clock = makeClock('2026-11-02T03:00:00+08:00')
  const { env, loop, cleanup } = open({ dice: { quietHours: { enabled: true, start: '99:99', end: '08:00' } }, random: () => 0.01, clock })
  t.after(cleanup)
  assert.equal(env.api.home.status(PERSONA).dice.quiet.enabled, false)
  assert.equal((await loop.tickOnce('wake')).code, 'AWAKENED')
})

test('骰子 / 静默只挡自主唤醒，主人消息照常投递', async (t) => {
  const clock = makeClock('2026-11-02T03:00:00+08:00')
  const { env, cleanup } = open({ dice: { quietHours: { enabled: true, start: '00:00', end: '08:00' } }, clock })
  t.after(cleanup)
  const r = await env.provided.dyHome.deliver({ channel: 'qq', contactId: 'owner', text: '还醒着吗', priority: 'owner' })
  assert.equal(r.ok, true)
  assert.equal(r.delivered, true)
})
