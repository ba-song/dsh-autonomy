/**
 * C4 · 自愈与档案修复（2026-11-05）
 * fake agents / fake sessionPersistence / 临时库；不真调模型。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'

const PERSONA = 'self:test-c4'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function fakeModel() {
  return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }
}

function makeFakeAgents() {
  const calls = { get: [], create: [], resume: [], followup: [], dispose: [] }
  const agents = {
    calls,
    resumeMode: 'ok', // ok | failOnce | alwaysFail
    failCreate: false,
    get(id) {
      calls.get.push(id)
      return null
    },
    mkHandle() {
      return {
        agent: {
          status: 'idle',
          async followup(msg) {
            calls.followup.push(msg)
            return { ok: true }
          },
          dispose() {
            calls.dispose.push('agent')
          },
        },
      }
    },
    create(args) {
      calls.create.push(args)
      if (agents.failCreate) throw new Error('create boom')
      return agents.mkHandle()
    },
    resume(args) {
      calls.resume.push(args)
      if (agents.resumeMode === 'alwaysFail') throw new Error('stored session failed validation: lacks an identified message')
      if (agents.resumeMode === 'failOnce') {
        agents.resumeMode = 'ok'
        throw new Error('stored session failed validation: lacks an identified message')
      }
      return agents.mkHandle()
    },
  }
  return agents
}

function writeFrames(path, header, events) {
  mkdirSync(dirname(path), { recursive: true })
  const f1 = zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`))
  const f2 = zstdCompressSync(Buffer.from(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`))
  writeFileSync(path, Buffer.concat([f1, f2]))
  return path
}

function readEvents(path) {
  const buf = readFileSync(path)
  const magic = [0x28, 0xb5, 0x2f, 0xfd]
  const offs = []
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]) offs.push(i)
  }
  const texts = []
  for (let k = 0; k < offs.length; k++) {
    try {
      texts.push(zstdDecompressSync(buf.subarray(offs[k], offs[k + 1] ?? buf.length)).toString('utf8'))
    } catch {}
  }
  return texts.flatMap((t) => t.split('\n')).filter(Boolean)
}

function openHeal() {
  const tmp = makeTempDir('autonomy-c4-')
  const homeDir = join(tmp.dir, 'home')
  const agents = makeFakeAgents()
  const persistence = { path: null, locate: () => (persistence.path ? { path: persistence.path } : null) }
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: false, minTickGapMinutes: 0, home: { enabled: true, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60 } },
    services: {
      ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }),
      agents,
      agentDefaultModel: fakeModel(),
      sessionPersistence: persistence,
    },
    clock: makeClock(),
  })
  const cleanup = () => {
    env.cleanup()
    tmp.cleanup()
  }
  return { env, agents, persistence, homeDir, cleanup }
}

async function firstHome(ctx) {
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.code, 'AWAKENED')
  ctx.env.api.home.dispose()
  return r
}

test('C4 / resume 失败 → 修档案 → resume 成功（REPAIRED）', async (t) => {
  const ctx = openHeal()
  t.after(ctx.cleanup)
  const first = await firstHome(ctx)
  ctx.persistence.path = join(ctx.homeDir, 'sessions', first.sessionId, 'session.v4.jsonl.zstd')
  writeFrames(ctx.persistence.path, { type: 'header', version: 4 }, [
    { type: 'user/message', data: { content: '旧话', source: { kind: 'user' } } },
    { type: 'assistant/message', data: { turn: 1, step: 0, stream: [], message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: '回答' }] } } },
  ])
  ctx.agents.resumeMode = 'failOnce'

  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.code, 'AWAKENED')
  assert.equal(r.repaired, true)
  assert.equal(ctx.agents.calls.resume.length, 2, '修完再 resume 一次')
  const heal = JSON.parse(ctx.env.api.db.prepare("SELECT value FROM meta WHERE key='home.lastHeal'").get().value)
  assert.equal(heal.code, 'REPAIRED')
  assert.equal(heal.from, first.sessionId)
  assert.ok(existsSync(heal.backup), '原档案要有 .bak 备份')
  const lines = readEvents(ctx.persistence.path)
  const um = lines.map((l) => JSON.parse(l)).find((e) => e.type === 'user/message')
  assert.match(um.data.id, UUID, '修复后 user/message 必须带 UUID')
  assert.equal(um.data.role, 'user')
})

test('C4 / 修不好 → 新建接管 + 旧行 source=heal 留档', async (t) => {
  const ctx = openHeal()
  t.after(ctx.cleanup)
  const first = await firstHome(ctx)
  ctx.agents.resumeMode = 'alwaysFail'

  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.code, 'AWAKENED', '自愈后正常叫醒')
  assert.equal(ctx.env.api.home.status(PERSONA).sessionId === first.sessionId, false)
  assert.ok(ctx.agents.calls.create.length >= 2, '初次 + 自愈各建一次')
  const rooms = ctx.env.api.db.prepare('SELECT * FROM home_rooms ORDER BY id').all()
  const old = rooms.find((x) => x.session_id === first.sessionId)
  assert.ok(old)
  assert.equal(old.source, 'heal')
  assert.ok(old.rotated_at)
  const heal = JSON.parse(ctx.env.api.db.prepare("SELECT value FROM meta WHERE key='home.lastHeal'").get().value)
  assert.equal(heal.code, 'HEALED')
  assert.equal(heal.from, first.sessionId)
  assert.equal(heal.to, ctx.env.api.home.status(PERSONA).sessionId)
})

test('C4 / pause.all：不自愈、不修档、不新建', async (t) => {
  const ctx = openHeal()
  t.after(ctx.cleanup)
  const first = await firstHome(ctx)
  ctx.agents.resumeMode = 'alwaysFail'
  ctx.env.api.db.prepare("INSERT INTO meta(key,value,updated_at) VALUES('pause.all',?,?)")
    .run(JSON.stringify({ on: true, until: null }), ctx.env.clock.now())

  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.code, 'PAUSED')
  assert.equal(ctx.agents.calls.create.length, 1, '只有最初那次 create')
  assert.equal(ctx.agents.calls.resume.length, 0)
})

test('C4 / dryRun（respectDryRun=true）：不动', async (t) => {
  const ctx = openHeal()
  t.after(ctx.cleanup)
  await firstHome(ctx)
  ctx.env.api.cfg.dryRun = true
  ctx.agents.resumeMode = 'alwaysFail'
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.code, 'DRY_RUN')
  assert.equal(ctx.agents.calls.resume.length, 0)
})

test('C4 / seed 与 handoff：含旧 id/persona/原因', async (t) => {
  const ctx = openHeal()
  t.after(ctx.cleanup)
  const first = await firstHome(ctx)
  ctx.agents.resumeMode = 'alwaysFail'
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.healed, true)
  assert.ok(r.handoffPath && existsSync(r.handoffPath))
  const body = readFileSync(r.handoffPath, 'utf8')
  assert.ok(body.includes(first.sessionId))
  assert.ok(body.includes('self-heal'))
  const seedMsg = ctx.agents.calls.followup.find((m) => m.source?.kind === 'autonomy-home-heal')
  assert.equal(seedMsg, undefined, '2026-11-12 起不再用 followup 投递 seed')
  const createArgs = ctx.agents.calls.create.at(-1)
  assert.equal(createArgs.seed, undefined, 'create 不能再带 seed 事件')
  assert.ok(createArgs.meta.seedText.includes(first.sessionId))
  const meta = ctx.env.api.db.prepare('SELECT value FROM meta WHERE key=?').get(`home.handoff.${r.sessionId}`)
  assert.ok(meta && JSON.parse(meta.value).text.includes(first.sessionId), '交接文本要落 meta')
  assert.deepEqual(createArgs.agentOptions, { provider: 'fake-provider', model: 'fake-model' })
})

test('C4 / UUID：自愈 seed 与普通叫醒的 user/message 都带 UUID', async (t) => {
  const ctx = openHeal()
  t.after(ctx.cleanup)
  await firstHome(ctx)
  ctx.agents.resumeMode = 'alwaysFail'
  await ctx.env.api.home.awake({ personaId: PERSONA })
  const msgs = ctx.agents.calls.followup
  assert.ok(msgs.length >= 1)
  for (const m of msgs) {
    assert.match(m.id, UUID, '每条投递消息都要有 UUID')
    assert.equal(m.role, 'user')
  }
})

test('C4 / 同一会话只修 1 次：失败后不无限重试', async (t) => {
  const ctx = openHeal()
  t.after(ctx.cleanup)
  const first = await firstHome(ctx)
  ctx.agents.resumeMode = 'alwaysFail'
  ctx.agents.failCreate = true

  const r1 = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r1.code, 'HOME_HEAL_FAILED')
  const resumes = ctx.agents.calls.resume.length
  const creates = ctx.agents.calls.create.length

  const r2 = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r2.code, 'HOME_HEAL_FAILED')
  assert.equal(ctx.agents.calls.resume.length, resumes, '第二次不再 resume')
  assert.equal(ctx.agents.calls.create.length, creates, '第二次不再 create')
  const heal = JSON.parse(ctx.env.api.db.prepare("SELECT value FROM meta WHERE key='home.lastHeal'").get().value)
  assert.equal(heal.ok, false)
  assert.equal(heal.from, first.sessionId)
})

test('C4 / 旧档案不删：原文件还在且 heal 记录 from', async (t) => {
  const ctx = openHeal()
  t.after(ctx.cleanup)
  const first = await firstHome(ctx)
  ctx.persistence.path = join(ctx.homeDir, 'sessions', first.sessionId, 'session.v4.jsonl.zstd')
  writeFrames(ctx.persistence.path, { type: 'header', version: 4 }, [{ type: 'user/message', data: { content: 'x' } }])
  const before = readFileSync(ctx.persistence.path)
  ctx.agents.resumeMode = 'alwaysFail'
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.healed, true)
  assert.ok(existsSync(ctx.persistence.path), '旧档案文件不能删')
  // repair 会重写并留 .bak；原文件仍在（内容可能被修）
  assert.ok(readFileSync(ctx.persistence.path).length > 0)
})

test('C4 / status.home：lastHeal {at,ok,code,from,to}', async (t) => {
  const ctx = openHeal()
  t.after(ctx.cleanup)
  const first = await firstHome(ctx)
  ctx.agents.resumeMode = 'alwaysFail'
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  const st = ctx.env.api.home.status(PERSONA)
  assert.equal(st.lastHeal.code, 'HEALED')
  assert.equal(st.lastHeal.ok, true)
  assert.equal(st.lastHeal.from, first.sessionId)
  assert.equal(st.lastHeal.to, r.sessionId)
  assert.ok(st.lastHeal.at)
})
