/** tick 独立开关 + 驱动力并入 home（16:26） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'
import { buildWakeCard, HOME_WAKE_PROMPT } from '../lib/run/home.js'

const PERSONA = 'self:test-tick'

function fakeAgents() {
  const calls = { create: [], resume: [], followup: [], get: [], dispose: [] }
  const h = () => ({ agent: { status: 'idle', async followup(m) { calls.followup.push(m); return { ok: true } }, dispose() { calls.dispose.push(1) } } })
  return { calls, get: (id) => (calls.get.push(id), null), create: (a) => (calls.create.push(a), h()), resume: (a) => (calls.resume.push(a), h()) }
}

function open({ tick = true, home = true } = {}) {
  const tmp = makeTempDir('autonomy-tick-')
  const homeDir = join(tmp.dir, 'home')
  const agents = fakeAgents()
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, tick: { enabled: tick }, dryRun: false, minTickGapMinutes: 0, allowedKinds: ['read_archive'], home: { enabled: home, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60 } },
    services: { ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }), agents, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } },
    clock: makeClock(),
  })
  return { env, agents, homeDir, cleanup: () => { env.cleanup(); tmp.cleanup() } }
}

test('tick.enabled=false：0 tick/0 action，home 仍能 awake', async (t) => {
  const ctx = open({ tick: false })
  t.after(ctx.cleanup)
  const r = await ctx.env.api.tick()
  assert.equal(r.code, 'TICK_DISABLED')
  assert.equal(ctx.env.api.db.prepare('SELECT COUNT(1) AS n FROM tick_runs').get().n, 0)
  assert.equal(ctx.env.api.db.prepare('SELECT COUNT(1) AS n FROM actions').get().n, 0)
  assert.equal(ctx.env.api.status().tickEnabled, false)
  const w = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(w.code, 'AWAKENED', 'tick 关了 home 不受影响')
})

test('tick.enabled=true：行为不变（能跑 tick）', async (t) => {
  const ctx = open({ tick: true })
  t.after(ctx.cleanup)
  const r = await ctx.env.api.tick()
  assert.notEqual(r.code, 'TICK_DISABLED')
  assert.equal(ctx.env.api.status().tickEnabled, true)
})

test('wake card：四条驱动力 + 目标/行动/反思字段', async (t) => {
  const ctx = open({ tick: false })
  t.after(ctx.cleanup)
  const now = ctx.env.clock.now()
  const db = ctx.env.api.db
  const ins = db.prepare('INSERT INTO drives(self_id,name,value,baseline,growth,updated_at) VALUES(?,?,?,?,?,?)')
  ins.run(PERSONA, 'curiosity', 0.8, 0.45, 0.05, now)
  ins.run(PERSONA, 'social', 0.5, 0.4, 0.04, now)
  ins.run(PERSONA, 'mastery', 0.6, 0.35, 0.03, now)
  ins.run(PERSONA, 'care', 0.7, 0.5, 0.02, now)
  db.prepare('INSERT INTO goals(id,self_id,title,note,source,priority,status,kind_hint,due_at,last_touched_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('g1', PERSONA, '收拾房间', null, 'self', 0.9, 'open', null, null, now, now, now)
  db.prepare('INSERT INTO actions(id,self_id,kind,status,risk,result_json,created_at,ended_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('a1', PERSONA, 'read_archive', 'done', 'low', JSON.stringify({ simulated: true }), now - 3600_000, now - 3600_000)
  db.prepare('INSERT INTO reflections(self_id,at,period,status,trigger,importance,window_start,window_end,evidence_json,text) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(PERSONA, now - 3600_000, 'threshold', 'pending', 'DAILY', 3, now - 7200_000, now - 3600_000, '[]', null)

  const card = buildWakeCard({ db, persona: { displayName: () => '汐', emotionState: () => ({ label: '平静', intensity: 0.2 }) }, cfg: ctx.env.api.cfg, personaId: PERSONA, now })
  for (const tag of ['【我】', '【目标】', '【最近行动】', '【反思】', '好奇', '社交', '精通', '照顾']) assert.ok(card.includes(tag), `缺 ${tag}`)
  assert.ok(card.length <= 500)
})

test('tick 关时醒来：drives 仍回归+增长并写回', async (t) => {
  const ctx = open({ tick: false })
  t.after(ctx.cleanup)
  const old = ctx.env.clock.now() - 6 * 3600_000
  const db = ctx.env.api.db
  const ins = db.prepare('INSERT INTO drives(self_id,name,value,baseline,growth,updated_at) VALUES(?,?,?,?,?,?)')
  for (const [name, value, base, growth] of [['curiosity', 0.9, 0.45, 0.05], ['social', 0.2, 0.4, 0.04], ['mastery', 0.35, 0.35, 0.03], ['care', 0.5, 0.5, 0.02]]) ins.run(PERSONA, name, value, base, growth, old)
  const before = db.prepare('SELECT value,updated_at FROM drives WHERE self_id=? AND name=?').get(PERSONA, 'curiosity')
  await ctx.env.api.home.awake({ personaId: PERSONA })
  const rows = db.prepare('SELECT name,value,updated_at FROM drives WHERE self_id=?').all(PERSONA)
  assert.equal(rows.length, 4)
  assert.ok(rows.every((r) => r.value >= 0 && r.value <= 1))
  assert.equal(rows[0].updated_at, ctx.env.clock.now(), '醒来时更新 updated_at')
  assert.notEqual(rows.find((r) => r.name === 'curiosity').value, before.value, '值应推进')
})

test('唤醒词仍 open-ended，不含任务/必须完成', () => {
  assert.ok(HOME_WAKE_PROMPT.includes('没有任务'))
  assert.ok(HOME_WAKE_PROMPT.includes('什么都不做也可以'))
  for (const bad of ['read_archive', 'write_diary', '你必须', '任务清单', '必须完成']) assert.equal(HOME_WAKE_PROMPT.includes(bad), false)
})
