/** 自驱学习：兴趣表 + 好奇心 + 唤醒自主练习 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'
import { loadDrives, advanceDrives } from '../lib/core/drives.js'

const PERSONA = 'self:test-interest'
const NOW = '2026-11-07T10:00:00+08:00'

function open() {
  const tmp = makeTempDir('autonomy-interest-')
  const dir = join(tmp.dir, '学习')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '沟通.md'), '# 沟通\n\n先听。\n')
  writeFileSync(join(dir, '插件.md'), '# 插件\n\n测试。\n')
  const homeDir = join(tmp.dir, 'home')
  const h = () => ({ agent: { status: 'idle', async followup() { return { ok: true } }, dispose() {} } })
  const agents = { get: () => null, create: () => h(), resume: () => h() }
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: false, practiceDir: dir, home: { enabled: true, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60, logPath: join(tmp.dir, 'auto.log'), deliverLog: join(tmp.dir, 'deliver.log') } },
    services: { ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }), agents, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } },
    clock: makeClock(NOW),
  })
  return { env, tmp, dir, homeDir, cleanup: () => { env.cleanup(); tmp.cleanup() } }
}
const tool = (env) => env.registered.find((r) => r.name === 'dy_life_interest')
const owner = (ctx) => ({ agent: { session: { header: { id: 'home-1', cwd: ctx.homeDir } } } })
const parse = (r) => JSON.parse(r.detail)

const setCuriosity = (ctx, v) => {
  ctx.env.api.db.prepare('INSERT INTO drives(self_id,name,value,baseline,growth,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(self_id,name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
    .run(PERSONA, 'curiosity', v, 0.45, 0.05, ctx.env.clock.now())
}
const curiosity = (ctx) => ctx.env.api.db.prepare("SELECT value FROM drives WHERE self_id=? AND name='curiosity'").get(PERSONA)?.value

test('interest / add/list/drop，drop 只标记不删', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const add = parse(await tool(ctx.env).execute({ action: 'add', topic: '沟通', note: '想学倾听' }, owner(ctx)))
  assert.equal(add.ok, true)
  const list = parse(await tool(ctx.env).execute({ action: 'list' }, owner(ctx)))
  assert.equal(list.interests.length, 1)
  assert.equal(list.interests[0].topic, '沟通')
  const drop = parse(await tool(ctx.env).execute({ action: 'drop', topic: '沟通' }, owner(ctx)))
  assert.equal(drop.ok, true)
  const list2 = parse(await tool(ctx.env).execute({ action: 'list' }, owner(ctx)))
  assert.equal(list2.interests.length, 0)
  assert.equal(ctx.env.api.db.prepare('SELECT COUNT(1) AS n FROM interests WHERE topic=?').get('沟通').n, 1)
})

test('interest / owner 建议提高好奇心，但 low curiosity 不强制练', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  setCuriosity(ctx, 0.2)
  await tool(ctx.env).execute({ action: 'add', topic: '插件', note: '主人建议', source: 'owner' }, owner(ctx))
  assert.ok(curiosity(ctx) > 0.2)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  const n = ctx.env.api.db.prepare("SELECT COUNT(1) AS n FROM action_log WHERE event='practice'").get().n
  assert.equal(n, 0)
})

test('interest / curiosity 高 + energy 足 → 显式调用才练一次（唤醒不自动）', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  setCuriosity(ctx, 0.9)
  ctx.env.api.db.prepare("INSERT INTO meta(key,value,updated_at) VALUES('home.energy',?,?)").run(JSON.stringify(0.8), ctx.env.clock.now())
  await tool(ctx.env).execute({ action: 'add', topic: '沟通' }, owner(ctx))
  await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(ctx.env.api.db.prepare("SELECT COUNT(1) AS n FROM action_log WHERE event='practice'").get().n, 0, '唤醒只建议，不自动执行')
  const r = ctx.env.api.practice.maybeSelfPractice()
  assert.equal(r.ok, true)
  const audit = ctx.env.api.db.prepare("SELECT note,data_json FROM action_log WHERE event='practice' ORDER BY id DESC LIMIT 1").get()
  assert.ok(audit.note.includes('source=self'))
  assert.ok(audit.data_json.includes('"source":"self"'))
  assert.ok(curiosity(ctx) < 0.9)
})

test('interest / energy 低 → 不触发自主练习', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  setCuriosity(ctx, 0.9)
  ctx.env.api.db.prepare("INSERT INTO meta(key,value,updated_at) VALUES('home.energy',?,?)").run(JSON.stringify(0.1), ctx.env.clock.now())
  await tool(ctx.env).execute({ action: 'add', topic: '沟通' }, owner(ctx))
  await ctx.env.api.home.awake({ personaId: PERSONA })
  const r = ctx.env.api.practice.maybeSelfPractice()
  assert.equal(r.code, 'ENERGY_LOW')
  assert.equal(ctx.env.api.db.prepare("SELECT COUNT(1) AS n FROM action_log WHERE event='practice'").get().n, 0)
})

test('interest / curiosity 随时间自然上升', (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const old = ctx.env.clock.now() - 24 * 3600_000
  ctx.env.api.db.prepare('INSERT INTO drives(self_id,name,value,baseline,growth,updated_at) VALUES(?,?,?,?,?,?)').run(PERSONA, 'curiosity', 0.4, 0.45, 0.05, old)
  const rows = loadDrives(ctx.env.api.db, PERSONA, ctx.env.clock.now())
  const next = advanceDrives(rows, ctx.env.clock.now())
  const c = next.find((r) => r.name === 'curiosity').value
  assert.ok(c > 0.4)
})

test('interest / 工具 owner 门禁', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const r = parse(await tool(ctx.env).execute({ action: 'list' }, { agent: { session: { header: { id: 'x', cwd: '/tmp/other' } } } }))
  assert.equal(r.ok, false)
})
