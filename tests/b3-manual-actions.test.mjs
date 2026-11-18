/** B3 · 手动行动工具（她主动调用才执行；tick 不接） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'
import { HOME_WAKE_PROMPT } from '../lib/run/home.js'

const PERSONA = 'self:test-b3'

function open({ withArchive = true, stickers = null } = {}) {
  const tmp = makeTempDir('autonomy-b3-')
  const archiveDir = join(tmp.dir, 'archive')
  const rawDir = join(tmp.dir, 'raw')
  const homeDir = join(tmp.dir, 'home')
  const memory = mockMemory()
  const diaryCalls = []
  memory.saveDiary = async (input) => {
    diaryCalls.push(input)
    return { id: 'd1', bytes: 12 }
  }
  if (withArchive) {
    mkdirSync(join(archiveDir, '2026-11-04'), { recursive: true })
    writeFileSync(join(archiveDir, '2026-11-04', 'a.md'), '---\ntitle: 旧事\n---\n今天翻到一段旧档案，讲的是雨。\n')
  }
  mkdirSync(rawDir, { recursive: true })
  mkdirSync(homeDir, { recursive: true })
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: true, minTickGapMinutes: 0, archiveDir, rawDir, stickerDirs: stickers ? [stickers] : [], home: { enabled: true, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60 } },
    services: { ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory }), agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } },
    clock: makeClock(),
  })
  const cleanup = () => { env.cleanup(); tmp.cleanup() }
  return { env, memory, diaryCalls, archiveDir, homeDir, cleanup }
}

const tool = (env) => env.registered.find((r) => r.name === 'dy_life_action_run')
const owner = (ctx) => ({ agent: { session: { header: { id: 'home-1', cwd: ctx.homeDir } } } })
const parse = (r) => JSON.parse(r.detail)

test('B3 / owner 门禁：非主人/子智能体拒绝', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  for (const exec of [
    { agent: { session: { header: { id: 'x', cwd: '/tmp/other' } } } },
    { agent: { session: { header: { id: 'sub', cwd: ctx.homeDir, parentSession: 'p' } } } },
  ]) {
    const r = parse(await tool(ctx.env).execute({ kind: 'read_archive' }, exec))
    assert.equal(r.ok, false)
  }
})

test('B3 / read_archive：真读档案，evidence + ≤500 字 episodeText', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const r = parse(await tool(ctx.env).execute({ kind: 'read_archive' }, owner(ctx)))
  assert.equal(r.ok, true)
  assert.equal(r.evidence[0].type, 'archive')
  assert.ok(r.evidence[0].ref.endsWith('2026-11-04/a.md'))
  assert.ok(r.episodeText.includes('雨'))
  assert.ok(r.episodeText.length <= 500)
})

test('B3 / read_archive：没有档案 → NO_ARCHIVE（不假装成功）', async (t) => {
  const ctx = open({ withArchive: false })
  t.after(ctx.cleanup)
  const r = parse(await tool(ctx.env).execute({ kind: 'read_archive' }, owner(ctx)))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_ARCHIVE')
})

test('B3 / write_diary：只在她调用时写，且带插件写身份', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const r = parse(await tool(ctx.env).execute({ kind: 'write_diary', text: '今天很安静。' }, owner(ctx)))
  assert.equal(r.ok, true)
  assert.equal(ctx.diaryCalls.length, 1)
  assert.equal(ctx.diaryCalls[0].text, '今天很安静。')
  assert.equal(ctx.diaryCalls[0].header.origin, 'plugin')
  assert.equal(r.evidence[0].type, 'diary')
})

test('B3 / write_diary：空文本 → NO_DRAFT，不调服务', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const r = parse(await tool(ctx.env).execute({ kind: 'write_diary' }, owner(ctx)))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_DRAFT')
  assert.equal(ctx.diaryCalls.length, 0)
})

test('B3 / organize_memory：只读建议，不改档案', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const file = join(ctx.archiveDir, '2026-11-04', 'a.md')
  const before = readFileSync(file, 'utf8')
  const r = parse(await tool(ctx.env).execute({ kind: 'organize_memory' }, owner(ctx)))
  assert.equal(r.ok, true)
  assert.ok(Array.isArray(r.result.suggestions))
  assert.equal(readFileSync(file, 'utf8'), before, '归档整理只能建议，不能改')
})

test('B3 / find_sticker / browse_douyin / send_qq：无通道 → UNAVAILABLE', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  for (const kind of ['find_sticker', 'browse_douyin', 'send_qq']) {
    const r = parse(await tool(ctx.env).execute({ kind }, owner(ctx)))
    assert.equal(r.ok, false)
    assert.equal(r.code, 'UNAVAILABLE')
  }
})

test('B3 / tick 不接真执行器：仍全 mock', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  await tool(ctx.env).execute({ kind: 'read_archive' }, owner(ctx))
  const ex = ctx.env.api.listExecutors()
  assert.ok(ex.length >= 6)
  assert.equal(ex.every((e) => e.mock === true), true, 'tick 的执行器仍全 mock')
})

test('B3 / 唤醒词仍是 open-ended，不加任务清单', async (t) => {
  assert.ok(HOME_WAKE_PROMPT.includes('没有任务'))
  for (const bad of ['read_archive', 'write_diary', 'organize_memory', '你必须', '任务清单']) {
    assert.equal(HOME_WAKE_PROMPT.includes(bad), false)
  }
})

test('B3 / 暂停时手动行动也停', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  ctx.env.api.db.prepare("INSERT INTO meta(key,value,updated_at) VALUES('pause.all',?,?)")
    .run(JSON.stringify({ on: true, until: null }), ctx.env.clock.now())
  const r = parse(await tool(ctx.env).execute({ kind: 'read_archive' }, owner(ctx)))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'PAUSED')
})

test('B3 / 她执行行动：audit source=self，降低对应驱动', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const now = ctx.env.clock.now()
  ctx.env.api.db.prepare('INSERT INTO drives(self_id,name,value,baseline,growth,updated_at) VALUES(?,?,?,?,?,?)').run(PERSONA, 'curiosity', 0.7, 0.45, 0.05, now)
  const r = parse(await tool(ctx.env).execute({ kind: 'read_archive', reason: '想看' }, owner(ctx)))
  assert.equal(r.ok, true)
  const log = ctx.env.api.db.prepare("SELECT data_json FROM action_log WHERE event='done' ORDER BY id DESC LIMIT 1").get()
  assert.ok(log.data_json.includes('"source":"self"'))
  const after = ctx.env.api.db.prepare("SELECT value FROM drives WHERE self_id=? AND name='curiosity'").get(PERSONA).value
  assert.ok(after < 0.7)
})
