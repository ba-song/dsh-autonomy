/**
 * 2026-11-14 · 聊天活动闸门（骰子/自主唤醒）
 *
 * 钉住：
 * 1. 无聊天活动 → 骰子照旧（不误伤正常自主唤醒）
 * 2. user/message 后立即到点 → CHAT_ACTIVE，不掷骰、不写 lastWake、不 followup
 * 3. 最后一条消息后 4:59 不掷；5:01 放行
 * 4. 回合进行中（turn/start 未 end）即使超过 5 分钟也不掷；turn/end 后放行
 * 5. 渠道 deliver 入站也算聊天活动
 * 6. 暂停优先：pause.all 仍返回 PAUSED，不误记成聊天中
 * 7. 聊天活动中轮换照常执行（闸门不挡轮换）
 * 8. chatIdleMin 默认 5、可配 1、0=关闭
 *
 * 全部 fake clock / fake agents / 临时库，不碰生产。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'
import { createHomeWakeLoop } from '../lib/run/home.js'
import { DEFAULTS, loadConfig } from '../lib/config.js'

const PERSONA = 'self:test-chat-gate'
const MODEL = { provider: 'fake-provider', model: 'fake-model' }
const FIVE_MIN = 5 * 60_000

function fakeAgents() {
  const calls = { create: [], resume: [], followup: [], get: [], dispose: [] }
  const handle = () => ({
    agent: {
      status: 'idle',
      async followup(m) {
        calls.followup.push(m)
        return { ok: true }
      },
      dispose() {
        calls.dispose.push('agent')
      },
    },
  })
  return {
    calls,
    get: (id) => (calls.get.push(id), null),
    create: (a) => (calls.create.push(a), handle()),
    resume: (a) => (calls.resume.push(a), handle()),
  }
}

function scheduler() {
  let jobs = []
  let id = 0
  return {
    get jobs() {
      return jobs
    },
    setTimeout(fn, ms) {
      const j = { id: ++id, fn, ms }
      jobs.push(j)
      return j.id
    },
    clearTimeout(x) {
      jobs = jobs.filter((j) => j.id !== x)
    },
    fire() {
      const j = jobs.shift()
      return j ? j.fn() : null
    },
  }
}

function open({ home = {}, dice = { enabled: true }, random = () => 0.99, clock = makeClock() } = {}) {
  const tmp = makeTempDir('autonomy-chat-gate-')
  const homeDir = join(tmp.dir, 'home')
  const agents = fakeAgents()
  const env = startPlugin({
    dir: tmp.dir,
    cfg: {
      enabled: true,
      dryRun: false,
      minTickGapMinutes: 0,
      home: {
        enabled: true,
        cwd: homeDir,
        minIntervalMin: 60,
        maxIntervalMin: 60,
        startupDelayMs: 0,
        ...home,
        dice,
      },
    },
    services: {
      ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }),
      agents,
      agentDefaultModel: { currentSelection: () => MODEL },
    },
    clock,
  })
  const sch = scheduler()
  const loop = createHomeWakeLoop({
    home: env.api.home,
    db: env.api.db,
    cfg: env.api.cfg,
    clock: env.clock.now,
    random,
    scheduler: sch,
    getPersonaId: () => PERSONA,
    persona: { displayName: () => '汐', emotionState: () => ({ label: '平静', intensity: 0.2 }) },
    log: { info() {}, warn() {} },
  })
  const cleanup = () => {
    loop.dispose()
    env.cleanup()
    tmp.cleanup()
  }
  return { env, agents, loop, sch, clock: env.clock, cleanup }
}

const meta = (env, key) => {
  const r = env.api.db.prepare('SELECT value FROM meta WHERE key=?').get(key)
  return r ? JSON.parse(r.value) : null
}

async function ensureSid(env) {
  const created = await env.api.home.ensureHome(PERSONA)
  assert.equal(created.ok, true, `ensureHome 失败：${created.code ?? ''}`)
  assert.ok(created.sessionId)
  return created.sessionId
}

const emit = (env, sid, type, data = {}) => env.api.home.observeSessionEvent({ header: { id: sid } }, { type, data })

test('聊天闸门 / 无聊天活动：骰子照旧（不误伤正常唤醒）', async (t) => {
  const { env, agents, loop, cleanup } = open({ random: () => 0.99 })
  t.after(cleanup)
  await ensureSid(env)

  const r = await loop.tickOnce('wake')
  assert.equal(r.code, 'DICE_MISS')
  assert.ok(meta(env, 'home.dice.lastRoll'), '无聊天时骰子必须真的掷')
  assert.equal(agents.calls.followup.length, 0)
  assert.equal(loop.status().lastChatSkip, null)
  assert.equal(env.api.home.chatActivityState().lastChatActivityAt, null)
})

test('聊天闸门 / user/message 后立即到点：CHAT_ACTIVE，不掷不醒', async (t) => {
  const { env, agents, loop, sch, cleanup } = open({ random: () => 0.01 })
  t.after(cleanup)
  const sid = await ensureSid(env)
  emit(env, sid, 'user/message', { content: '在吗' })

  const r = await loop.tickOnce('wake')
  assert.equal(r.code, 'CHAT_ACTIVE')
  assert.equal(r.activeTurn, false)
  assert.equal(r.remainingMs, FIVE_MIN)
  assert.equal(agents.calls.followup.length, 0, '聊天中绝不 followup')
  assert.equal(meta(env, 'home.dice.lastRoll'), null, '聊天中绝不掷骰')
  assert.equal(meta(env, 'home.lastWake'), null, '没醒就不能写 lastWake')

  const skip = meta(env, 'home.lastChatSkip')
  assert.equal(skip.code, 'CHAT_ACTIVE')
  assert.equal(skip.windowMs, FIVE_MIN)
  assert.equal(loop.status().lastCode, 'CHAT_ACTIVE')
  assert.equal(loop.status().lastChatSkip.code, 'CHAT_ACTIVE')
  assert.equal(env.api.home.lastChatActivityAt, env.clock.now())
  assert.equal(env.api.home.status(PERSONA).lastChatActivityAt, env.clock.now())
  assert.equal(sch.jobs.at(-1).ms, FIVE_MIN, '应在空闲窗口结束时复查')
})

test('聊天闸门 / 最后消息后 4:59 不掷，5:01 放行', async (t) => {
  const { env, agents, loop, clock, cleanup } = open({ random: () => 0.01 })
  t.after(cleanup)
  const sid = await ensureSid(env)
  emit(env, sid, 'assistant/message', {
    usage: { inputTokens: 12 },
    message: { content: [{ type: 'text', text: '我在' }] },
  })
  const lastAt = clock.now()
  assert.equal(env.api.home.status(PERSONA).promptTokens, 12, '聊天闸门不能挡 assistant usage 计量')

  clock.advance(4 * 60_000 + 59_000)
  const blocked = await loop.tickOnce('wake')
  assert.equal(blocked.code, 'CHAT_ACTIVE')
  assert.equal(blocked.idleMs, 4 * 60_000 + 59_000)
  assert.equal(blocked.remainingMs, 1000)
  assert.equal(meta(env, 'home.dice.lastRoll'), null)
  assert.equal(agents.calls.followup.length, 0)

  clock.advance(2000) // 距最后一条消息 5:01
  const allowed = await loop.tickOnce('wake')
  assert.equal(allowed.code, 'AWAKENED')
  assert.equal(agents.calls.followup.length, 1)
  const roll = meta(env, 'home.dice.lastRoll')
  assert.ok(roll, '放行后必须正常掷骰')
  assert.equal(roll.at, lastAt + 4 * 60_000 + 59_000 + 2000)
})

test('聊天闸门 / 回合进行中超过 5 分钟也不掷；turn/end 后从聊天结束重新计 5 分钟', async (t) => {
  const { env, agents, loop, clock, cleanup } = open({ random: () => 0.01 })
  t.after(cleanup)
  const sid = await ensureSid(env)
  emit(env, sid, 'turn/start', { turn: 1 })
  clock.advance(6 * 60_000)

  const blocked = await loop.tickOnce('wake')
  assert.equal(blocked.code, 'CHAT_ACTIVE')
  assert.equal(blocked.activeTurn, true, '回合没结束就是聊天进行中')
  assert.equal(blocked.remainingMs, 0)
  assert.equal(meta(env, 'home.dice.lastRoll'), null)
  assert.equal(agents.calls.followup.length, 0)

  emit(env, sid, 'turn/end', { ok: true })
  clock.advance(4 * 60_000 + 59_000)
  assert.equal((await loop.tickOnce('wake')).code, 'CHAT_ACTIVE', 'turn/end 后 4:59 仍不掷')
  clock.advance(2000)
  const allowed = await loop.tickOnce('wake')
  assert.equal(allowed.code, 'AWAKENED', 'turn/end 后 5:01 放行')
  assert.equal(agents.calls.followup.length, 1)
})

test('聊天闸门 / 渠道 deliver 入站也算聊天活动', async (t) => {
  const { env, agents, loop, clock, cleanup } = open({ random: () => 0.01 })
  t.after(cleanup)
  await ensureSid(env)
  const d = await env.provided.dyHome.deliver({ channel: 'qq', contactId: 'owner', text: '在吗', priority: 'owner' })
  assert.equal(d.ok, true)
  assert.equal(d.delivered, true)
  assert.equal(env.api.home.lastChatActivityAt, clock.now(), 'deliver 入站必须更新时间轴')

  clock.advance(4 * 60_000 + 59_000)
  assert.equal((await loop.tickOnce('wake')).code, 'CHAT_ACTIVE')
  clock.advance(2000)
  assert.equal((await loop.tickOnce('wake')).code, 'AWAKENED')
  assert.equal(agents.calls.followup.length, 2, '1 次投递 + 1 次醒来')
})

test('聊天闸门 / 暂停优先：聊天中仍返回 PAUSED，不误记 CHAT_ACTIVE', async (t) => {
  const { env, clock, loop, cleanup } = open({ random: () => 0.01 })
  t.after(cleanup)
  const sid = await ensureSid(env)
  emit(env, sid, 'user/message', { content: '在吗' })
  env.api.db
    .prepare("INSERT INTO meta(key,value,updated_at) VALUES('pause.all',?,?)")
    .run(JSON.stringify({ on: true, until: null }), clock.now())

  const r = await loop.tickOnce('wake')
  assert.equal(r.code, 'PAUSED')
  assert.equal(loop.status().lastChatSkip, null)
})

test('聊天闸门 / 不挡轮换：聊天活动中 rotateHome 照常执行', async (t) => {
  const { env, cleanup } = open({ random: () => 0.99 })
  t.after(cleanup)
  const sid = await ensureSid(env)
  emit(env, sid, 'user/message', { content: '在吗' })
  const before = env.api.home.chatActivityState().lastChatActivityAt
  env.api.db
    .prepare('UPDATE home_sessions SET prompt_tokens=?, context_window=? WHERE home_session_id=?')
    .run(70_000, 100_000, sid)

  const r = await env.api.home.rotateHome({ personaId: PERSONA, reason: 'threshold' })
  assert.equal(r.code, 'ROTATED')
  assert.notEqual(r.sessionId, sid)
  assert.equal(env.api.home.chatActivityState().lastChatActivityAt, before, '轮换不改聊天活动时间轴')
})

test('聊天闸门 / 阈值可配：默认 5、可配 1、0=关闭', async (t) => {
  assert.equal(DEFAULTS.home.chatIdleMin, 5)
  assert.equal(loadConfig({}).home.chatIdleMin, 5)
  assert.equal(loadConfig({ home: { chatIdleMin: 1 } }).home.chatIdleMin, 1)

  const one = open({ home: { chatIdleMin: 1 }, random: () => 0.01 })
  t.after(one.cleanup)
  const sid1 = await ensureSid(one.env)
  emit(one.env, sid1, 'user/message', { content: 'x' })
  one.clock.advance(59_000)
  assert.equal((await one.loop.tickOnce('wake')).code, 'CHAT_ACTIVE', '1 分钟窗口内仍挡')
  one.clock.advance(2000)
  assert.equal((await one.loop.tickOnce('wake')).code, 'AWAKENED', '1:01 后放行')

  const off = open({ home: { chatIdleMin: 0 }, random: () => 0.99 })
  t.after(off.cleanup)
  const sid2 = await ensureSid(off.env)
  emit(off.env, sid2, 'user/message', { content: 'x' })
  assert.equal((await off.loop.tickOnce('wake')).code, 'DICE_MISS', '0 表示关闭闸门，聊天中也照常掷')
})
