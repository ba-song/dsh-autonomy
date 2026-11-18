/** 2026-11-12：轮换交接不再用构造器 seed，改为 systemPrompt 交接上下文（meta 留档） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'

const PERSONA = 'self:test-handoff'
const NOTE = '以下是你上一个会话的记录，不是现在发生的事'

function fakeAgents() {
  const calls = { create: [], resume: [], followup: [], inject: [], get: [], dispose: [] }
  const logs = new Map()
  const logOf = (id) => {
    if (!logs.has(id)) logs.set(id, [])
    return logs.get(id)
  }
  const handle = (sessionId) => ({
    agent: {
      status: 'idle',
      session: { log: logOf(sessionId) },
      async followup(m) { calls.followup.push(m); logOf(sessionId).push({ type: 'user/message', data: m }); return { ok: true } },
      inject(m) { calls.inject.push(m); logOf(sessionId).push({ type: 'user/message', data: m }) },
      dispose() { calls.dispose.push(1) },
    },
  })
  const sessionOf = (a) => a?.sessionId ?? a?.resumeSessionId ?? 'unknown'
  return { calls, logs, create: (a) => (calls.create.push(a), handle(sessionOf(a))), get: () => null, resume: (a) => (calls.resume.push(a), handle(sessionOf(a))) }
}
function writeArchive(path, events) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.concat([
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'header', version: 4 })}\n`)),
    zstdCompressSync(Buffer.from(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`)),
  ]))
}
function mkEvents(n, lastRole = 'user') {
  const out = []
  for (let i = 0; i < n; i++) {
    const role = i === n - 1 ? lastRole : i % 2 === 0 ? 'user' : 'assistant'
    out.push(role === 'user'
      ? { type: 'user/message', seq: i, time: 1000 + i, surfaceOp: 'append', data: { id: `u${i}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `用户消息-${i}` }] } }
      : { type: 'assistant/message', seq: i, time: 1000 + i, surfaceOp: 'append', data: { turn: i, step: 0, stream: [], message: { id: `a${i}`, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: `助手回复-${i}` }] } } })
  }
  return out
}
function open() {
  const tmp = makeTempDir('autonomy-h-')
  const homeDir = join(tmp.dir, 'home')
  const agents = fakeAgents()
  const persistence = { path: null, locate: () => (persistence.path ? { path: persistence.path } : null) }
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: false, home: { enabled: true, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60, contextLimit: 650_000, rotateRatio: 0.62 } },
    services: { ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }), agents, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) }, sessionPersistence: persistence },
    clock: makeClock(),
  })
  return { env, agents, persistence, homeDir, cleanup: () => { env.cleanup(); tmp.cleanup() } }
}
async function prepare(ctx, events) {
  const first = await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.env.api.home.dispose()
  ctx.persistence.path = join(ctx.homeDir, 'sessions', first.sessionId, 'session.v4.jsonl.zstd')
  if (events) writeArchive(ctx.persistence.path, events)
  ctx.env.api.db.prepare('UPDATE home_sessions SET prompt_tokens=?, context_window=? WHERE home_session_id=?').run(70_000, 100_000, first.sessionId)
  return first
}
function handoffText(ctx, id) {
  const row = ctx.env.api.db.prepare('SELECT value FROM meta WHERE key=?').get(`home.handoff.${id}`)
  if (!row) return ''
  try { return JSON.parse(row.value).text || '' } catch { return '' }
}

test('rotate / 不再向 create 传 seed 事件', async (t) => {
  const ctx = open(); t.after(ctx.cleanup)
  await prepare(ctx, mkEvents(60))
  const r = await ctx.env.api.home.rotateHome({ personaId: PERSONA })
  assert.equal(r.code, 'ROTATED')
  assert.equal(ctx.agents.calls.create.at(-1).seed, undefined, 'create 不能再带 seed')
  assert.ok(r.handoffChars > 0)
})

test('rotate / 交接文本含说明、50 条原话（最近优先截断）', async (t) => {
  const ctx = open(); t.after(ctx.cleanup)
  await prepare(ctx, mkEvents(60))
  const r = await ctx.env.api.home.rotateHome({ personaId: PERSONA })
  const text = handoffText(ctx, r.sessionId)
  assert.ok(text.includes(NOTE))
  assert.ok(text.includes('用户消息-10'), '最近 50 条应从第 10 条起')
  assert.ok(text.includes('用户消息-59'), 'TAIL='+text.slice(-400))
  console.log('TAIL:', text.slice(-300)); console.log('LINES:', text.split('\n').filter((l) => l.startsWith('- ')).length)
  assert.equal(text.split('\n').filter((l) => l.startsWith('- ')).length, 50)
})

test('rotate / 旧档案不可用时仍能建新家，交接降级为空', async (t) => {
  const ctx = open(); t.after(ctx.cleanup)
  await prepare(ctx, null)
  ctx.persistence.path = null
  const r = await ctx.env.api.home.rotateHome({ personaId: PERSONA })
  assert.equal(r.code, 'ROTATED')
  const text = handoffText(ctx, r.sessionId)
  assert.ok(text.includes(NOTE))
  assert.equal(text.split('\n').filter((l) => l.startsWith('- ')).length, 0, '没有档案时不应有原话行')
})

test('rotate / 交接消息用 v4 合法 source（不是旧 plugin 包装）', async (t) => {
  const ctx = open(); t.after(ctx.cleanup)
  await prepare(ctx, mkEvents(60))
  const r = await ctx.env.api.home.rotateHome({ personaId: PERSONA })
  assert.equal(r.code, 'ROTATED')
  const injected = ctx.agents.calls.inject.at(-1)
  assert.ok(injected, '轮换应调用 agent.inject 注入交接')
  assert.equal(injected.source?.kind, 'handoff-note', 'source.kind 必须是自有类型，不能是旧 V3 的 plugin')
  assert.notEqual(injected.source?.kind, 'plugin')
  assert.ok(Array.isArray(injected.content) && injected.content[0]?.text?.includes(NOTE))
})

test('resume / 缺交接的会话会把留档交接补注入一次，且不重复', async (t) => {
  const ctx = open(); t.after(ctx.cleanup)
  await prepare(ctx, mkEvents(60))
  const r = await ctx.env.api.home.rotateHome({ personaId: PERSONA })
  assert.equal(r.code, 'ROTATED')
  const before = ctx.agents.calls.inject.length
  // 模拟宿主重启 + 旧 bug 现场：交接没落盘，房间里只有后来的一两句话
  ctx.agents.logs.set(r.sessionId, [{ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '[QQ] 笨鱼' }] } }])
  ctx.env.api.home.dispose()
  ctx.persistence.path = join(ctx.homeDir, 'sessions', r.sessionId, 'session.v4.jsonl.zstd')
  const again = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(again.ok, true, JSON.stringify(again))
  assert.equal(ctx.agents.calls.inject.length, before + 1, '缺交接的会话应在 resume 时补注入一次')
  const recovered = ctx.env.api.db.prepare('SELECT value FROM meta WHERE key=?').get(`home.handoff.${r.sessionId}.recovered`)
  assert.ok(recovered, '应记录 handoff_recover meta')
  assert.equal(JSON.parse(recovered.value).ok, true)
  // 第二次 resume：日志里已经有交接，不再重复注入
  ctx.env.api.home.dispose()
  await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(ctx.agents.calls.inject.length, before + 1, '已有交接后不得重复注入')
})
