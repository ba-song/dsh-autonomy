import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'

const PERSONA = 'self:test-rules-ctx'
const RULES = '\n\n【这个房间的规矩】\n- 只许说真话\n- 发完 dy_say 在正文原样复述'
const TEXT = `[QQ·私聊 主人] 你好${RULES}`
const textOf = (m) => (Array.isArray(m.content) ? m.content.map((c) => c.text ?? '').join(' ') : String(m.content))

test('home 把房间规矩挂成 systemPrompt 常驻上下文，消息内规则被剥掉', async (t) => {
  const tmp = makeTempDir('autonomy-rules-ctx-')
  const homeDir = join(tmp.dir, 'home')
  const contexts = []
  const calls = { followup: [] }
  const agent = {
    status: 'idle',
    async followup(m) { calls.followup.push(m); return { ok: true } },
    dispose() {},
    ctx: { systemPrompt: { context: (spec) => { contexts.push(spec); return () => {} } } },
  }
  const agents = { get: () => null, create: () => ({ agent }), resume: () => ({ agent }) }
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: false, minTickGapMinutes: 0, home: { enabled: true, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60 } },
    services: { ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }), agents, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } },
    clock: makeClock(),
  })
  t.after(() => { env.cleanup(); tmp.cleanup() })
  await env.provided.dyHome.deliver({ channel: 'qq', contactId: 'owner', text: TEXT })
  await env.provided.dyHome.deliver({ channel: 'qq', contactId: 'owner', text: TEXT })
  assert.equal(contexts.length, 1, '规矩上下文只挂一次')
  assert.equal(contexts[0].name, 'dy-home-rules')
  assert.ok(String(contexts[0].text()).includes('只许说真话'))
  const first = textOf(calls.followup[0])
  const second = textOf(calls.followup[1])
  assert.ok(first.startsWith('[QQ·私聊 主人] 你好'))
  assert.ok(!first.includes('【这个房间的规矩】'), '挂上后消息里不再重复规则')
  assert.ok(!second.includes('【这个房间的规矩】'))
})
