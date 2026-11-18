/**
 * 抖音私信/互动消息 → 会话路由（douyinInbox）
 *
 * 标准（2026-11-14，与 dsh-channel-bridge 的 QQ 标准一致）：
 * 1. 主人事件 → home.deliver（channel=douyin、priority=owner），**不另开会话**；
 * 2. 非主人事件 → **每个联系人/会话一个独立 agent 会话**（agents.create/resume + agentOptions + per-key cwd），**不碰 home**；
 * 3. 首轮基线不投递；4. 同一事件去重只投一次，**不跨会话**；5. 无 agents/model 时明确 UNAVAILABLE；
 * 6. 重启/恢复：同一 key 复用；resume 失败新建并把旧 id 留档。
 *
 * 全部用 fake agents/home/service + 临时库，不连 SSH/真实 home/真实 agents。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { openDb } from '../lib/store/db.js'
import { createDouyinInbox, DOUYIN_OTHERS_KEY, formatDouyinEventLine } from '../lib/run/douyin-inbox.js'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'

const MODEL = { provider: 'deepseek-account', model: 'deepseek-flash' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const textOf = (m) => (Array.isArray(m?.content) ? m.content.map((c) => c.text ?? '').join(' ') : String(m?.content ?? ''))

const ownerEvent = (overrides = {}) => ({
  type: 'dm_message',
  kind: 'dm_message',
  id: 'dme_owner_1',
  owner: true,
  isOwner: true,
  fromMe: false,
  conversationId: 'conv-owner',
  conversationName: '饲养员',
  sender: '饲养员',
  text: '在吗',
  preview: '在吗',
  time: '刚刚',
  dedupeKey: 'fp-owner-1',
  ...overrides,
})

const otherEvent = (overrides = {}) => ({
  type: 'dm_message',
  kind: 'dm_message',
  id: 'dme_other_1',
  owner: false,
  isOwner: false,
  fromMe: false,
  conversationId: 'conv-other',
  conversationName: '小李',
  sender: '小李',
  text: '你好',
  preview: '你好',
  time: '1分钟前',
  dedupeKey: 'fp-other-1',
  ...overrides,
})

/** 指定联系人/会话的事件（每个 conversationId 一个独立会话） */
const contactEvent = (conversationId, name, overrides = {}) =>
  otherEvent({
    id: `dme_${conversationId}`,
    conversationId,
    conversationName: name,
    sender: name,
    dedupeKey: `fp-${conversationId}`,
    ...overrides,
  })

/** 假 agents：按 sessionId 存 agent，create/resume 都能被 get 命中（模拟宿主 live 会话） */
function makeFakeAgents() {
  const calls = { create: [], resume: [], get: [], followup: [], dispose: [] }
  const byId = new Map()
  const mkAgent = () => ({
    status: 'idle',
    session: { log: [] }, // 宿主内存事件日志（自动回复走 session.log 兜底扫描）
    async followup(m) {
      calls.followup.push(m)
      return { ok: true }
    },
    dispose() {
      calls.dispose.push(1)
    },
  })
  return {
    calls,
    byId,
    get: async (id) => {
      calls.get.push(id)
      const agent = byId.get(String(id))
      return agent ? { agent } : null
    },
    create: async (args) => {
      calls.create.push(args)
      const agent = mkAgent()
      byId.set(String(args.sessionId), agent)
      return { agent }
    },
    resume: async (args) => {
      calls.resume.push(args)
      const agent = mkAgent()
      byId.set(String(args.resumeSessionId), agent)
      return { agent }
    },
  }
}

function makeFakeHome({ result = null } = {}) {
  const calls = []
  return {
    calls,
    async deliver(payload) {
      calls.push(payload)
      return result ?? { ok: true, delivered: true, code: 'DELIVERED' }
    },
  }
}

/** 假 dyDouyin：轮询按批返回事件；也可收集订阅回调；dmSend 只记录不真发 */
function makeFakeService({
  batches = [],
  primed = false,
  subscribe = true,
  dmSendResult = null,
  notifySubscribe = true,
  notifyPrimed = true,
} = {}) {
  const calls = { poll: [], status: 0, subscribe: 0, notifySubscribe: 0, dmSend: [] }
  const queue = batches.map((b) => [...b])
  const subs = new Set()
  const notifySubs = new Set()
  let sourcePrimed = primed
  let notifySourcePrimed = notifyPrimed
  let sendResult = dmSendResult
  const service = {
    dmWatchStatus: () => {
      calls.status += 1
      return { primed: sourcePrimed, running: true, cfgEnabled: true }
    },
    dmWatch: async (args = {}) => {
      calls.poll.push(args)
      if (args.action === 'poll') {
        const events = queue.length ? queue.shift() : []
        sourcePrimed = true
        return { ok: true, events, count: events.length, primed: true }
      }
      return { ok: true, events: [], count: 0, primed: sourcePrimed }
    },
    dmSend: async (args = {}) => {
      calls.dmSend.push(args)
      return sendResult ?? { ok: true, action: 'dm_send', verified: true, result: 'sent', conversation: { id: args?.conversationId ?? null } }
    },
    // 通知事件源（契约：notifyWatchSubscribe / notifyWatchStatus）
    notifyWatchStatus: () => ({ primed: notifySourcePrimed, running: true, cfgEnabled: true }),
  }
  if (subscribe) {
    service.dmWatchSubscribe = (fn) => {
      calls.subscribe += 1
      subs.add(fn)
      return () => subs.delete(fn)
    }
  }
  if (notifySubscribe) {
    service.notifyWatchSubscribe = (fn) => {
      calls.notifySubscribe += 1
      notifySubs.add(fn)
      return () => notifySubs.delete(fn)
    }
  }
  return {
    service,
    calls,
    setDmSendResult(result) {
      sendResult = result
    },
    setNotifyPrimed(value) {
      notifySourcePrimed = value
    },
    emit(event) {
      for (const fn of [...subs]) fn(event)
    },
    emitNotify(event) {
      for (const fn of [...notifySubs]) fn(event)
    },
    get subCount() {
      return subs.size
    },
    get notifySubCount() {
      return notifySubs.size
    },
  }
}

/** 通知事件（契约字段：id/actor/type/text/time/ageMs/isOwner/replyable） */
const notifyEvent = (overrides = {}) => ({
  id: 'ntf_1',
  actor: '路人甲',
  type: 'mention',
  text: '提到了你',
  time: '刚刚',
  ageMs: 30_000,
  isOwner: false,
  replyable: true,
  ...overrides,
})

/** 起一个只含 douyinInbox 的测试实例（临时 DB + 临时 cwd） */
function makeInbox({ service = null, agents = null, home = null, model = MODEL, cfg = {} } = {}) {
  const tmp = makeTempDir('douyin-inbox-')
  const dbInfo = openDb({ dbPath: join(tmp.dir, 'autonomy.db') })
  const clock = makeClock()
  const inbox = createDouyinInbox({
    db: dbInfo.db,
    cfg: { enabled: true, respectDryRun: false, cwd: join(tmp.dir, 'douyin'), cwdRoot: tmp.dir, attachRetryMs: 60_000, pollMs: 3_000, ...cfg },
    getService: () => service,
    getHome: () => home,
    getAgents: () => agents,
    getDefaultModel: () => model,
    getPresets: () => null,
    getDryRun: () => false,
    clock: clock.now,
    log: null,
  })
  const cleanup = () => {
    try {
      inbox.dispose()
    } catch {}
    try {
      dbInfo.close()
    } catch {}
    tmp.cleanup()
  }
  return { inbox, db: dbInfo.db, tmp, clock, cleanup }
}

async function waitFor(fn, timeoutMs = 2000) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** 宿主 session/event 形状：assistant/message（含 reasoning/tool 分块，用于验证不外发推理） */
const assistantEvent = (text, extraParts = []) => ({
  type: 'assistant/message',
  data: {
    turn: 1,
    step: 0,
    message: {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '这是内部推理，绝不能外发' },
        { type: 'tool-call', name: 'dy_douyin_dm_list' },
        ...(text ? [{ type: 'text', text }] : []),
        ...extraParts,
      ],
    },
  },
})
const turnEndEvent = (data = {}) => ({ type: 'turn/end', data: { turn: 1, ok: true, ...data } })
const sessionRef = (sessionId) => ({ header: { id: sessionId } })

// ── 1. 主人 → home ────────────────────────────────────────

test('douyinInbox / 主人事件 → home.deliver（channel=douyin、priority=owner），不建独立会话', async (t) => {
  const home = makeFakeHome()
  const agents = makeFakeAgents()
  const ctx = makeInbox({ home, agents })
  t.after(ctx.cleanup)

  const r = await ctx.inbox.handleEvent(ownerEvent())
  assert.equal(r.ok, true)
  assert.equal(r.route, 'home')
  assert.equal(r.owner, true)
  assert.equal(home.calls.length, 1)
  const payload = home.calls[0]
  assert.equal(payload.channel, 'douyin')
  assert.equal(payload.kind, 'private')
  assert.equal(payload.priority, 'owner')
  assert.equal(payload.contactId, 'conv-owner')
  assert.equal(payload.contactName, '饲养员')
  assert.match(payload.text, /饲养员/)
  assert.match(payload.text, /在吗/)
  assert.equal(payload.messageId, 'dme_owner_1')
  // 主人消息绝不另开抖音会话
  assert.equal(agents.calls.create.length, 0)
  assert.equal(agents.calls.followup.length, 0)
  assert.equal(ctx.db.prepare("SELECT COUNT(1) n FROM sqlite_master WHERE type='table' AND name='douyin_sessions'").get().n, 0)
})

test('douyinInbox / home 拒收时返回错误码、记 stats，不静默吞', async (t) => {
  const home = makeFakeHome({ result: { ok: false, code: 'PAUSED' } })
  const ctx = makeInbox({ home, agents: makeFakeAgents() })
  t.after(ctx.cleanup)

  const r = await ctx.inbox.handleEvent(ownerEvent())
  assert.equal(r.ok, false)
  assert.equal(r.code, 'PAUSED')
  assert.equal(r.route, 'home')
  assert.equal(ctx.inbox.status().stats.failed, 1)
  assert.equal(ctx.inbox.status().stats.lastCode, 'PAUSED')
})

// ── 2. 非主人 → 独立会话 ─────────────────────────────────

test('douyinInbox / 非主人事件 → 统一抖音会话（create + agentOptions + 固定 cwd），不进 home', async (t) => {
  const home = makeFakeHome()
  const agents = makeFakeAgents()
  const ctx = makeInbox({ home, agents })
  t.after(ctx.cleanup)
  const key = DOUYIN_OTHERS_KEY
  const cwd = join(ctx.tmp.dir, 'douyin')

  const r = await ctx.inbox.handleEvent(otherEvent())
  assert.equal(r.ok, true)
  assert.equal(r.route, 'others')
  assert.equal(r.owner, false)
  assert.equal(r.key, key)
  assert.equal(r.replyTarget, 'conv-other')
  assert.equal(home.calls.length, 0, '非主人消息绝不能进 home')

  assert.equal(agents.calls.create.length, 1)
  const args = agents.calls.create[0]
  assert.match(args.sessionId, UUID)
  assert.deepEqual(args.agentOptions, MODEL, 'create 必须带 agentOptions（11-01 事故根因）')
  assert.equal(args.meta.cwd, cwd, '统一 cwd，不按联系人拆子目录')
  assert.equal(args.meta.autonomyDouyinInbox, true)
  assert.equal(args.meta.douyinKey, key)

  assert.equal(agents.calls.followup.length, 1)
  const msg = agents.calls.followup[0]
  assert.equal(msg.role, 'user')
  assert.ok(Array.isArray(msg.content))
  assert.match(textOf(msg), /小李/)
  assert.match(textOf(msg), /你好/)
  assert.equal(msg.source.kind, 'user')
  assert.equal(msg.source.channelInbound, true)
  assert.equal(msg.source.channel, 'douyin')
  assert.equal(msg.source.contactId, 'conv-other', '消息里保留各自的 conversationId')
  assert.equal(msg.source.contactName, '小李', '消息里保留各自的 contactName')
  assert.equal(msg.source.scope, key)
  assert.equal(msg.source.key, key)
  assert.equal(msg.source.owner, false)
  assert.equal(formatDouyinEventLine({ conversationName: '小李', text: '你好', time: '1分钟前' }), '【抖音私信】小李：你好（1分钟前）')

  const row = ctx.db.prepare('SELECT * FROM douyin_sessions WHERE key=?').get(key)
  assert.ok(row, '会话指针必须落库')
  assert.equal(row.session_id, args.sessionId)
  assert.equal(row.cwd, cwd)
  assert.equal(row.messages, 1)
  assert.equal(ctx.inbox.status().sessions.lastSessionId, args.sessionId)
  assert.equal(ctx.inbox.status().sessions.active, 1)
  assert.equal(ctx.inbox.status().replies.pending, 1)
  assert.equal(ctx.inbox.status().replies.pendingTargets, 1)
})

test('douyinInbox / 两个不同联系人 → 同一个会话（总接待室），各自 conversationId 保留', async (t) => {
  const home = makeFakeHome()
  const agents = makeFakeAgents()
  const ctx = makeInbox({ home, agents })
  t.after(ctx.cleanup)
  const cwd = join(ctx.tmp.dir, 'douyin')

  await ctx.inbox.handleEvent(contactEvent('dmc_aaa', '小李'))
  await ctx.inbox.handleEvent(contactEvent('dmc_bbb', '小王', { text: '另一条' }))

  assert.equal(home.calls.length, 0)
  assert.equal(agents.calls.create.length, 1, '所有非主人共用一个会话')
  assert.equal(agents.calls.create[0].meta.cwd, cwd)
  assert.equal(agents.calls.create[0].meta.douyinKey, DOUYIN_OTHERS_KEY)
  assert.equal(agents.calls.followup.length, 2, '按到达顺序都进同一个会话')
  assert.match(textOf(agents.calls.followup[0]), /小李/)
  assert.match(textOf(agents.calls.followup[1]), /小王/)
  assert.equal(agents.calls.followup[0].source.contactId, 'dmc_aaa')
  assert.equal(agents.calls.followup[1].source.contactId, 'dmc_bbb')
  assert.equal(agents.calls.followup[0].source.contactName, '小李')
  assert.equal(agents.calls.followup[1].source.contactName, '小王')
  const rows = ctx.db.prepare('SELECT key, session_id, cwd FROM douyin_sessions').all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].key, DOUYIN_OTHERS_KEY)
  assert.equal(rows[0].cwd, cwd)
  assert.equal(ctx.inbox.status().sessions.active, 1)
  assert.equal(ctx.inbox.status().replies.pending, 2, '两条入站各自保留待回复状态')
  assert.equal(ctx.inbox.status().replies.pendingTargets, 2)
})

test('douyinInbox / 同一联系人连续消息复用同一会话（不重复 create）', async (t) => {
  const agents = makeFakeAgents()
  const ctx = makeInbox({ home: makeFakeHome(), agents })
  t.after(ctx.cleanup)
  const key = DOUYIN_OTHERS_KEY

  await ctx.inbox.handleEvent(otherEvent())
  const r2 = await ctx.inbox.handleEvent(otherEvent({ id: 'dme_other_2', dedupeKey: 'fp-other-2', text: '第二句' }))
  assert.equal(r2.ok, true)
  assert.equal(r2.key, key)
  assert.equal(agents.calls.create.length, 1, '同一会话')
  assert.equal(agents.calls.resume.length, 0)
  assert.equal(agents.calls.followup.length, 2)
  assert.match(textOf(agents.calls.followup[1]), /第二句/)
  assert.equal(ctx.db.prepare('SELECT messages FROM douyin_sessions WHERE key=?').get(key).messages, 2)
  assert.equal(ctx.inbox.status().replies.pending, 2)
})

test('douyinInbox / 重启恢复：统一会话有指针、live 不在 → agents.resume（带 agentOptions）', async (t) => {
  const agents = makeFakeAgents()
  const tmp = makeTempDir('douyin-inbox-')
  const dbInfo = openDb({ dbPath: join(tmp.dir, 'autonomy.db') })
  const clock = makeClock()
  const base = join(tmp.dir, 'douyin')
  const key = DOUYIN_OTHERS_KEY
  const cwd = base
  const now = clock.now()
  dbInfo.db.exec(`CREATE TABLE IF NOT EXISTS douyin_sessions (
    key TEXT PRIMARY KEY, conversation_id TEXT, contact_name TEXT,
    session_id TEXT NOT NULL, prev_session_id TEXT, cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
    messages INTEGER NOT NULL DEFAULT 0, replaced_count INTEGER NOT NULL DEFAULT 0)`)
  dbInfo.db
    .prepare(
      'INSERT INTO douyin_sessions(key, conversation_id, contact_name, session_id, prev_session_id, cwd, created_at, last_seen_at, messages, replaced_count) VALUES(?,?,?,?,NULL,?,?,?,0,0)',
    )
    .run(key, 'conv-other', '小李', 'sess-old-1', cwd, now, now)
  const inbox = createDouyinInbox({
    db: dbInfo.db,
    cfg: { enabled: true, respectDryRun: false, cwd: base, cwdRoot: tmp.dir },
    getHome: () => makeFakeHome(),
    getAgents: () => agents,
    getDefaultModel: () => MODEL,
    getPresets: () => null,
    getDryRun: () => false,
    clock: clock.now,
    log: null,
  })
  t.after(() => {
    try {
      inbox.dispose()
    } catch {}
    try {
      dbInfo.close()
    } catch {}
    tmp.cleanup()
  })

  const r = await inbox.handleEvent(otherEvent({ dedupeKey: 'fp-other-resume' }))
  assert.equal(r.ok, true)
  assert.equal(r.key, key)
  assert.equal(agents.calls.resume.length, 1)
  assert.equal(agents.calls.resume[0].resumeSessionId, 'sess-old-1')
  assert.deepEqual(agents.calls.resume[0].agentOptions, MODEL)
  assert.equal(agents.calls.resume[0].meta.autonomyDouyinInbox, true)
  assert.equal(agents.calls.resume[0].meta.douyinKey, key)
  assert.equal(agents.calls.resume[0].meta.cwd, cwd)
  assert.equal(agents.calls.create.length, 0)
  assert.equal(agents.calls.followup.length, 1)
  assert.equal(inbox.status().stats.sessionResumed, 1)
})

test('douyinInbox / resume 失败 → 新建接管，旧 session id 留档（prev_session_id）', async (t) => {
  const agents = makeFakeAgents()
  agents.resume = async (args) => {
    agents.calls.resume.push(args)
    throw new Error('resume boom')
  }
  const tmp = makeTempDir('douyin-inbox-')
  const dbInfo = openDb({ dbPath: join(tmp.dir, 'autonomy.db') })
  const clock = makeClock()
  const base = join(tmp.dir, 'douyin')
  const key = DOUYIN_OTHERS_KEY
  const now = clock.now()
  dbInfo.db.exec(`CREATE TABLE IF NOT EXISTS douyin_sessions (
    key TEXT PRIMARY KEY, conversation_id TEXT, contact_name TEXT,
    session_id TEXT NOT NULL, prev_session_id TEXT, cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
    messages INTEGER NOT NULL DEFAULT 0, replaced_count INTEGER NOT NULL DEFAULT 0)`)
  dbInfo.db
    .prepare(
      'INSERT INTO douyin_sessions(key, conversation_id, contact_name, session_id, prev_session_id, cwd, created_at, last_seen_at, messages, replaced_count) VALUES(?,?,?,?,NULL,?,?,?,0,0)',
    )
    .run(key, null, null, 'sess-old-2', base, now, now)
  const inbox = createDouyinInbox({
    db: dbInfo.db,
    cfg: { enabled: true, respectDryRun: false, cwd: base, cwdRoot: tmp.dir },
    getHome: () => makeFakeHome(),
    getAgents: () => agents,
    getDefaultModel: () => MODEL,
    getPresets: () => null,
    getDryRun: () => false,
    clock: clock.now,
    log: null,
  })
  t.after(() => {
    try {
      inbox.dispose()
    } catch {}
    try {
      dbInfo.close()
    } catch {}
    tmp.cleanup()
  })

  const r = await inbox.handleEvent(otherEvent({ dedupeKey: 'fp-other-replace' }))
  assert.equal(r.ok, true)
  assert.equal(r.key, key)
  assert.equal(agents.calls.resume.length, 1)
  assert.equal(agents.calls.create.length, 1)
  const created = agents.calls.create[0]
  assert.equal(created.meta.douyinKey, key)
  const row = dbInfo.db.prepare('SELECT * FROM douyin_sessions WHERE key=?').get(key)
  assert.equal(row.session_id, created.sessionId, '新会话接管')
  assert.equal(row.prev_session_id, 'sess-old-2', '旧 id 留档')
  assert.equal(row.replaced_count, 1)
  assert.equal(inbox.status().stats.sessionReplaced, 1)
  const archived = JSON.parse(dbInfo.db.prepare("SELECT value FROM meta WHERE key='douyin.inbox.replacedFrom'").get().value)
  assert.equal(archived.at(-1).key, key)
  assert.equal(archived.at(-1).from, 'sess-old-2')
  assert.equal(archived.at(-1).to, created.sessionId)
})

// ── 3. 首轮基线不投 ──────────────────────────────────────

test('douyinInbox / 首轮基线不投递，第二轮才投新事件', async (t) => {
  const home = makeFakeHome()
  const agents = makeFakeAgents()
  const fake = makeFakeService({ batches: [[ownerEvent(), otherEvent()], [ownerEvent({ id: 'dme_owner_2', dedupeKey: 'fp-owner-2', text: '新消息' })]] })
  const ctx = makeInbox({ home, agents, service: fake.service })
  t.after(ctx.cleanup)

  const first = await ctx.inbox.pollOnce()
  assert.equal(first.ok, true)
  assert.equal(first.baseline, true)
  assert.equal(first.baselineSkipped, 2)
  assert.equal(home.calls.length, 0, '基线事件不投 home')
  assert.equal(agents.calls.followup.length, 0, '基线事件不建会话')
  assert.equal(ctx.inbox.status().stats.baselineSkipped, 2)

  const second = await ctx.inbox.pollOnce()
  assert.equal(second.baseline, false)
  assert.equal(second.count, 1)
  assert.equal(home.calls.length, 1, '第二轮的新主人事件投 home')
  assert.match(home.calls[0].text, /新消息/)
})

// ── 4. 重复事件不投 ──────────────────────────────────────

test('douyinInbox / 同一事件重复投递被去重（订阅 + 轮询都算）', async (t) => {
  const home = makeFakeHome()
  const ev = ownerEvent({ dedupeKey: 'fp-dedupe-1' })
  const fake = makeFakeService({ batches: [[], [ev]] })
  const ctx = makeInbox({ home, agents: makeFakeAgents(), service: fake.service })
  t.after(ctx.cleanup)

  const first = await ctx.inbox.pollOnce() // 基线（0 条）
  assert.equal(first.baseline, true)
  const second = await ctx.inbox.pollOnce() // 投第一条
  assert.equal(second.count, 1)
  assert.equal(home.calls.length, 1)

  // 同一事件再从订阅通道进来 / 再被轮询取到：都不再投
  const dup1 = await ctx.inbox.handleEvent(ev)
  assert.equal(dup1.deduped, true)
  assert.equal(dup1.code, 'DEDUPED')
  const dup2 = await ctx.inbox.pollOnce({})
  // 第三批为空；重复事件本轮没有，但如果服务重复吐同一条也必须去掉
  assert.equal(home.calls.length, 1)
  assert.equal(ctx.inbox.status().stats.deduped, 1)
  void dup2
})

test('douyinInbox / 轮询重复返回同一事件时只投一次', async (t) => {
  const home = makeFakeHome()
  const ev = ownerEvent({ dedupeKey: 'fp-repeat-1' })
  const fake = makeFakeService({ batches: [[], [ev], [ev]] })
  const ctx = makeInbox({ home, agents: makeFakeAgents(), service: fake.service })
  t.after(ctx.cleanup)

  await ctx.inbox.pollOnce() // 基线
  await ctx.inbox.pollOnce() // 投
  const third = await ctx.inbox.pollOnce() // 服务重复吐同一条
  assert.equal(third.count, 1)
  assert.equal(third.delivered, 0)
  assert.equal(home.calls.length, 1)
  assert.equal(ctx.inbox.status().stats.deduped, 1)
})

test('douyinInbox / 去重：id 优先；无 id 时 conversationId+dedupeKey，跨联系人相同指纹不误判', async (t) => {
  const home = makeFakeHome()
  const ctx = makeInbox({ home, agents: makeFakeAgents() })
  t.after(ctx.cleanup)

  // 有 id：不同联系人同 dedupeKey/文案 → 各投一次（id 已含会话指纹，天然不同）
  const a = ownerEvent({ id: 'x1', conversationId: 'dmc_aaa', dedupeKey: 'same-fp', text: '同文案' })
  const b = ownerEvent({ id: 'x2', conversationId: 'dmc_bbb', dedupeKey: 'same-fp', text: '同文案' })
  const r1 = await ctx.inbox.handleEvent(a)
  const r2 = await ctx.inbox.handleEvent(b)
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.notEqual(r2.deduped, true)
  assert.equal(home.calls.length, 2)

  // 无 id：同 dedupeKey/文案、不同 conversationId → 仍各投一次（不跨联系人误判）
  const c = ownerEvent({ id: undefined, conversationId: 'dmc_ccc', dedupeKey: 'no-id-fp', text: '一样' })
  const d = ownerEvent({ id: undefined, conversationId: 'dmc_ddd', dedupeKey: 'no-id-fp', text: '一样' })
  await ctx.inbox.handleEvent(c)
  await ctx.inbox.handleEvent(d)
  assert.equal(home.calls.length, 4)

  // 同一条（同 id / 同 conversationId+指纹）再来一次 → 去重
  const r5 = await ctx.inbox.handleEvent(a)
  assert.equal(r5.deduped, true)
  const r6 = await ctx.inbox.handleEvent(c)
  assert.equal(r6.deduped, true)
  assert.equal(home.calls.length, 4)
  assert.equal(ctx.inbox.status().stats.deduped, 2)
})

test('douyinInbox / 统一 cwd：不按联系人建子目录，conversationId 只留在消息 source', async (t) => {
  const agents = makeFakeAgents()
  const ctx = makeInbox({ home: makeFakeHome(), agents })
  t.after(ctx.cleanup)
  const cwd = join(ctx.tmp.dir, 'douyin')

  await ctx.inbox.handleEvent(contactEvent('../../evil', '路人'))
  await ctx.inbox.handleEvent(contactEvent('dmc_bbb', '小王', { text: '第二条' }))

  assert.equal(agents.calls.create.length, 1)
  assert.equal(agents.calls.create[0].meta.cwd, cwd, '统一 cwd，不拼 conversationId 子目录')
  assert.equal(existsSync(join(cwd, 'evil')), false, '不建 per-contact 子目录')
  assert.equal(ctx.inbox.status().sessions.lastKey, DOUYIN_OTHERS_KEY)
  assert.equal(agents.calls.followup[0].source.contactId, '../../evil')
  assert.equal(agents.calls.followup[1].source.contactId, 'dmc_bbb')
})

// ── 5. 环境不具备时明确 UNAVAILABLE ─────────────────────

test('douyinInbox / 无 agents → UNAVAILABLE(AGENTS_UNAVAILABLE)，不静默丢', async (t) => {
  const home = makeFakeHome()
  const ctx = makeInbox({ home, agents: null })
  t.after(ctx.cleanup)

  const r = await ctx.inbox.handleEvent(otherEvent())
  assert.equal(r.ok, false)
  assert.equal(r.code, 'UNAVAILABLE')
  assert.equal(r.reason, 'AGENTS_UNAVAILABLE')
  assert.equal(r.route, 'others')
  assert.equal(home.calls.length, 0)
  const st = ctx.inbox.status()
  assert.equal(st.stats.failed, 1)
  assert.equal(st.stats.lastCode, 'UNAVAILABLE')
  assert.equal(st.stats.lastError.reason, 'AGENTS_UNAVAILABLE')
})

test('douyinInbox / 无默认模型 → UNAVAILABLE(NO_MODEL)，不建会话', async (t) => {
  const agents = makeFakeAgents()
  const ctx = makeInbox({ home: makeFakeHome(), agents, model: null })
  t.after(ctx.cleanup)

  const r = await ctx.inbox.handleEvent(otherEvent())
  assert.equal(r.ok, false)
  assert.equal(r.code, 'UNAVAILABLE')
  assert.equal(r.reason, 'NO_MODEL')
  assert.equal(agents.calls.create.length, 0)
  assert.equal(ctx.inbox.status().stats.lastError.reason, 'NO_MODEL')
})

test('douyinInbox / 没有 dyDouyin 服务 → pollOnce 返回 UNAVAILABLE，不抛', async (t) => {
  const ctx = makeInbox({ home: makeFakeHome(), agents: makeFakeAgents(), service: null })
  t.after(ctx.cleanup)
  const r = await ctx.inbox.pollOnce()
  assert.equal(r.ok, false)
  assert.equal(r.code, 'UNAVAILABLE')
  assert.equal(r.reason, 'SERVICE_UNAVAILABLE')
})

// ── 6. 自身发出的消息不投（fromMe） ──────────────────────

test('douyinInbox / fromMe 事件（她自己用 web 发的）默认跳过，不投 home', async (t) => {
  const home = makeFakeHome()
  const ctx = makeInbox({ home, agents: makeFakeAgents() })
  t.after(ctx.cleanup)

  const r = await ctx.inbox.handleEvent(ownerEvent({ fromMe: true, text: '我：好', dedupeKey: 'fp-self-1' }))
  assert.equal(r.ok, true)
  assert.equal(r.skipped, 'fromMe')
  assert.equal(home.calls.length, 0)
  assert.equal(ctx.inbox.status().stats.skippedSelf, 1)
})

// ── 7. 插件接线（startPlugin + 真实 home / fake agents） ──

test('douyinInbox / 插件接线：主人→真实 home；两个不同联系人→两个独立会话', async (t) => {
  const tmp = makeTempDir('douyin-inbox-wire-')
  const fake = makeFakeService()
  const agents = makeFakeAgents()
  const env = startPlugin({
    dir: tmp.dir,
    cfg: {
      enabled: true,
      dryRun: false,
      home: {
        enabled: true,
        cwd: join(tmp.dir, 'home'),
        minIntervalMin: 60,
        maxIntervalMin: 60,
        logPath: join(tmp.dir, 'logs', 'autonomy.log'),
        deliverLog: join(tmp.dir, 'home', 'deliver.log'),
      },
      douyinInbox: { enabled: true, cwd: join(tmp.dir, 'douyin'), cwdRoot: tmp.dir, respectDryRun: false },
    },
    services: {
      ...withServices({ persona: mockPersona({ selfId: 'self:test-routing' }), memory: mockMemory() }),
      agents,
      agentDefaultModel: { currentSelection: () => MODEL },
      dyDouyin: fake.service,
    },
    clock: makeClock(),
  })
  t.after(() => {
    env.cleanup()
    tmp.cleanup()
  })

  await waitFor(() => env.api.douyinInboxStatus().attached === true)
  assert.equal(fake.calls.subscribe, 1, '应优先订阅 dmWatchSubscribe')

  // 主人消息 → 真实 home（home 自己建 home 会话）
  fake.emit(ownerEvent())
  await env.api.douyinInbox.whenIdle()
  const homeCreate = agents.calls.create.find((a) => a.meta?.autonomyHome === true)
  assert.ok(homeCreate, '主人消息应由 home 建会话（autonomyHome=true）')
  const homeSession = homeCreate.sessionId
  const homeMsg = agents.calls.followup.find((m) => m.source?.channel === 'douyin' && m.source?.contactName === '饲养员')
  assert.ok(homeMsg, '主人消息应进 home 会话')
  assert.match(textOf(homeMsg), /在吗/)
  assert.equal(
    agents.calls.create.filter((a) => a.meta?.autonomyDouyinInbox === true).length,
    0,
    '主人消息不建抖音独立会话',
  )

  // 两个不同联系人 → 同一个抖音会话（总接待室）；home 不新增会话、不新增消息
  const beforeHomeFollowups = agents.calls.followup.length
  fake.emit(contactEvent('dmc_aaa', '小李'))
  await env.api.douyinInbox.whenIdle()
  fake.emit(contactEvent('dmc_bbb', '小王', { text: '另一条' }))
  await env.api.douyinInbox.whenIdle()

  const created = agents.calls.create.filter((a) => a.meta?.autonomyDouyinInbox === true)
  assert.equal(created.length, 1, '所有非主人共用一个会话')
  assert.notEqual(created[0].sessionId, homeSession)
  assert.equal(created[0].meta.cwd, join(tmp.dir, 'douyin'), '统一 cwd，不按联系人拆子目录')
  assert.equal(created[0].meta.douyinKey, DOUYIN_OTHERS_KEY)
  assert.deepEqual(created[0].agentOptions, MODEL)
  const otherMsgs = agents.calls.followup.filter((m) => m.source?.channel === 'douyin' && m.source?.owner === false)
  assert.equal(otherMsgs.length, 2)
  assert.match(textOf(otherMsgs[0]), /小李/)
  assert.match(textOf(otherMsgs[1]), /小王/)
  assert.deepEqual(otherMsgs.map((m) => m.source.contactId), ['dmc_aaa', 'dmc_bbb'])
  assert.equal(agents.calls.followup.length, beforeHomeFollowups + 2, '非主人消息不应再往 home 投一条')

  // 指针表：抖音一个 key；home 会话在 home_sessions，不在 douyin_sessions
  const douyinRows = env.api.db.prepare('SELECT * FROM douyin_sessions').all()
  assert.equal(douyinRows.length, 1)
  assert.equal(douyinRows[0].key, DOUYIN_OTHERS_KEY)
  assert.equal(douyinRows[0].session_id, created[0].sessionId)
  const homeRows = env.api.db.prepare('SELECT * FROM home_sessions').all()
  assert.equal(homeRows.length, 1)
  assert.equal(homeRows[0].home_session_id, homeSession)
  assert.equal(env.api.douyinInboxStatus().sessions.active, 1)
  assert.equal(env.api.douyinInboxStatus().replies.pending, 2, '两条入站各自保留待回复状态')

  // 插件接线：同一回合里两个联系人 → 按各自 conversationId 分别发回（不串、不只回第一条）
  const beforeSends = fake.calls.dmSend.length
  env.ctx.emit('session/event', sessionRef(created[0].sessionId), assistantEvent('接线回复：收到'))
  env.ctx.emit('session/event', sessionRef(created[0].sessionId), turnEndEvent())
  await waitFor(() => fake.calls.dmSend.length === beforeSends + 2)
  const sent = fake.calls.dmSend.slice(beforeSends)
  assert.deepEqual(sent.map((x) => x.conversationId), ['dmc_aaa', 'dmc_bbb'])
  for (const call of sent) {
    assert.equal(call.text, '接线回复：收到')
    assert.equal(call.confirm, true)
  }
  assert.equal(env.api.douyinInboxStatus().replies.pending, 0)
  assert.equal(env.api.douyinInboxStatus().replies.sent, 2)
})

test('douyinInbox / 插件接线：douyinInbox.enabled=false 不订阅、不轮询', async (t) => {
  const tmp = makeTempDir('douyin-inbox-off-')
  const fake = makeFakeService()
  const env = startPlugin({
    dir: tmp.dir,
    cfg: { enabled: true, dryRun: false, home: { enabled: false }, douyinInbox: { enabled: false, cwd: join(tmp.dir, 'douyin') } },
    services: { ...withServices(), agents: makeFakeAgents(), agentDefaultModel: { currentSelection: () => MODEL }, dyDouyin: fake.service },
    clock: makeClock(),
  })
  t.after(() => {
    env.cleanup()
    tmp.cleanup()
  })

  await new Promise((r) => setTimeout(r, 30))
  assert.equal(fake.calls.subscribe, 0)
  assert.equal(fake.calls.poll.length, 0)
  assert.equal(env.api.douyinInboxStatus().started, false)
})

test('douyinInbox / auto 模式：源 dmWatchEnabled=false 时改自己轮询（不静默订阅）', async (t) => {
  const fake = makeFakeService({ batches: [[]] })
  fake.service.dmWatchStatus = () => ({ primed: false, running: false, cfgEnabled: false })
  const ctx = makeInbox({ home: makeFakeHome(), agents: makeFakeAgents(), service: fake.service })
  t.after(ctx.cleanup)

  const started = ctx.inbox.start()
  assert.equal(started.ok, true)
  await waitFor(() => ctx.inbox.status().mode === 'poll')
  await waitFor(() => fake.calls.poll.length >= 1)
  assert.equal(fake.calls.subscribe, 0, '源 watcher 关着时不订阅（收不到事件）')
  await ctx.inbox.whenIdle()
  ctx.inbox.stop()
})

// ── 8. 非主人自动回复（QQ auto 标准） ────────────────────

test('douyinInbox / 自动回复：回合结束把最后一段 assistant 文本发回对应 conversationId，只一次', async (t) => {
  const fake = makeFakeService()
  const ctx = makeInbox({ home: makeFakeHome(), agents: makeFakeAgents(), service: fake.service })
  t.after(ctx.cleanup)

  const delivered = await ctx.inbox.handleEvent(contactEvent('dmc_aaa', '小李'))
  assert.equal(delivered.ok, true)
  assert.equal(delivered.replyArmed, true, '非主人投递成功要挂回复 watch')
  const sid = delivered.sessionId
  assert.ok(sid)

  // 推理 + tool 分块 + 最终文本：只发 text 分块
  ctx.inbox.observeSessionEvent(sessionRef(sid), assistantEvent('收到啦，晚点回你'))
  ctx.inbox.observeSessionEvent(sessionRef(sid), turnEndEvent())
  await waitFor(() => fake.calls.dmSend.length === 1)

  assert.deepEqual(fake.calls.dmSend[0], { conversationId: 'dmc_aaa', text: '收到啦，晚点回你', confirm: true })
  assert.doesNotMatch(fake.calls.dmSend[0].text, /内部推理/)
  const st = ctx.inbox.status()
  assert.equal(st.replies.sent, 1)
  assert.equal(st.replies.pending, 0)
  assert.equal(st.replies.last.verified, true)
  assert.deepEqual(st.replies.last.targets.map((x) => x.conversationId), ['dmc_aaa'])
  assert.equal(st.replies.last.targets[0].verified, true)
  assert.equal(st.replies.last.chars, 8)
  assert.ok(st.replies.last.textHash)
  // meta 也记发送结果（verified），不含正文
  const last = JSON.parse(ctx.db.prepare("SELECT value FROM meta WHERE key='douyin.inbox.last'").get().value)
  assert.equal(last.replies.sent, 1)
  assert.equal(last.replies.last.verified, true)
  assert.equal(last.replies.last.textHash, st.replies.last.textHash)
  assert.equal(JSON.stringify(last).includes('收到啦'), false, 'meta 不记正文')

  // 再来一个 turn/end：同一入站事件不重复发
  ctx.inbox.observeSessionEvent(sessionRef(sid), turnEndEvent())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(fake.calls.dmSend.length, 1)
  assert.equal(ctx.inbox.status().replies.sent, 1)
})

test('douyinInbox / 自动回复：owner 事件只进 home，不挂回复 watch、不调 dmSend', async (t) => {
  const fake = makeFakeService()
  const home = makeFakeHome()
  const ctx = makeInbox({ home, agents: makeFakeAgents(), service: fake.service })
  t.after(ctx.cleanup)

  const r = await ctx.inbox.handleEvent(ownerEvent())
  assert.equal(r.route, 'home')
  assert.equal(r.replyArmed, undefined)
  assert.equal(ctx.inbox.status().replies.pending, 0)

  // 即便有人在别的会话说 assistant/turn end，也不发
  ctx.inbox.observeSessionEvent(sessionRef('home-session-x'), assistantEvent('不该发出去'))
  ctx.inbox.observeSessionEvent(sessionRef('home-session-x'), turnEndEvent())
  await new Promise((r2) => setTimeout(r2, 30))
  assert.equal(fake.calls.dmSend.length, 0)
  assert.equal(home.calls.length, 1)
})

test('douyinInbox / 自动回复：空文本 / 只有 reasoning+tool / 错误回合都不发、不重试', async (t) => {
  const fake = makeFakeService()
  const ctx = makeInbox({ home: makeFakeHome(), agents: makeFakeAgents(), service: fake.service })
  t.after(ctx.cleanup)

  // A：只有 tool 调用，没有 text 分块
  const a = await ctx.inbox.handleEvent(contactEvent('dmc_tool', '工具人'))
  ctx.inbox.observeSessionEvent(sessionRef(a.sessionId), assistantEvent(''))
  ctx.inbox.observeSessionEvent(sessionRef(a.sessionId), turnEndEvent())

  // B：turn/end 报错
  const b = await ctx.inbox.handleEvent(contactEvent('dmc_err', '报错人', { text: '另一条' }))
  ctx.inbox.observeSessionEvent(sessionRef(b.sessionId), assistantEvent('这条不该发'))
  ctx.inbox.observeSessionEvent(sessionRef(b.sessionId), turnEndEvent({ ok: false, reason: { kind: 'error', code: 'E_X' } }))

  await waitFor(() => ctx.inbox.status().replies.skipped >= 2)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(fake.calls.dmSend.length, 0)
  const st = ctx.inbox.status()
  assert.equal(st.replies.sent, 0)
  assert.equal(st.replies.failed, 0)
  assert.equal(st.replies.skipped, 2)
})

test('douyinInbox / 自动回复：dmSend 失败不重试、不重复；verified=false 记 stats', async (t) => {
  const fake = makeFakeService({ dmSendResult: { ok: false, code: 'E_UNVERIFIED', message: '发送后回读不到', verified: false } })
  const ctx = makeInbox({ home: makeFakeHome(), agents: makeFakeAgents(), service: fake.service })
  t.after(ctx.cleanup)

  const d = await ctx.inbox.handleEvent(contactEvent('dmc_aaa', '小李'))
  ctx.inbox.observeSessionEvent(sessionRef(d.sessionId), assistantEvent('你好呀'))
  ctx.inbox.observeSessionEvent(sessionRef(d.sessionId), turnEndEvent())
  await waitFor(() => fake.calls.dmSend.length === 1)
  await new Promise((r) => setTimeout(r, 50))

  assert.equal(fake.calls.dmSend.length, 1, '失败不重试')
  const st = ctx.inbox.status()
  assert.equal(st.replies.sent, 0)
  assert.equal(st.replies.failed, 1)
  assert.equal(st.replies.last.code, 'E_UNVERIFIED')
  assert.equal(st.replies.last.verified, false)
  // 再补一个 turn/end 也不会重发
  ctx.inbox.observeSessionEvent(sessionRef(d.sessionId), turnEndEvent())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(fake.calls.dmSend.length, 1)
})

test('douyinInbox / 自动回复：dmSend 不可用时跳过（不静默、不抛）', async (t) => {
  const fake = makeFakeService()
  delete fake.service.dmSend
  const ctx = makeInbox({ home: makeFakeHome(), agents: makeFakeAgents(), service: fake.service })
  t.after(ctx.cleanup)

  const d = await ctx.inbox.handleEvent(contactEvent('dmc_aaa', '小李'))
  ctx.inbox.observeSessionEvent(sessionRef(d.sessionId), assistantEvent('你好呀'))
  ctx.inbox.observeSessionEvent(sessionRef(d.sessionId), turnEndEvent())
  await waitFor(() => ctx.inbox.status().replies.skipped === 1)
  assert.equal(ctx.inbox.status().replies.last.code, 'DM_SEND_UNAVAILABLE')
})

test('douyinInbox / 自动回复：同一回合两条不同联系人 → 共用会话、按各自 conversationId 各发一条', async (t) => {
  const fake = makeFakeService()
  const ctx = makeInbox({ home: makeFakeHome(), agents: makeFakeAgents(), service: fake.service })
  t.after(ctx.cleanup)

  const a = await ctx.inbox.handleEvent(contactEvent('dmc_aaa', '小李'))
  const b = await ctx.inbox.handleEvent(contactEvent('dmc_bbb', '小王', { text: '另一条' }))
  assert.equal(a.sessionId, b.sessionId, '所有非主人共用一个会话')
  assert.equal(ctx.inbox.status().replies.pending, 2, '两条入站各自保留待回复状态')

  // 同一回合（同一 session 一次 assistant 文本 + turn/end）
  ctx.inbox.observeSessionEvent(sessionRef(a.sessionId), assistantEvent('统一回复'))
  ctx.inbox.observeSessionEvent(sessionRef(a.sessionId), turnEndEvent())
  await waitFor(() => fake.calls.dmSend.length === 2)

  assert.deepEqual(
    fake.calls.dmSend.map((x) => x.conversationId),
    ['dmc_aaa', 'dmc_bbb'],
    '按事件 conversationId 分别发，不只回第一条',
  )
  assert.equal(fake.calls.dmSend.every((x) => x.text === '统一回复' && x.confirm === true), true)
  assert.equal(ctx.inbox.status().replies.pending, 0)
  assert.equal(ctx.inbox.status().replies.sent, 2)
  assert.deepEqual(
    ctx.inbox.status().replies.last.targets.map((x) => [x.conversationId, x.ok]),
    [
      ['dmc_aaa', true],
      ['dmc_bbb', true],
    ],
  )

  // 下一个回合：又一条另一联系人 → 只回他，不重发前两条
  const c = await ctx.inbox.handleEvent(contactEvent('dmc_ccc', '小张', { text: '第三条' }))
  assert.equal(c.sessionId, a.sessionId)
  ctx.inbox.observeSessionEvent(sessionRef(a.sessionId), assistantEvent('回小张'))
  ctx.inbox.observeSessionEvent(sessionRef(a.sessionId), turnEndEvent())
  await waitFor(() => fake.calls.dmSend.length === 3)
  assert.equal(fake.calls.dmSend[2].conversationId, 'dmc_ccc')
  assert.equal(fake.calls.dmSend[2].text, '回小张')
})

test('douyinInbox / 自动回复：同一会话多联系人在一回合内，部分发送失败不影响其他目标', async (t) => {
  const fake = makeFakeService()
  // aaa 失败、bbb 成功
  fake.service.dmSend = async (args = {}) => {
    fake.calls.dmSend.push(args)
    if (args.conversationId === 'dmc_aaa') return { ok: false, code: 'E_UNVERIFIED', verified: false }
    return { ok: true, action: 'dm_send', verified: true, result: 'sent' }
  }
  const ctx = makeInbox({ home: makeFakeHome(), agents: makeFakeAgents(), service: fake.service })
  t.after(ctx.cleanup)

  const a = await ctx.inbox.handleEvent(contactEvent('dmc_aaa', '小李'))
  await ctx.inbox.handleEvent(contactEvent('dmc_bbb', '小王', { text: '另一条' }))
  ctx.inbox.observeSessionEvent(sessionRef(a.sessionId), assistantEvent('都收到'))
  ctx.inbox.observeSessionEvent(sessionRef(a.sessionId), turnEndEvent())
  await waitFor(() => fake.calls.dmSend.length === 2)
  await new Promise((r) => setTimeout(r, 30))

  const st = ctx.inbox.status()
  assert.equal(st.replies.sent, 1)
  assert.equal(st.replies.failed, 1)
  assert.equal(st.replies.pending, 0)
  // 失败不重试：不再多出第三次调用
  assert.equal(fake.calls.dmSend.length, 2)
})

test('douyinInbox / 自动回复：push 事件漏收时轮询 agent.session.log 兜底', async (t) => {
  const fake = makeFakeService()
  const agents = makeFakeAgents()
  const ctx = makeInbox({ home: makeFakeHome(), agents, service: fake.service })
  t.after(ctx.cleanup)

  const d = await ctx.inbox.handleEvent(contactEvent('dmc_aaa', '小李'))
  const agent = agents.byId.get(String(d.sessionId))
  assert.ok(agent?.session?.log)
  agent.session.log.push(assistantEvent('轮询兜底也能行'))
  agent.session.log.push(turnEndEvent())

  ctx.inbox.replyTick()
  await waitFor(() => fake.calls.dmSend.length === 1)
  assert.equal(fake.calls.dmSend[0].conversationId, 'dmc_aaa')
  assert.equal(fake.calls.dmSend[0].text, '轮询兜底也能行')
})

test('douyinInbox / 自动回复：回合迟迟不结束 → 超时不发、不重试', async (t) => {
  const fake = makeFakeService()
  const ctx = makeInbox({ home: makeFakeHome(), agents: makeFakeAgents(), service: fake.service })
  t.after(ctx.cleanup)

  const d = await ctx.inbox.handleEvent(contactEvent('dmc_aaa', '小李'))
  assert.ok(d.sessionId)
  assert.equal(ctx.inbox.status().replies.pending, 1)

  ctx.clock.advance(180_000 + 1) // 超过默认 reply.timeoutMs
  ctx.inbox.replyTick()
  await waitFor(() => ctx.inbox.status().replies.timeout === 1)
  assert.equal(fake.calls.dmSend.length, 0)
  assert.equal(ctx.inbox.status().replies.pending, 0)
})

test('douyinInbox / 自动回复：超 500 字截断成一条；[SILENT] 不发', async (t) => {
  const fake = makeFakeService()
  const ctx = makeInbox({ home: makeFakeHome(), agents: makeFakeAgents(), service: fake.service })
  t.after(ctx.cleanup)

  const long = '字'.repeat(600)
  const a = await ctx.inbox.handleEvent(contactEvent('dmc_long', '长文'))
  ctx.inbox.observeSessionEvent(sessionRef(a.sessionId), assistantEvent(long))
  ctx.inbox.observeSessionEvent(sessionRef(a.sessionId), turnEndEvent())
  await waitFor(() => fake.calls.dmSend.length === 1)
  assert.equal(Array.from(fake.calls.dmSend[0].text).length, 500, 'dmSend 上限 500，且只发一条')
  assert.equal(fake.calls.dmSend[0].conversationId, 'dmc_long')

  const b = await ctx.inbox.handleEvent(contactEvent('dmc_silent', '沉默', { text: '另一条' }))
  ctx.inbox.observeSessionEvent(sessionRef(b.sessionId), assistantEvent('[SILENT]'))
  ctx.inbox.observeSessionEvent(sessionRef(b.sessionId), turnEndEvent())
  await waitFor(() => ctx.inbox.status().replies.skipped === 1)
  assert.equal(ctx.inbox.status().replies.last.code, 'SILENT')
  assert.equal(fake.calls.dmSend.length, 1)
})
// ── 9. 通知事件（dyDouyin.notifyWatchSubscribe / notifyWatchStatus） ──

test('douyinInbox / 通知：owner 通知 → home.deliver 一次，不建抖音会话、不自动回复', async (t) => {
  const fake = makeFakeService()
  const home = makeFakeHome()
  const agents = makeFakeAgents()
  const ctx = makeInbox({ home, agents, service: fake.service })
  t.after(ctx.cleanup)

  const r = await ctx.inbox.handleNotifyEvent(
    notifyEvent({ id: 'ntf_owner_1', isOwner: true, actor: '饲养员', type: 'comment_reply', text: '主人评论了' }),
  )
  assert.equal(r.ok, true)
  assert.equal(r.route, 'notify')
  assert.equal(r.owner, true)
  assert.equal(home.calls.length, 1)
  const payload = home.calls[0]
  assert.equal(payload.channel, 'douyin')
  assert.equal(payload.priority, 'owner')
  assert.equal(payload.messageId, 'notify:ntf_owner_1')
  assert.match(payload.text, /饲养员/)
  assert.match(payload.text, /回复评论/)
  assert.equal(agents.calls.create.length, 0, 'owner 通知不建抖音会话')
  assert.equal(ctx.inbox.status().replies.pending, 0, '通知不挂自动回复')
  assert.equal(ctx.inbox.status().notify.owner, 1)
  assert.equal(ctx.inbox.status().notify.session, 0)
})

test('douyinInbox / 通知：非 owner → 统一会话，source 保留通知 id/actor/type，且不自动回复', async (t) => {
  const fake = makeFakeService()
  const home = makeFakeHome()
  const agents = makeFakeAgents()
  const ctx = makeInbox({ home, agents, service: fake.service })
  t.after(ctx.cleanup)

  const r = await ctx.inbox.handleNotifyEvent(
    notifyEvent({ id: 'ntf_1', actor: '路人甲', type: 'mention', text: '提到了你', replyable: true }),
  )
  assert.equal(r.ok, true)
  assert.equal(r.route, 'notify')
  assert.equal(r.owner, false)
  assert.equal(home.calls.length, 0)
  assert.equal(agents.calls.create.length, 1)
  assert.equal(agents.calls.create[0].meta.cwd, join(ctx.tmp.dir, 'douyin'))
  const msg = agents.calls.followup.at(-1)
  assert.equal(msg.source.source, 'notify')
  assert.equal(msg.source.notifyId, 'ntf_1')
  assert.equal(msg.source.actor, '路人甲')
  assert.equal(msg.source.notifyType, 'mention')
  assert.equal(msg.source.replyable, true)
  assert.equal(msg.source.scope, DOUYIN_OTHERS_KEY)
  assert.equal(msg.source.conversationId, undefined, '通知没有 conversationId，不能拿来发私信')
  assert.match(textOf(msg), /路人甲/)
  assert.match(textOf(msg), /提到/)
  assert.match(textOf(msg), /ntf_1/, 'replyable 时带稳定 id 方便工具精准回复')
  assert.equal(ctx.inbox.status().replies.pending, 0)

  // 通知不挂自动回复：这个会话出 assistant/turn end 也不会有 dmSend
  const sid = agents.calls.create[0].sessionId
  ctx.inbox.observeSessionEvent(sessionRef(sid), assistantEvent('不该自动发'))
  ctx.inbox.observeSessionEvent(sessionRef(sid), turnEndEvent())
  await new Promise((r2) => setTimeout(r2, 30))
  assert.equal(fake.calls.dmSend.length, 0, '通知绝不自动回复/发私信')
  assert.equal(ctx.inbox.status().notify.session, 1)
})

test('douyinInbox / 通知：同一 id 去重（只投一次）', async (t) => {
  const home = makeFakeHome()
  const ctx = makeInbox({ home, agents: makeFakeAgents(), service: makeFakeService().service })
  t.after(ctx.cleanup)

  const ev = notifyEvent({ id: 'ntf_dup', isOwner: true, actor: '饲养员' })
  await ctx.inbox.handleNotifyEvent(ev)
  const r2 = await ctx.inbox.handleNotifyEvent({ ...ev })
  assert.equal(r2.deduped, true)
  assert.equal(home.calls.length, 1)
  assert.equal(ctx.inbox.status().notify.deduped, 1)
})

test('douyinInbox / 通知：首轮基线不投（源未 primed），源就绪后才投新通知', async (t) => {
  const fake = makeFakeService({ notifyPrimed: false })
  const home = makeFakeHome()
  const ctx = makeInbox({ home, agents: makeFakeAgents(), service: fake.service })
  t.after(ctx.cleanup)

  const first = await ctx.inbox.handleNotifyEvent(notifyEvent({ id: 'ntf_old', isOwner: true }))
  assert.equal(first.baseline, true)
  assert.equal(first.code, 'NOTIFY_BASELINE')
  assert.equal(home.calls.length, 0)
  assert.equal(ctx.inbox.status().notify.baselineSkipped, 1)

  fake.setNotifyPrimed(true)
  const second = await ctx.inbox.handleNotifyEvent(notifyEvent({ id: 'ntf_new', isOwner: true, text: '新通知' }))
  assert.equal(second.ok, true)
  assert.equal(second.baseline, undefined)
  assert.equal(home.calls.length, 1)
  assert.match(home.calls[0].text, /新通知/)
})

test('douyinInbox / 通知与私信去重分开：同一字符串 id 两条通道各投一次', async (t) => {
  const home = makeFakeHome()
  const ctx = makeInbox({ home, agents: makeFakeAgents(), service: makeFakeService().service })
  t.after(ctx.cleanup)

  await ctx.inbox.handleEvent(ownerEvent({ id: 'shared-1', dedupeKey: 'shared-fp' }))
  assert.equal(home.calls.length, 1)
  await ctx.inbox.handleNotifyEvent(notifyEvent({ id: 'shared-1', isOwner: true }))
  assert.equal(home.calls.length, 2, '通知和私信各自去重，不互相吞')
  const dup = await ctx.inbox.handleNotifyEvent(notifyEvent({ id: 'shared-1', isOwner: true }))
  assert.equal(dup.deduped, true)
  assert.equal(home.calls.length, 2)
})

test('douyinInbox / 通知：缺少 notifyWatchSubscribe 时明确降级，私信路由照常', async (t) => {
  const fake = makeFakeService({ notifySubscribe: false })
  const home = makeFakeHome()
  const ctx = makeInbox({ home, agents: makeFakeAgents(), service: fake.service })
  t.after(ctx.cleanup)

  const started = ctx.inbox.start()
  assert.equal(started.ok, true)
  await waitFor(() => ctx.inbox.status().notify.lastErrorCode === 'NOTIFY_UNAVAILABLE')
  const st = ctx.inbox.status()
  assert.equal(st.notify.supported, false)
  assert.equal(st.notify.subscribed, false)
  // 私信仍照常工作
  const r = await ctx.inbox.handleEvent(ownerEvent())
  assert.equal(r.ok, true)
  assert.equal(home.calls.length, 1)
})

test('douyinInbox / 通知订阅接线：start 后 notifyWatchSubscribe 收到事件 → 统一会话（不投 home）', async (t) => {
  const fake = makeFakeService()
  const home = makeFakeHome()
  const agents = makeFakeAgents()
  const ctx = makeInbox({ home, agents, service: fake.service })
  t.after(ctx.cleanup)

  ctx.inbox.start()
  await waitFor(() => fake.calls.notifySubscribe === 1)
  assert.equal(ctx.inbox.status().notify.subscribed, true)

  fake.emitNotify(notifyEvent({ id: 'ntf_wire', actor: '接线人' }))
  await ctx.inbox.whenIdle()
  assert.equal(agents.calls.followup.length, 1)
  assert.equal(agents.calls.followup[0].source.notifyId, 'ntf_wire')
  assert.match(textOf(agents.calls.followup[0]), /接线人/)
  assert.equal(home.calls.length, 0)
  assert.equal(fake.calls.dmSend.length, 0)
  assert.equal(ctx.inbox.status().notify.session, 1)
})

test('douyinInbox / 通知：owner 通知经订阅也只投 home 一处，不重复投会话', async (t) => {
  const fake = makeFakeService()
  const home = makeFakeHome()
  const agents = makeFakeAgents()
  const ctx = makeInbox({ home, agents, service: fake.service })
  t.after(ctx.cleanup)

  ctx.inbox.start()
  await waitFor(() => fake.calls.notifySubscribe === 1)
  fake.emitNotify(notifyEvent({ id: 'ntf_owner_wire', isOwner: true, actor: '草荧' }))
  await ctx.inbox.whenIdle()
  assert.equal(home.calls.length, 1, 'owner 通知进 home')
  assert.equal(agents.calls.create.length, 0, '不建抖音会话')
  assert.equal(agents.calls.followup.length, 0, '不投统一会话')
})
