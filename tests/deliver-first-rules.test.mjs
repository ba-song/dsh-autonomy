/** QQ 房间规矩只在会话第一条注入，后续剥掉 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'

const PERSONA = 'self:test-rules'
const RULES = '\n\n【这个房间的规矩】\n- 只许说真话\n- 别刷屏'
const TEXT = `[QQ·私聊 主人] 你好${RULES}`

function open() {
  const tmp = makeTempDir('autonomy-rules-')
  const homeDir = join(tmp.dir, 'home')
  const calls = { create: [], resume: [], followup: [], get: [], dispose: [] }
  const h = () => ({ agent: { status: 'idle', async followup(m) { calls.followup.push(m); return { ok: true } }, dispose() { calls.dispose.push(1) } } })
  const agents = { calls, get: (id) => (calls.get.push(id), null), create: (a) => (calls.create.push(a), h()), resume: (a) => (calls.resume.push(a), h()) }
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: false, minTickGapMinutes: 0, home: { enabled: true, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60, deliverLog: join(tmp.dir, 'deliver.log') } },
    services: { ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }), agents, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } },
    clock: makeClock(),
  })
  return { env, calls, cleanup: () => { env.cleanup(); tmp.cleanup() } }
}
const textOf = (m) => (Array.isArray(m.content) ? m.content.map((c) => c.text ?? '').join(' ') : String(m.content))

test('rules / 新会话第一条原样带规则，返回 firstInSession=true', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  const r = await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'owner', text: TEXT })
  assert.equal(r.delivered, true)
  assert.equal(r.firstInSession, true)
  assert.ok(textOf(ctx.calls.followup[0]).includes('【这个房间的规矩】'))
  const sid = ctx.env.api.home.status(PERSONA).sessionId
  assert.equal(JSON.parse(ctx.env.api.db.prepare('SELECT value FROM meta WHERE key=?').get(`home.delivered.${sid}`).value), 1)
})

test('rules / 第二条仍带规则块（2026-11-12 起不剥），仍保留 [QQ·…] 正文', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'owner', text: TEXT })
  const r = await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'owner', text: TEXT })
  assert.equal(r.firstInSession, false)
  const body = textOf(ctx.calls.followup[1])
  assert.ok(body.startsWith('[QQ·私聊 主人] 你好'))
  assert.equal(body.includes('【这个房间的规矩】'), true, '每条都要带，避免她忘记 dy_say 复述规则')
  assert.equal(body.includes('只许说真话'), true)
  const sid = ctx.env.api.home.status(PERSONA).sessionId
  assert.equal(JSON.parse(ctx.env.api.db.prepare('SELECT value FROM meta WHERE key=?').get(`home.delivered.${sid}`).value), 2)
})

test('rules / 换 sessionId 后计数隔离，新会话第一条又带', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'owner', text: TEXT })
  await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'owner', text: TEXT })
  const oldSid = ctx.env.api.home.status(PERSONA).sessionId
  ctx.env.api.home.dispose()
  ctx.env.api.db.prepare('UPDATE home_sessions SET home_session_id=? WHERE persona_id=?').run('new-session-2222', PERSONA)
  const r = await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'owner', text: TEXT })
  assert.equal(r.firstInSession, true)
  assert.ok(textOf(ctx.calls.followup.at(-1)).includes('【这个房间的规矩】'))
  assert.equal(JSON.parse(ctx.env.api.db.prepare('SELECT value FROM meta WHERE key=?').get(`home.delivered.${oldSid}`).value), 2)
  assert.equal(JSON.parse(ctx.env.api.db.prepare('SELECT value FROM meta WHERE key=?').get('home.delivered.new-session-2222').value), 1)
})

test('rules / 无规则文本后续消息保持不变', async (t) => {
  const ctx = open()
  t.after(ctx.cleanup)
  await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'owner', text: '一' })
  const r = await ctx.env.provided.dyHome.deliver({ channel: 'qq', contactId: 'owner', text: '[QQ·私聊 主人] 普通消息' })
  assert.equal(r.firstInSession, false)
  assert.equal(textOf(ctx.calls.followup[1]), '[QQ·私聊 主人] 普通消息')
})
