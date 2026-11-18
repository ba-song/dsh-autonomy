/** 回合卡死守护 15min + 目标提示 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'
import { buildWakeCard } from '../lib/run/home.js'

const PERSONA = 'self:test-stuck'

function open() {
  const tmp = makeTempDir('autonomy-stuck-')
  const homeDir = join(tmp.dir, 'home')
  const calls = { create: [], resume: [], followup: [], get: [], dispose: [] }
  const h = () => ({ agent: { status: 'idle', async followup(m) { calls.followup.push(m); return { ok: true } }, dispose() { calls.dispose.push(1) } } })
  const agents = { calls, get: (id) => (calls.get.push(id), null), create: (a) => (calls.create.push(a), h()), resume: (a) => (calls.resume.push(a), h()) }
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: false, minTickGapMinutes: 0, home: { enabled: true, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60, deliverLog: join(tmp.dir, 'deliver.log') } },
    services: { ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }), agents, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } },
    clock: makeClock(),
  })
  return { env, calls, homeDir, cleanup: () => { env.cleanup(); tmp.cleanup() } }
}

test('stuck / 15 分钟无 turn/end：status 标记且 awake 被拒', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const home = await ctx.env.api.home.awake({ personaId: PERSONA })
  const sid = home.sessionId
  ctx.env.api.home.observeSessionEvent({ header: { id: sid } }, { type: 'turn/start', data: { turn: 7 } })
  ctx.env.clock.advance(16 * 60_000)
  const st = ctx.env.api.home.status(PERSONA)
  assert.equal(st.stuckTurn.turn, 7)
  assert.equal(st.stuckTurn.active, true)
  assert.ok(st.stuckTurn.minutes >= 15)
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'STUCK_TURN')
})

test('stuck / 未到 15 分钟：不拦、不标 stuck', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const home = await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.env.api.home.observeSessionEvent({ header: { id: home.sessionId } }, { type: 'turn/start', data: { turn: 3 } })
  ctx.env.clock.advance(14 * 60_000)
  assert.equal(ctx.env.api.home.status(PERSONA).stuckTurn, null)
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.code, 'AWAKENED')
})

test('stuck / turn/end 后自然恢复；card 目标文案', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const home = await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.env.api.home.observeSessionEvent({ header: { id: home.sessionId } }, { type: 'turn/start', data: { turn: 4 } })
  ctx.env.clock.advance(16 * 60_000)
  assert.equal((await ctx.env.api.home.awake({ personaId: PERSONA })).code, 'STUCK_TURN')
  ctx.env.api.home.observeSessionEvent({ header: { id: home.sessionId } }, { type: 'turn/end', data: { ok: true } })
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.code, 'AWAKENED')

  const none = buildWakeCard({ db: ctx.env.api.db, persona: mockPersona({ selfId: PERSONA }), cfg: ctx.env.api.cfg, personaId: PERSONA, now: ctx.env.clock.now() })
  assert.ok(none.includes('【目标】暂无（可以给自己定一个）'))
  ctx.env.api.db.prepare('INSERT INTO goals(id,self_id,title,note,source,priority,status,kind_hint,due_at,last_touched_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('g1', PERSONA, '整理房间', null, 'self', 0.9, 'open', null, null, ctx.env.clock.now(), ctx.env.clock.now(), ctx.env.clock.now())
  const card = buildWakeCard({ db: ctx.env.api.db, persona: mockPersona({ selfId: PERSONA }), cfg: ctx.env.api.cfg, personaId: PERSONA, now: ctx.env.clock.now() })
  assert.ok(card.includes('【目标】整理房间'))
  assert.equal(card.includes('暂无（可以给自己定一个）'), false)
})
