/** 生活侧文件日志：wake/deliver/rotate、失败静默、轮转 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'
import { createFileLogger } from '../lib/log-file.js'

const PERSONA = 'self:test-autolog'

function open({ logPath = null } = {}) {
  const tmp = makeTempDir('autonomy-autolog-')
  const homeDir = join(tmp.dir, 'home')
  const path = logPath ?? join(tmp.dir, 'logs', 'autonomy.log')
  const calls = { create: [], resume: [], followup: [], get: [], dispose: [] }
  const h = () => ({ agent: { status: 'idle', async followup(m) { calls.followup.push(m); return { ok: true } }, dispose() {} } })
  const agents = { calls, get: () => null, create: (a) => (calls.create.push(a), h()), resume: (a) => (calls.resume.push(a), h()) }
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: false, minTickGapMinutes: 0, home: { enabled: true, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60, logPath: path, deliverLog: join(tmp.dir, 'deliver.log') } },
    services: { ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }), agents, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } },
    clock: makeClock(),
  })
  return { env, path, tmp, cleanup: () => { env.cleanup(); tmp.cleanup() } }
}

const linesOf = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean)

test('autonomy log / wake + deliver + rotate 各一行，格式可解析', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: '你好' })
  await ctx.env.api.home.rotateHome({ personaId: PERSONA, reason: 'manual', force: true })
  const lines = linesOf(ctx.path)
  const parsed = lines.map((l) => {
    const m = /^(\S+) (info|warn) ([a-z_]+)(?: (.*))?$/.exec(l)
    assert.ok(m, `格式不对：${l}`)
    return { at: m[1], level: m[2], event: m[3], fields: m[4] ?? '' }
  })
  assert.ok(Number.isFinite(Date.parse(parsed[0].at)))
  for (const ev of ['wake', 'deliver', 'rotate']) assert.ok(parsed.some((x) => x.event === ev), `缺 ${ev}`)
  const wake = parsed.find((x) => x.event === 'wake')
  assert.ok(wake.fields.includes('code=AWAKENED'))
  assert.ok(parsed.some((x) => x.event === 'deliver' && x.fields.includes('status=ok')))
  assert.ok(parsed.find((x) => x.event === 'rotate').fields.includes('old='))
})

test('autonomy log / 写失败静默，不影响 awake', async (t) => {
  const tmp = makeTempDir('autonomy-autolog-bad-')
  const ctx = open({ logPath: tmp.dir }) // 指向目录 → append 失败
  t.after(() => { ctx.cleanup(); tmp.cleanup() })
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.code, 'AWAKENED')
})

test('autonomy log / >5MB（测试用小阈值）轮转 .1', (t) => {
  const tmp = makeTempDir('autonomy-autolog-rot-')
  t.after(() => tmp.cleanup())
  const path = join(tmp.dir, 'autonomy.log')
  const logger = createFileLogger({ path, maxBytes: 60 })
  for (let i = 0; i < 10; i++) logger.write('info', 'wake', { code: 'AWAKENED', session: `s${i}` })
  assert.equal(existsSync(`${path}.1`), true, '超过阈值应轮转 .1')
  assert.ok(linesOf(path).length > 0)
  assert.ok(linesOf(`${path}.1`).length > 0)
})
