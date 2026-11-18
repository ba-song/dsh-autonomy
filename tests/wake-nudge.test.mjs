/** 唤醒 nudge：驱动力建议，只提示不执行 + 审计 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'
import { buildWakeNudge, createHomeWakeLoop } from '../lib/run/home.js'

const PERSONA = 'self:test-nudge'

function seed(db, values) {
  const st = db.prepare('INSERT INTO drives(self_id,name,value,baseline,growth,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(self_id,name) DO UPDATE SET value=excluded.value')
  const now = Date.now()
  for (const [name, value] of Object.entries(values)) st.run(PERSONA, name, value, 0.4, 0.03, now)
}

function open() {
  const tmp = makeTempDir('autonomy-nudge-')
  const homeDir = join(tmp.dir, 'home')
  const calls = { followup: [] }
  const h = () => ({ agent: { status: 'idle', async followup(m) { calls.followup.push(m); return { ok: true } }, dispose() {} } })
  const agents = { get: () => null, create: () => h(), resume: () => h() }
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: false, minTickGapMinutes: 0, home: { enabled: true, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60, logPath: join(tmp.dir, 'a.log'), deliverLog: join(tmp.dir, 'd.log') } },
    services: { ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }), agents, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } },
    clock: makeClock(),
  })
  return { env, calls, cleanup: () => { env.cleanup(); tmp.cleanup() } }
}

test('nudge / 高好奇 → practice', (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  seed(ctx.env.api.db, { curiosity: 0.85, social: 0.2, mastery: 0.2, care: 0.2 })
  const n = buildWakeNudge({ db: ctx.env.api.db, cfg: ctx.env.api.cfg, personaId: PERSONA })
  assert.ok(n)
  assert.equal(n.action, 'practice')
  assert.equal(n.drive, 'curiosity')
  assert.ok(n.text.includes('好奇'))
  assert.equal(n.canAct, true)
  assert.ok(n.text.includes('dy_life_action_run'))
  assert.ok(n.text.includes('不想做'))
  assert.equal(n.text.includes('必须'), false)
  assert.equal(n.text.includes('你应该'), false)
})

test('nudge / 低驱动 → 无建议', (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  seed(ctx.env.api.db, { curiosity: 0.2, social: 0.1, mastery: 0.1, care: 0.1 })
  assert.equal(buildWakeNudge({ db: ctx.env.api.db, cfg: ctx.env.api.cfg, personaId: PERSONA }), null)
})

test('nudge / 表达高 → write_diary', (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  seed(ctx.env.api.db, { curiosity: 0.2, social: 0.9, mastery: 0.2, care: 0.2 })
  const n = buildWakeNudge({ db: ctx.env.api.db, cfg: ctx.env.api.cfg, personaId: PERSONA })
  assert.equal(n.action, 'write_diary')
  assert.equal(n.drive, 'social')
})

test('nudge / goal 加成可把 0.5 推到阈值上', (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const now = ctx.env.clock.now()
  seed(ctx.env.api.db, { curiosity: 0.5, social: 0.1, mastery: 0.1, care: 0.1 })
  ctx.env.api.db.prepare('INSERT INTO goals(id,self_id,title,note,source,priority,status,kind_hint,due_at,last_touched_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('g1', PERSONA, '练点东西', null, 'self', 0.8, 'open', 'practice', null, now, now, now)
  const n = buildWakeNudge({ db: ctx.env.api.db, cfg: ctx.env.api.cfg, personaId: PERSONA })
  assert.equal(n.action, 'practice')
  assert.ok(n.score > 0.6)
})

test('nudge / 每轮最多一条 wake_nudge 审计', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  seed(ctx.env.api.db, { curiosity: 0.9, social: 0.2, mastery: 0.2, care: 0.2 })
  let jobs = []
  const scheduler = { setTimeout: (fn, ms) => { jobs.push({ fn, ms }); return jobs.length }, clearTimeout: () => {}, fire: () => jobs.shift()?.fn?.() }
  const loop = createHomeWakeLoop({
    home: ctx.env.api.home,
    db: ctx.env.api.db,
    cfg: ctx.env.api.cfg,
    clock: ctx.env.clock.now,
    random: () => 0.01,
    scheduler,
    getPersonaId: () => PERSONA,
    persona: { displayName: () => '汐', emotionState: () => ({ label: '平静', intensity: 0.2 }) },
  })
  t.after(() => loop.dispose())
  await loop.tickOnce('wake')
  const rows = ctx.env.api.db.prepare("SELECT data_json FROM action_log WHERE event='wake_nudge'").all()
  assert.equal(rows.length, 1)
  const d = JSON.parse(rows[0].data_json)
  assert.equal(d.drive, 'curiosity')
  assert.equal(d.action, 'practice')
  assert.equal(typeof d.score, 'number')
})


test('nudge / energy 低时 high drive 只建议、不提示直接执行', (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  seed(ctx.env.api.db, { curiosity: 0.9, social: 0.1, mastery: 0.1, care: 0.1 })
  ctx.env.api.db.prepare("INSERT INTO meta(key,value,updated_at) VALUES('home.energy',?,?)").run(JSON.stringify(0.1), ctx.env.clock.now())
  const n = buildWakeNudge({ db: ctx.env.api.db, cfg: ctx.env.api.cfg, personaId: PERSONA })
  assert.equal(n.canAct, false)
  assert.equal(n.text.includes('dy_life_action_run'), false)
})

test('nudge / 同一行动 30 分钟内不再建议', (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  seed(ctx.env.api.db, { curiosity: 0.9, social: 0.1, mastery: 0.1, care: 0.1 })
  ctx.env.api.db.prepare('INSERT INTO action_log(at,self_id,event,code,note,data_json) VALUES(?,?,?,?,?,?)').run(
    ctx.env.clock.now() - 5 * 60_000, PERSONA, 'wake_nudge', 'SUGGEST', 'action=practice', JSON.stringify({ drive: 'curiosity', action: 'practice', score: 0.9 }),
  )
  const n = buildWakeNudge({ db: ctx.env.api.db, cfg: ctx.env.api.cfg, personaId: PERSONA, now: ctx.env.clock.now() })
  assert.equal(n, null)
})

test('nudge / 仅建议不执行（不写 actions）', (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  seed(ctx.env.api.db, { curiosity: 0.9, social: 0.1, mastery: 0.1, care: 0.1 })
  buildWakeNudge({ db: ctx.env.api.db, cfg: ctx.env.api.cfg, personaId: PERSONA })
  assert.equal(ctx.env.api.db.prepare('SELECT COUNT(1) AS n FROM actions').get().n, 0)
})
