/** 学习与练习：主题匹配/追加/截断/门禁/审计 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'

const PERSONA = 'self:test-practice'

function open() {
  const tmp = makeTempDir('autonomy-practice-')
  const dir = join(tmp.dir, '学习')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '沟通.md'), '# 沟通\n\n先听，再说。\n')
  writeFileSync(join(dir, '插件.md'), '# 插件\n\n测试，同步，别碰生产。\n')
  const homeDir = join(tmp.dir, 'home')
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: true, practiceDir: dir, home: { enabled: true, cwd: homeDir } },
    services: withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }),
    clock: makeClock('2026-11-07T10:00:00+08:00'),
  })
  return { env, tmp, dir, homeDir, cleanup: () => { env.cleanup(); tmp.cleanup() } }
}
const tool = (env) => env.registered.find((r) => r.name === 'dy_life_practice')
const owner = (ctx) => ({ agent: { session: { header: { id: 'home-1', cwd: ctx.homeDir } } } })
const parse = (r) => JSON.parse(r.detail)

test('practice / 有主题：读材料、返回字段、记录追加', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const r = parse(await tool(ctx.env).execute({ topic: '沟通', note: '今天练习复述', minutes: 12 }, owner(ctx)))
  assert.equal(r.ok, true)
  assert.equal(r.topic, '沟通')
  assert.ok(r.bytes > 0)
  assert.equal(r.noteLen, 6)
  assert.ok(r.file.endsWith('沟通.md'))
  const record = readFileSync(r.recordFile, 'utf8')
  assert.ok(record.includes('## 10:00 · 沟通'))
  assert.ok(record.includes('minutes: 12'))
  assert.ok(record.includes('今天练习复述'))
})

test('practice / 无主题：NO_TOPIC 并列出可用主题', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const r = parse(await tool(ctx.env).execute({}, owner(ctx)))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_TOPIC')
  assert.deepEqual(r.topics, ['插件', '沟通'])
})

test('practice / 模糊匹配', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const r = parse(await tool(ctx.env).execute({ topic: '沟' }, owner(ctx)))
  assert.equal(r.ok, true)
  assert.equal(r.topic, '沟通')
  const no = parse(await tool(ctx.env).execute({ topic: '不存在' }, owner(ctx)))
  assert.equal(no.code, 'NO_TOPIC')
})

test('practice / 记录追加不覆盖', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const a = parse(await tool(ctx.env).execute({ topic: '沟通', note: '一' }, owner(ctx)))
  const b = parse(await tool(ctx.env).execute({ topic: '插件', note: '二' }, owner(ctx)))
  assert.equal(a.recordFile, b.recordFile)
  const text = readFileSync(a.recordFile, 'utf8')
  assert.equal((text.match(/^## /gm) ?? []).length, 2)
})

test('practice / note 截断 500', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const r = parse(await tool(ctx.env).execute({ topic: '沟通', note: 'x'.repeat(800) }, owner(ctx)))
  assert.equal(r.ok, true)
  assert.equal(r.noteLen, 500)
  assert.ok(readFileSync(r.recordFile, 'utf8').includes('x'.repeat(500)))
})

test('practice / owner 门禁', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const r = parse(await tool(ctx.env).execute({ topic: '沟通' }, { agent: { session: { header: { id: 'x', cwd: '/tmp/other' } } } }))
  assert.equal(r.ok, false)
})

test('practice / 审计只记 topic/bytes/noteLen，不记正文', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const body = 'SECRET-PRACTICE-NOTE'
  await tool(ctx.env).execute({ topic: '沟通', note: body }, owner(ctx))
  const row = ctx.env.api.db.prepare("SELECT note,data_json FROM action_log WHERE event='practice' ORDER BY id DESC LIMIT 1").get()
  assert.ok(row)
  assert.ok(row.note.includes('topic=沟通'))
  assert.ok(row.note.includes('noteLen=' + body.length))
  assert.equal(String(row.note).includes(body), false)
  assert.equal(String(row.data_json).includes(body), false)
})
