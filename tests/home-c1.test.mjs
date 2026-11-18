/**
 * C1 · home 骨架回归测试（2026-11-05）
 *
 * 钉住 6 件事：
 * 1. create/resume 必须带 agentOptions:{provider,model}（11-01 空回合事故根因）
 * 2. 拿不到默认模型 → NO_MODEL，不建/不 resume
 * 3. 并发叫醒只跑一个（第二个 IN_FLIGHT）
 * 4. cwd 指向 D-005 新家；旧 cwd 的会话不 resume，只留档
 * 5. dyHome.isHomeSession 正/负例
 * 6. home.enabled=false 完全不动；pause.all / dryRun 前置挡住
 *
 * 全部 fake agents / fake model / 临时库；不真调模型、不碰生产。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'

const PERSONA = 'self:test-home'
const MODEL = { provider: 'fake-provider', model: 'fake-model' }

function fakeModel(sel = MODEL) {
  return { currentSelection: () => sel }
}

function makeFakeAgents({ followupImpl = null } = {}) {
  const calls = { get: [], create: [], resume: [], followup: [], dispose: [] }
  const makeHandle = () => {
    const agent = {
      status: 'idle',
      async followup(msg) {
        calls.followup.push(msg)
        if (followupImpl) return followupImpl(msg)
        return { ok: true }
      },
      dispose() {
        calls.dispose.push('agent')
      },
    }
    return { agent }
  }
  let live = null
  return {
    calls,
    setLive(h) {
      live = h
    },
    get(id) {
      calls.get.push(id)
      return live
    },
    create(args) {
      calls.create.push(args)
      return makeHandle()
    },
    resume(args) {
      calls.resume.push(args)
      return makeHandle()
    },
  }
}

function openHome({ agents = makeFakeAgents(), model = fakeModel(), home = {}, cfg = {}, presets = null, extraServices = {} } = {}) {
  const tmp = makeTempDir('autonomy-home-')
  const homeDir = join(tmp.dir, 'home')
  const env = startPlugin({
    dir: tmp.dir,
    cfg: {
      enabled: true,
      dryRun: false,
      minTickGapMinutes: 0,
      ...cfg,
      home: { enabled: true, cwd: homeDir, minIntervalMin: 120, maxIntervalMin: 240, ...home },
    },
    services: { ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }), agents, agentDefaultModel: model, ...(presets ? { agentPresets: presets } : {}), ...extraServices },
    clock: makeClock(),
  })
  const cleanup = () => {
    env.cleanup()
    tmp.cleanup()
  }
  return { env, homeDir, agents, cleanup }
}

test('C1 / home.enabled=false：完全不动（不建表格/不建目录/不调 agents）', async (t) => {
  const agents = makeFakeAgents()
  const { env, homeDir, cleanup } = openHome({ agents, home: { enabled: false } })
  t.after(cleanup)

  const r = await env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'HOME_DISABLED')
  assert.equal(agents.calls.create.length, 0)
  assert.equal(agents.calls.resume.length, 0)
  assert.equal(agents.calls.followup.length, 0)
  assert.equal(existsSync(homeDir), false, '关着就不该建家目录')
  const tbl = env.api.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='home_sessions'").get()
  assert.equal(tbl, undefined, '关着就不该建 home_sessions 表')
  assert.equal(env.api.home.status(PERSONA).enabled, false)
})

test('C1 / create：带 agentOptions、新家 cwd、open-ended 叫醒', async (t) => {
  const agents = makeFakeAgents()
  const { env, homeDir, cleanup } = openHome({ agents })
  t.after(cleanup)

  const r = await env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.ok, true)
  assert.equal(r.code, 'AWAKENED')
  assert.equal(r.created, true)

  assert.equal(agents.calls.create.length, 1)
  const args = agents.calls.create[0]
  assert.match(args.sessionId, /^[0-9a-f-]{36}$/i)
  assert.deepEqual(args.agentOptions, MODEL, 'create 必须带 agentOptions:{provider,model}')
  assert.equal(args.meta.cwd, homeDir)
  assert.equal(args.meta.autonomyHome, true)
  assert.equal(args.meta.personaId, PERSONA)
  assert.equal(args.meta.agentPreset, 'standard', '默认 standard（setup 挂 preset 后工具集由宿主 catalog 决定）')

  assert.equal(existsSync(homeDir), true, 'cwd 不存在要创建')
  assert.equal(agents.calls.followup.length, 1)
  const wake = agents.calls.followup[0]
  const wakeText = Array.isArray(wake.content) ? wake.content.map((c) => c.text ?? '').join(' ') : String(wake.content)
  assert.equal(wake.source.kind, 'autonomy-home-wake')
  assert.ok(wakeText.includes('没有任务'), '叫醒词是 open-ended，不派活')
  assert.ok(wakeText.includes('都由你定'))
  assert.ok(!wakeText.includes('写日记'), '不强制写日记')

  const row = env.api.db.prepare('SELECT * FROM home_sessions WHERE persona_id=?').get(PERSONA)
  assert.equal(row.home_session_id, r.sessionId)
  assert.equal(row.cwd, homeDir)
  assert.equal(env.api.home.status(PERSONA).healthy, true)
})

test('C1 / resume：已有同 cwd 行 → 不 create，resume 带 agentOptions', async (t) => {
  const agents = makeFakeAgents()
  const { env, cleanup } = openHome({ agents })
  t.after(cleanup)

  const first = await env.api.home.awake({ personaId: PERSONA })
  assert.equal(first.code, 'AWAKENED')
  env.api.home.dispose() // 丢掉进程内 handle，强制走 resume

  const second = await env.api.home.awake({ personaId: PERSONA })
  assert.equal(second.code, 'AWAKENED')
  assert.equal(second.resumed, true)
  assert.equal(agents.calls.create.length, 1, '第二次不许再建')
  assert.equal(agents.calls.resume.length, 1)
  assert.equal(agents.calls.resume[0].resumeSessionId, first.sessionId)
  assert.deepEqual(agents.calls.resume[0].agentOptions, MODEL)
  assert.equal(agents.calls.resume[0].meta.cwd, env.api.home.cwd)
  assert.equal(agents.calls.resume[0].meta.agentPreset, 'standard')
})

test('C1 / NO_MODEL：拿不到默认模型 → 不建/不 resume/不 followup', async (t) => {
  const agents = makeFakeAgents()
  const { env, homeDir, cleanup } = openHome({ agents, model: fakeModel(null) })
  t.after(cleanup)

  const r = await env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_MODEL')
  assert.equal(agents.calls.create.length, 0)
  assert.equal(agents.calls.resume.length, 0)
  assert.equal(agents.calls.followup.length, 0)
  assert.equal(existsSync(homeDir), false, '没模型连目录都不建')
  const n = env.api.db.prepare('SELECT COUNT(1) AS n FROM home_sessions').get().n
  assert.equal(Number(n), 0)
})

test('C1 / 并发叫醒：只跑一个，第二个 IN_FLIGHT', async (t) => {
  let release
  const gate = new Promise((r) => {
    release = r
  })
  const agents = makeFakeAgents({ followupImpl: () => gate })
  const { env, cleanup } = openHome({ agents })
  t.after(cleanup)

  const p1 = env.api.home.awake({ personaId: PERSONA })
  const r2 = await env.api.home.awake({ personaId: PERSONA })
  assert.equal(r2.ok, false)
  assert.equal(r2.code, 'IN_FLIGHT')

  release()
  const r1 = await p1
  assert.equal(r1.code, 'AWAKENED')
  assert.equal(agents.calls.followup.length, 1, '并发时只有第一个真正 followup')
  assert.equal(agents.calls.create.length, 1)
})

test('C1 / dyHome.isHomeSession：正例/负例', async (t) => {
  const agents = makeFakeAgents()
  const { env, cleanup } = openHome({ agents })
  t.after(cleanup)

  const r = await env.api.home.awake({ personaId: PERSONA })
  const dyHome = env.provided.dyHome
  assert.ok(dyHome, 'dyHome 服务必须 provide')
  assert.equal(dyHome.version, 1)
  assert.equal(dyHome.isHomeSession(r.sessionId), true)
  assert.equal(dyHome.isHomeSession('some-other-session'), false)
  assert.equal(dyHome.isHomeSession(''), false)
})

test('C1 / 旧 cwd（e7f98e90）不 resume：新建接管，旧 id 留档', async (t) => {
  const agents = makeFakeAgents()
  const { env, homeDir, cleanup } = openHome({ agents })
  t.after(cleanup)

  const first = await env.api.home.awake({ personaId: PERSONA })
  assert.equal(first.code, 'AWAKENED')
  env.api.home.dispose()

  const oldId = 'e7f98e90-d650-4856-bcdf-39e1519629d5'
  env.api.db
    .prepare('UPDATE home_sessions SET home_session_id=?, cwd=? WHERE persona_id=?')
    .run(oldId, '/sdcard/Documents/Me', PERSONA)

  const second = await env.api.home.awake({ personaId: PERSONA })
  assert.equal(second.code, 'AWAKENED')
  assert.equal(second.created, true, '旧 cwd 不 resume，新建')
  assert.equal(agents.calls.resume.length, 0, '绝不允许 resume 旧 e7f98e90')
  assert.equal(agents.calls.create.length, 2)

  const row = env.api.db.prepare('SELECT * FROM home_sessions WHERE persona_id=?').get(PERSONA)
  assert.equal(row.cwd, homeDir)
  assert.notEqual(row.home_session_id, oldId)

  const raw = env.api.db.prepare("SELECT value FROM meta WHERE key='home.migratedFrom'").get()
  const history = JSON.parse(raw.value)
  assert.equal(history.at(-1).from, oldId)
  assert.equal(history.at(-1).to, row.home_session_id)
})

test('C1 / 总闸：pause.all → PAUSED；dryRun → DRY_RUN；都不调 agents', async (t) => {
  const agents = makeFakeAgents()
  const { env, cleanup } = openHome({ agents })
  t.after(cleanup)

  const now = env.clock.now()
  env.api.db
    .prepare("INSERT INTO meta(key,value,updated_at) VALUES('pause.all',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify({ on: true, until: null, by: 'test' }), now)

  const paused = await env.api.home.awake({ personaId: PERSONA })
  assert.equal(paused.ok, false)
  assert.equal(paused.code, 'PAUSED')
  assert.equal(agents.calls.create.length + agents.calls.resume.length, 0)

  // 解除暂停，但 dryRun=true（respectDryRun 默认 true）→ DRY_RUN
  env.api.db.prepare("UPDATE meta SET value=? WHERE key='pause.all'").run(JSON.stringify({ on: false, until: null }))
  env.api.cfg.dryRun = true
  const dry = await env.api.home.awake({ personaId: PERSONA })
  assert.equal(dry.ok, false)
  assert.equal(dry.code, 'DRY_RUN')
  assert.equal(agents.calls.create.length + agents.calls.resume.length, 0)
})


test('C1 / home.agentPreset 可覆盖；缺省 standard', async (t) => {
  const ctx = openHome({ home: { agentPreset: 'full' } })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(ctx.agents.calls.create[0].meta.agentPreset, 'full')
  assert.equal(ctx.env.api.cfg.home.agentPreset, 'full')
})


test('C1 / preset setup：create/resume 都带 setup，并 mount resolvedId', async (t) => {
  const mounts = []
  const resolves = []
  const presets = {
    async resolve(id) { resolves.push(id); return id ?? 'standard' },
    async mount(ctx, id) { mounts.push(id) },
  }
  const ctx = openHome({ presets })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  const create = ctx.agents.calls.create[0]
  assert.equal(typeof create.setup, 'function')
  assert.equal(create.meta.agentPreset, 'standard')
  await create.setup({}, {})
  assert.deepEqual(mounts, ['standard'])
  assert.deepEqual(resolves, ['standard'])
})

test('C1 / preset setup：resume 也传 setup', async (t) => {
  const mounts = []
  const presets = { async resolve(id) { return id ?? 'standard' }, async mount(ctx, id) { mounts.push(id) } }
  const ctx = openHome({ presets })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.env.api.home.dispose()
  await ctx.env.api.home.awake({ personaId: PERSONA })
  const resume = ctx.agents.calls.resume[0]
  assert.equal(typeof resume.setup, 'function')
  await resume.setup({}, {})
  assert.deepEqual(mounts, ['standard'])
})

test('C1 / preset setup：空配置 resolve(undefined)，缺服务不传 setup', async (t) => {
  const resolves = []
  const presets = { async resolve(id) { resolves.push(id); return id ?? 'default-x' }, async mount() {} }
  const ctx = openHome({ home: { agentPreset: '' }, presets })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.deepEqual(resolves, [undefined])
  assert.equal(ctx.agents.calls.create[0].meta.agentPreset, 'default-x')

  const ctx2 = openHome()
  t.after(ctx2.cleanup)
  await ctx2.env.api.home.awake({ personaId: PERSONA })
  assert.equal(ctx2.agents.calls.create[0].setup, undefined)
})

test('C1 / preset resolve 返回对象取 .id；字符串兼容；{} 回退配置', async (t) => {
  const mounts = []
  const objPresets = {
    async resolve() { return { id: 'standard' } },
    async mount(ctx, id) { mounts.push([ctx, id]) },
  }
  const c1 = openHome({ presets: objPresets })
  t.after(c1.cleanup)
  await c1.env.api.home.awake({ personaId: PERSONA })
  const create = c1.agents.calls.create[0]
  assert.equal(create.meta.agentPreset, 'standard')
  const sentinel = { marker: 'ctx' }
  await create.setup(sentinel, {})
  assert.deepEqual(mounts[0], [sentinel, 'standard'])

  const strPresets = { async resolve() { return 'ptc' }, async mount() {} }
  const c2 = openHome({ home: { agentPreset: 'standard' }, presets: strPresets })
  t.after(c2.cleanup)
  await c2.env.api.home.awake({ personaId: PERSONA })
  assert.equal(c2.agents.calls.create[0].meta.agentPreset, 'ptc')

  const emptyPresets = { async resolve() { return {} }, async mount() {} }
  const c3 = openHome({ home: { agentPreset: 'standard' }, presets: emptyPresets })
  t.after(c3.cleanup)
  await c3.env.api.home.awake({ personaId: PERSONA })
  assert.equal(c3.agents.calls.create[0].meta.agentPreset, 'standard')
})


test('C1 / workspace：匹配 cwd → attachSession 一次', async (t) => {
  let listPath = null
  const attached = []
  const registry = { list: () => [{ record: { path: listPath }, attachSession: async (id) => { attached.push(id) } }] }
  const ctx = openHome({ extraServices: { workspaceRegistry: registry } })
  t.after(ctx.cleanup)
  listPath = ctx.homeDir
  await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.deepEqual(attached, [ctx.env.api.home.status(PERSONA).sessionId])
})

test('C1 / workspace：无匹配 → 不调用、不报错', async (t) => {
  let called = 0
  const registry = { list: () => [{ record: { path: '/tmp/not-home' }, attachSession: async () => { called += 1 } }] }
  const ctx = openHome({ extraServices: { workspaceRegistry: registry } })
  t.after(ctx.cleanup)
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.code, 'AWAKENED')
  assert.equal(called, 0)
})

test('C1 / workspace：attach 抛错 → create 仍成功', async (t) => {
  let listPath = null
  const registry = { list: () => [{ record: { path: listPath }, attachSession: async () => { throw new Error('attach boom') } }] }
  const ctx = openHome({ extraServices: { workspaceRegistry: registry } })
  t.after(ctx.cleanup)
  listPath = ctx.homeDir
  const r = await ctx.env.api.home.awake({ personaId: PERSONA })
  assert.equal(r.code, 'AWAKENED')
  assert.equal(r.created, true)
})
