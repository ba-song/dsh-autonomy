/**
 * C2 · home 唤醒循环（2026-11-05）
 *
 * 钉住：enabled=false 不挂表 / 到点叫醒一次 / 并发不叠 / 失败重试 3 次上限 /
 * 启动补醒 / 状态卡字段与长度 / pause+dryRun 门 / 骰子默认关 / status.home 字段。
 * 全部 fake agents + fake model + 假调度器 + 临时库；不真调模型。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'
import { createHomeWakeLoop, buildWakeCard, HOME_WAKE_PROMPT, MAX_CARD_CHARS } from '../lib/run/home.js'

const PERSONA = 'self:test-c2'
const H = 3600_000
const MIN = 60_000

function fakeModel() {
  return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }
}

function makeFakeAgents({ followupImpl = null } = {}) {
  const calls = { get: [], create: [], resume: [], followup: [], dispose: [] }
  const makeHandle = () => ({
    agent: {
      status: 'idle',
      async followup(msg) {
        calls.followup.push(msg)
        if (followupImpl) return followupImpl(msg)
        return { ok: true }
      },
      dispose() {
        calls.dispose.push('agent')
      },
    },
  })
  return {
    calls,
    get: (id) => (calls.get.push(id), null),
    create: (a) => (calls.create.push(a), makeHandle()),
    resume: (a) => (calls.resume.push(a), makeHandle()),
  }
}

function makeScheduler() {
  let jobs = []
  let nextId = 1
  return {
    get jobs() {
      return jobs
    },
    setTimeout(fn, ms) {
      const id = nextId++
      jobs.push({ id, fn, ms })
      return id
    },
    clearTimeout(id) {
      jobs = jobs.filter((j) => j.id !== id)
    },
    fire() {
      const j = jobs.shift()
      return j ? j.fn() : null
    },
  }
}

function openLoop({ home = {}, cfg = {}, agents = makeFakeAgents(), persona = null } = {}) {
  const tmp = makeTempDir('autonomy-c2-')
  const homeDir = join(tmp.dir, 'home')
  const env = startPlugin({
    dir: tmp.dir,
    cfg: {
      enabled: true,
      dryRun: false,
      minTickGapMinutes: 0,
      ...cfg,
      home: { enabled: true, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60, ...home },
    },
    services: {
      ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: mockMemory() }),
      agents,
      agentDefaultModel: fakeModel(),
    },
    clock: makeClock(),
  })
  const scheduler = makeScheduler()
  const loop = createHomeWakeLoop({
    home: env.api.home,
    db: env.api.db,
    cfg: env.api.cfg,
    clock: env.clock.now,
    persona: persona ?? { displayName: () => '杨汐', emotionState: () => ({ label: '平静', intensity: 0.2 }) },
    random: () => 0.5,
    scheduler,
    getPersonaId: () => PERSONA,
    log: { info() {}, warn() {} },
  })
  const cleanup = () => {
    loop.dispose()
    env.cleanup()
    tmp.cleanup()
  }
  return { env, agents, loop, scheduler, homeDir, cleanup }
}

function seedMeta(env, key, value, at = env.clock.now()) {
  env.api.db
    .prepare("INSERT INTO meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .run(key, JSON.stringify(value), at)
}

test('C2 / home.enabled=false：不挂表、不排期', () => {
  const { env, loop, scheduler, cleanup } = openLoop({ home: { enabled: false } })
  try {
    assert.equal(loop.start(), false)
    assert.equal(loop.status().armed, false)
    assert.equal(scheduler.jobs.length, 0)
    assert.equal(env.api.homeWakeState().armed, false)
  } finally {
    cleanup()
  }
})

test('C2 / 到点叫醒一次（启动补醒 → fire → AWAKENED）', async () => {
  const { env, agents, loop, scheduler, cleanup } = openLoop()
  try {
    assert.equal(loop.start(), true)
    assert.equal(scheduler.jobs.length, 1)
    assert.equal(scheduler.jobs[0].ms, 15_000, '启动补醒延迟 15s（避开 provider 初始化）')

    const r = await scheduler.fire()
    assert.equal(r.code, 'AWAKENED')
    assert.equal(agents.calls.followup.length, 1)
    const wake = agents.calls.followup[0]
    const wakeText = Array.isArray(wake.content) ? wake.content.map((c) => c.text ?? '').join(' ') : String(wake.content)
    assert.ok(wakeText.startsWith(HOME_WAKE_PROMPT))
    assert.ok(wakeText.includes('【现在】'), '叫醒词后面带状态卡')

    const st = loop.status()
    assert.equal(st.armed, true)
    assert.equal(st.lastCode, 'AWAKENED')
    assert.ok(st.nextWakeAt > env.clock.now())
    const meta = JSON.parse(env.api.db.prepare("SELECT value FROM meta WHERE key='home.lastWake'").get().value)
    assert.equal(meta.code, 'AWAKENED')
    assert.ok(meta.sessionId)
  } finally {
    cleanup()
  }
})

test('C2 / 并发不叠：两个 tickOnce 只 followup 一次', async (t) => {
  let release
  const gate = new Promise((r) => {
    release = r
  })
  const agents = makeFakeAgents({ followupImpl: () => gate })
  const { loop, cleanup } = openLoop({ agents })
  t.after(cleanup)

  const p1 = loop.tickOnce()
  const r2 = await loop.tickOnce()
  assert.equal(r2.code, 'IN_FLIGHT')
  release()
  const r1 = await p1
  assert.equal(r1.code, 'AWAKENED')
  assert.equal(agents.calls.followup.length, 1)
  assert.equal(agents.calls.create.length, 1)
})

test('C2 / 失败短重试：3 次后回到正常间隔，不自动换会话', async (t) => {
  const agents = makeFakeAgents({
    followupImpl: () => {
      throw new Error('transport down')
    },
  })
  const { env, loop, scheduler, cleanup } = openLoop({ agents })
  t.after(cleanup)

  loop.start()
  const r1 = await scheduler.fire()
  assert.equal(r1.code, 'AWAKE_FAILED')
  assert.equal(scheduler.jobs.at(-1).ms, 60_000, '第一次失败 60s 后重试')

  const r2 = await scheduler.fire()
  assert.equal(r2.code, 'AWAKE_FAILED')
  assert.equal(scheduler.jobs.at(-1).ms, 120_000, '第二次失败 120s 后重试')

  const r3 = await scheduler.fire()
  assert.equal(r3.code, 'AWAKE_FAILED')
  assert.ok(scheduler.jobs.at(-1).ms >= 60 * MIN, '第三次仍失败 → 回正常周期')
  assert.equal(agents.calls.followup.length, 3, '初试 + 2 次重试')
  assert.equal(agents.calls.create.length, 1, '不自动换会话')
  const meta = JSON.parse(env.api.db.prepare("SELECT value FROM meta WHERE key='home.lastWake'").get().value)
  assert.equal(meta.code, 'AWAKE_FAILED')
})

test('C2 / 启动补醒：超一个间隔才补；刚醒过按正常间隔', () => {
  const first = openLoop()
  try {
    seedMeta(first.env, 'home.lastWake', { at: first.env.clock.now() - 5 * H, code: 'AWAKENED' })
    first.loop.start()
    assert.equal(first.scheduler.jobs[0].ms, 15_000, '5h 没醒 → 启动延迟 15s 后补一次')
  } finally {
    first.cleanup()
  }

  const second = openLoop()
  try {
    seedMeta(second.env, 'home.lastWake', { at: second.env.clock.now() - 10 * MIN, code: 'AWAKENED' })
    second.loop.start()
    assert.equal(second.scheduler.jobs[0].ms, 60 * MIN, '10 分钟前刚醒 → 正常等一个间隔')
  } finally {
    second.cleanup()
  }
})

test('C2 / 状态卡：字段齐全、≤500 字、跟着叫醒词走', async (t) => {
  const { env, agents, loop, scheduler, cleanup } = openLoop()
  t.after(cleanup)
  const now = env.clock.now()
  const db = env.api.db

  const insDrive = db.prepare('INSERT INTO drives(self_id,name,value,baseline,growth,updated_at) VALUES(?,?,?,?,?,?)')
  insDrive.run(PERSONA, 'curiosity', 0.83, 0.45, 0.05, now)
  insDrive.run(PERSONA, 'social', 0.56, 0.4, 0.04, now)
  db.prepare('INSERT INTO goals(id,self_id,title,note,source,priority,status,kind_hint,due_at,last_touched_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('g1', PERSONA, '把家收拾好', null, 'self', 0.9, 'open', null, null, now, now, now)
  db.prepare('INSERT INTO actions(id,self_id,kind,status,risk,result_json,created_at,ended_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('a1', PERSONA, 'read_archive', 'done', 'low', JSON.stringify({ simulated: true }), now - H, now - H)
  db.prepare('INSERT INTO reflections(self_id,at,period,status,trigger,importance,window_start,window_end,evidence_json,text) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(PERSONA, now - H, 'threshold', 'pending', 'DAILY', 3, now - 2 * H, now - H, '[]', null)

  const card = buildWakeCard({ db, persona: { displayName: () => '杨汐', emotionState: () => ({ label: '平静', intensity: 0.2 }) }, cfg: env.api.cfg, personaId: PERSONA, now })
  for (const tag of ['【现在】', '【我】', '【心情】', '【目标】', '【最近行动】', '【最近会话】', '【反思】']) {
    assert.ok(card.includes(tag), `状态卡缺 ${tag}`)
  }
  assert.ok(card.length <= MAX_CARD_CHARS)
  assert.ok(card.includes('杨汐'))
  assert.ok(card.includes('把家收拾好'))
  assert.ok(card.includes('模拟'))
  assert.ok(card.includes('1 条 pending'))

  loop.start()
  const r = await scheduler.fire()
  assert.equal(r.code, 'AWAKENED')
  const raw = agents.calls.followup[0].content
  const content = Array.isArray(raw) ? raw.map((c) => c.text ?? '').join(' ') : String(raw)
  assert.ok(content.includes('【现在】') && content.includes('【我】'))
})

test('C2 / 总闸：pause.all → PAUSED；dryRun → DRY_RUN', async (t) => {
  const { env, agents, loop, cleanup } = openLoop()
  t.after(cleanup)

  seedMeta(env, 'pause.all', { on: true, until: null, by: 'test' })
  const p = await loop.tickOnce()
  assert.equal(p.code, 'PAUSED')
  assert.equal(agents.calls.followup.length, 0)

  seedMeta(env, 'pause.all', { on: false, until: null })
  env.api.cfg.dryRun = true
  const d = await loop.tickOnce()
  assert.equal(d.code, 'DRY_RUN')
  assert.equal(agents.calls.followup.length, 0)
})

test('C2 / 骰子默认关（只留配置位，不做加权）', () => {
  const { env, loop, cleanup } = openLoop()
  try {
    assert.equal(loop.status().diceEnabled, false)
    env.api.cfg.home.dice.enabled = true
    const second = createHomeWakeLoop({
      home: env.api.home,
      db: env.api.db,
      cfg: env.api.cfg,
      clock: env.clock.now,
      scheduler: makeScheduler(),
      getPersonaId: () => PERSONA,
    })
    assert.equal(second.status().diceEnabled, true)
    second.dispose()
  } finally {
    cleanup()
  }
})

test('C2 / status.home：enabled/cwd/sessionId/nextWakeAt/lastWake/lastCode/inFlight', async (t) => {
  const { env, loop, scheduler, cleanup } = openLoop()
  t.after(cleanup)

  loop.start()
  await scheduler.fire()
  const st = loop.status()
  assert.equal(st.enabled, true)
  assert.equal(st.armed, true)
  assert.equal(typeof st.nextWakeAt, 'number')
  assert.equal(st.lastCode, 'AWAKENED')
  assert.ok(st.lastWake?.at)
  assert.equal(st.inFlight, false)
  assert.equal(st.intervalMin, 60)
  assert.equal(st.intervalMax, 60)
  assert.equal(env.api.home.status(PERSONA).sessionId, st.lastWake.sessionId)
})
