/**
 * 抖音私信 / 互动消息 → 会话路由（2026-11-14，v4：非主人统一一个「总接待室」）
 *
 * 标准（主人 2026-11-14 19:07 改定）：
 * - 主人（isOwner=true：饲养员 / 草荧 / dm-owner.txt）的消息 → 现有 home（`dyHome.deliver`），
 *   **不另开会话**，不抢 home 的轮换/投递/骰子；home 自己的暂停/dryRun/队列闸门照旧生效。
 * - 其他联系人 → **统一进一个抖音会话**（key=`douyin:others`，cwd=`/sdcard/DSHA/渠道/douyin`，
 *   不再按联系人拆会话/子目录）；消息作为 user 消息按到达顺序 followup；**不调 home.deliver**，
 *   home 上下文完全隔离；不登记 workspace（GUI 不显示）。
 * - 但每条入站事件都保留自己的 `conversationId/contactName`；自动回复按事件的 conversationId
 *   分别发回，**不同联系人绝不串回复目标**。
 * - 会话解析顺序（照 `dsh-channel-bridge/lib/sessions.js:1-14` 的 QQ 标准）：
 *   1) 内存缓存 handle（宿主里仍活）→ 2) `agents.get(prevId)` live →
 *   3) `agents.resume` → 4) 只有前面都失败才 `agents.create`（旧 id 留档 prev_session_id）。
 * - 首轮只建基线不投递；同一事件（id，或 conversationId+dedupeKey）去重，跨联系人重复不误判。
 * - 环境不具备 agents/model 时返回明确 `UNAVAILABLE`（带 reason），不静默丢。
 *
 * 事件源（只读接口，见 dsh-douyin `lib/index.js:124-129`）：
 *   ctx.get('dyDouyin') → { dmWatch({action}), dmWatchStatus(), dmWatchSubscribe(fn) }
 * 默认优先订阅（profile 已开 dmWatchEnabled=3s，watcher 在 douyin 插件里跑）；
 * 订阅不可用时退回自己轮询 dmWatch({action:'poll'})；源 watcher 关着时 auto 模式也改轮询。
 *
 * 硬约束（写死）：
 * 1. create/resume **必须带** `agentOptions:{provider,model}`（11-01「每轮 error」事故根因）；
 *    拿不到默认模型 → `UNAVAILABLE` + reason=NO_MODEL，不建会话、不写表。
 * 2. 会话 cwd 固定 `douyinInbox.cwd`（默认 /sdcard/DSHA/渠道/douyin）；cwd 必须在上限根（默认 /sdcard/DSHA）内。
 * 3. 单飞：同一时刻只 ensure/建一个会话；事件串行投递，保持到达顺序。
 * 4. 任何投递失败都记 stats/lastError + 日志，不吞；不自动重放（unknown 不重试）。
 * 5. 自动回复：一个入站事件最多回一次；同一回合合并多条时，按各自 conversationId 分别发。
 */
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { normalize, resolve } from 'node:path'
import { pauseActive } from '../core/policy.js'
import { getMeta, setMeta } from '../store/db.js'

/** 统一抖音会话的 cwd（所有非主人共用；与 home 分开） */
export const DEFAULT_DOUYIN_CWD = '/sdcard/DSHA/渠道/douyin'

/** 统一会话 key：所有非主人进同一个「总接待室」 */
export const DOUYIN_OTHERS_KEY = 'douyin:others'

/** 会话指针表：统一会话一行（沿用 home_sessions/home_rooms 的 `ensureTable` 口径，幂等建表） */
export const DOUYIN_SESSIONS_DDL = `CREATE TABLE IF NOT EXISTS douyin_sessions (
  key             TEXT PRIMARY KEY,
  conversation_id TEXT,
  contact_name    TEXT,
  session_id      TEXT NOT NULL,
  prev_session_id TEXT,
  cwd             TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  messages        INTEGER NOT NULL DEFAULT 0,
  replaced_count  INTEGER NOT NULL DEFAULT 0
)`

export const DOUYIN_SEEN_META = 'douyin.inbox.seen'
export const DOUYIN_NOTIFY_SEEN_META = 'douyin.inbox.notifySeen'
export const DOUYIN_LAST_META = 'douyin.inbox.last'
export const DOUYIN_REPLACED_META = 'douyin.inbox.replacedFrom'

/** 通知类型中文标签（与 dsh-douyin 通知面板一致） */
const NOTIFY_TYPE_LABELS = Object.freeze({
  mention: '@提及',
  comment_reply: '回复评论',
  like_comment: '赞了评论',
  like_danmaku: '赞了弹幕',
  follow: '新关注',
})

const ok = (extra = {}) => ({ ok: true, ...extra })
const fail = (code, extra = {}) => ({ ok: false, code, ...extra })
/** 环境不具备（agents/model/服务）时的统一错误：明确 UNAVAILABLE + reason，绝不静默丢 */
const unavailable = (reason, extra = {}) => ({ ok: false, code: 'UNAVAILABLE', reason, ...extra })

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()
const hash12 = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 12)

const safe = (fn, fallback = null) => {
  try {
    return typeof fn === 'function' ? fn() : fallback
  } catch {
    return fallback
  }
}

/**
 * 事件正文（给 home / 独立会话的 user 消息用）。
 * 与 dsh-douyin `formatDmEventText` 口径一致，但不跨插件 import（只读参考）。
 */
export function formatDouyinEventLine(event) {
  const who = squash(event?.conversationName ?? event?.contactName ?? '') || '抖音用户'
  const text = squash(event?.text ?? event?.preview ?? '')
  const time = squash(event?.time ?? '')
  return `【抖音私信】${who}${text ? `：${text}` : ''}${time ? `（${time}）` : ''}`
}

/**
 * assistant/message 的 data → 可发送的纯文本：
 * 只取 content 里 `type === 'text'` 的分块，**排除 reasoning/tool 部分**（不发推理过程）。
 * 与 dsh-channel-bridge `textOfAssistant` 同口径。
 */
export function douyinReplyText(data) {
  try {
    const msg = data?.message ?? data
    const content = msg?.content ?? data?.content
    if (Array.isArray(content)) {
      return content
        .filter((part) => part && part.type === 'text')
        .map((part) => String(part.text ?? ''))
        .join('')
        .trim()
    }
    // 字符串 content 只在没有分块信息时接受（不会带 reasoning 标记）
    return typeof content === 'string' ? content.trim() : ''
  } catch {
    return ''
  }
}

/** turn/end 是否错误结束（错误回合不自动回复） */
export function douyinTurnEndError(data) {
  try {
    if (data?.ok === false) return true
    const reason = data?.reason ?? data?.error
    return String(reason?.kind ?? reason?.type ?? '') === 'error'
  } catch {
    return false
  }
}

/**
 * 去重键：优先事件 id（dsh-douyin 的 id 已含会话指纹 + 序号，天然区分联系人）；
 * 没有 id 时用 conversationId + dedupeKey/字段指纹，跨联系人重复不会误判为同一条。
 */
export function douyinEventKey(event) {
  const id = squash(event?.id)
  if (id) return `id:${id}`
  const conv = squash(event?.conversationId) || squash(event?.conversationName) || 'unknown'
  const fp =
    squash(event?.dedupeKey) ||
    [squash(event?.preview), squash(event?.time), squash(event?.text)].join('\u0001')
  return `${conv}\u0001${fp || 'unknown'}`
}

/** 订阅/轮询事件归一：只要 dm_message/私信类事件，字段统一成 routeOne 认识的样子 */
export function normalizeDouyinEvent(event) {
  if (!event || typeof event !== 'object') return null
  const type = squash(event.type ?? event.kind)
  if (type && type !== 'dm_message') return null
  const conversationName = squash(event.conversationName ?? event.name ?? event.conversation?.name)
  const conversationId = event.conversationId ?? event.conversation?.id ?? null
  const text = squash(event.text ?? event.preview ?? '')
  const owner = event.owner === true || event.isOwner === true || event.conversation?.isOwner === true
  return {
    key: douyinEventKey(event),
    convKey: DOUYIN_OTHERS_KEY,
    targetId: squash(conversationId) || null, // 自动回复目标：只用事件自己的 conversationId
    id: event.id ?? null,
    owner,
    isOwner: owner,
    fromMe: event.fromMe === true,
    conversationId,
    conversationName,
    contactName: conversationName || squash(event.sender) || '抖音用户',
    text,
    preview: squash(event.preview),
    time: squash(event.time),
    at: Number(event.at) || null,
    raw: event,
  }
}

/**
 * 通知事件去重键：同一 id 去重；无 id 时 actor+type+text+time 兜底。
 * **与私信 seen 分开存**（同一字符串 id 在两条通道也不算重复）。
 */
export function douyinNotifyEventKey(event) {
  const id = squash(event?.id)
  if (id) return `n:${id}`
  const fields = [squash(event?.actor), squash(event?.type), squash(event?.text), squash(event?.time)].join('\u0001')
  return `n:fallback:${fields || 'unknown'}`
}

/** 通知事件归一：{id, actor, type, text, time, ageMs, isOwner, replyable}（没有 conversationId，不能拿来发私信） */
export function normalizeDouyinNotifyEvent(event) {
  if (!event || typeof event !== 'object') return null
  const id = event.id !== undefined && event.id !== null && String(event.id).trim() ? String(event.id).trim() : null
  const actor = squash(event.actor ?? event.actorName ?? event.name) || '抖音用户'
  const type = squash(event.type ?? event.kind) || 'notify'
  const text = squash(event.text ?? event.content)
  const time = squash(event.time)
  const ageMs = Number.isFinite(Number(event.ageMs)) ? Number(event.ageMs) : null
  const owner = event.isOwner === true || event.owner === true
  const replyable = event.replyable === true
  return {
    key: douyinNotifyEventKey(event),
    id,
    actor,
    type,
    text,
    time,
    ageMs,
    owner,
    isOwner: owner,
    replyable,
    at: Number(event.at) || null,
    raw: event,
  }
}

/** 通知正文（投 home / 统一会话的消息文本；只有 replyable 才带稳定 id，方便工具精准回复） */
export function formatDouyinNotifyLine(event) {
  const label = NOTIFY_TYPE_LABELS[event?.type] ?? squash(event?.type) ?? '通知'
  const actor = squash(event?.actor ?? event?.actorName) || '抖音用户'
  const text = squash(event?.text ?? event?.content)
  const time = squash(event?.time)
  const idHint = event?.id && event?.replyable === true ? `[通知id: ${String(event.id).slice(0, 80)}]` : ''
  return `【抖音通知】${label} · ${actor}${text ? `：${text}` : ''}${time ? `（${time}）` : ''}${idHint}`
}

/**
 * @param {{
 *   db: object,
 *   cfg?: object,                        // douyinInbox 子配置（已 normalize）
 *   getService?: () => object|null,      // () => ctx.get('dyDouyin')
 *   getHome?: () => object|null,         // () => home（有 deliver）
 *   getAgents?: () => object|null,
 *   getDefaultModel?: () => ({provider,model}|null),
 *   getPresets?: () => object|null,
 *   getDryRun?: () => boolean,
 *   clock?: () => number,
 *   log?: object|null,
 *   timers?: { setTimeout?: Function, clearTimeout?: Function } | null,
 * }} deps
 */
export function createDouyinInbox({
  db = null,
  cfg = {},
  getService = () => null,
  getHome = () => null,
  getAgents = () => null,
  getDefaultModel = () => null,
  getPresets = () => null,
  getDryRun = () => false,
  clock = Date.now,
  log = null,
  timers = null,
} = {}) {
  const setT = timers?.setTimeout ?? setTimeout
  const clearT = timers?.clearTimeout ?? clearTimeout

  const c = {
    enabled: cfg?.enabled === true,
    mode: ['auto', 'subscribe', 'poll'].includes(String(cfg?.mode)) ? String(cfg.mode) : 'auto',
    pollMs: Math.max(1000, Math.min(300_000, Number(cfg?.pollMs) || 3000)),
    attachRetryMs: Math.max(1000, Math.min(600_000, Number(cfg?.attachRetryMs) || 5000)),
    cwd: String(cfg?.cwd || DEFAULT_DOUYIN_CWD),
    cwdRoot: String(cfg?.cwdRoot || '/sdcard/DSHA'),
    agentPreset: String(cfg?.agentPreset ?? '').trim(),
    denyTools: Array.isArray(cfg?.denyTools) ? cfg.denyTools.map((x) => String(x ?? '').trim()).filter(Boolean) : [],
    limit: Math.max(1, Math.min(100, Number(cfg?.limit) || 20)),
    maxSeen: Math.max(50, Math.min(5000, Number(cfg?.maxSeen) || 1000)),
    skipFromMe: cfg?.skipFromMe !== false,
    respectDryRun: cfg?.respectDryRun !== false,
    // 自动回复（QQ auto 标准：回合结束把最后一段 assistant 文本发回对应联系人）
    reply: {
      enabled: cfg?.reply?.enabled !== false,
      maxChars: Math.max(1, Math.min(500, Number(cfg?.reply?.maxChars) || 500)),
      timeoutMs: Math.max(10_000, Math.min(1_800_000, Number(cfg?.reply?.timeoutMs) || 180_000)),
      pollMs: Math.max(200, Math.min(60_000, Number(cfg?.reply?.pollMs) || 1000)),
    },
    // 通知事件源（dyDouyin.notifyWatchSubscribe/notifyWatchStatus）；只投递/提示，不自动回复
    notify: {
      enabled: cfg?.notify?.enabled !== false,
    },
  }

  // ── 状态 ───────────────────────────────────────────────
  const seen = new Map() // 私信 dedupeKey -> at
  const notifySeen = new Map() // 通知 dedupeKey -> at（与私信分开）
  const queue = []
  const idleWaiters = []
  let processing = false
  let started = false
  let stopped = false
  let primed = false
  let attachTimer = null
  let pollTimer = null
  let unsubscribe = null
  let lastAttachCode = null
  let loaded = false
  let tableReady = false
  // 通知事件源（push 订阅）
  let notifyUnsubscribe = null
  let notifyAttachTimer = null
  let notifyAttachPromise = null
  let notifyLastCode = null
  let notifyPrimed = null // null=未知（信任源已建基线）、false=源未建基线（首轮不投）、true=已就绪
  let notifyLastLoggedCode = null

  // 每个 key 一个会话 handle / 一个单飞 promise（QQ 标准：per-key session）
  const handles = new Map() // key -> { agent, sessionId }
  const sessionToKey = new Map() // sessionId -> key（session/event → 回复目标）
  const sessionPromises = new Map() // key -> Promise
  let lastKey = null
  let lastSessionId = null

  // 自动回复：统一会话一个 watch（投递后挂上，回合结束按各入站事件的 conversationId 分别发）
  const replyWatches = new Map() // sessionId -> watch
  const replyFlushing = new Set()
  const pendingReplies = [] // 入站事件队列：{ eventKey, conversationId, contactName, at }（顺序 = 到达顺序）
  let replyTimer = null

  const stats = {
    mode: null,
    attached: false,
    events: 0,
    baselineSkipped: 0,
    deduped: 0,
    skippedSelf: 0,
    skippedEmpty: 0,
    routedOwner: 0,
    routedOthers: 0,
    failed: 0,
    lastCode: null,
    lastError: null,
    lastEventAt: null,
    lastRouteAt: null,
    lastPollAt: null,
    polls: 0,
    pollErrors: 0,
    subscribeEvents: 0,
    sessionCreated: 0,
    sessionResumed: 0,
    sessionCached: 0,
    sessionReplaced: 0,
    lastKey: null,
    lastSessionId: null,
    // 自动回复（QQ auto 标准）
    repliesSent: 0,
    repliesFailed: 0,
    repliesSkipped: 0,
    repliesTimeout: 0,
    lastReply: null,
    // 通知事件（只投递/提示，不自动回复）
    notifyEvents: 0,
    notifyBaselineSkipped: 0,
    notifyDeduped: 0,
    notifySkipped: 0,
    notifyOwner: 0,
    notifySession: 0,
    notifyFailed: 0,
    notifyLastCode: null,
    notifyLastError: null,
    notifyLastEventAt: null,
    lastNotify: null,
  }

  // ── 持久化：去重键 / 统计 / 会话指针 ────────────────────
  function ensureLoaded() {
    if (loaded) return
    loaded = true
    try {
      const saved = getMeta(db, DOUYIN_SEEN_META, null)
      const keys = Array.isArray(saved) ? saved : Array.isArray(saved?.keys) ? saved.keys : []
      for (const k of keys) if (typeof k === 'string' && k) seen.set(k, Number(saved?.at) || clock())
      while (seen.size > c.maxSeen) seen.delete(seen.keys().next().value)
      // 通知单独一份 seen（私信/通知互不影响）
      const savedNotify = getMeta(db, DOUYIN_NOTIFY_SEEN_META, null)
      const notifyKeys = Array.isArray(savedNotify) ? savedNotify : Array.isArray(savedNotify?.keys) ? savedNotify.keys : []
      for (const k of notifyKeys) if (typeof k === 'string' && k) notifySeen.set(k, Number(savedNotify?.at) || clock())
      while (notifySeen.size > c.maxSeen) notifySeen.delete(notifySeen.keys().next().value)
    } catch {
      // 状态缺失/损坏：当首次启动，重新建基线
    }
  }

  function persistSeen() {
    try {
      setMeta(db, DOUYIN_SEEN_META, { v: 2, at: clock(), keys: [...seen.keys()] }, clock())
    } catch {
      /* 落盘失败不影响投递 */
    }
  }

  function persistNotifySeen() {
    try {
      setMeta(db, DOUYIN_NOTIFY_SEEN_META, { v: 1, at: clock(), keys: [...notifySeen.keys()] }, clock())
    } catch {
      /* 落盘失败不影响投递 */
    }
  }

  function persistStats() {
    try {
      setMeta(
        db,
        DOUYIN_LAST_META,
        {
          at: clock(),
          events: stats.events,
          owner: stats.routedOwner,
          others: stats.routedOthers,
          deduped: stats.deduped,
          failed: stats.failed,
          lastCode: stats.lastCode,
          lastError: stats.lastError,
          contacts: handles.size,
          lastKey,
          lastSessionId,
          replies: {
            sent: stats.repliesSent,
            failed: stats.repliesFailed,
            skipped: stats.repliesSkipped,
            timeout: stats.repliesTimeout,
            last: stats.lastReply,
          },
          notify: {
            events: stats.notifyEvents,
            owner: stats.notifyOwner,
            session: stats.notifySession,
            deduped: stats.notifyDeduped,
            baselineSkipped: stats.notifyBaselineSkipped,
            skipped: stats.notifySkipped,
            failed: stats.notifyFailed,
            lastCode: stats.notifyLastCode,
            last: stats.lastNotify,
          },
        },
        clock(),
      )
    } catch {
      /* 同上 */
    }
  }

  function noteFailure(code, detail = {}) {
    stats.failed += 1
    stats.lastCode = String(code ?? 'UNKNOWN')
    stats.lastError = {
      at: clock(),
      code: stats.lastCode,
      route: detail.route ?? null,
      reason: detail.reason ?? null,
      key: detail.key ?? null,
      error: detail.error ? String(detail.error).slice(0, 300) : null,
    }
    persistStats()
    try {
      log?.warn?.(
        `[autonomy] douyin inbox 投递失败（不重放）：${stats.lastCode}${detail.reason ? `/${detail.reason}` : ''}${detail.key ? ` key=${detail.key}` : ''}`,
      )
    } catch {}
  }

  function ensureTable() {
    if (tableReady || !db) return
    try {
      let cols = []
      try {
        cols = db.prepare('PRAGMA table_info(douyin_sessions)').all().map((x) => x.name)
      } catch {}
      // 第一版（未上线、默认关）按 scope 建的表：没有生产数据，直接重建为 per-key
      if (cols.length && !cols.includes('key')) {
        db.exec('DROP TABLE IF EXISTS douyin_sessions')
        cols = []
        log?.warn?.('[autonomy] douyin_sessions 旧结构（scope）无生产数据，已重建为 per-key')
      }
      db.exec(DOUYIN_SESSIONS_DDL)
      const after = db.prepare('PRAGMA table_info(douyin_sessions)').all().map((x) => x.name)
      const add = [
        ['conversation_id', 'TEXT'],
        ['contact_name', 'TEXT'],
        ['prev_session_id', 'TEXT'],
        ['messages', 'INTEGER NOT NULL DEFAULT 0'],
        ['replaced_count', 'INTEGER NOT NULL DEFAULT 0'],
      ]
      for (const [name, ddl] of add) {
        if (!after.includes(name)) db.exec(`ALTER TABLE douyin_sessions ADD COLUMN ${name} ${ddl}`)
      }
      tableReady = true
    } catch (e) {
      log?.warn?.(`[autonomy] douyin_sessions 建表失败：${e?.message ?? e}`)
    }
  }

  const rowOf = (key) => {
    if (!db) return null
    try {
      ensureTable()
      return db.prepare('SELECT * FROM douyin_sessions WHERE key=?').get(String(key)) ?? null
    } catch {
      return null
    }
  }

  const touchRow = (key) => {
    if (!db) return
    try {
      db.prepare('UPDATE douyin_sessions SET last_seen_at=?, messages=messages+1 WHERE key=?').run(clock(), String(key))
    } catch {
      /* 观测字段，失败不影响投递 */
    }
  }

  // ── 服务 / 模型 / 闸门 ─────────────────────────────────
  const serviceOf = () => safe(getService, null)
  const agentsOf = () => safe(getAgents, null)

  const modelOf = () => {
    const sel = safe(getDefaultModel, null)
    const provider = String(sel?.provider ?? '').trim()
    const model = String(sel?.model ?? '').trim()
    return provider && model ? { provider, model } : null
  }

  const dryRunActive = () => {
    if (!c.respectDryRun) return false
    try {
      return Boolean(getDryRun())
    } catch {
      return false
    }
  }

  const normalizeOut = (out) => {
    if (!out) return null
    if (out.agent) return { agent: out.agent }
    if (typeof out.followup === 'function' || out.status) return { agent: out }
    return null
  }

  /** 主人消息的闸门：只拦自己的开关和总暂停；暂停/dryRun/队列交给 home.deliver 自己判 */
  function gateBase() {
    if (!c.enabled) return fail('DISABLED')
    try {
      if (pauseActive(getMeta(db, 'pause.all', null), clock())) return fail('PAUSED')
    } catch {
      /* 读不到暂停态按未暂停处理，比误停安全 */
    }
    return null
  }

  /** 其他人会话的闸门：多一层 dryRun（建会话要花模型调用，演练时不动） */
  function gateOthers() {
    const base = gateBase()
    if (base) return base
    if (dryRunActive()) return fail('DRY_RUN')
    return null
  }

  /** key 的 cwd：`<cwd>/<安全id>`（每个联系人一个目录，不共用一个） */
  /** 统一会话的 cwd：固定一个目录，不再按联系人拆子目录 */
  function cwdForKey(_key = DOUYIN_OTHERS_KEY) {
    return normalize(resolve(String(c.cwd || DEFAULT_DOUYIN_CWD)))
  }

  /** 建会话前确保 cwd 存在：必须落在 cwdRoot 白名单内（同 channel-bridge `ensureCwd` 口径） */
  function ensureCwdForKey(key = DOUYIN_OTHERS_KEY) {
    const root = normalize(resolve(String(c.cwdRoot || '/sdcard/DSHA')))
    const abs = cwdForKey(key)
    const inRoot = (p) => p === root || p.startsWith(`${root}/`)
    if (!inRoot(abs)) return unavailable('CWD_UNAVAILABLE', { reason: 'CWD_OUTSIDE_ROOT', key, cwd: abs })
    try {
      mkdirSync(abs, { recursive: true })
      return ok({ cwd: abs })
    } catch (e) {
      return unavailable('CWD_UNAVAILABLE', { reason: 'CWD_CREATE_FAILED', key, cwd: abs, error: String(e?.message ?? e) })
    }
  }

  // ── 独立会话（agents.create / resume） ─────────────────
  async function composeSetup() {
    const presets = safe(getPresets, null)
    const canMount = Boolean(presets && typeof presets.mount === 'function')
    if (!presets) log?.warn?.('[autonomy] agentPresets 不可用：抖音会话不传 setup（工具集可能只有全局工具）')
    const deny = c.denyTools
    if (!canMount && !deny.length) return { setup: null, presetId: c.agentPreset }
    let presetId = c.agentPreset
    if (canMount && typeof presets.resolve === 'function') {
      try {
        const r = await presets.resolve(c.agentPreset || undefined)
        const raw = r && typeof r === 'object' ? r.id : r
        presetId = String(raw ?? '').trim() || c.agentPreset
      } catch {
        presetId = c.agentPreset
      }
    }
    const setup = async (agentCtx, agent) => {
      if (canMount) {
        try {
          await presets.mount(agentCtx, presetId)
        } catch (e) {
          // fail-open：少一个预设，不能让会话建不起来（QQ 标准同口径）
          log?.warn?.(`[autonomy] 抖音会话 preset 挂载失败（不影响会话）：${String(e?.message ?? e).slice(0, 200)}`)
        }
      }
      if (!deny.length) return
      try {
        const tools = agentCtx?.tools
        if (typeof tools?.restrict !== 'function') return
        const known =
          typeof tools.get === 'function'
            ? deny.filter((n) => {
                try {
                  return Boolean(tools.get(n, agent))
                } catch {
                  return false
                }
              })
            : deny
        if (known.length) tools.restrict({ deny: known })
      } catch (e) {
        log?.warn?.(`[autonomy] 抖音会话工具裁剪失败（不影响会话）：${String(e?.message ?? e).slice(0, 200)}`)
      }
    }
    return { setup, presetId }
  }

  const sessionMeta = (key, _ev, cwd, presetId) => ({
    cwd,
    autonomyDouyinInbox: true,
    channel: 'douyin',
    douyinKey: key,
    scope: 'others',
    ...(presetId ? { agentPreset: presetId } : {}),
  })

  const setHandle = (key, agent, sessionId) => {
    const prev = handles.get(key)
    if (prev?.sessionId && prev.sessionId !== sessionId) sessionToKey.delete(String(prev.sessionId))
    handles.set(key, { agent, sessionId })
    if (sessionId) sessionToKey.set(String(sessionId), String(key))
    lastKey = key
    lastSessionId = sessionId
    stats.lastKey = key
    stats.lastSessionId = sessionId
  }

  async function liveAgentOf(sessionId) {
    const agents = agentsOf()
    if (!sessionId || !agents || typeof agents.get !== 'function') return null
    try {
      const out = await Promise.resolve(agents.get(sessionId))
      const h = normalizeOut(out)
      return h?.agent ?? null
    } catch {
      return null
    }
  }

  function recordReplaced(key, replacedFrom, to) {
    try {
      const list = getMeta(db, DOUYIN_REPLACED_META, [])
      const next = [
        ...(Array.isArray(list) ? list : []),
        { key: String(key), from: String(replacedFrom), to: String(to), at: clock() },
      ].slice(-50)
      setMeta(db, DOUYIN_REPLACED_META, next, clock())
    } catch {
      /* 留档失败不挡新建 */
    }
  }

  async function createForKey(key, ev, { replacedFrom = null } = {}) {
    const model = modelOf()
    if (!model) return unavailable('NO_MODEL', { key })
    const agents = agentsOf()
    if (!agents || typeof agents.create !== 'function') return unavailable('AGENTS_UNAVAILABLE', { key })
    const cwdCheck = ensureCwdForKey(key)
    if (!cwdCheck.ok) return cwdCheck
    const cwd = cwdCheck.cwd

    const composed = await composeSetup()
    const sessionId = randomUUID()
    let out
    try {
      out = await Promise.resolve(
        agents.create({
          sessionId,
          meta: sessionMeta(key, ev, cwd, composed.presetId),
          ...(composed.setup ? { setup: composed.setup } : {}),
          agentOptions: model,
        }),
      )
    } catch (e) {
      return fail('SESSION_CREATE_FAILED', { key, error: String(e?.message ?? e) })
    }
    const h = normalizeOut(out)
    if (!h) return fail('SESSION_CREATE_FAILED', { key, error: 'agents.create 未返回 agent' })

    const now = clock()
    try {
      ensureTable()
      if (replacedFrom) {
        db.prepare(
          `UPDATE douyin_sessions
             SET session_id=?, prev_session_id=?, cwd=?, conversation_id=?, contact_name=?, last_seen_at=?, replaced_count=replaced_count+1
           WHERE key=?`,
        ).run(sessionId, String(replacedFrom), cwd, ev?.conversationId ?? null, ev?.contactName ?? null, now, key)
        const row = db.prepare('SELECT session_id FROM douyin_sessions WHERE key=?').get(key)
        if (!row) throw new Error('旧行消失')
      } else {
        db.prepare(
          `INSERT INTO douyin_sessions(key, conversation_id, contact_name, session_id, prev_session_id, cwd, created_at, last_seen_at, messages, replaced_count)
           VALUES(?,?,?,?,NULL,?,?,?,0,0)
           ON CONFLICT(key) DO UPDATE SET
             conversation_id=excluded.conversation_id, contact_name=excluded.contact_name,
             session_id=excluded.session_id, cwd=excluded.cwd, last_seen_at=excluded.last_seen_at`,
        ).run(key, ev?.conversationId ?? null, ev?.contactName ?? null, sessionId, cwd, now, now)
      }
    } catch (e) {
      try {
        h.agent?.dispose?.()
      } catch {}
      return fail('SESSION_CREATE_FAILED', { key, error: String(e?.message ?? e) })
    }
    if (replacedFrom) {
      recordReplaced(key, replacedFrom, sessionId)
      stats.sessionReplaced += 1
    }
    setHandle(key, h.agent, sessionId)
    stats.sessionCreated += 1
    log?.info?.(
      `[autonomy] 抖音独立会话已创建 ${sessionId.slice(0, 8)}… key=${key} cwd=${cwd}${replacedFrom ? `（旧 ${String(replacedFrom).slice(0, 8)}… 留档）` : ''}`,
    )
    return ok({
      code: replacedFrom ? 'REPLACED' : 'CREATED',
      key,
      sessionId,
      cwd,
      created: true,
      resumed: false,
      replacedFrom,
      agent: h.agent,
    })
  }

  async function ensureSessionInner(key, ev) {
    const model = modelOf()
    if (!model) return unavailable('NO_MODEL', { key })
    const agents = agentsOf()
    if (!agents || (typeof agents.create !== 'function' && typeof agents.resume !== 'function')) {
      return unavailable('AGENTS_UNAVAILABLE', { key })
    }
    const row = rowOf(key)
    const prevId = row?.session_id ? String(row.session_id) : ''

    // 1) 内存缓存：宿主里还活着就直接用（同一会话不能 resume 两次）
    const cached = handles.get(key)
    if (cached?.agent) {
      if (typeof agents.get !== 'function') {
        stats.sessionCached += 1
        return ok({ code: 'CACHED', key, sessionId: cached.sessionId, created: false, resumed: false, agent: cached.agent })
      }
      const live = await liveAgentOf(cached.sessionId)
      if (live) {
        setHandle(key, live, cached.sessionId)
        stats.sessionCached += 1
        return ok({ code: 'CACHED', key, sessionId: cached.sessionId, created: false, resumed: false, agent: live })
      }
      handles.delete(key) // 宿主里已不在：走 live/resume/新建
    }

    // 2) 宿主里已经有这个会话的 live agent
    const live = prevId ? await liveAgentOf(prevId) : null
    if (live) {
      setHandle(key, live, prevId)
      try {
        db.prepare('UPDATE douyin_sessions SET last_seen_at=? WHERE key=?').run(clock(), key)
      } catch {}
      stats.sessionCached += 1
      return ok({ code: 'EXISTING', key, sessionId: prevId, created: false, resumed: false, agent: live })
    }

    // 3) resume 旧会话
    if (prevId && typeof agents.resume === 'function') {
      const composed = await composeSetup()
      let out = null
      try {
        out = await Promise.resolve(
          agents.resume({
            resumeSessionId: prevId,
            meta: sessionMeta(key, ev, row?.cwd || cwdForKey(key), composed.presetId),
            ...(composed.setup ? { setup: composed.setup } : {}),
            agentOptions: model,
          }),
        )
      } catch (e) {
        log?.warn?.(`[autonomy] 抖音会话 resume 失败（改新建）：key=${key} ${String(e?.message ?? e).slice(0, 200)}`)
        out = null
      }
      const h = normalizeOut(out)
      if (h) {
        setHandle(key, h.agent, prevId)
        stats.sessionResumed += 1
        try {
          db.prepare('UPDATE douyin_sessions SET last_seen_at=? WHERE key=?').run(clock(), key)
        } catch {}
        return ok({ code: 'RESUMED', key, sessionId: prevId, created: false, resumed: true, agent: h.agent })
      }
    }

    // 4) 只有前面都失败才新建；旧 id 留档 prev_session_id（绝不静默丢消息）
    return createForKey(key, ev, { replacedFrom: prevId || null })
  }

  /** 建/恢复（同 key 并发去重：同一时刻只 ensure 一个会话） */
  function ensureSession(key, ev) {
    const inflight = sessionPromises.get(key)
    if (inflight) return inflight
    const p = ensureSessionInner(key, ev)
      .catch((e) => fail('SESSION_ENSURE_FAILED', { key, error: String(e?.message ?? e) }))
      .finally(() => {
        sessionPromises.delete(key)
      })
    sessionPromises.set(key, p)
    return p
  }

  // ── 消息构造 / 投递 ─────────────────────────────────────
  const asContentArray = (content) => (Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }])

  async function buildUserMessage(ev) {
    const content = [{ type: 'text', text: formatDouyinEventLine(ev) }]
    const source = {
      kind: 'user',
      channelInbound: true,
      channel: 'douyin',
      contactId: ev.conversationId ?? null,
      contactName: ev.contactName ?? null,
      conversationId: ev.conversationId ?? null,
      scope: ev.convKey, // douyin:others（总接待室）
      key: ev.convKey,
      owner: false,
    }
    try {
      const mod = await import('@deepseek-ai/dsh-llm')
      if (typeof mod?.createUserMessage === 'function') {
        const m = mod.createUserMessage({ content, source })
        if (m && typeof m === 'object') {
          if (!m.id) m.id = randomUUID()
          if (!m.role) m.role = 'user'
          m.content = asContentArray(m.content)
          return m
        }
      }
    } catch {}
    return { id: randomUUID(), role: 'user', content: asContentArray(content), source }
  }

  async function deliverToOthers(ev) {
    const key = ev.convKey // douyin:others（所有非主人同一个总接待室）
    let resolved = await ensureSession(key, ev)
    if (!resolved.ok) return resolved
    const message = await buildUserMessage(ev)
    let startSeq = readAgentEvents(resolved.agent).length
    try {
      await resolved.agent.followup(message)
      touchRow(key)
      const pending = queuePendingReply(ev) // 保留这条事件自己的 conversationId
      const watch = noteReplyWatch({ key, agent: resolved.agent, sessionId: resolved.sessionId, startSeq })
      return ok({
        code: 'DELIVERED',
        key,
        sessionId: resolved.sessionId,
        delivered: true,
        replyArmed: Boolean(watch),
        replyTarget: pending?.conversationId ?? null,
      })
    } catch (e) {
      const firstError = String(e?.message ?? e).slice(0, 200)
      // 缓存句柄可能已失效：清掉会话缓存后重新 ensure 一次，再试一次（只一次，不无限重试）
      handles.delete(key)
      resolved = await ensureSession(key, ev)
      if (!resolved.ok) return { ...resolved, error: firstError }
      startSeq = readAgentEvents(resolved.agent).length
      try {
        await resolved.agent.followup(message)
        touchRow(key)
        const pending = queuePendingReply(ev)
        const watch = noteReplyWatch({ key, agent: resolved.agent, sessionId: resolved.sessionId, startSeq })
        return ok({
          code: 'DELIVERED',
          key,
          sessionId: resolved.sessionId,
          delivered: true,
          retried: true,
          replyArmed: Boolean(watch),
          replyTarget: pending?.conversationId ?? null,
        })
      } catch (e2) {
        return fail('DELIVER_FAILED', { key, error: String(e2?.message ?? e2).slice(0, 300), sessionId: resolved.sessionId })
      }
    }
  }

  async function deliverToHome(ev) {
    const home = safe(getHome, null)
    if (!home || typeof home.deliver !== 'function') return unavailable('HOME_UNAVAILABLE')
    const payload = {
      channel: 'douyin',
      kind: 'private',
      contactId: ev.conversationId ?? ev.conversationName ?? 'douyin',
      contactName: ev.contactName ?? '抖音',
      text: formatDouyinEventLine(ev),
      priority: 'owner',
      messageId: ev.id ?? null,
    }
    try {
      const r = await Promise.resolve(home.deliver(payload))
      if (r && r.ok === true) return ok({ code: r.code ?? 'DELIVERED', queued: r.queued === true, delivered: r.delivered === true, deduped: r.deduped === true, priority: 'owner' })
      return fail(String(r?.code ?? 'HOME_REJECTED'), { error: r?.error ?? null, priority: 'owner' })
    } catch (e) {
      return fail('HOME_DELIVER_FAILED', { error: String(e?.message ?? e).slice(0, 300) })
    }
  }

  // ── 自动回复（QQ auto 标准：回合结束把最后一段 assistant 文本发回对应联系人） ──
  const REPLY_SILENT = '[SILENT]'

  /** 读 agent 内存事件日志（宿主 session.log / snapshotEvents；拿不到返回 []） */
  function readAgentEvents(agent) {
    try {
      const s = agent?.session
      if (Array.isArray(s?.log)) return s.log
      if (typeof s?.snapshotEvents === 'function') return s.snapshotEvents(0) ?? []
    } catch {}
    return []
  }

  /** 投递成功 → 记一条待回复（保留它自己的 conversationId，绝不合并/串目标） */
  function queuePendingReply(ev) {
    if (!c.reply?.enabled) return null
    const entry = {
      eventKey: ev?.key ?? null,
      conversationId: ev?.targetId ? String(ev.targetId).trim() : null,
      contactName: ev?.contactName ?? null,
      at: clock(),
    }
    pendingReplies.push(entry)
    while (pendingReplies.length > 200) pendingReplies.shift() // 内存上限（正常远小于）
    return entry
  }

  /** 统一会话的回复 watch：同一回合内多条入站共用；回合结束发完即摘除 */
  function noteReplyWatch({ key, agent, sessionId, startSeq = null }) {
    if (!c.reply?.enabled) return null
    const sid = String(sessionId ?? '')
    if (!sid || !agent || !key) return null
    // 会话换了（resume 失败新建等）：旧 session 的 watch 已无意义，摘掉防串发
    for (const [oldSid, oldWatch] of [...replyWatches.entries()]) {
      if (oldWatch.key === String(key) && oldSid !== sid) replyWatches.delete(oldSid)
    }
    const existing = replyWatches.get(sid)
    if (existing) {
      // 同一回合又有新消息进来：共用这个 watch（文本在回合结束后统一取最后一段）
      existing.lastEventAt = clock()
      existing.deadline = clock() + c.reply.timeoutMs
      ensureReplyLoop()
      return existing
    }
    const watch = {
      key: String(key),
      agent,
      sessionId: sid,
      startSeq: Number.isFinite(Number(startSeq)) ? Number(startSeq) : readAgentEvents(agent).length,
      startedAt: clock(),
      deadline: clock() + c.reply.timeoutMs,
      pushText: '',
      pushEnded: false,
      pushError: false,
      lastEventAt: null,
    }
    replyWatches.set(sid, watch)
    ensureReplyLoop()
    return watch
  }

  function scanReplyWatch(watch) {
    let text = ''
    let ended = false
    let error = false
    const events = readAgentEvents(watch.agent).slice(watch.startSeq)
    for (const ev of events) {
      if (ev?.type === 'assistant/message') {
        const t = douyinReplyText(ev?.data)
        if (t) text = t
      } else if (ev?.type === 'turn/end') {
        ended = true
        error = douyinTurnEndError(ev?.data)
      }
    }
    // 推送通道（ctx session/event）比日志更早/更细：有就用
    if (watch.pushText) text = watch.pushText
    if (watch.pushEnded) {
      ended = true
      error = watch.pushError
    }
    return { text, ended, error }
  }

  /** 待回复事件按 conversationId 分组（保持首次出现顺序；同一联系人只发一条，事件各自算已回） */
  function replyTargetsOf(entries) {
    const map = new Map()
    for (const entry of entries) {
      const id = entry.conversationId || ''
      if (!map.has(id)) map.set(id, { conversationId: entry.conversationId || null, entries: [] })
      map.get(id).entries.push(entry)
    }
    return [...map.values()]
  }

  /**
   * 发一批回复（一个回合一次）：
   * 文本取本轮最后一段 assistant text；待回复事件按各自 conversationId 分别 dmSend（绝不合并目标）。
   * 错误回合 / 空文本 / 只有 reasoning / [SILENT] / 暂停 → 整批跳过；单个目标失败不重试、不影响其他目标。
   */
  async function flushReply(sessionId, { timeout = false } = {}) {
    const sid = String(sessionId ?? '')
    if (!sid || replyFlushing.has(sid)) return { ok: false, code: 'BUSY' }
    const watch = replyWatches.get(sid)
    if (!watch) return { ok: false, code: 'NO_WATCH' }
    replyWatches.delete(sid)
    if (!replyWatches.size) stopReplyLoop()
    replyFlushing.add(sid)
    const batch = pendingReplies.splice(0, pendingReplies.length) // 快照；发完/失败都不重试
    try {
      const targets = replyTargetsOf(batch)
      const finish = (code, results, extra = {}) => {
        const sent = results.filter((x) => x.outcome === 'sent').length
        const failed = results.filter((x) => x.outcome === 'failed').length
        const skipped = results.filter((x) => x.outcome === 'skipped').length
        stats.repliesSent += sent
        stats.repliesFailed += failed
        stats.repliesSkipped += skipped
        stats.lastReply = {
          at: clock(),
          key: watch.key,
          code,
          verified: sent > 0 && results.every((x) => x.outcome !== 'sent' || x.verified === true),
          chars: extra.chars ?? 0,
          ...(extra.textHash ? { textHash: extra.textHash } : {}),
          targets: results,
        }
        persistStats()
        return { ok: sent > 0, code, key: watch.key, sent, failed, skipped, results }
      }

      if (timeout) {
        stats.repliesTimeout += 1
        const results = targets.map((t) => ({
          conversationId: t.conversationId,
          ok: false,
          verified: false,
          outcome: 'skipped',
          code: 'REPLY_TIMEOUT',
        }))
        const out = finish('REPLY_TIMEOUT', results)
        log?.warn?.(
          `[autonomy] 抖音自动回复超时（${Math.round(c.reply.timeoutMs / 1000)}s 没有回合结束）：${watch.key} 待回 ${targets.length} 个会话，不发送、不重试`,
        )
        return out
      }

      const scanned = scanReplyWatch(watch)
      if (!scanned.ended) {
        // 调用方以为结束了但还没有 turn/end：按原顺序放回队首等下一轮（不算发送）
        pendingReplies.unshift(...batch)
        while (pendingReplies.length > 200) pendingReplies.pop()
        replyWatches.set(sid, watch)
        ensureReplyLoop()
        return { ok: false, code: 'TURN_NOT_ENDED', key: watch.key }
      }

      const raw = squash(scanned.text)
      const withoutSilent = raw.split(REPLY_SILENT).join('').trim()
      const text = Array.from(withoutSilent).slice(0, c.reply.maxChars).join('')
      const chars = text ? Array.from(text).length : 0
      let skipCode = null
      if (scanned.error) skipCode = 'TURN_ERROR'
      else if (!raw) skipCode = 'EMPTY' // 空文本 / 只有 tool 调用（没有 text 分块）
      else if (!withoutSilent) skipCode = 'SILENT' // 这一轮只有 [SILENT]
      else if (!text) skipCode = 'EMPTY'
      else {
        const g = gateOthers() // 不绕过暂停 / dryRun
        if (g) skipCode = g.code
        else if (!targets.length) skipCode = 'NO_TARGET'
      }
      if (skipCode) {
        const results = targets.map((t) => ({
          conversationId: t.conversationId,
          ok: false,
          verified: false,
          outcome: 'skipped',
          code: skipCode,
        }))
        const out = finish(skipCode, results, { chars })
        log?.info?.(`[autonomy] 抖音自动回复跳过：${skipCode} key=${watch.key} 待回 ${targets.length} 个会话`)
        return out
      }

      const svc = serviceOf()
      const canSend = Boolean(svc && typeof svc.dmSend === 'function')
      const results = []
      for (const target of targets) {
        if (!target.conversationId) {
          // 不按昵称猜：没有 conversationId 的入站事件只能记为跳过
          results.push({ conversationId: null, ok: false, verified: false, outcome: 'skipped', code: 'NO_CONVERSATION_ID' })
          continue
        }
        if (!canSend) {
          results.push({
            conversationId: target.conversationId,
            ok: false,
            verified: false,
            outcome: 'skipped',
            code: 'DM_SEND_UNAVAILABLE',
          })
          continue
        }
        let r = null
        try {
          r = await Promise.resolve(svc.dmSend({ conversationId: target.conversationId, text, confirm: true }))
        } catch (e) {
          results.push({
            conversationId: target.conversationId,
            ok: false,
            verified: false,
            outcome: 'failed',
            code: 'DM_SEND_FAILED',
            error: String(e?.message ?? e).slice(0, 200),
          })
          continue
        }
        if (!r || r.ok !== true) {
          results.push({
            conversationId: target.conversationId,
            ok: false,
            verified: false,
            outcome: 'failed',
            code: String(r?.code ?? 'DM_SEND_FAILED'),
            ...(r?.message ? { error: String(r.message).slice(0, 200) } : {}),
          })
          continue
        }
        results.push({
          conversationId: target.conversationId,
          ok: true,
          verified: r.verified === true,
          outcome: 'sent',
          code: r.verified === true ? 'SENT' : 'SENT_UNVERIFIED',
          chars,
        })
      }
      const code = results.some((x) => x.ok === true)
        ? results.every((x) => x.ok === true && x.verified === true)
          ? 'SENT'
          : 'SENT_UNVERIFIED'
        : String(results[0]?.code ?? 'NO_TARGET')
      const out = finish(code, results, { chars, ...(text ? { textHash: hash12(text) } : {}) })
      log?.info?.(
        `[autonomy] 抖音自动回复：${watch.key} ${chars} 字 → ${results.length} 个会话（ok=${out.sent} fail=${out.failed}${results.some((x) => x.code === 'DM_SEND_UNAVAILABLE') ? ' dmSend 不可用' : ''}）`,
      )
      return out
    } finally {
      replyFlushing.delete(sid)
    }
  }

  /** 推送通道：宿主 session/event → 目标会话的 assistant 文本 / turn end */
  function observeSessionEvent(session, event) {
    try {
      const sid = String(session?.header?.id ?? session?.id ?? '')
      if (!sid) return null
      const watch = replyWatches.get(sid) ?? null
      if (!watch) return null
      if (event?.type === 'assistant/message') {
        const text = douyinReplyText(event?.data)
        if (text) watch.pushText = text
        watch.lastEventAt = clock()
        return { assistant: true, chars: Array.from(watch.pushText).length }
      }
      if (event?.type === 'turn/end') {
        watch.pushEnded = true
        watch.pushError = douyinTurnEndError(event?.data)
        void flushReply(sid, { timeout: false })
        return { turnEnd: true }
      }
      return null
    } catch {
      return null
    }
  }

  /** 兜底轮询：push 事件不可用/漏收时，每 reply.pollMs 扫一次 agent.session.log */
  function replyTick() {
    if (!c.reply?.enabled) return { checked: 0, pending: replyWatches.size }
    for (const [sid, watch] of [...replyWatches.entries()]) {
      const scanned = scanReplyWatch(watch)
      if (scanned.ended) {
        void flushReply(sid, { timeout: false })
        continue
      }
      if (clock() >= watch.deadline) void flushReply(sid, { timeout: true })
    }
    return { checked: replyWatches.size, pending: replyWatches.size }
  }

  function ensureReplyLoop() {
    if (replyTimer || !started || stopped || !c.reply?.enabled || !replyWatches.size) return
    replyTimer = setT(() => {
      replyTimer = null
      try {
        replyTick()
      } catch {}
      ensureReplyLoop()
    }, c.reply.pollMs)
    try {
      replyTimer?.unref?.()
    } catch {}
  }

  function stopReplyLoop() {
    if (replyTimer) {
      try {
        clearT(replyTimer)
      } catch {}
      replyTimer = null
    }
  }

  // ── 通知事件源（dyDouyin.notifyWatchSubscribe / notifyWatchStatus） ──
  // 只做「投入会话/提示」：owner 通知 → home；其他通知 → 统一抖音会话（douyin:others）；
  // **绝不自动回复、绝不拿通知去发私信**（通知没有 conversationId，回复只能由主人/工具按稳定 id 精准做）。

  function notifySourcePrimed() {
    try {
      const st = serviceOf()?.notifyWatchStatus?.()
      if (st && typeof st.primed === 'boolean') return st.primed
    } catch {}
    return null
  }

  function setNotifyCode(code) {
    notifyLastCode = code
    if (notifyLastLoggedCode === code) return
    notifyLastLoggedCode = code
    if (code) log?.warn?.(`[autonomy] 抖音通知事件源降级：${code}（私信路由/自动回复不受影响）`)
  }

  function scheduleNotifyAttach(delayMs = c.attachRetryMs) {
    if (!started || stopped || notifyAttachTimer || notifyUnsubscribe) return
    notifyAttachTimer = setT(() => {
      notifyAttachTimer = null
      void attachNotify()
    }, Math.max(0, delayMs))
    try {
      notifyAttachTimer?.unref?.()
    } catch {}
  }

  /** 订阅通知事件；没有 notifyWatchSubscribe 时明确降级（不静默），并定期重试等 API 上线 */
  function attachNotify() {
    if (notifyAttachPromise) return notifyAttachPromise
    notifyAttachPromise = attachNotifyInner().finally(() => {
      notifyAttachPromise = null
    })
    return notifyAttachPromise
  }

  async function attachNotifyInner() {
    if (!started || stopped || notifyUnsubscribe) return ok({ mode: 'already' })
    if (!c.notify.enabled) {
      setNotifyCode('NOTIFY_DISABLED')
      return fail('NOTIFY_DISABLED')
    }
    const svc = serviceOf()
    if (!svc) {
      setNotifyCode('SERVICE_UNAVAILABLE')
      scheduleNotifyAttach()
      return unavailable('SERVICE_UNAVAILABLE')
    }
    if (typeof svc.notifyWatchSubscribe !== 'function') {
      setNotifyCode('NOTIFY_UNAVAILABLE')
      scheduleNotifyAttach()
      return fail('NOTIFY_UNAVAILABLE')
    }
    let off = null
    try {
      off = await Promise.resolve(svc.notifyWatchSubscribe(onNotifyEvent))
    } catch (e) {
      setNotifyCode('NOTIFY_SUBSCRIBE_FAILED')
      scheduleNotifyAttach()
      return fail('NOTIFY_SUBSCRIBE_FAILED', { error: String(e?.message ?? e) })
    }
    notifyUnsubscribe = typeof off === 'function' ? off : () => {}
    notifyPrimed = notifySourcePrimed()
    setNotifyCode(null)
    log?.info?.(
      `[autonomy] 抖音通知已订阅（owner→home，其他人→统一会话；首轮基线${notifyPrimed === false ? '源未就绪，先不投' : '信任源已建'}）`,
    )
    return ok({ mode: 'subscribe', primed: notifyPrimed })
  }

  function onNotifyEvent(event) {
    void enqueueJob('notify', event)
  }

  function markNotifySeen(key) {
    if (!key) return
    notifySeen.set(key, clock())
    while (notifySeen.size > c.maxSeen) notifySeen.delete(notifySeen.keys().next().value)
  }

  function noteNotifyFailure(code, ev, detail = {}) {
    stats.notifyFailed += 1
    stats.notifyLastCode = String(code ?? 'NOTIFY_FAILED')
    stats.notifyLastError = {
      at: clock(),
      code: stats.notifyLastCode,
      notifyId: ev?.id ?? null,
      error: detail.error ? String(detail.error).slice(0, 200) : null,
    }
    persistStats()
    try {
      log?.warn?.(`[autonomy] 抖音通知投递失败（不重放）：${stats.notifyLastCode}${ev?.id ? ` id=${ev.id}` : ''}`)
    } catch {}
  }

  async function deliverNotifyToHome(ev) {
    const home = safe(getHome, null)
    if (!home || typeof home.deliver !== 'function') return unavailable('HOME_UNAVAILABLE')
    try {
      const r = await Promise.resolve(
        home.deliver({
          channel: 'douyin',
          kind: 'private',
          contactId: ev.id ? `notify:${ev.id}` : ev.actor,
          contactName: ev.actor,
          text: formatDouyinNotifyLine(ev),
          priority: 'owner',
          messageId: ev.id ? `notify:${ev.id}` : null,
        }),
      )
      if (r && r.ok === true) return ok({ code: r.code ?? 'DELIVERED', route: 'home' })
      return fail(String(r?.code ?? 'HOME_REJECTED'), { route: 'home' })
    } catch (e) {
      return fail('HOME_DELIVER_FAILED', { route: 'home', error: String(e?.message ?? e).slice(0, 300) })
    }
  }

  async function buildNotifyMessage(ev) {
    const content = [{ type: 'text', text: formatDouyinNotifyLine(ev) }]
    const source = {
      kind: 'user',
      channelInbound: true,
      channel: 'douyin',
      source: 'notify', // 与私信区分
      notifyId: ev.id,
      actor: ev.actor,
      notifyType: ev.type,
      replyable: ev.replyable === true,
      owner: ev.owner === true,
      scope: DOUYIN_OTHERS_KEY,
      // 通知没有 conversationId：不写、也不能拿去发私信
    }
    try {
      const mod = await import('@deepseek-ai/dsh-llm')
      if (typeof mod?.createUserMessage === 'function') {
        const m = mod.createUserMessage({ content, source })
        if (m && typeof m === 'object') {
          if (!m.id) m.id = randomUUID()
          if (!m.role) m.role = 'user'
          m.content = asContentArray(m.content)
          return m
        }
      }
    } catch {}
    return { id: randomUUID(), role: 'user', content: asContentArray(content), source }
  }

  async function deliverNotifyToSession(ev) {
    const key = DOUYIN_OTHERS_KEY
    const resolved = await ensureSession(key, ev)
    if (!resolved.ok) return resolved
    const message = await buildNotifyMessage(ev)
    try {
      await resolved.agent.followup(message)
      touchRow(key)
      // 通知只进会话，不挂自动回复、不进 pendingReplies
      return ok({ code: 'DELIVERED', key, sessionId: resolved.sessionId, route: 'session' })
    } catch (e) {
      return fail('DELIVER_FAILED', { key, error: String(e?.message ?? e).slice(0, 300), sessionId: resolved.sessionId })
    }
  }

  /**
   * 通知单事件路由：owner → home；其他 → 统一会话。与私信去重分开；首轮基线不投。
   * 返回 {ok, route:'home'|'session'|'skipped', ...}；失败不抛、记 stats.notify*。
   */
  async function routeNotifyOne(rawEvent) {
    ensureLoaded()
    stats.notifyEvents += 1
    stats.notifyLastEventAt = clock()
    const ev = normalizeDouyinNotifyEvent(rawEvent)
    if (!ev) return fail('BAD_EVENT', { route: 'notify' })

    const key = ev.key
    if (key && notifySeen.has(key)) {
      stats.notifyDeduped += 1
      return ok({ route: 'skipped', deduped: true, code: 'DEDUPED', notifyId: ev.id })
    }

    // 首轮基线：源 watcher 还没建好基线（notifyWatchStatus().primed === false）时只记 seen、不投
    const st = notifySourcePrimed()
    if (st === true) notifyPrimed = true
    else if (st === false) notifyPrimed = false

    markNotifySeen(key)
    persistNotifySeen()
    if (notifyPrimed === false) {
      stats.notifyBaselineSkipped += 1
      return ok({ route: 'skipped', baseline: true, code: 'NOTIFY_BASELINE', notifyId: ev.id })
    }

    if (!c.notify.enabled) {
      stats.notifySkipped += 1
      return ok({ route: 'skipped', code: 'NOTIFY_DISABLED', notifyId: ev.id })
    }
    const g = ev.owner ? gateBase() : gateOthers()
    if (g) {
      stats.notifySkipped += 1
      stats.notifyLastCode = g.code
      persistStats()
      return { ...g, route: 'notify', notifyId: ev.id, owner: ev.owner }
    }

    const r = ev.owner ? await deliverNotifyToHome(ev) : await deliverNotifyToSession(ev)
    if (!r.ok) {
      noteNotifyFailure(r.code, ev, { error: r.error })
      return { ...r, route: 'notify', owner: ev.owner, notifyId: ev.id }
    }
    if (ev.owner) stats.notifyOwner += 1
    else stats.notifySession += 1
    stats.lastNotify = {
      at: clock(),
      notifyId: ev.id,
      actor: ev.actor,
      type: ev.type,
      owner: ev.owner,
      route: ev.owner ? 'home' : 'session',
    }
    persistStats()
    return { ...r, route: 'notify', owner: ev.owner, notifyId: ev.id }
  }

  /**
   * 单事件路由（串行队列里的实际动作）。
   * 返回：{ok, route:'home'|'others', code, ...}；失败不抛、记 stats.lastError。
   */
  async function routeOne(rawEvent) {
    ensureLoaded()
    stats.events += 1
    stats.lastEventAt = clock()
    const ev = normalizeDouyinEvent(rawEvent)
    if (!ev) return fail('BAD_EVENT', { route: 'none' })
    if (ev.fromMe && c.skipFromMe) {
      stats.skippedSelf += 1
      return ok({ route: 'skipped', skipped: 'fromMe', code: 'SKIPPED_SELF' })
    }
    if (!ev.text) {
      stats.skippedEmpty += 1
      return ok({ route: 'skipped', skipped: 'empty', code: 'SKIPPED_EMPTY' })
    }
    const key = ev.key
    if (key && seen.has(key)) {
      stats.deduped += 1
      return ok({ route: 'skipped', deduped: true, code: 'DEDUPED', key: ev.convKey })
    }
    if (key) {
      seen.set(key, clock())
      while (seen.size > c.maxSeen) seen.delete(seen.keys().next().value)
      persistSeen()
    }

    if (ev.owner) {
      const g = gateBase()
      if (g) {
        noteFailure(g.code, { route: 'home', reason: g.reason })
        return { ...g, route: 'home' }
      }
      const r = await deliverToHome(ev)
      if (!r.ok) {
        noteFailure(r.code, { route: 'home', reason: r.reason, error: r.error })
        return { ...r, route: 'home' }
      }
      stats.routedOwner += 1
      stats.lastRouteAt = clock()
      persistStats()
      return { ...r, route: 'home', owner: true }
    }

    const g = gateOthers()
    if (g) {
      noteFailure(g.code, { route: 'others', reason: g.reason, key: ev.convKey })
      return { ...g, route: 'others' }
    }
    const r = await deliverToOthers(ev)
    if (!r.ok) {
      noteFailure(r.code, { route: 'others', reason: r.reason, key: ev.convKey, error: r.error })
      return { ...r, route: 'others' }
    }
    stats.routedOthers += 1
    stats.lastRouteAt = clock()
    persistStats()
    return { ...r, route: 'others', owner: false }
  }

  // ── 串行队列（保持事件顺序，单飞） ──────────────────────
  // 关键：出队和「processing=false」必须在同一个同步块里完成，否则会丢唤醒：
  // 上一事件 await 完后，测试/订阅方拿到 resolve 的微任务可能先于 pump 的 finally 执行，
  // 此时入队的新事件会看到 draining 仍为真却不被处理（2026-11-14 第一版就踩了这个坑）。
  function kick() {
    if (processing) return
    processing = true
    void (async () => {
      try {
        for (;;) {
          const item = queue.shift()
          if (!item) {
            processing = false // 先清标志再复查队列：中间没有 await，不会丢事件
            if (!queue.length) return
            if (processing) return
            processing = true
            continue
          }
          let out
          try {
            out = item.kind === 'notify' ? await routeNotifyOne(item.event) : await routeOne(item.event)
          } catch (e) {
            const code = item.kind === 'notify' ? 'NOTIFY_ROUTE_FAILED' : 'ROUTE_FAILED'
            if (item.kind === 'notify') noteNotifyFailure(code, null, { error: String(e?.message ?? e) })
            else noteFailure(code, { error: String(e?.message ?? e) })
            out = fail(code, { error: String(e?.message ?? e).slice(0, 300) })
          }
          item.resolve(out)
        }
      } finally {
        processing = false
        const waiters = idleWaiters.splice(0)
        for (const resolve of waiters) resolve()
      }
    })()
  }

  /** 入队（kind='dm' 私信 / 'notify' 通知；共用串行队列，顺序稳定） */
  function enqueueJob(kind, event) {
    return new Promise((resolve) => {
      queue.push({ kind, event, resolve })
      kick()
    })
  }

  function enqueue(event) {
    return enqueueJob('dm', event)
  }

  /** 等当前队列清空（测试/手动 poll 用；不阻塞新事件的入队） */
  function whenIdle() {
    if (!processing && !queue.length) return Promise.resolve()
    return new Promise((resolve) => idleWaiters.push(resolve))
  }

  // ── 事件源：订阅 / 轮询 ────────────────────────────────
  function resolveMode(svc) {
    if (!svc) return null
    if (c.mode === 'poll') return typeof svc.dmWatch === 'function' ? 'poll' : null
    if (c.mode === 'subscribe') return typeof svc.dmWatchSubscribe === 'function' ? 'subscribe' : null
    if (typeof svc.dmWatchSubscribe === 'function') return 'subscribe'
    if (typeof svc.dmWatch === 'function') return 'poll'
    return null
  }

  function onSourceEvent(event) {
    stats.subscribeEvents += 1
    void enqueue(event)
  }

  function maybeStartSource(svc) {
    // 只在明确「源 watcher 没跑」时显式 start（幂等）；状态未知不乱动
    try {
      const st = svc?.dmWatchStatus?.()
      if (st && st.cfgEnabled !== false && st.running === false && typeof svc.dmWatch === 'function') {
        void Promise.resolve(svc.dmWatch({ action: 'start' })).catch(() => {})
        log?.info?.('[autonomy] 抖音 dm watcher 未在跑：已请求 start（幂等）')
      }
    } catch {}
  }

  function scheduleAttach(delayMs = c.attachRetryMs) {
    if (!started || stopped || attachTimer || unsubscribe || pollTimer) return
    attachTimer = setT(() => {
      attachTimer = null
      void attach()
    }, Math.max(0, delayMs))
    try {
      attachTimer?.unref?.()
    } catch {}
  }

  function schedulePoll(delayMs = c.pollMs) {
    if (!started || stopped || pollTimer) return
    pollTimer = setT(async () => {
      pollTimer = null
      try {
        await pollOnce()
      } catch {}
      schedulePoll(c.pollMs)
    }, Math.max(0, delayMs))
    try {
      pollTimer?.unref?.()
    } catch {}
  }

  function setAttachCode(code) {
    if (lastAttachCode === code) return
    lastAttachCode = code
    if (code) log?.warn?.(`[autonomy] 抖音 inbox 暂不可用（稍后重试）：${code}`)
  }

  async function attach() {
    if (!started || stopped) return fail('NOT_STARTED')
    if (unsubscribe || pollTimer) return ok({ mode: stats.mode })
    ensureLoaded()
    // 通知事件源独立订阅：即使私信不可用也尝试；失败只降级，不影响私信
    void attachNotify()
    const svc = serviceOf()
    if (!svc) {
      stats.mode = 'waiting-service'
      setAttachCode('SERVICE_UNAVAILABLE')
      scheduleAttach()
      return unavailable('SERVICE_UNAVAILABLE')
    }
    let mode = resolveMode(svc)
    if (!mode) {
      stats.mode = 'waiting-api'
      setAttachCode('DMWATCH_UNAVAILABLE')
      scheduleAttach()
      return unavailable('DMWATCH_UNAVAILABLE')
    }
    // 源 watcher 自己没开（dsh-douyin 的 dmWatchEnabled=false）→ 订阅永远收不到事件；
    // auto 模式改由我们自己轮询（dmWatch({action:'poll'}) 不看 dmWatchEnabled），不静默。
    if (mode === 'subscribe' && c.mode === 'auto' && typeof svc.dmWatch === 'function') {
      let st = null
      try {
        st = svc.dmWatchStatus?.()
      } catch {}
      if (st && st.cfgEnabled === false) {
        log?.warn?.('[autonomy] dsh-douyin 的 dmWatchEnabled=false：抖音 inbox 改由自己轮询（不订阅）')
        mode = 'poll'
      }
    }
    if (mode === 'subscribe') {
      let off = null
      try {
        off = await Promise.resolve(svc.dmWatchSubscribe(onSourceEvent))
      } catch (e) {
        setAttachCode('SUBSCRIBE_FAILED')
        scheduleAttach()
        return fail('SUBSCRIBE_FAILED', { error: String(e?.message ?? e) })
      }
      unsubscribe = typeof off === 'function' ? off : () => {}
      stats.mode = 'subscribe'
      stats.attached = true
      lastAttachCode = null
      maybeStartSource(svc)
      log?.info?.('[autonomy] 抖音 inbox 已订阅 dmWatch（主人→home，每个联系人→各自独立会话）')
      return ok({ mode: 'subscribe' })
    }
    stats.mode = 'poll'
    stats.attached = true
    lastAttachCode = null
    schedulePoll(0)
    log?.info?.(`[autonomy] 抖音 inbox 已启动轮询（每 ${Math.round(c.pollMs / 1000)}s）`)
    return ok({ mode: 'poll' })
  }

  /**
   * 轮询一次：走 svc.dmWatch({action:'poll'})，只处理基线之后的新事件。
   * 首轮基线：**第一次成功轮询返回的事件一律只记 seen、不投递**（历史/积压不灌进会话）。
   * 真实服务里 dm watcher 自己也会先建基线（首轮 events=[]），所以正常不会丢新消息。
   */
  async function pollOnce({ limit = null } = {}) {
    ensureLoaded()
    const svc = serviceOf()
    if (!svc || typeof svc.dmWatch !== 'function') return unavailable('SERVICE_UNAVAILABLE')
    stats.polls += 1
    stats.lastPollAt = clock()
    let r
    try {
      r = await Promise.resolve(svc.dmWatch({ action: 'poll', limit: Math.max(1, Math.min(100, Number(limit) || c.limit)) }))
    } catch (e) {
      stats.pollErrors += 1
      noteFailure('POLL_FAILED', { error: String(e?.message ?? e) })
      return fail('POLL_FAILED', { error: String(e?.message ?? e).slice(0, 300), events: [] })
    }
    if (!r || r.ok === false) {
      const code = String(r?.code ?? 'POLL_FAILED')
      stats.pollErrors += 1
      stats.lastCode = code
      return fail(code, { message: r?.message ?? null, events: [] })
    }
    const events = Array.isArray(r.events) ? r.events : []
    if (!primed) {
      primed = true
      for (const event of events) {
        const key = douyinEventKey(event)
        if (!key) continue
        seen.set(key, clock())
        while (seen.size > c.maxSeen) seen.delete(seen.keys().next().value)
      }
      stats.baselineSkipped += events.length
      persistSeen()
      log?.info?.(`[autonomy] 抖音 inbox 首轮基线 ${events.length} 条（历史事件不投递）`)
      return ok({ baseline: true, baselineSkipped: events.length, count: events.length, delivered: 0, results: [] })
    }
    const results = []
    for (const event of events) results.push(await enqueue(event))
    return ok({
      baseline: false,
      count: events.length,
      delivered: results.filter((x) => x?.ok === true && x?.route !== 'skipped').length,
      results,
    })
  }

  // ── 生命周期 / 状态 ────────────────────────────────────
  function start() {
    if (started) return ok({ started: true, mode: stats.mode })
    if (!c.enabled) {
      log?.info?.('[autonomy] douyin inbox 未启用（douyinInbox.enabled=false）：不订阅也不轮询')
      return fail('DISABLED')
    }
    started = true
    stopped = false
    ensureLoaded()
    ensureReplyLoop()
    void attach()
    return ok({ started: true })
  }

  function stop() {
    stopped = true
    started = false
    stopReplyLoop()
    replyWatches.clear()
    replyFlushing.clear()
    pendingReplies.length = 0
    if (attachTimer) {
      try {
        clearT(attachTimer)
      } catch {}
      attachTimer = null
    }
    if (pollTimer) {
      try {
        clearT(pollTimer)
      } catch {}
      pollTimer = null
    }
    if (unsubscribe) {
      try {
        unsubscribe()
      } catch {}
      unsubscribe = null
    }
    if (notifyAttachTimer) {
      try {
        clearT(notifyAttachTimer)
      } catch {}
      notifyAttachTimer = null
    }
    if (notifyUnsubscribe) {
      try {
        notifyUnsubscribe()
      } catch {}
      notifyUnsubscribe = null
    }
    notifyPrimed = null
    stats.attached = false
    try {
      log?.info?.('[autonomy] 抖音 inbox 已停止')
    } catch {}
    return ok({ stopped: true })
  }

  function dispose() {
    const r = stop()
    persistSeen()
    persistStats()
    return r
  }

  function status() {
    const svc = safe(getService, null)
    let source = { available: Boolean(svc), dmWatch: false, subscribe: false, running: null, primed: null, cfgEnabled: null }
    if (svc) {
      source.dmWatch = typeof svc.dmWatch === 'function'
      source.subscribe = typeof svc.dmWatchSubscribe === 'function'
      try {
        const st = svc.dmWatchStatus?.()
        if (st && typeof st === 'object') {
          source.running = typeof st.running === 'boolean' ? st.running : null
          source.primed = typeof st.primed === 'boolean' ? st.primed : null
          source.cfgEnabled = st.cfgEnabled ?? null
        }
      } catch {}
    }
    return {
      enabled: c.enabled,
      started,
      attached: stats.attached,
      mode: stats.mode,
      lastAttachCode,
      primed,
      queued: queue.length,
      seen: seen.size,
      cwd: c.cwd,
      cwdRoot: c.cwdRoot,
      pollMs: c.pollMs,
      sessions: {
        // per-key：每个联系人一个会话；只报数量/最近 key，不吐全部名单
        active: handles.size,
        lastKey,
        lastSessionId,
        created: stats.sessionCreated,
        resumed: stats.sessionResumed,
        replaced: stats.sessionReplaced,
      },
      replies: {
        // 自动回复（QQ auto 标准）：只看统计；lastReply 不含正文
        enabled: c.reply.enabled,
        pending: pendingReplies.length, // 待回复的入站事件数（每条保留自己的 conversationId）
        pendingTargets: [...new Set(pendingReplies.map((x) => x.conversationId).filter(Boolean))].length,
        sent: stats.repliesSent,
        failed: stats.repliesFailed,
        skipped: stats.repliesSkipped,
        timeout: stats.repliesTimeout,
        last: stats.lastReply,
      },
      notify: {
        // 通知事件源：subscribed=false 且 lastErrorCode=NOTIFY_UNAVAILABLE 表示 dyDouyin 还没提供 API（明确降级）
        enabled: c.notify.enabled,
        supported: typeof svc?.notifyWatchSubscribe === 'function',
        subscribed: Boolean(notifyUnsubscribe),
        primed: notifyPrimed,
        lastErrorCode: notifyLastCode,
        seen: notifySeen.size,
        events: stats.notifyEvents,
        owner: stats.notifyOwner,
        session: stats.notifySession,
        deduped: stats.notifyDeduped,
        baselineSkipped: stats.notifyBaselineSkipped,
        skipped: stats.notifySkipped,
        failed: stats.notifyFailed,
        last: stats.lastNotify,
      },
      source,
      stats: { ...stats },
    }
  }

  return {
    start,
    stop,
    dispose,
    attach,
    attachNotify,
    pollOnce,
    handleEvent: (event) => enqueue(event),
    handleNotifyEvent: (event) => enqueueJob('notify', event),
    whenIdle,
    status,
    routeOne,
    routeNotifyOne,
    observeSessionEvent,
    replyTick,
    flushReply,
    replyWatches,
    cwdForKey,
    ensureCwdForKey,
    get primed() {
      return primed
    },
  }
}
