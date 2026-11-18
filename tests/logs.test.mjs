/** dy_logs：白名单、tail、grep、门禁 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readLog, LOG_NAMES } from '../lib/io/logs.js'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'

function paths() {
  const tmp = makeTempDir('autonomy-logs-')
  const p = {}
  for (const n of LOG_NAMES) {
    p[n] = join(tmp.dir, `${n}.log`)
    mkdirSync(dirname(p[n]), { recursive: true })
    writeFileSync(p[n], `${n} hello\n`)
  }
  return { tmp, p }
}

test('logs / list 含 6 个白名单', () => {
  const { tmp, p } = paths()
  const r = readLog({ name: 'list', paths: p })
  assert.equal(r.ok, true)
  assert.deepEqual(r.lines.map((x) => x.name).sort(), ['autonomy', 'bridge', 'bridge-outbox', 'home', 'memory', 'web'])
  tmp.cleanup()
})

test('logs / 非法 name → BAD_NAME；不存在 → NO_LOG', () => {
  assert.equal(readLog({ name: 'etc-passwd', paths: {} }).code, 'BAD_NAME')
  const tmp = makeTempDir('autonomy-logs-')
  const r = readLog({ name: 'home', paths: { home: join(tmp.dir, 'missing.log') } })
  assert.equal(r.code, 'NO_LOG')
  tmp.cleanup()
})

test('logs / tail 行数与上限 200', () => {
  const tmp = makeTempDir('autonomy-logs-')
  const path = join(tmp.dir, 'big.log')
  writeFileSync(path, Array.from({ length: 300 }, (_, i) => `line-${i + 1}`).join('\n') + '\n')
  const all = readLog({ name: 'home', lines: 500, paths: { home: path } })
  assert.equal(all.ok, true)
  assert.equal(all.lines.length, 200)
  assert.equal(all.lines.at(-1), 'line-300')
  assert.equal(all.total, 300)
  const five = readLog({ name: 'home', lines: 5, paths: { home: path } })
  assert.deepEqual(five.lines, ['line-296', 'line-297', 'line-298', 'line-299', 'line-300'])
  tmp.cleanup()
})

test('logs / grep 命中与无命中', () => {
  const tmp = makeTempDir('autonomy-logs-')
  const path = join(tmp.dir, 'grep.log')
  writeFileSync(path, 'alpha\nbeta\nalpha-two\n')
  const hit = readLog({ name: 'home', grep: 'alpha', paths: { home: path } })
  assert.deepEqual(hit.lines, ['alpha', 'alpha-two'])
  assert.equal(hit.matched, 2)
  const none = readLog({ name: 'home', grep: 'zzz', paths: { home: path } })
  assert.equal(none.ok, true)
  assert.deepEqual(none.lines, [])
  tmp.cleanup()
})

test('logs / 每行截断 500 字 + since 尽力过滤', () => {
  const tmp = makeTempDir('autonomy-logs-')
  const path = join(tmp.dir, 'long.log')
  writeFileSync(path, `[2026-11-06T00:00:00Z] ${'x'.repeat(600)}\n[2026-11-05T00:00:00Z] old\n`)
  const r = readLog({ name: 'home', lines: 2, paths: { home: path } })
  assert.equal(r.lines[0].length, 500)
  const s = readLog({ name: 'home', since: '2026-11-06T00:00:00Z', paths: { home: path } })
  assert.equal(s.lines.length, 1)
  assert.ok(s.lines[0].includes('xxxx'))
  tmp.cleanup()
})

test('logs / 工具 owner 门禁 + list', async (t) => {
  const tmp = makeTempDir('autonomy-logs-')
  const homeDir = join(tmp.dir, 'home')
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: true, home: { enabled: true, cwd: homeDir } },
    services: withServices({ persona: mockPersona({ selfId: 'self:logs' }), memory: mockMemory() }),
    clock: makeClock(),
  })
  t.after(() => { env.cleanup(); tmp.cleanup() })
  const tool = env.registered.find((r) => r.name === 'dy_logs')
  assert.ok(tool)
  const owner = { agent: { session: { header: { id: 'home-1', cwd: homeDir } } } }
  const r = JSON.parse((await tool.execute({ name: 'list' }, owner)).detail)
  assert.equal(r.ok, true)
  assert.equal(r.lines.length, 6)
  const denied = JSON.parse((await tool.execute({ name: 'list' }, { agent: { session: { header: { id: 'x', cwd: '/tmp/other' } } } })).detail)
  assert.equal(denied.ok, false)
})
