/** 安全新建式日记：与 saveDiary 同格式、同目录、永不覆盖 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendDiary, DIARY_APPEND_ROOT } from '../lib/run/diary-append.js'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'

const PERSONA = 'self:test-diary-append'
const NOW = Date.parse('2026-11-08T18:00:00+08:00')

test('diary / 首次创建：同日期目录/同文件名格式/frontmatter', (t) => {
  const tmp = makeTempDir('autonomy-diary-')
  t.after(() => tmp.cleanup())
  const r = appendDiary({ text: '今天很安静', title: '安静', mood: '平静', tags: ['生活'], now: NOW, root: tmp.dir })
  assert.equal(r.ok, true)
  assert.equal(r.date, '2026-11-08')
  assert.equal(r.file, join(tmp.dir, '2026-11-08', '180000-01.md'))
  assert.ok(r.bytes > 0)
  const s = readFileSync(r.file, 'utf8')
  assert.ok(s.startsWith('---\n'))
  assert.ok(s.includes('date: 2026-11-08'))
  assert.ok(s.includes('seq: 1'))
  assert.ok(s.includes('author: self'))
  assert.ok(s.includes('- title: 安静'.replace('- ', '')) || s.includes('title: 安静'))
  assert.ok(s.includes('mood: 平静'))
  assert.ok(s.includes('tags: 生活'))
  assert.ok(s.includes('今天很安静'))
})

test('diary / 二次调用新建第二条，不覆盖第一条', (t) => {
  const tmp = makeTempDir('autonomy-diary-')
  t.after(() => tmp.cleanup())
  const a = appendDiary({ text: '第一条', now: NOW, root: tmp.dir })
  const b = appendDiary({ text: '第二条', now: NOW, root: tmp.dir })
  assert.equal(a.file, join(tmp.dir, '2026-11-08', '180000-01.md'))
  assert.equal(b.file, join(tmp.dir, '2026-11-08', '180000-02.md'))
  assert.equal(readFileSync(a.file, 'utf8').includes('第二条'), false)
  assert.equal(readFileSync(b.file, 'utf8').includes('第一条'), false)
  assert.equal(readdirSync(join(tmp.dir, '2026-11-08')).length, 2)
})

test('diary / 已有同格式条目不被覆盖，自动换 seq', (t) => {
  const tmp = makeTempDir('autonomy-diary-')
  t.after(() => tmp.cleanup())
  const dir = join(tmp.dir, '2026-11-08')
  mkdirSync(dir, { recursive: true })
  const old = join(dir, '180000-01.md')
  writeFileSync(old, '# 原有日记\n不能覆盖我\n')
  const r = appendDiary({ text: '新内容', now: NOW, root: tmp.dir })
  assert.equal(r.file, join(dir, '180000-02.md'))
  assert.ok(readFileSync(old, 'utf8').startsWith('# 原有日记\n不能覆盖我'))
  assert.ok(readFileSync(r.file, 'utf8').includes('新内容'))
})

test('diary / 空文本拒绝，不建文件', (t) => {
  const tmp = makeTempDir('autonomy-diary-')
  t.after(() => tmp.cleanup())
  const r = appendDiary({ text: '  \n ', now: NOW, root: tmp.dir })
  assert.equal(r.code, 'EMPTY_TEXT')
  assert.equal(existsSync(join(tmp.dir, '2026-11-08')), false)
})

test('diary / 固定目录 + 超长截断', (t) => {
  const tmp = makeTempDir('autonomy-diary-')
  t.after(() => tmp.cleanup())
  assert.equal(DIARY_APPEND_ROOT, '/sdcard/DSHA/记忆/数据/diary')
  const r = appendDiary({ text: 'x'.repeat(25_000), now: NOW, root: tmp.dir })
  assert.equal(r.ok, true)
  const s = readFileSync(r.file, 'utf8')
  assert.equal((s.match(/x/g) ?? []).length, 20_000)
})

test('diary / 工具 owner 门禁；非 owner 拒绝', async (t) => {
  const tmp = makeTempDir('autonomy-diary-')
  const homeDir = join(tmp.dir, 'home')
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: true, home: { enabled: true, cwd: homeDir } },
    services: withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }),
    clock: makeClock('2026-11-08T18:00:00+08:00'),
  })
  t.after(() => { env.cleanup(); tmp.cleanup() })
  const tool = env.registered.find((r) => r.name === 'dy_life_diary_append')
  assert.ok(tool)
  const r = JSON.parse((await tool.execute({ text: 'x' }, { agent: { session: { header: { id: 'x', cwd: '/tmp/other' } } } })).detail)
  assert.equal(r.ok, false)
})
