/**
 * C3 · 650k 计量 / 轮换 / handoff + 两个 owner-only 工具（2026-11-05）
 *
 * 覆盖：计量写回、低于阈值不轮换、到阈值轮换 + handoff、handoff 内容上限、
 * 轮换失败保留旧行、缺计量不崩、旧行不删、新会话带 agentOptions、status 字段；
 * 以及 dy_life_home_status / dy_life_home_awake 的 owner 门、pause/dryRun、并发。
 * 全部 fake agents/model + 临时库；不真调模型。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'

const PERSONA = 'self:test-c3'

function fakeModel() {
  return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }
}

function makeFakeAgents({ followupImpl = null } = {}) {
  const calls = { get: [], create: [], resume: [], followup: [], dispose: [] }
  const agents = {
    calls,
    failCreate: false,
    get(id) {
      calls.get.push(id)
      return null
    },
    create(args) {
      calls.create.push(args)
      if (agents.failCreate) throw new Error('create boom')
      return {
        agent: {
          status: 'idle',
          async followup(msg) {
            calls.followup.push(msg)
            if (followupImpl) return followupImpl(msg)
            return { ok: true }
          },
          dispose() {
            calls.dispose.push('agent')
          },
        },
      }
    },
    resume(args) {
      calls.resume.push(args)
      return {
        agent: {
          status: 'idle',
          async followup(msg) {
            calls.followup.push(msg)
            if (followupImpl) return followupImpl(msg)
            return { ok: true }
          },
          dispose() {
            calls.dispose.push('agent')
          },
        },
      }
    },
  }
  return agents
}

function openHome({ home = {}, followupImpl = null } = {}) {
  const tmp = makeTempDir('autonomy-c3-')
  const homeDir = join(tmp.dir, 'home')
  const agents = makeFakeAgents({ followupImpl })
  const env = startPlugin({
    dir: tmp.dir,
    cfg: {
      enabled: true,
      dryRun: false,
      minTickGapMinutes: 0,
      ...home,
      home: {
        enabled: true,
        cwd: homeDir,
        minIntervalMin: 60,
        maxIntervalMin: 60,
        contextLimit: 650_000,
        rotateRatio: 0.62,
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

function tool(env, name) {
  return env.registered.find((r) => r.name === name)
}

function homeExec(sessionId) {
  return { agent: { session: { header: { id: sessionId, cwd: '/sdcard/DSHA/生活/数据/home' } } } }
}

const parse = (r) => JSON.parse(r.detail)

test('C3 / 计量：assistant usage + request/context 写回 home_sessions', async (t) => {
  const { env, cleanup } = openHome()
  t.after(cleanup)
  const first = await env.api.home.awake({ personaId: PERSONA })
  const sid = first.sessionId

  env.api.home.observeSessionEvent(
    { header: { id: sid } },
    { type: 'assistant/message', data: { usage: { inputTokens: 123, cacheReadTokens: 456 }, content: [{ type: 'text', text: 'hi' }] } },
  )
  env.api.home.observeSessionEvent({ header: { id: sid } }, { type: 'request/context', data: { contextWindow: 100_000 } })

  const st = env.api.home.status(PERSONA)
  assert.equal(st.promptTokens, 579)
  assert.equal(st.contextWindow, 100_000)
  assert.ok(Math.abs(st.ratio - 0.00579) < 1e-9)
})

test('C3 / 低于阈值：rotateHome 返回 BELOW_THRESHOLD，不换会话', async (t) => {
  const { env, cleanup } = openHome()
  t.after(cleanup)
  const first = await env.api.home.awake({ personaId: PERSONA })
  setTokens(env, first.sessionId, 100, 100_000)

  const r = await env.api.home.rotateHome({ personaId: PERSONA })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'BELOW_THRESHOLD')
  assert.equal(env.api.home.status(PERSONA).sessionId, first.sessionId)
  assert.equal(env.api.db.prepare('SELECT COUNT(1) AS n FROM home_rooms').get().n, 1)
})

test('C3 / 到阈值轮换：handoff 落盘、新会话带 agentOptions', async (t) => {
  const { env, agents, cleanup } = openHome()
  t.after(cleanup)
  const first = await env.api.home.awake({ personaId: PERSONA })
  setTokens(env, first.sessionId, 70_000, 100_000)

  const r = await env.api.home.rotateHome({ personaId: PERSONA, reason: 'threshold' })
  assert.equal(r.ok, true)
  assert.equal(r.code, 'ROTATED')
  assert.notEqual(r.sessionId, first.sessionId)
  assert.ok(r.handoffPath && existsSync(r.handoffPath), 'handoff 文件要存在')

  assert.equal(agents.calls.create.length, 2, '初次 + 轮换各一次')
  const rotateArgs = agents.calls.create.at(-1)
  assert.deepEqual(rotateArgs.agentOptions, { provider: 'fake-provider', model: 'fake-model' })
  assert.equal(rotateArgs.meta.cwd, env.api.home.cwd)
  assert.equal(rotateArgs.meta.rotatedFrom, first.sessionId)

  const row = env.api.db.prepare('SELECT * FROM home_sessions WHERE persona_id=?').get(PERSONA)
  assert.equal(row.home_session_id, r.sessionId)
  assert.equal(row.prompt_tokens, 0, '新会话计量归零')
})

test('C3 / handoff 内容：旧 session/原因/最近原话，最多 50 条', async (t) => {
  const { env, cleanup } = openHome()
  t.after(cleanup)
  const first = await env.api.home.awake({ personaId: PERSONA })
  for (let i = 0; i < 60; i++) {
    env.api.home.observeSessionEvent(
      { header: { id: first.sessionId } },
      { type: 'assistant/message', data: { usage: { inputTokens: 1 }, content: [{ type: 'text', text: `msg-${i}` }] } },
    )
  }
  setTokens(env, first.sessionId, 70_000, 100_000)
  const r = await env.api.home.rotateHome({ personaId: PERSONA, reason: 'threshold' })
  assert.equal(r.code, 'ROTATED')

  const body = readFileSync(r.handoffPath, 'utf8')
  assert.ok(body.includes('交接（rotate）'))
  assert.ok(body.includes(first.sessionId), '要写旧 session id')
  assert.ok(body.includes('msg-59'), '要带最近原话')
  const itemLines = body.split('\n').filter((l) => l.startsWith('- ['))
  assert.ok(itemLines.length <= 50, `最多 50 条，实际 ${itemLines.length}`)
  assert.ok(itemLines.length >= 1)
})

test('C3 / 轮换失败：保留旧行/旧会话，记 home.lastRotate 原因码', async (t) => {
  const { env, agents, cleanup } = openHome()
  t.after(cleanup)
  const first = await env.api.home.awake({ personaId: PERSONA })
  setTokens(env, first.sessionId, 70_000, 100_000)
  agents.failCreate = true

  const r = await env.api.home.rotateHome({ personaId: PERSONA })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'HOME_CREATE_FAILED')
  assert.equal(env.api.home.status(PERSONA).sessionId, first.sessionId, '旧会话保留')
  assert.equal(env.api.db.prepare('SELECT COUNT(1) AS n FROM home_rooms').get().n, 1, '旧行不删、不新增')
  const last = JSON.parse(env.api.db.prepare("SELECT value FROM meta WHERE key='home.lastRotate'").get().value)
  assert.equal(last.ok, false)
  assert.equal(last.code, 'HOME_CREATE_FAILED')
})

test('C3 / 缺计量：observe 不崩，status 保持 0', async (t) => {
  const { env, cleanup } = openHome()
  t.after(cleanup)
  await env.api.home.awake({ personaId: PERSONA })
  assert.doesNotThrow(() => env.api.home.observeSessionEvent({ header: { id: 'not-home' } }, { type: 'assistant/message', data: {} }))
  const r = env.api.home.observeSessionEvent({ header: { id: 'whatever' } }, { type: 'request/context', data: {} })
  assert.equal(r, null)
  const st = env.api.home.status(PERSONA)
  assert.equal(st.promptTokens, 0)
  assert.equal(st.contextWindow, 0)
  assert.equal(st.ratio, 0)
})

test('C3 / 旧行不删：home_rooms 保留 create 行并标 rotated_at', async (t) => {
  const { env, cleanup } = openHome()
  t.after(cleanup)
  const first = await env.api.home.awake({ personaId: PERSONA })
  setTokens(env, first.sessionId, 70_000, 100_000)
  const r = await env.api.home.rotateHome({ personaId: PERSONA })
  assert.equal(r.code, 'ROTATED')

  const rooms = env.api.db.prepare('SELECT * FROM home_rooms ORDER BY id').all()
  assert.equal(rooms.length, 2)
  assert.equal(rooms[0].session_id, first.sessionId, '旧 session 行还在')
  assert.ok(rooms[0].rotated_at)
  assert.equal(rooms[0].source, 'create')
  assert.equal(rooms[1].session_id, r.sessionId)
  assert.equal(rooms[1].source, 'rotate')
  assert.equal(rooms[1].rotated_at, null)
})

test('C3 / status.home 字段：promptTokens/contextWindow/ratio/rotateAt', async (t) => {
  const { env, cleanup } = openHome()
  t.after(cleanup)
  const first = await env.api.home.awake({ personaId: PERSONA })
  setTokens(env, first.sessionId, 70_000, 100_000)
  const r = await env.api.home.rotateHome({ personaId: PERSONA })
  const st = env.api.home.status(PERSONA)
  assert.equal(r.code, 'ROTATED')
  assert.equal(st.promptTokens, 0)
  assert.equal(st.contextWindow, 100_000)
  assert.equal(st.ratio, 0)
  assert.ok(st.rotateAt)
  assert.equal(st.lastRotate.code, 'ROTATED')
})

// ── 两个工具 ───────────────────────────────────────────

test('C3-工具 / dy_life_home_status：owner 可读全部字段 + home_sessions 行', async (t) => {
  const { env, cleanup } = openHome()
  t.after(cleanup)
  const first = await env.api.home.awake({ personaId: PERSONA })
  const res = await tool(env, 'dy_life_home_status').execute({}, homeExec(first.sessionId))
  const out = parse(res)
  assert.equal(out.ok, true)
  assert.equal(out.home.sessionId, first.sessionId)
  assert.equal(out.home.cwd, env.api.home.cwd)
  assert.equal(typeof out.home.promptTokens, 'number')
  assert.equal(typeof out.home.contextWindow, 'number')
  assert.equal(typeof out.home.ratio, 'number')
  assert.ok('rotateAt' in out.home)
  assert.equal(out.row.home_session_id, first.sessionId)
  assert.equal(out.row.prompt_tokens, 0)
})

test('C3-工具 / dy_life_home_awake：受 pause/dryRun 约束，审计 trigger=manual', async (t) => {
  const { env, cleanup } = openHome()
  t.after(cleanup)
  const first = await env.api.home.awake({ personaId: PERSONA })
  const exec = homeExec(first.sessionId)

  const now = env.clock.now()
  env.api.db
    .prepare("INSERT INTO meta(key,value,updated_at) VALUES('pause.all',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify({ on: true, until: null }), now)
  const paused = parse(await tool(env, 'dy_life_home_awake').execute({ reason: '验收' }, exec))
  assert.equal(paused.ok, false)
  assert.equal(paused.status, 'SKIPPED')
  assert.equal(paused.code, 'PAUSED')

  env.api.db.prepare("UPDATE meta SET value=? WHERE key='pause.all'").run(JSON.stringify({ on: false, until: null }))
  env.api.cfg.dryRun = true
  const dry = parse(await tool(env, 'dy_life_home_awake').execute({}, exec))
  assert.equal(dry.code, 'DRY_RUN')

  const log = env.api.db.prepare("SELECT * FROM action_log WHERE event='home_awake' ORDER BY id DESC LIMIT 1").get()
  assert.ok(log)
  assert.ok(log.note.includes('trigger=manual'))
})

test('C3-工具 / dy_life_home_awake：并发第二次 IN_FLIGHT', async (t) => {
  let release
  const gate = new Promise((r) => {
    release = r
  })
  const { env, cleanup } = openHome({ followupImpl: () => gate })
  t.after(cleanup)
  // 先建好会话（ensureHome 不 followup），避免初始创建消耗 gate
  const created = await env.api.home.ensureHome(PERSONA)
  const exec = homeExec(created.sessionId)

  const p1 = tool(env, 'dy_life_home_awake').execute({}, exec)
  await new Promise((r) => setImmediate(r))
  const r2 = parse(await tool(env, 'dy_life_home_awake').execute({}, exec))
  release()
  const r1 = parse(await p1)
  assert.equal(r1.status, 'AWAKE')
  assert.equal(r2.code, 'IN_FLIGHT')
})

test('C3-工具 / owner-only：非主人/子智能体拒绝', async (t) => {
  const { env, cleanup } = openHome()
  t.after(cleanup)
  await env.api.home.awake({ personaId: PERSONA })
  const other = { agent: { session: { header: { id: 'other-session', cwd: '/tmp/other' } } } }
  const sub = { agent: { session: { header: { id: 'sub', cwd: env.api.home.cwd, parentSession: 'p1' } } } }
  for (const exec of [other, sub]) {
    const s = parse(await tool(env, 'dy_life_home_status').execute({}, exec))
    assert.equal(s.ok, false)
    const a = parse(await tool(env, 'dy_life_home_awake').execute({}, exec))
    assert.equal(a.ok, false)
  }
})

test('C3 / home 工具动作写入活动表（不是醒来）', async (t) => {
  const { env, cleanup } = openHome()
  t.after(cleanup)
  const first = await env.api.home.awake({ personaId: PERSONA })
  const sid = first.sessionId
  env.api.home.observeSessionEvent({ header: { id: sid } }, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: JSON.stringify({ path: '/tmp/a' }) } })
  env.api.home.observeSessionEvent({ header: { id: sid } }, { type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: 'call-1', isError: false } } })
  const rows = env.api.db.prepare("SELECT name,summary,status FROM home_activities WHERE self_id=? ORDER BY id DESC LIMIT 1").all(PERSONA)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'read_file')
  assert.equal(rows[0].status, 'done')
  assert.ok(rows[0].summary.includes('/tmp/a'))
})
