/** B3b · 反思入口 + goalId + 档案轮转 + channel 字段 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'
import { kindStats } from '../lib/run/actions.js'

const PERSONA = 'self:test-b3b'

function open({ random = Math.random, files = 2 } = {}) {
  const tmp = makeTempDir('autonomy-b3b-')
  const archiveDir = join(tmp.dir, 'archive')
  const rawDir = join(tmp.dir, 'raw')
  const homeDir = join(tmp.dir, 'home')
  mkdirSync(join(archiveDir, '2026-11-04'), { recursive: true })
  for (let i = 0; i < files; i++) writeFileSync(join(archiveDir, '2026-11-04', `f${i}.md`), `内容 ${i}\n`)
  mkdirSync(rawDir, { recursive: true })
  mkdirSync(homeDir, { recursive: true })
  const env = startPlugin({
    dir: tmp.dir,
    random,
    cfg: { enabled: true, dryRun: true, minTickGapMinutes: 0, archiveDir, rawDir, stickerDirs: [], archiveRecentDays: 7, home: { enabled: true, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60 } },
    services: { ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }), agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } },
    clock: makeClock(),
  })
  const cleanup = () => { env.cleanup(); tmp.cleanup() }
  return { env, homeDir, cleanup }
}
const tool = (env, name) => env.registered.find((r) => r.name === name)
const exec = (ctx) => ({ agent: { session: { header: { id: 'home-1', cwd: ctx.homeDir } } } })
const parse = (r) => JSON.parse(r.detail)

test('B3b / dy_life_reflect：写入 done 并消费 pending + 审计', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const now = ctx.env.clock.now()
  ctx.env.api.db.prepare("INSERT INTO reflections(self_id,at,period,status,trigger,importance,window_start,window_end,evidence_json,text) VALUES(?,?,?,'pending','DAILY',3,?,?,'[]',NULL)")
    .run(PERSONA, now - 60_000, 'threshold', now - 120_000, now - 60_000)
  const r = parse(await tool(ctx.env, 'dy_life_reflect').execute({ text: '今天想明白了一件事。', goalId: 'g1' }, exec(ctx)))
  assert.equal(r.ok, true)
  const done = ctx.env.api.db.prepare("SELECT * FROM reflections WHERE status='done' ORDER BY id DESC LIMIT 1").get()
  assert.equal(done.text, '今天想明白了一件事。')
  assert.equal(done.period, 'manual')
  assert.equal(ctx.env.api.db.prepare("SELECT status FROM reflections WHERE status='consumed'").get().status, 'consumed')
  assert.equal(ctx.env.api.db.prepare("SELECT COUNT(1) AS n FROM action_log WHERE event='reflection'").get().n, 1)
})

test('B3b / dy_life_reflect：空文本拒绝', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const r = parse(await tool(ctx.env, 'dy_life_reflect').execute({ text: '   ' }, exec(ctx)))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'EMPTY_TEXT')
})

test('B3b / dy_life_reflect：pause 拒绝', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  ctx.env.api.db.prepare("INSERT INTO meta(key,value,updated_at) VALUES('pause.all',?,?)")
    .run(JSON.stringify({ on: true, until: null }), ctx.env.clock.now())
  const r = parse(await tool(ctx.env, 'dy_life_reflect').execute({ text: 'x' }, exec(ctx)))
  assert.equal(r.code, 'PAUSED')
})

test('B3b / dy_life_reflect：非 owner 拒绝', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const r = parse(await tool(ctx.env, 'dy_life_reflect').execute({ text: 'x' }, { agent: { session: { header: { id: 'x', cwd: '/tmp/other' } } } }))
  assert.equal(r.ok, false)
})

test('B3b / dy_life_reflect：长度截断 500', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const r = parse(await tool(ctx.env, 'dy_life_reflect').execute({ text: 'a'.repeat(800) }, exec(ctx)))
  assert.equal(r.ok, true)
  assert.equal(r.text.length, 500)
  assert.equal(ctx.env.api.db.prepare("SELECT LENGTH(text) AS n FROM reflections WHERE status='done' ORDER BY id DESC LIMIT 1").get().n, 500)
})

test('B3b / action goalId：open 目标写入 action.goal_id + status.goalId', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const now = ctx.env.clock.now()
  ctx.env.api.db.prepare('INSERT INTO goals(id,self_id,title,note,source,priority,status,kind_hint,due_at,last_touched_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('g1', PERSONA, '想读点东西', null, 'self', 0.8, 'open', 'read_archive', null, now, now, now)
  const r = parse(await tool(ctx.env, 'dy_life_action_run').execute({ kind: 'read_archive', goalId: 'g1' }, exec(ctx)))
  assert.equal(r.ok, true)
  const a = ctx.env.api.db.prepare('SELECT goal_id FROM actions ORDER BY created_at DESC LIMIT 1').get()
  assert.equal(a.goal_id, 'g1')
  assert.equal(ctx.env.api.status().recentActions[0].goalId, 'g1')
})

test('B3b / action goalId：不存在/已关闭拒绝', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const now = ctx.env.clock.now()
  ctx.env.api.db.prepare('INSERT INTO goals(id,self_id,title,note,source,priority,status,kind_hint,due_at,last_touched_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('g2', PERSONA, '已结束', null, 'self', 0.5, 'done', null, null, now, now, now)
  for (const [goalId, code] of [['nope', 'GOAL_NOT_FOUND'], ['g2', 'GOAL_CLOSED']]) {
    const r = parse(await tool(ctx.env, 'dy_life_action_run').execute({ kind: 'read_archive', goalId }, exec(ctx)))
    assert.equal(r.ok, false)
    assert.equal(r.code, code)
  }
})

test('B3b / action 无 goalId 仍可运行', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const r = parse(await tool(ctx.env, 'dy_life_action_run').execute({ kind: 'read_archive' }, exec(ctx)))
  assert.equal(r.ok, true)
  assert.equal(ctx.env.api.db.prepare('SELECT goal_id FROM actions ORDER BY created_at DESC LIMIT 1').get().goal_id, null)
})

test('B3b / read_archive 轮转：最近 N 天随机挑，多次出现 ≥2 种', async (t) => {
  let i = 0
  const seq = [0, 0.99, 0.4, 0.7]
  const ctx = open({ random: () => seq[i++ % seq.length], files: 3 })
  t.after(ctx.cleanup)
  const seen = new Set()
  for (let k = 0; k < 4; k++) {
    const r = parse(await tool(ctx.env, 'dy_life_action_run').execute({ kind: 'read_archive' }, exec(ctx)))
    assert.equal(r.ok, true)
    seen.add(r.evidence[0].ref)
    ctx.env.clock.advance(11 * 60_000) // 过同 kind 10 分钟防刷屏
  }
  assert.ok(seen.size >= 2, `至少要出现 2 种，实际 ${seen.size}`)
})

test('B3b / channel 字段与统计口径', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const r = parse(await tool(ctx.env, 'dy_life_action_run').execute({ kind: 'read_archive', channel: 'qq' }, exec(ctx)))
  assert.equal(r.ok, true)
  const a = ctx.env.api.db.prepare('SELECT decision_json FROM actions ORDER BY created_at DESC LIMIT 1').get()
  assert.equal(JSON.parse(a.decision_json).channel, 'qq')
  const stats = kindStats(ctx.env.api.db, PERSONA, 'read_archive', { now: ctx.env.clock.now() })
  assert.equal(stats.channelsToday.qq, 1)
})
