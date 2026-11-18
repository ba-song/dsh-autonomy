/**
 * C3b · 回合结束即量一次（2026-11-08 主人要求）
 *
 * 覆盖：turn/end 后到 650k 自动轮换（不再等下一次醒来）、低于阈值不动、
 * 连续 turn/end 只轮换一次、轮换用的是最新计量。
 * 全部 fake agents/model + 临时库；不真调模型。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'

const PERSONA = 'self:test-turn-rotate'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function fakeModel() {
  return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }
}

function makeFakeAgents() {
  const calls = { get: [], create: [], resume: [], followup: [], dispose: [] }
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
  const agents = {
    calls,
    failCreate: false,
    createDelayMs: 0,
    get(id) {
      calls.get.push(id)
      return null
    },
    async create(args) {
      calls.create.push(args)
      if (agents.failCreate) throw new Error('create boom')
      if (agents.createDelayMs) await wait(agents.createDelayMs)
      return handle()
    },
    resume(args) {
      calls.resume.push(args)
      return handle()
    },
  }
  return agents
}

function openHome({ home = {} } = {}) {
  const tmp = makeTempDir('autonomy-turn-rotate-')
  const homeDir = join(tmp.dir, 'home')
  const agents = makeFakeAgents()
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
        contextLimit: 650_000,
        rotateRatio: 0.62,
        turnRotateDelayMs: 10,
        ...home,
      },
    },
    services: {
      ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }),
      agents,
      agentDefaultModel: fakeModel(),
    },
    clock: makeClock(),
  })
  const cleanup = () => {
    env.cleanup()
    tmp.cleanup()
  }
  return { env, agents, homeDir, cleanup }
}

function setTokens(env, sessionId, pt, cw) {
  env.api.db.prepare('UPDATE home_sessions SET prompt_tokens=?, context_window=? WHERE home_session_id=?').run(pt, cw, sessionId)
}

const turnEnd = (env, sid) => env.api.home.observeSessionEvent({ header: { id: sid } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

test('C3b / 回合结束到 650k：自动轮换（不用等醒来）', async (t) => {
  const { env, agents, cleanup } = openHome()
  t.after(cleanup)
  const first = await env.api.home.awake({ personaId: PERSONA })
  assert.equal(first.code, 'AWAKENED')
  assert.equal(agents.calls.create.length, 1)

  setTokens(env, first.sessionId, 700_000, 1_048_576)
  turnEnd(env, first.sessionId)
  await wait(80)

  assert.equal(agents.calls.create.length, 2, '回合结束后应轮换一次')
  const rotateArgs = agents.calls.create.at(-1)
  assert.equal(rotateArgs.meta.rotatedFrom, first.sessionId)

  const st = env.api.home.status(PERSONA)
  assert.notEqual(st.sessionId, first.sessionId)
  assert.equal(st.promptTokens, 0)
  assert.equal(st.lastRotate.code, 'ROTATED')
  assert.equal(st.lastRotate.reason, 'threshold-turn-end')
  assert.ok(st.lastRotate.handoffPath && existsSync(st.lastRotate.handoffPath), 'handoff 文件要存在')
})

test('C3b / 低于阈值：回合结束不动会话', async (t) => {
  const { env, agents, cleanup } = openHome()
  t.after(cleanup)
  const first = await env.api.home.awake({ personaId: PERSONA })

  setTokens(env, first.sessionId, 499_999, 1_048_576)
  turnEnd(env, first.sessionId)
  await wait(80)

  assert.equal(agents.calls.create.length, 1, '没到线不应新建会话')
  assert.equal(env.api.home.status(PERSONA).sessionId, first.sessionId)
  assert.equal(env.api.home.status(PERSONA).lastRotate, null)
})

test('C3b / 连续 turn/end：只轮换一次', async (t) => {
  const { env, agents, cleanup } = openHome()
  t.after(cleanup)
  const first = await env.api.home.awake({ personaId: PERSONA })
  setTokens(env, first.sessionId, 700_000, 1_048_576)

  turnEnd(env, first.sessionId)
  turnEnd(env, first.sessionId)
  turnEnd(env, first.sessionId)
  await wait(100)

  assert.equal(agents.calls.create.length, 2, '三次 turn/end 只能轮换一次')
  const n = env.api.db.prepare('SELECT COUNT(1) AS n FROM home_rooms').get().n
  assert.equal(n, 2, '旧房间留档 + 新房间，各一行')
})

test('C3b / 轮换失败：旧会话保留，下一回合还能再试', async (t) => {
  const { env, agents, cleanup } = openHome()
  t.after(cleanup)
  const first = await env.api.home.awake({ personaId: PERSONA })
  setTokens(env, first.sessionId, 700_000, 1_048_576)
  agents.failCreate = true

  turnEnd(env, first.sessionId)
  await wait(80)

  assert.equal(env.api.home.status(PERSONA).sessionId, first.sessionId, '失败不换会话')
  assert.equal(env.api.home.status(PERSONA).lastRotate.code, 'HOME_CREATE_FAILED')

  agents.failCreate = false
  turnEnd(env, first.sessionId)
  await wait(80)
  assert.equal(env.api.home.status(PERSONA).lastRotate.code, 'ROTATED', '下一回合重试成功')
})

test('C3b / 轮换中的主人消息先排队，轮换完投到新家', async (t) => {
  const { env, agents, cleanup } = openHome()
  t.after(cleanup)
  const first = await env.api.home.awake({ personaId: PERSONA })
  const baseline = agents.calls.followup.length
  agents.createDelayMs = 60

  setTokens(env, first.sessionId, 700_000, 1_048_576)
  turnEnd(env, first.sessionId)
  await wait(30) // 定时器 10ms + 轮换已开始（create 还要 60ms）

  const d = await env.api.home.deliver({ channel: 'qq', kind: 'private', contactId: 'owner', contactName: '主人', text: '在吗', priority: 'owner' })
  assert.equal(d.ok, true)
  assert.equal(d.queued, true, '轮换窗口内先排队')
  assert.equal(d.delivered, false)

  await wait(220)
  const st = env.api.home.status(PERSONA)
  assert.notEqual(st.sessionId, first.sessionId, '会话已轮换')
  assert.equal(st.pendingDeliveries.owner + st.pendingDeliveries.normal, 0, '队列已清')
  assert.equal(agents.calls.followup.length, baseline + 1, '轮换完成后只投一次')
})

test('C3b / 回合进行中醒来不抢着轮换（交给回合结束）', async (t) => {
  const { env, agents, cleanup } = openHome()
  t.after(cleanup)
  const first = await env.api.home.awake({ personaId: PERSONA })
  assert.equal(agents.calls.create.length, 1)

  setTokens(env, first.sessionId, 700_000, 1_048_576)
  env.api.home.observeSessionEvent({ header: { id: first.sessionId } }, { type: 'turn/start', data: { turn: 1 } })

  const r = await env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.ok, true)
  assert.equal(agents.calls.create.length, 1, '回合进行中醒来不轮换')

  env.api.home.observeSessionEvent({ header: { id: first.sessionId } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await wait(80)
  assert.equal(agents.calls.create.length, 2, '回合结束后照常轮换')
  assert.notEqual(env.api.home.status(PERSONA).sessionId, first.sessionId)
})
