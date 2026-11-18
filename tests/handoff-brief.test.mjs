/** home 交接：结构化简报 + 最近 50 条原话（不替换） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'

const PERSONA = 'self:test-brief'

function writeArchive(path, n = 60, extra = []) {
  mkdirSync(dirname(path), { recursive: true })
  const events = []
  for (let i = 0; i < n; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant'
    events.push(role === 'user'
      ? { type: 'user/message', seq: i, time: 1000 + i, surfaceOp: 'append', data: { id: `u${i}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `原话-${i}` }] } }
      : { type: 'assistant/message', seq: i, time: 1000 + i, surfaceOp: 'append', data: { turn: i, step: 0, stream: [], message: { id: `a${i}`, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: `回答-${i}` }] } } })
  }
  events.push(...extra)
  writeFileSync(path, Buffer.concat([
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'header', version: 4 })}\n`)),
    zstdCompressSync(Buffer.from(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`)),
  ]))
}

function open({ brief = () => '这是结构化简报', failBrief = false, agents = null } = {}) {
  const tmp = makeTempDir('autonomy-brief-')
  const homeDir = join(tmp.dir, 'home')
  const calls = { create: [], resume: [], followup: [] }
  let resumeMode = 'ok'
  const h = () => ({ agent: { status: 'idle', async followup(m) { calls.followup.push(m); return { ok: true } }, dispose() {} } })
  const fakeAgents = agents ?? {
    calls,
    get: () => null,
    create: (a) => (calls.create.push(a), h()),
    resume: (a) => { calls.resume.push(a); if (resumeMode === 'failOnce' || resumeMode === 'alwaysFail') { throw new Error('resume failed') } return h() },
  }
  const memory = mockMemory()
  memory.handoffBrief = (input) => {
    if (failBrief) throw new Error('brief down')
    const r = typeof brief === 'function' ? brief(input) : brief
    return r
  }
  const persistence = { path: null, locate: () => (persistence.path ? { path: persistence.path } : null) }
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: false, home: { enabled: true, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60, logPath: join(tmp.dir, 'a.log'), deliverLog: join(tmp.dir, 'd.log') } },
    services: { ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory }), agents: fakeAgents, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) }, sessionPersistence: persistence },
    clock: makeClock(),
  })
  return { env, calls: fakeAgents.calls ?? calls, memory, persistence, homeDir, tmp, setResumeFail: () => { resumeMode = 'alwaysFail' }, cleanup: () => { env.cleanup(); tmp.cleanup() } }
}

function handoffText(ctx, id) {
  const row = ctx.env.api.db.prepare('SELECT value FROM meta WHERE key=?').get(`home.handoff.${id}`)
  if (!row) return ''
  try { return JSON.parse(row.value).text || '' } catch { return '' }
}

async function prepare(ctx) {
  const first = await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.env.api.home.dispose()
  ctx.persistence.path = join(ctx.homeDir, 'sessions', first.sessionId, 'session.v4.jsonl.zstd')
  writeArchive(ctx.persistence.path, 60)
  return first
}

test('brief / rotate 交接文本：说明+简报+50 条原话，不再传 seed 事件', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  await prepare(ctx)
  const r = await ctx.env.api.home.rotateHome({ personaId: PERSONA, force: true })
  assert.equal(r.code, 'ROTATED')
  assert.equal(ctx.calls.create.at(-1).seed, undefined)
  const text = handoffText(ctx, r.sessionId)
  assert.ok(text.includes('这是结构化简报'))
  assert.equal(text.split('\n').filter((l) => l.startsWith('- ')).length, 50)
  assert.ok(text.includes('原话-10'))
  assert.ok(text.includes('回答-59'))
  const md = readFileSync(r.handoffPath, 'utf8')
  assert.ok(md.includes('## 结构化简报'))
  assert.ok(md.indexOf('## 结构化简报') < md.indexOf('## 最近原话'))
})

test('brief / 空简报省略；抛错不阻断 50 条', async (t) => {
  const ctx = open({ brief: () => '' })
  t.after(ctx.cleanup)
  await prepare(ctx)
  const r = await ctx.env.api.home.rotateHome({ personaId: PERSONA, force: true })
  const text = handoffText(ctx, r.sessionId)
  assert.ok(!text.includes('这是结构化简报'))
  assert.equal(text.split('\n').filter((l) => l.startsWith('- ')).length, 50)

  const ctx2 = open({ failBrief: true })
  t.after(ctx2.cleanup)
  await prepare(ctx2)
  const r2 = await ctx2.env.api.home.rotateHome({ personaId: PERSONA, force: true })
  assert.equal(r2.code, 'ROTATED')
  assert.equal(handoffText(ctx2, r2.sessionId).split('\n').filter((l) => l.startsWith('- ')).length, 50)
})

test('brief / 过滤记忆注入与时间快照，真实 50 条不被顶掉', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const first = await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.env.api.home.dispose()
  ctx.persistence.path = join(ctx.homeDir, 'sessions', first.sessionId, 'session.v4.jsonl.zstd')
  const notices = []
  for (let i = 0; i < 20; i++) {
    notices.push({ type: 'user/message', seq: 1000 + i, time: 5000 + i, surfaceOp: 'append', data: { id: `n${i}`, role: 'user', source: { kind: 'plugin:dy-memory' }, content: [{ type: 'text', text: `【记忆·本轮相关】注入-${i}` }] } })
    notices.push({ type: 'user/message', seq: 2000 + i, time: 6000 + i, surfaceOp: 'append', data: { id: `t${i}`, role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: `Time sampled while preparing turn ${i}` }] } })
  }
  writeArchive(ctx.persistence.path, 60, notices)
  const r = await ctx.env.api.home.rotateHome({ personaId: PERSONA, force: true })
  const text = handoffText(ctx, r.sessionId)
  assert.equal(text.split('\n').filter((l) => l.startsWith('- ')).length, 50)
  assert.ok(!text.includes('【记忆·本轮相关】'))
  assert.ok(!text.includes('Time sampled while preparing'))
  assert.ok(text.includes('原话-10'))
})

test('brief / heal 交接写进 meta，不传 seed 事件', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const first = await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.env.api.home.dispose()
  ctx.persistence.path = join(ctx.homeDir, 'sessions', first.sessionId, 'session.v4.jsonl.zstd')
  writeArchive(ctx.persistence.path, 60)
  ctx.setResumeFail()
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.healed, true)
  const created = ctx.calls.create.at(-1)
  assert.equal(created.seed, undefined)
  assert.ok(String(created.meta.seedText).includes('简报：'))
  const text = handoffText(ctx, r.sessionId)
  assert.ok(text.includes('这是结构化简报'))
  assert.equal(text.split('\n').filter((l) => l.startsWith('- ')).length, 50)
})
