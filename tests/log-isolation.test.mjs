/** 测试日志隔离：home 日志必须落 tmp */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'

const PERSONA = 'self:test-isolation'

function open({ home = {} } = {}) {
  const tmp = makeTempDir('autonomy-iso-')
  const homeDir = join(tmp.dir, 'home')
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: false, minTickGapMinutes: 0, home: { enabled: true, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60, ...home } },
    services: { ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }), agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } },
    clock: makeClock(),
  })
  return { env, tmp, homeDir, cleanup: () => { env.cleanup(); tmp.cleanup() } }
}

test('isolation / 未显式指定日志路径时自动落 tmp', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  assert.ok(ctx.env.api.cfg.home.logPath.startsWith(ctx.tmp.dir), 'autonomy log 必须在 tmp')
  assert.ok(ctx.env.api.cfg.home.deliverLog.startsWith(ctx.tmp.dir), 'deliver log 必须在 tmp')
  await ctx.env.api.home.awake({ personaId: PERSONA })
  await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'c', text: 'x' })
  assert.equal(existsSync(ctx.env.api.cfg.home.logPath), true)
  assert.equal(existsSync(ctx.env.api.cfg.home.deliverLog), true)
})

test('isolation / 显式记录路径优先', (t) => {
  const ctx = open({ home: { logPath: '/tmp/explicit-autonomy.log', deliverLog: '/tmp/explicit-deliver.log' } })
  t.after(ctx.cleanup)
  assert.equal(ctx.env.api.cfg.home.logPath, '/tmp/explicit-autonomy.log')
  assert.equal(ctx.env.api.cfg.home.deliverLog, '/tmp/explicit-deliver.log')
})
