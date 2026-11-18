/** P0 · async agents + 消息 content 数组 + 自愈修 content */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'

const PERSONA = 'self:test-p0'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function agents({ async = false, failCreate = false, resumeMode = 'ok' } = {}) {
  const calls = { create: [], resume: [], followup: [], get: [], dispose: [] }
  const handle = () => ({
    agent: {
      status: 'idle',
      async followup(m) { calls.followup.push(m); return { ok: true } },
      dispose() { calls.dispose.push(1) },
    },
  })
  const wrap = (fn) => (async ? Promise.resolve().then(fn) : fn())
  const out = {
    calls,
    failCreate,
    get: (id) => (calls.get.push(id), null),
    create: (a) => wrap(() => { calls.create.push(a); if (out.failCreate) throw new Error('create boom'); return handle() }),
    resume: (a) => wrap(() => {
      calls.resume.push(a)
      if (resumeMode === 'alwaysFail') throw new Error('validation failed')
      if (resumeMode === 'failOnce') { resumeMode = 'ok'; throw new Error('validation failed') }
      return handle()
    }),
  }
  return out
}

function frames(path, header, events) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.concat([
    zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`)),
    zstdCompressSync(Buffer.from(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`)),
  ]))
}

function eventsOf(path) {
  const b = readFileSync(path)
  const m = [0x28, 0xb5, 0x2f, 0xfd]
  const off = []
  for (let i = 0; i <= b.length - 4; i++) if (b[i] === m[0] && b[i + 1] === m[1] && b[i + 2] === m[2] && b[i + 3] === m[3]) off.push(i)
  const texts = []
  for (let k = 0; k < off.length; k++) { try { texts.push(zstdDecompressSync(b.subarray(off[k], off[k + 1] ?? b.length)).toString('utf8')) } catch {} }
  return texts.flatMap((t) => t.split('\n')).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

function open(opts = {}) {
  const tmp = makeTempDir('autonomy-p0-')
  const homeDir = join(tmp.dir, 'home')
  const ag = agents(opts)
  const persistence = { path: null, locate: () => (persistence.path ? { path: persistence.path } : null) }
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: false, minTickGapMinutes: 0, home: { enabled: true, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60 } },
    services: { ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }), agents: ag, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) }, sessionPersistence: persistence },
    clock: makeClock(),
  })
  const cleanup = () => { env.cleanup(); tmp.cleanup() }
  return { env, ag, persistence, homeDir, cleanup }
}

test('P0 / async agents：create/resume 返回 Promise 也能成功', async (t) => {
  const ctx = open({ async: true })
  t.after(ctx.cleanup)
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.code, 'AWAKENED')
  assert.equal(ctx.ag.calls.create.length, 1)
  ctx.env.api.home.dispose()
  const r2 = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r2.code, 'AWAKENED')
  assert.equal(ctx.ag.calls.resume.length, 1)
})

test('P0 / 同步 fake agents 仍兼容', async (t) => {
  const ctx = open({ async: false })
  t.after(ctx.cleanup)
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.code, 'AWAKENED')
  assert.equal(ctx.ag.calls.create.length, 1)
})

test('P0 / wake 消息 content 必须是数组（不允许字符串）', async (t) => {
  const ctx = open({ async: false })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  const msg = ctx.ag.calls.followup[0]
  assert.match(msg.id, UUID)
  assert.ok(Array.isArray(msg.content), 'content 必须是数组')
  assert.equal(msg.content[0].type, 'text')
})

test('P0 / 修复字符串 content → 数组，backup 存在', async (t) => {
  const ctx = open({ async: true, resumeMode: 'failOnce' })
  t.after(ctx.cleanup)
  const first = await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.env.api.home.dispose()
  ctx.persistence.path = join(ctx.homeDir, 'sessions', first.sessionId, 'session.v4.jsonl.zstd')
  frames(ctx.persistence.path, { type: 'header', version: 4 }, [
    { type: 'user/message', data: { id: randomUUID(), role: 'user', content: '旧话是字符串' } },
    { type: 'assistant/message', data: { turn: 1, step: 0, stream: [], message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: '回答也是字符串' } } },
  ])
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.code, 'AWAKENED')
  assert.equal(r.repaired, true)
  const evs = eventsOf(ctx.persistence.path)
  for (const e of evs) {
    if (!e.type.endsWith('/message')) continue
    const c = e.type === 'assistant/message' ? e.data?.message?.content : e.data?.content
    assert.ok(Array.isArray(c), `${e.type} content 必须是数组`)
  }
  const heal = JSON.parse(ctx.env.api.db.prepare("SELECT value FROM meta WHERE key='home.lastHeal'").get().value)
  assert.ok(existsSync(heal.backup))
})

test('P0 / 修不了（坏 header）→ 新建接管，旧档案不删', async (t) => {
  const ctx = open({ async: true, resumeMode: 'alwaysFail' })
  t.after(ctx.cleanup)
  const first = await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.env.api.home.dispose()
  ctx.persistence.path = join(ctx.homeDir, 'sessions', first.sessionId, 'session.v4.jsonl.zstd')
  mkdirSync(dirname(ctx.persistence.path), { recursive: true })
  writeFileSync(ctx.persistence.path, Buffer.from('not a zstd archive'))
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.code, 'AWAKENED')
  assert.equal(r.healed, true)
  assert.ok(existsSync(ctx.persistence.path), '旧档案不能删')
})

test('P0 / 自愈 create 失败 → HOME_HEAL_FAILED（带 error）', async (t) => {
  const ctx = open({ async: true, resumeMode: 'alwaysFail' })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.env.api.home.dispose()
  ctx.ag.failCreate = true
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.code, 'HOME_HEAL_FAILED')
  const heal = JSON.parse(ctx.env.api.db.prepare("SELECT value FROM meta WHERE key='home.lastHeal'").get().value)
  assert.equal(heal.ok, false)
  assert.equal(heal.code, 'HOME_HEAL_FAILED')
  assert.ok(heal.error)
})

test('P0 / 自愈 seed 消息 content 也是数组', async (t) => {
  const ctx = open({ async: true, resumeMode: 'alwaysFail' })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.env.api.home.dispose()
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.healed, true)
  for (const m of ctx.ag.calls.followup) assert.ok(Array.isArray(m.content))
})

test('P0 / 所有投递消息无字符串 content', async (t) => {
  const ctx = open({ async: true })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  for (const m of ctx.ag.calls.followup) {
    assert.ok(Array.isArray(m.content))
    assert.equal(typeof m.content, 'object')
  }
})

async function withArchive(events) {
  const ctx = open({ async: true, resumeMode: 'failOnce' })
  const first = await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.env.api.home.dispose()
  const path = join(ctx.homeDir, 'sessions', first.sessionId, 'session.v4.jsonl.zstd')
  ctx.persistence.path = path
  frames(path, { type: 'header', version: 4 }, events)
  return { ctx, path }
}

test('P0 / 修档自检：assistant content 数组 → 通过', async (t) => {
  const { ctx } = await withArchive([
    { type: 'assistant/message', data: { turn: 1, step: 0, stream: [], message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: '数组正文' }] } } },
  ])
  t.after(ctx.cleanup)
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.repaired, true, 'assistant 数组 content 不应误报自检失败')
})

test('P0 / 修档：assistant content 字符串 → 包数组后通过', async (t) => {
  const { ctx, path } = await withArchive([
    { type: 'assistant/message', data: { turn: 1, step: 0, stream: [], message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: '字符串正文' } } },
  ])
  t.after(ctx.cleanup)
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.repaired, true)
  const evs = eventsOf(path)
  const a = evs.find((e) => e.type === 'assistant/message')
  assert.ok(Array.isArray(a.data.message.content))
  assert.equal(a.data.message.content[0].text, '字符串正文')
})

test('P0 / 修档：user content 字符串 → 仍通过', async (t) => {
  const { ctx } = await withArchive([
    { type: 'user/message', data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: '用户字符串' } },
  ])
  t.after(ctx.cleanup)
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.repaired, true)
})

test('P0 / 修档自检：assistant 无 content 且无 message → 仍失败并转自愈', async (t) => {
  const { ctx, path } = await withArchive([
    { type: 'assistant/message', data: { turn: 1, step: 0, stream: [] } },
  ])
  t.after(ctx.cleanup)
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.repaired, false, '真正坏的 assistant 不能被误放行')
  assert.equal(r.healed, true)
  assert.ok(existsSync(path), '原档案不删')
})
