/** 旧房间门牌 + 最近想做 + 只读 suggestion */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'
import { buildWakeCard } from '../lib/run/home.js'

const PERSONA = 'self:test-rooms'

function writeArchive(path, msgs) {
  mkdirSync(dirname(path), { recursive: true })
  const header = JSON.stringify({ type: 'header', version: 4 })
  const lines = msgs.map((m, i) => JSON.stringify({
    type: m.role === 'user' ? 'user/message' : 'assistant/message',
    seq: i,
    time: 1000 + i,
    surfaceOp: 'append',
    data: m.role === 'user'
      ? { id: `u${i}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: m.text }] }
      : { turn: i, step: 0, stream: [], message: { id: `a${i}`, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: m.text }] } },
  })).join('\n')
  writeFileSync(path, Buffer.concat([zstdCompressSync(Buffer.from(`${header}\n`)), zstdCompressSync(Buffer.from(`${lines}\n`))]))
}

function open() {
  const tmp = makeTempDir('autonomy-rooms-')
  const homeDir = join(tmp.dir, 'home')
  const paths = {}
  const persistence = { locate: ({ id }) => (paths[id] ? { path: paths[id] } : null) }
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: true, minTickGapMinutes: 0, home: { enabled: true, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60, deliverLog: join(tmp.dir, 'deliver.log') } },
    services: { ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }), agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) }, sessionPersistence: persistence },
    clock: makeClock(),
  })
  return { env, paths, homeDir, cleanup: () => { env.cleanup(); tmp.cleanup() } }
}

const addRoom = (ctx, id, msgs, at = ctx.env.clock.now()) => {
  try { ctx.env.api.home.listRooms(1) } catch {}
  ctx.env.api.db.prepare('INSERT INTO home_rooms(persona_id,session_id,cwd,created_at,rotated_at,source) VALUES(?,?,?,?,?,?)')
    .run(PERSONA, id, ctx.homeDir, at, null, 'rotate')
  ctx.paths[id] = join(ctx.homeDir, 'sessions', id, 'session.v4.jsonl.zstd')
  writeArchive(ctx.paths[id], msgs)
}

const tool = (env, name) => env.registered.find((r) => r.name === name)
const owner = (ctx) => ({ agent: { session: { header: { id: 'home-1', cwd: ctx.homeDir } } } })
const parse = (r) => JSON.parse(r.detail)

test('rooms / list：最近房间 + 首末摘要', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  addRoom(ctx, 'aaaaaaaa-1111-4111-8111-111111111111', [{ role: 'user', text: '旧房间第一条' }, { role: 'assistant', text: '旧房间末条' }], ctx.env.clock.now() - 1000)
  addRoom(ctx, 'bbbbbbbb-2222-4222-8222-222222222222', [{ role: 'user', text: '新房间' }], ctx.env.clock.now())
  const r = parse(await tool(ctx.env, 'dy_life_room_list').execute({}, owner(ctx)))
  assert.equal(r.ok, true)
  assert.equal(r.rooms.length, 2)
  assert.equal(r.rooms[0].shortId, 'bbbbbbbb')
  assert.equal(r.rooms[0].first, '新房间')
  assert.equal(r.rooms[1].first, '旧房间第一条')
  assert.equal(r.rooms[1].last, '旧房间末条')
})

test('rooms / read：只读最近 N 条且每条截断 200', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  addRoom(ctx, 'cccccccc-3333-4333-8333-333333333333', [{ role: 'user', text: 'x'.repeat(300) }, { role: 'assistant', text: '末条' }])
  const r = parse(await tool(ctx.env, 'dy_life_room_read').execute({ sessionId: 'cccccccc-3333-4333-8333-333333333333', limit: 1 }, owner(ctx)))
  assert.equal(r.ok, true)
  assert.equal(r.messages.length, 1)
  assert.equal(r.messages[0].text, '末条')
  const r2 = parse(await tool(ctx.env, 'dy_life_room_read').execute({ sessionId: 'cccccccc-3333-4333-8333-333333333333', limit: 2 }, owner(ctx)))
  assert.equal(r2.messages[0].text.length, 200)
})

test('rooms / 非法 session 拒绝 + owner 门禁', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const bad = parse(await tool(ctx.env, 'dy_life_room_read').execute({ sessionId: 'nope' }, owner(ctx)))
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'ROOM_NOT_FOUND')
  const denied = parse(await tool(ctx.env, 'dy_life_room_read').execute({ sessionId: 'nope' }, { agent: { session: { header: { id: 'x', cwd: '/tmp/other' } } } }))
  assert.equal(denied.ok, false)
})

test('card / 【最近想做】含反思与最高驱动；空数据显示暂无', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const now = ctx.env.clock.now()
  const db = ctx.env.api.db
  const insD = db.prepare('INSERT INTO drives(self_id,name,value,baseline,growth,updated_at) VALUES(?,?,?,?,?,?)')
  insD.run(PERSONA, 'curiosity', 0.8, 0.45, 0.05, now)
  insD.run(PERSONA, 'social', 0.3, 0.4, 0.04, now)
  insD.run(PERSONA, 'mastery', 0.2, 0.35, 0.03, now)
  insD.run(PERSONA, 'care', 0.4, 0.5, 0.02, now)
  db.prepare("INSERT INTO reflections(self_id,at,period,status,trigger,importance,window_start,window_end,evidence_json,text) VALUES(?,?,?,'done','MANUAL',1,?,?,'[]',?)")
    .run(PERSONA, now, 'manual', now, now, '想读点旧档案')
  const card = buildWakeCard({ db, persona: mockPersona({ selfId: PERSONA }), cfg: ctx.env.api.cfg, personaId: PERSONA, now })
  assert.ok(card.includes('【最近想做】想读点旧档案'))
  assert.ok(card.includes('最高：好奇'))
  const empty = buildWakeCard({ db: ctx.env.api.db, persona: mockPersona({ selfId: 'self:none' }), cfg: ctx.env.api.cfg, personaId: 'self:none', now })
  assert.ok(empty.includes('【最近想做】暂无'))
})

test('status / suggestion 字段存在，且不触发行动', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const before = ctx.env.api.db.prepare('SELECT COUNT(1) AS n FROM actions').get().n
  const s = ctx.env.api.status()
  assert.equal(typeof s.suggestion, 'string')
  assert.ok(s.suggestion.length > 0)
  const after = ctx.env.api.db.prepare('SELECT COUNT(1) AS n FROM actions').get().n
  assert.equal(after, before)
})
