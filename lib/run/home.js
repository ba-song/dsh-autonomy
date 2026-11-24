/**
 * home 影子会话骨架（C1，2026-11-05）
 *
 * 她自己的「家」：独立 agent 会话，不登记 onebot manager，不自动外发。
 * C1 只做骨架：建/恢复、单飞、busy、open-ended 叫醒、dyHome 服务；不做唤醒循环/骰子/自愈/轮换（C2–C4）。
 *
 * 硬约束（写死）：
 * 1. create/resume **必须带** `agentOptions:{provider,model}`（11-01「每轮 error」事故根因）；
 *    拿不到默认模型 → `NO_MODEL`，不建会话、不 resume。
 * 2. 任何创建/唤醒前先过总闸：`enabled && home.enabled` → `pause.all` → dryRun（respectDryRun 默认 true）。
 * 3. cwd 固定 `home.cwd`（D-005 新家，默认 `/sdcard/DSHA/生活/数据/home`）；
 *    旧行 cwd 不同 → **不 resume 旧会话**（旧 id 只留档到 meta.home.migratedFrom），新建并接管。
 * 4. 一进程内只有一个 awake 在飞：并发第二个 `IN_FLIGHT`。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, renameSync, readFileSync, copyFileSync, appendFileSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { rollDice, diceBonusOf, diceQuietOf } from './dice.js'
import { pauseActive } from '../core/policy.js'
import { loadDrives, advanceDrives, saveDrives } from '../core/drives.js'
import { getMeta, setMeta } from '../store/db.js'
import { recordActivity, recentActivities } from './activity.js'
import { createFileLogger, DEFAULT_AUTONOMY_LOG } from '../log-file.js'

/**
 * 把历史消息转成 seed 事件（2026-11-12 起只用 user/message handoff-history）。
 * 纯函数：不碰 clock/randomUUID 之外的状态，便于单测。
 */
export function buildSeedHistoryEvents(messages, { seqOffset = 1, startTime = Date.now() } = {}) {
  const events = []
  const list = Array.isArray(messages) ? messages : []
  for (let i = 0; i < list.length; i++) {
    const m = list[i]
    const text = String(m?.text ?? '').trim()
    if (!text) continue
    const who = m.role === 'user' ? '主人' : '汐'
    events.push({
      type: 'user/message',
      seq: events.length + seqOffset,
      time: startTime + events.length,
      data: {
        id: randomUUID(),
        role: 'user',
        source: { kind: 'handoff-history' },
        content: [{ type: 'text', text: `${who}：${text}` }],
      },
      surfaceOp: 'append',
    })
  }
  return events
}

export const HOME_SESSION_DDL = `CREATE TABLE IF NOT EXISTS home_sessions (
  persona_id      TEXT PRIMARY KEY,
  home_session_id TEXT NOT NULL UNIQUE,
  cwd             TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  prompt_tokens   INTEGER NOT NULL DEFAULT 0,
  context_window  INTEGER NOT NULL DEFAULT 0
)`

/** C3：房间历史（home_sessions 是当前指针，旧会话在 home_rooms 留档） */
export const HOME_ROOMS_DDL = `CREATE TABLE IF NOT EXISTS home_rooms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id  TEXT NOT NULL,
  session_id  TEXT NOT NULL UNIQUE,
  cwd         TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  rotated_at  INTEGER,
  source      TEXT NOT NULL DEFAULT 'create'
)`

export const DEFAULT_HOME_CWD = '/sdcard/DSHA/生活/数据/home'

/** open-ended 叫醒词：不派活、不强制写日记、可以什么都不做 */
export const HOME_WAKE_PROMPT =
  '你自己睁开了眼睛，不是谁叫你，也没有任务派给你。\n' +
  '想做什么、做多久、要不要说话，都由你定；什么都不做也可以，这不算浪费。\n' +
  '如果只想确认一下就走，直接结束这一轮。'

const ok = (extra = {}) => ({ ok: true, ...extra })
const fail = (code, extra = {}) => ({ ok: false, code, ...extra })

export function createHomeService({
  db,
  cfg,
  getAgents = () => null,
  getDefaultModel = () => null,
  getDryRun = null, // 不注入时退回 cfg.dryRun
  getSessionPersistence = () => null, // 宿主 sessionPersistence（用于定位档案）
  getPersonaId = () => null, // 无 home 行时用于 deliver 建家
  getPresets = () => null, // 宿主 agentPresets（可选）
  getWorkspaceRegistry = () => null, // 宿主 workspaceRegistry（可选，用于 GUI 工作区登记）
  getPractice = () => null, // 学习/兴趣（自驱练习）
  getSchedule = () => null, // 宿主 schedule 服务（轮换迁移提醒）
  getMemory = () => null, // 宿主 dyMemory（handoffBrief）
  clock = () => Date.now(),
  log = null,
} = {}) {
  const homeCfg = cfg?.home ?? {}
  const cwd = String(homeCfg.cwd || DEFAULT_HOME_CWD)
  const respectDryRun = homeCfg.respectDryRun !== false
  const agentPreset = String(homeCfg.agentPreset ?? '').trim() || null
  const autonomyLog = createFileLogger({ path: homeCfg.logPath || DEFAULT_AUTONOMY_LOG, now: clock })
  const logEvent = (level, event, fields = {}) => autonomyLog.write(level, event, fields)

  const resolvePresetId = async () => {
    const presets = safe(getPresets, null)
    if (!presets || typeof presets.resolve !== 'function') return agentPreset
    try {
      const r = await presets.resolve(agentPreset || undefined)
      // controller: const resolvedId = (await presets.resolve(presetId)).id
      const raw = r && typeof r === 'object' ? r.id : r
      const id = typeof raw === 'string' ? raw.trim() : ''
      return id || agentPreset
    } catch {
      return agentPreset
    }
  }

  /** 与 GUI controller 一致：agents.create/resume 必须带 setup 才会 mount preset */
  const composeSetup = async () => {
    const presets = safe(getPresets, null)
    const resolvedId = await resolvePresetId()
    if (!presets || typeof presets.mount !== 'function') {
      if (!presets) log?.warn?.('[autonomy] agentPresets 不可用：不传 setup（工具集可能只有全局工具）')
      return { setup: null, resolvedId }
    }
    const setup = async (agentCtx, agent) => {
      await presets.mount(agentCtx, resolvedId)
    }
    return { setup, resolvedId }
  }
  const maxMigrated = 20

  let awakeInFlight = false
  let rotateInFlight = false
  let turnRotateTimer = null
  let ensurePromise = null
  let handle = null
  let handleSessionId = null
  let recent = []
  const toolCalls = new Map()
  let presetAutoAttempted = false
  let activeTurn = null
  let stuckDetections = 0
  const STUCK_MS = 15 * 60_000
  let turnHandler = null
  let retryState = () => false
  // 统一私聊：渠道适配器只转发，home 串行投递
  const ownerQueue = []
  const normalQueue = []
  const recentDouyinDeliveries = new Map()
  const failedDeliveries = []
  let lastDeliverError = null
  let lastDrainStage = 'idle'
  let deliverRunning = false
  let ownerDelivering = false
  let drainRetryTimer = null
  let handoverUsed = false
  const healAttempted = new Set() // 同一会话最多修/愈一次
  // 2026-11-14：聊天活动时间轴（骰子/自主唤醒闸门用；只记时间，不落库、不挡投递/轮换/暂停）
  let lastChatActivityAt = 0
  let lastChatActivitySource = null

  const agentsOf = () => {
    try {
      return getAgents() ?? null
    } catch {
      return null
    }
  }

  const modelOf = () => {
    let sel = null
    try {
      sel = getDefaultModel()
    } catch {
      sel = null
    }
    const provider = String(sel?.provider ?? '').trim()
    const model = String(sel?.model ?? '').trim()
    return provider && model ? { provider, model } : null
  }

  const dryRunActive = () => {
    if (typeof getDryRun === 'function') {
      try {
        return Boolean(getDryRun())
      } catch {
        return Boolean(cfg?.dryRun)
      }
    }
    return Boolean(cfg?.dryRun)
  }

  /** 总闸：返回 null 表示放行；否则返回失败对象 */
  const gate = () => {
    if (!cfg?.enabled || homeCfg.enabled !== true) return fail('HOME_DISABLED')
    try {
      if (pauseActive(getMeta(db, 'pause.all', null), clock())) return fail('PAUSED')
    } catch {
      /* 读不到暂停态按未暂停处理，比误停安全 */
    }
    if (dryRunActive() && respectDryRun) return fail('DRY_RUN')
    return null
  }

  const ensureTable = () => {
    try {
      db.exec(HOME_SESSION_DDL)
      db.exec(HOME_ROOMS_DDL)
      // 老 v3 表没有计量列：补上（失败不致命，计量会保持 0）
      try {
        const cols = db.prepare('PRAGMA table_info(home_sessions)').all().map((c) => c.name)
        if (!cols.includes('prompt_tokens')) db.exec('ALTER TABLE home_sessions ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0')
        if (!cols.includes('context_window')) db.exec('ALTER TABLE home_sessions ADD COLUMN context_window INTEGER NOT NULL DEFAULT 0')
      } catch {}
    } catch (e) {
      log?.warn?.(`[autonomy] home_sessions 建表失败：${e?.message ?? e}`)
    }
  }

  const rowOf = (personaId) => {
    try {
      ensureTable()
      return db.prepare('SELECT * FROM home_sessions WHERE persona_id=?').get(String(personaId)) ?? null
    } catch {
      return null
    }
  }

  const touch = (personaId) => {
    try {
      db.prepare('UPDATE home_sessions SET last_seen_at=? WHERE persona_id=?').run(clock(), String(personaId))
    } catch {
      /* 观测字段，失败不影响唤醒 */
    }
  }

  const normalize = (out) => {
    if (!out) return null
    if (out.agent) return { agent: out.agent, raw: out }
    // 有些 fake/宿主实现直接返回 agent 本体
    if (typeof out.followup === 'function' || out.status) return { agent: out, raw: out }
    return null
  }

  const recordMigration = (personaId, from, fromCwd, to) => {
    try {
      const list = getMeta(db, 'home.migratedFrom', [])
      const next = [
        ...(Array.isArray(list) ? list : []),
        { personaId: String(personaId), from: String(from), fromCwd: String(fromCwd), to: String(to), at: clock() },
      ].slice(-maxMigrated)
      setMeta(db, 'home.migratedFrom', next, clock())
    } catch {
      /* 留档失败不挡新建 */
    }
  }

  const samePath = (a, b) => {
    const norm = (p) => {
      try {
        return realpathSync(String(p))
      } catch {
        return String(p ?? '').replace(/\/+$/, '')
      }
    }
    return Boolean(a) && Boolean(b) && norm(a) === norm(b)
  }

  /** 把插件建出来的 home 会话登记进 GUI 工作区；失败只 warn，绝不阻断建会话 */
  const attachHomeToWorkspace = async (sessionId) => {
    try {
      const reg = safe(getWorkspaceRegistry, null)
      if (!reg || typeof reg.list !== 'function') return false
      const list = await Promise.resolve(reg.list())
      const ws = (Array.isArray(list) ? list : []).find((w) => samePath(w?.record?.path ?? w?.path, cwd))
      if (!ws || typeof ws.attachSession !== 'function') return false
      await ws.attachSession(sessionId)
      log?.info?.(`[autonomy] home 会话已登记 workspace：${sessionId.slice(0, 8)}…`)
      return true
    } catch (e) {
      log?.warn?.(`[autonomy] workspace 登记失败（不阻断）：${e?.message ?? e}`)
      return false
    }
  }

  const createHome = async (personaId, { migratedFrom = null, migratedFromCwd = null, source = 'create', seedText = null, healedFrom = null, handoffText = null } = {}) => {
    const model = modelOf()
    if (!model) return fail('NO_MODEL', { personaId, cwd })
    const agents = agentsOf()
    if (!agents || typeof agents.create !== 'function') return fail('AGENTS_UNAVAILABLE', { personaId, cwd })
    if (!cwd || !String(cwd).trim()) return fail('HOME_CWD_INVALID')

    try {
      mkdirSync(cwd, { recursive: true })
    } catch (e) {
      return fail('HOME_CWD_UNAVAILABLE', { error: String(e?.message ?? e) })
    }

    const composed = await composeSetup()
    const sessionId = randomUUID()
    let out
    try {
      out = await agents.create({
        sessionId,
        meta: {
          cwd,
          autonomyHome: true,
          personaId: String(personaId),
          ...(composed.resolvedId ? { agentPreset: composed.resolvedId } : {}),
          ...(healedFrom ? { healedFrom: String(healedFrom) } : {}),
          ...(seedText ? { seedText: String(seedText).slice(0, 2000) } : {}),
        },
        ...(composed.setup ? { setup: composed.setup } : {}),
        agentOptions: model,
      })
    } catch (e) {
      return fail('HOME_CREATE_FAILED', { error: String(e?.message ?? e) })
    }
    const h = normalize(out)
    if (!h) return fail('HOME_CREATE_FAILED', { error: 'agents.create 未返回 agent' })

    // 2026-11-14：交接作为新房间的 user/notice 消息注入（不是 systemPrompt）
    const handoff = String(handoffText ?? seedText ?? '').trim()
    let handoffMounted = false
    if (handoff) {
      handoffMounted = await injectHandoffMessage(h.agent, handoff)
      try { setMeta(db, `home.handoff.${sessionId}.delivered`, { at: clock(), ok: handoffMounted }, clock()) } catch {}
      try { setMeta(db, `home.handoff.${sessionId}`, { at: clock(), chars: handoff.length, mounted: handoffMounted, text: handoff }) } catch {}
    }
    const now = clock()
    try {
      ensureTable()
      db.prepare(
        `INSERT INTO home_sessions(persona_id, home_session_id, cwd, created_at, last_seen_at)
         VALUES(?,?,?,?,?)
         ON CONFLICT(persona_id) DO UPDATE SET home_session_id=excluded.home_session_id, cwd=excluded.cwd, created_at=excluded.created_at, last_seen_at=excluded.last_seen_at`,
      ).run(String(personaId), sessionId, cwd, now, now)
      db.prepare(
        `INSERT INTO home_rooms(persona_id, session_id, cwd, created_at, rotated_at, source)
         VALUES(?,?,?,?,NULL,?) ON CONFLICT(session_id) DO NOTHING`,
      ).run(String(personaId), sessionId, cwd, now, source)
    } catch (e) {
      try {
        h.agent?.dispose?.()
      } catch {}
      return fail('HOME_CREATE_FAILED', { error: String(e?.message ?? e) })
    }
    if (migratedFrom) recordMigration(personaId, migratedFrom, migratedFromCwd, sessionId)
    handle = h
    handleSessionId = sessionId
    log?.info?.(`[autonomy] home 已创建 ${sessionId.slice(0, 8)}… cwd=${cwd}${migratedFrom ? `（旧 ${String(migratedFrom).slice(0, 8)}… 留档）` : ''}`)
    await attachHomeToWorkspace(sessionId)
    return ok({ code: 'CREATED', sessionId, cwd, created: true, resumed: false, migratedFrom, source, seedText, handoffMounted, agent: h.agent })
  }

  // ── C4：UUID 消息 / 档案修复 / 自愈 ─────────────────────────

  const asContentArray = (c) => (Array.isArray(c) ? c : [{ type: 'text', text: String(c ?? '') }])

  const identifiedMessage = async ({ content, source }) => {
    const contentArray = asContentArray(content)
    try {
      const mod = await import('@deepseek-ai/dsh-llm')
      if (typeof mod?.createUserMessage === 'function') {
        const m = mod.createUserMessage({ content: contentArray, source })
        if (m && typeof m === 'object') {
          if (!m.id) m.id = randomUUID()
          if (!m.role) m.role = 'user'
          // 宿主可能把 content 规整成字符串；投递前强制数组（16:10 事故）
          m.content = asContentArray(m.content)
          return m
        }
      }
    } catch {}
    return { id: randomUUID(), role: 'user', content: contentArray, source }
  }

  const locateArchive = (sessionId, rowCwd) => {
    try {
      const p = getSessionPersistence?.()
      if (p && typeof p.locate === 'function') {
        const r = p.locate({ id: String(sessionId), cwd: String(rowCwd ?? cwd) })
        const path = typeof r === 'string' ? r : r?.path ?? r?.file
        if (path) return String(path)
      }
    } catch {}
    return null
  }

  const zstdMagic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const decompressFrames = (buf) => {
    const offsets = []
    for (let i = 0; i <= buf.length - 4; i++) {
      if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i)
    }
    if (!offsets.length) throw new Error('no zstd frame')
    const out = []
    for (let k = 0; k < offsets.length; k++) {
      const end = offsets[k + 1] ?? buf.length
      try {
        out.push(zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8'))
      } catch {
        // 坏帧直接丢；后面重新拼好帧
      }
    }
    if (!out.length) throw new Error('all zstd frames bad')
    return out
  }

  /** 修档案：多帧扫描 → 丢坏帧/坏行 → 补 user/message 的 id/role → 备份原文件 → 原子重写 */
  const repairArchive = (sessionId, rowCwd) => {
    try {
      const path = locateArchive(sessionId, rowCwd)
      if (!path) return { ok: false, code: 'ARCHIVE_NOT_FOUND' }
      const raw = readFileSync(path)
      const texts = decompressFrames(raw)
      const lines = texts.flatMap((t) => String(t).split('\n')).filter((l) => l.trim())
      if (!lines.length) return { ok: false, code: 'ARCHIVE_EMPTY' }
      let header = lines[0]
      try {
        JSON.parse(header)
      } catch {
        return { ok: false, code: 'ARCHIVE_BAD_HEADER' }
      }
      let fixed = 0
      const events = []
      for (const line of lines.slice(1)) {
        let ev
        try {
          ev = JSON.parse(line)
        } catch {
          continue // 坏行丢
        }
        const msgTypes = ev?.type === 'user/message' || ev?.type === 'assistant/message' || ev?.type === 'system/message'
        if (msgTypes) {
          ev.data = ev.data ?? {}
          // 16:10 事故：content 是字符串 → 宿主校验 message has invalid content
          // assistant/message、system/message 的正文在 data.message.content（嵌套），user 在 data.content
          const holder = ev.type === 'user/message' ? ev.data : (ev.data.message && typeof ev.data.message === 'object' ? ev.data.message : null)
          if (holder) {
            if (typeof holder.content === 'string') {
              holder.content = [{ type: 'text', text: holder.content }]
              fixed += 1
            } else if (holder.content != null && !Array.isArray(holder.content)) {
              holder.content = [{ type: 'text', text: String(holder.content) }]
              fixed += 1
            }
          }
        }
        if (ev?.type === 'user/message') {
          ev.data = ev.data ?? {}
          if (!ev.data.id) {
            ev.data.id = randomUUID()
            fixed += 1
          }
          if (!ev.data.role) ev.data.role = 'user'
        }
        events.push(JSON.stringify(ev))
      }
      if (!events.length) return { ok: false, code: 'ARCHIVE_NO_EVENTS' }
      const frame1 = zstdCompressSync(Buffer.from(`${header}\n`))
      const frame2 = zstdCompressSync(Buffer.from(`${events.join('\n')}\n`))
      const out = Buffer.concat([frame1, frame2])
      const backup = `${path}.bak-${clock()}`
      copyFileSync(path, backup)
      const tmp = `${path}.tmp-${Math.random().toString(36).slice(2)}`
      writeFileSync(tmp, out)
      // 自检：第一帧只含 header，事件帧可解析且 user/message 有 id
      const check = decompressFrames(readFileSync(tmp))
      const firstLine = String(check[0]).split('\n').filter(Boolean)[0]
      let contentOk = true
      try {
        const all = check.flatMap((t) => String(t).split('\n')).filter(Boolean).slice(1)
        for (const line of all) {
          const ev = JSON.parse(line)
          if (!['user/message', 'assistant/message', 'system/message'].includes(ev?.type)) continue
          const content = ev.type === 'user/message' ? ev?.data?.content : ev?.data?.message?.content
          if (!Array.isArray(content)) contentOk = false
        }
      } catch {
        contentOk = false
      }
      if (firstLine !== header || !contentOk) {
        // 自检失败：绝不用坏文件覆盖原档案（tmp 留着给人排查）
        return { ok: false, code: 'ARCHIVE_SELFCHECK_FAILED', backup, tmp }
      }
      renameSync(tmp, path)
      return { ok: true, code: 'REPAIRED', path, backup, fixed }
    } catch (e) {
      return { ok: false, code: 'ARCHIVE_REPAIR_FAILED', error: String(e?.message ?? e) }
    }
  }

  const buildHealSeed = (row, reason, handoffPath) => {
    const head = '你的上一个家坏了（档案校验失败/读不出），这不是消失，是换了个地方接着生活。'
    const archived = recentArchiveMessages(row.home_session_id, row.cwd, 50) ?? []
    const brief = buildHandoffBrief(row, reason, archived)
    const tail = archived.slice(-3).map((x) => String(x.text ?? '')).filter(Boolean)
    return [
      head,
      `旧 session：${row.home_session_id}`,
      `persona：${row.persona_id ?? ''}`,
      `原因：${reason}`,
      brief ? `简报：${brief.slice(0, 800)}` : '',
      handoffPath ? `交接：${handoffPath}` : '交接：没有记录到原话',
      tail.length ? `最近原话：${tail.join(' / ').slice(0, 500)}` : '最近原话：没有记录到原话',
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 2000)
  }

  const recordHeal = (payload) => {
    try {
      setMeta(db, 'home.lastHeal', payload, clock())
    } catch {}
    logEvent(payload?.ok ? 'info' : 'warn', 'heal', { from: payload?.from, to: payload?.to, code: payload?.code })
    return payload
  }

  // 由后面（buildHandoff 之后）赋值的实现；resume 失败时调用
  let healHomeImpl = null

  const resumeHome = async (personaId, row) => {
    const model = modelOf()
    if (!model) return fail('NO_MODEL', { personaId, cwd, sessionId: row.home_session_id })
    const agents = agentsOf()
    if (!agents || typeof agents.resume !== 'function') return fail('AGENTS_UNAVAILABLE', { personaId, cwd })

    const composed = await composeSetup()
    let out
    try {
      out = await agents.resume({
        resumeSessionId: row.home_session_id,
        meta: { cwd, autonomyHome: true, personaId: String(personaId), ...(composed.resolvedId ? { agentPreset: composed.resolvedId } : {}) },
        ...(composed.setup ? { setup: composed.setup } : {}),
        agentOptions: model,
      })
    } catch (e) {
      if (healHomeImpl) return healHomeImpl(personaId, row, { error: String(e?.message ?? e), code: 'HOME_RESUME_FAILED' })
      return fail('HOME_RESUME_FAILED', { error: String(e?.message ?? e), sessionId: row.home_session_id })
    }
    const h = normalize(out)
    if (!h) {
      if (healHomeImpl) return healHomeImpl(personaId, row, { error: 'agents.resume 未返回 agent', code: 'HOME_RESUME_FAILED' })
      return fail('HOME_RESUME_FAILED', { error: 'agents.resume 未返回 agent', sessionId: row.home_session_id })
    }
    touch(personaId)
    handle = h
    handleSessionId = row.home_session_id
    mountStoredHandoff(h.agent, row.home_session_id)
    const recovered = await recoverEmptyHandoff(h.agent, row.home_session_id)
    return ok({ code: 'RESUMED', sessionId: row.home_session_id, cwd, created: false, resumed: true, recovered: recovered.recovered, agent: h.agent })
  }

  /** 读旧会话头里的 agentPreset（不依赖 live agent；读档失败返回 null=未知，不自动轮换） */
  const headerPresetOf = (row) => {
    try {
      const path = locateArchive(row.home_session_id, row.cwd)
      if (!path) return null
      const texts = decompressFrames(readFileSync(path))
      const first = String(texts[0] ?? '').split('\n').find((l) => l.trim())
      if (!first) return null
      const h = JSON.parse(first)
      const preset = h?.agentPreset ?? h?.header?.agentPreset ?? null
      return typeof preset === 'string' && preset.trim() ? preset.trim() : null
    } catch {
      return null
    }
  }

  /** 首次 ensureHome：头 preset 与配置不一致时自动轮换一次；成功/失败都只试一次 */
  const maybeAutoRotatePreset = async (personaId, row) => {
    if (presetAutoAttempted) return null
    try {
      const mark = getMeta(db, 'home.presetRotatedTo', null)
      if (mark !== null && mark !== undefined) return null // 标记存在永不再自动
    } catch {}
    const head = headerPresetOf(row)
    const target = await resolvePresetId()
    if (!target || !head || head === target) return null
    presetAutoAttempted = true
    try {
      log?.info?.(`[autonomy] home preset 不一致（${head}→${agentPreset}），自动轮换一次`)
      const r = await rotateHome({ personaId, reason: 'preset', force: true })
      if (r?.ok) {
        try {
          setMeta(db, 'home.presetRotatedTo', target ?? '', clock())
        } catch {}
        return r
      }
      try {
        setMeta(db, 'home.presetRotateFailed', { at: clock(), code: r?.code ?? 'ROTATE_FAILED', from: row.home_session_id, preset: agentPreset }, clock())
      } catch {}
      return null
    } catch (e) {
      try {
        setMeta(db, 'home.presetRotateFailed', { at: clock(), code: 'ROTATE_FAILED', error: String(e?.message ?? e).slice(0, 200), from: row.home_session_id, preset: agentPreset }, clock())
      } catch {}
      return null
    }
  }

  const checkStuckTurn = () => {
    if (!activeTurn) return null
    const ms = clock() - Number(activeTurn.startedAt ?? clock())
    if (ms < STUCK_MS) return null
    stuckDetections += 1
    const payload = {
      turn: activeTurn.turn,
      startedAt: activeTurn.startedAt,
      minutes: Math.floor(ms / 60_000),
      detections: stuckDetections,
      at: clock(),
      active: true,
    }
    try {
      setMeta(db, 'home.stuckTurn', payload, clock())
      if (stuckDetections >= 2) {
        const since = getMeta(db, 'home.stuckSince', null)
        if (!since) setMeta(db, 'home.stuckSince', { at: clock(), turn: activeTurn.turn, startedAt: activeTurn.startedAt }, clock())
      }
    } catch {}
    logEvent('warn', 'stuck', { turn: activeTurn.turn, minutes: Math.floor(ms / 60_000) })
    log?.warn?.(`[autonomy] home 回合疑似卡死 ${Math.floor(ms / 60_000)} 分钟（turn=${activeTurn.turn}）`)
    return payload
  }

  /**
   * 2026-11-14：记一次聊天活动（只记内存，不写库）。
   * 触发点：渠道入站 deliver、home 会话的 user/message、assistant/message、turn/start。
   * 用 max 防系统时钟回拨把「最后活动」冲早，导致提前放行骰子。
   */
  const markChatActivity = (source = 'unknown') => {
    const at = clock()
    if (at > lastChatActivityAt) lastChatActivityAt = at
    lastChatActivitySource = String(source ?? 'unknown')
    return lastChatActivityAt
  }

  /**
   * 给唤醒循环读的聊天活动快照。
   * activeTurn 只在回合未卡死时算「聊天进行中」；卡死后交给 awake 的 STUCK_TURN 逻辑，
   * 避免一个丢失的 turn/end 永远堵住自主唤醒。
   */
  const chatActivityState = () => {
    const now = clock()
    const at = Number(lastChatActivityAt) || 0
    let activeTurnNow = false
    if (activeTurn) {
      const startedAt = Number(activeTurn.startedAt) || 0
      activeTurnNow = !startedAt || now - startedAt < STUCK_MS
    }
    return {
      lastChatActivityAt: at || null,
      idleMs: at ? Math.max(0, now - at) : null,
      activeTurn: activeTurnNow,
      turnStartedAt: activeTurnNow ? activeTurn.startedAt ?? null : null,
      lastSource: lastChatActivitySource,
    }
  }

  // 2026-11-15：所有“外部触发唤醒”统一用这个闸门；manual/turn-retry 不走这里。
  // 触发源：file/device/notify/autonomy；聊天活动后 5 分钟内直接返回 CHAT_ACTIVE。
  const CHAT_GATED_SOURCES = new Set(['file', 'device', 'notify', 'wake', 'check', 'retry'])
  const chatGate = (source = 'autonomy') => {
    const min = Math.max(0, Number(homeCfg.chatIdleMin ?? 5))
    if (!min || !CHAT_GATED_SOURCES.has(String(source))) return null
    const st = chatActivityState()
    const at = Number(st.lastChatActivityAt) || 0
    const idleMs = at > 0 ? Math.max(0, clock() - at) : null
    const byIdle = idleMs != null && idleMs < min * 60_000
    if (!byIdle && st.activeTurn !== true) return null
    const remain = byIdle ? Math.max(0, min * 60_000 - idleMs) : 0
    log?.info?.(`[autonomy] 跳过 ${source} 唤醒：聊天活动中（idle=${idleMs == null ? 'n/a' : `${Math.floor(idleMs / 1000)}s`}）`)
    try { setMeta(db, 'home.lastChatSkip', { at: clock(), source, idleMs, remainingMs: remain, activeTurn: st.activeTurn === true }, clock()) } catch {}
    return { ok: false, code: 'CHAT_ACTIVE', source, lastChatActivityAt: at || null, idleMs, remainingMs: remain, activeTurn: st.activeTurn === true }
  }

  const ensureHomeInner = async (personaId) => {
    const g = gate()
    if (g) return g
    if (!personaId) return fail('NO_PERSONA')

    ensureTable()
    const row = rowOf(personaId)

    // 首次 ensureHome：旧头 preset 与配置不一致 → 自动轮换一次（异步，不阻塞 apply）
    if (row) {
      const auto = await maybeAutoRotatePreset(personaId, row)
      if (auto?.ok && handle && handleSessionId === auto.sessionId) {
        return ok({
          code: 'PRESET_ROTATED',
          sessionId: auto.sessionId,
          cwd,
          created: true,
          resumed: false,
          presetRotated: true,
          agent: handle.agent,
        })
      }
    }

    // 旧家 cwd 不同：不 resume，新建接管，旧 id 只留档（D-005）
    if (row && String(row.cwd) !== cwd) {
      try {
        handle?.agent?.dispose?.()
      } catch {}
      handle = null
      handleSessionId = null
      return createHome(personaId, { migratedFrom: row.home_session_id, migratedFromCwd: row.cwd })
    }

    if (row) {
      if (handle && handleSessionId === row.home_session_id) {
        touch(personaId)
        return ok({ code: 'EXISTING', sessionId: row.home_session_id, cwd, created: false, resumed: false, agent: handle.agent })
      }
      const agents = agentsOf()
      if (!agents) return fail('AGENTS_UNAVAILABLE', { personaId, cwd })
      let live = null
      try {
        live = typeof agents.get === 'function' ? await Promise.resolve(agents.get(row.home_session_id)) : null
      } catch {
        live = null
      }
      const h = normalize(live)
      if (h) {
        handle = h
        handleSessionId = row.home_session_id
        touch(personaId)
        mountStoredHandoff(h.agent, row.home_session_id)
        const recovered = await recoverEmptyHandoff(h.agent, row.home_session_id)
        return ok({ code: 'EXISTING', sessionId: row.home_session_id, cwd, created: false, resumed: false, recovered: recovered.recovered, agent: h.agent })
      }
      if (healAttempted.has(row.home_session_id)) {
        return fail('HOME_HEAL_FAILED', { personaId, sessionId: row.home_session_id, error: 'already attempted' })
      }
      return resumeHome(personaId, row)
    }

    return createHome(personaId)
  }

  /** 建/恢复（并发去重：同一时刻只建一个） */
  const ensureHome = (personaId) => {
    if (ensurePromise) return ensurePromise
    ensurePromise = ensureHomeInner(personaId).finally(() => {
      ensurePromise = null
    })
    return ensurePromise
  }

  // ── C3：计量 / 轮换 / handoff ─────────────────────────────

  const extractText = (data) => {
    try {
      const msg = data?.message ?? data
      const content = msg?.content ?? data?.content
      if (Array.isArray(content)) {
        return content
          .filter((c) => c?.type === 'text' && c?.text)
          .map((c) => c.text)
          .join(' ')
          .slice(0, 500)
      }
      return String(content ?? '').slice(0, 500)
    } catch {
      return ''
    }
  }

  const recordRotate = (payload) => {
    try {
      setMeta(db, 'home.lastRotate', payload, clock())
    } catch {}
    if (payload?.ok && payload?.code === 'ROTATED') {
      logEvent('info', 'rotate', { old: payload.from, new: payload.to, reason: payload.reason, tokens: payload.ratio ?? '-' })
    }
    return payload
  }

  const shouldRotateRow = (row) => {
    if (!row) return null
    const limit = Number(homeCfg.contextLimit ?? 650_000)
    const ratioCfg = Number(homeCfg.rotateRatio ?? 0.7)
    const pt = Number(row.prompt_tokens ?? 0)
    const cw = Number(row.context_window ?? 0)
    const ratio = cw > 0 ? pt / cw : 0
    const byRatio = cw > 0 && ratioCfg > 0 && ratio >= ratioCfg
    const byLimit = limit > 0 && pt >= limit
    return byRatio || byLimit ? { byRatio, byLimit, ratio, pt, cw, limit, ratioCfg } : null
  }

  const buildHandoffBrief = (row, reason, msgs) => {
    try {
      const mem = safe(getMemory, null)
      if (!mem || typeof mem.handoffBrief !== 'function') return ''
      const out = mem.handoffBrief({
        header: { cwd: String(row.cwd ?? cwd), id: String(row.home_session_id) },
        cwd: String(row.cwd ?? cwd),
        recent: (Array.isArray(msgs) ? msgs : []).map((m) => ({ role: m.role, text: String(m.text ?? '').slice(0, 300), at: m.at })),
        kind: String(reason).includes('heal') ? 'heal' : 'rotate',
        contactId: 'home',
        maxChars: Number(homeCfg.handoffBriefMaxChars ?? 1200),
      })
      const text = typeof out === 'string' ? out : out?.text
      return typeof text === 'string' ? text.trim() : ''
    } catch (e) {
      log?.warn?.(`[autonomy] handoffBrief 失败（不阻断交接）：${e?.message ?? e}`)
      return ''
    }
  }

  const buildHandoff = (row, reason) => {
    const dir = join(cwd, '记忆区', '压缩记忆')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date(clock()).toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const kind = String(reason).includes('heal') ? 'heal' : 'rotate'
    const path = join(dir, `home-${kind}-${stamp}.md`)
    const maxItems = Math.min(200, Math.max(1, Number(homeCfg.handoffMaxItems ?? 50)))
    const maxChars = Math.min(50_000, Math.max(500, Number(homeCfg.handoffMaxChars ?? 12_000)))
    const archived = recentArchiveMessages(row.home_session_id, row.cwd, maxItems)
    const items = (archived ?? []).slice(-maxItems)
    const brief = buildHandoffBrief(row, reason, items)
    const lines = [
      `# 她的家 · 交接（${String(reason).includes('heal') ? 'self-heal' : 'rotate'}）`,
      '',
      `> 时间：${new Date(clock()).toISOString()}`,
      `> 旧 session：${row.home_session_id}`,
      `> 原因：${reason}`,
      `> tokens：${Number(row.prompt_tokens ?? 0)} / ${Number(row.context_window ?? 0)}`,
      '',
    ]
    if (brief) lines.push('## 结构化简报', '', String(brief).replace(/^【交接简报】\s*/, '').replace(/\s*【交接简报结束】$/, '').slice(0, 1200), '')
    lines.push('## 最近原话（最多 50 条）', '')
    if (!items.length) lines.push('（没有记录到原话）')
    let chars = lines.join('\n').length
    for (const it of items) {
      const line = `- [${it.at ? new Date(it.at).toISOString().slice(5, 16).replace('T', ' ') : '—'}] ${String(it.text ?? '').slice(0, 300)}`
      if (chars + line.length > maxChars) break
      lines.push(line)
      chars += line.length + 1
    }
    const body = `${lines.join('\n')}\n`
    const tmp = `${path}.tmp-${Math.random().toString(36).slice(2)}`
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, path)
    return path
  }

  /**
   * 把交接作为新房间的一条 user/notice 消息塞进去（不是 systemPrompt 注入）。
   * 2026-11-15 修：source.kind 不能用旧 V3 的 `plugin` 包装（DSH v4 在落盘时拒绝
   * “format v4 message requires a producer-owned source kind”，整批写不进去，
   * 轮换后的新房间会一直写失败）；改用自己产的消息类型 `handoff-note`。
   */
  const injectHandoffMessage = async (agent, text) => {
    const t = String(text ?? '').trim()
    if (!t || typeof agent?.inject !== 'function') return false
    try {
      let message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: t }],
        source: { kind: 'handoff-note', form: 'notice', summary: '轮换交接：上一段房间的记录' },
      }
      try {
        const mod = await import('@deepseek-ai/dsh-llm')
        if (typeof mod?.createUserMessage === 'function') {
          message = mod.createUserMessage({ content: message.content, source: message.source })
        } else if (typeof mod?.createMessage === 'function') {
          message = mod.createMessage({ role: 'user', content: message.content, source: message.source })
        }
      } catch {}
      await agent.inject(message)
      return true
    } catch (e) {
      try { log.warn?.(`[autonomy] 交接消息注入失败：${e?.message ?? e}`) } catch {}
      return false
    }
  }

  /** 冷恢复时不要重复注入：交接消息已经在会话历史里；只兼容旧 meta 标记。 */
  const mountStoredHandoff = (agent, sessionId) => {
    try {
      const rec = getMeta(db, `home.handoff.${sessionId}`)
      return Boolean(rec?.delivered)
    } catch { return false }
  }

  /** 交接消息的固定开头（与 HANDOFF_NOTE 一致，避免依赖定义顺序）。 */
  const HANDOFF_TEXT_PREFIX = '以下是你上一个会话的记录'
  /** 会话日志里有没有那条交接消息；读不到返回 null（未知，不乱动）。 */
  const sessionLogHasHandoff = (agent) => {
    try {
      const events = agent?.session?.log
      if (!Array.isArray(events)) return null
      return events.some((ev) => {
        if (ev?.type !== 'user/message') return false
        const content = ev?.data?.content
        const text = Array.isArray(content)
          ? content.map((block) => String(block?.text ?? '')).join('')
          : String(content ?? '')
        return text.trim().startsWith(HANDOFF_TEXT_PREFIX)
      })
    } catch {
      return null
    }
  }

  /**
   * 2026-11-15 修：轮换交接曾用旧 V3 source（kind:'plugin'），DSH v4 落盘时拒收，
   * 新房间整批写不进（只剩 header），重启后房间是空的。这里在 resume 空房间时
   * 把 meta 里留档的交接文本用新 source 补注入一次；已经有交接消息的会话不动。
   */
  const handoffRecovering = new Set()
  const handoffRecoverAttempted = new Set()
  const recoverEmptyHandoff = async (agent, sessionId) => {
    if (!sessionId || handoffRecovering.has(sessionId) || handoffRecoverAttempted.has(sessionId)) {
      return { recovered: false, code: 'ALREADY_ATTEMPTED' }
    }
    let rec = null
    try {
      rec = getMeta(db, `home.handoff.${sessionId}`)
    } catch {
      return { recovered: false, code: 'NO_META' }
    }
    const text = String(rec?.text ?? '').trim()
    if (!text) return { recovered: false, code: 'NO_TEXT' }
    const hasHandoff = sessionLogHasHandoff(agent)
    if (hasHandoff === null) return { recovered: false, code: 'NO_SESSION_LOG' }
    if (hasHandoff) return { recovered: false, code: 'ALREADY_HAS_HANDOFF' }
    handoffRecovering.add(sessionId)
    try {
      const ok = await injectHandoffMessage(agent, text)
      handoffRecoverAttempted.add(sessionId)
      logEvent(ok ? 'info' : 'warn', 'handoff_recover', { session: sessionId, ok })
      try {
        setMeta(db, `home.handoff.${sessionId}.recovered`, { at: clock(), ok, chars: text.length }, clock())
      } catch {}
      return { recovered: ok, code: ok ? 'RECOVERED' : 'INJECT_FAILED' }
    } finally {
      handoffRecovering.delete(sessionId)
    }
  }

  /** 交接文本：说明 + 结构化简报 + 最近 N 条原话（注入新房间，不写旧会话）。 */
  const buildHandoffText = (row, reason = 'rotate') => {
    const limit = Math.min(200, Math.max(1, Number(homeCfg.handoffMaxItems ?? 50)))
    const archived = recentArchiveMessages(row.home_session_id, row.cwd, limit) ?? []
    const brief = buildHandoffBrief(row, reason, archived)
    const lines = [HANDOFF_NOTE, '', `交接（${String(reason).includes('heal') ? 'self-heal' : 'rotate'}）· 旧 session：${row.home_session_id}`]
    if (brief) lines.push('', String(brief).replace(/^【交接简报】\s*/, '').replace(/\s*【交接简报结束】$/, '').slice(0, 1200))
    lines.push('', `【最近原话（最多 ${limit} 条）】`)
    for (const m of archived) {
      const who = m.role === 'user' ? '主人' : '汐'
      lines.push(`- ${who}：${String(m.text ?? '').slice(0, 300)}`)
    }
    const out = lines.join('\n').slice(0, 20000)
    try { console.error('[handoff-debug]', { archived: archived.length, chars: out.length }) } catch {}
    return out
  }

  /**
   * C4 自愈：resume 失败 → 修档案（最多 1 次）→ 再 resume；仍失败 → handoff+seed → 新建接管。
   * 总闸（enabled/pause/dryRun）在创建前再判；不删旧档案；同一 session 不无限重试。
   */
  healHomeImpl = async (personaId, row, { error = '', code = 'HOME_RESUME_FAILED' } = {}) => {
    const oldId = row.home_session_id
    const g = gate()
    if (g) return g // 暂停/演练时不自愈
    if (healAttempted.has(oldId)) {
      return recordHeal({ at: clock(), ok: false, code: 'HOME_HEAL_FAILED', from: oldId, error: 'already attempted', cause: code })
    }
    healAttempted.add(oldId)

    // 1) 先修档案，修好再 resume 一次
    const repair = repairArchive(oldId, row.cwd)
    let repaired = false
    if (repair.ok) {
      const model = modelOf()
      const agents = agentsOf()
      if (model && agents?.resume) {
        try {
          const composed = await composeSetup()
          const out = await agents.resume({
            resumeSessionId: oldId,
            meta: { cwd, autonomyHome: true, personaId: String(personaId), ...(composed.resolvedId ? { agentPreset: composed.resolvedId } : {}) },
            ...(composed.setup ? { setup: composed.setup } : {}),
            agentOptions: model,
          })
          const h = normalize(out)
          if (h) {
            handle = h
            handleSessionId = oldId
            repaired = true
            touch(personaId)
            const rec = recordHeal({ at: clock(), ok: true, code: 'REPAIRED', from: oldId, to: oldId, backup: repair.backup })
            log?.info?.(`[autonomy] home 档案已修并 resume 成功：${oldId.slice(0, 8)}…`)
            return ok({ code: 'AWAKENED', resumed: true, repaired: true, sessionId: oldId, cwd, lastHeal: rec, agent: h.agent })
          }
        } catch {}
      }
    }

    // 2) 仍不行 → handoff + seed + 新建接管（旧行/旧档案都不删）
    let handoffPath = null
    try {
      handoffPath = buildHandoff(row, 'self-heal')
    } catch (e) {
      log?.warn?.(`[autonomy] 自愈 handoff 写失败：${e?.message ?? e}`)
    }
    const seedText = buildHealSeed(row, 'self-heal', handoffPath)
    // 2026-11-14：交接作为新房间消息注入
    let handoffText = seedText
    try { handoffText = buildHandoffText(row, 'self-heal') } catch {}
    const created = await createHome(personaId, { source: 'heal', seedText, handoffText, healedFrom: oldId })
    if (!created.ok) {
      const rec = recordHeal({
        at: clock(),
        ok: false,
        code: 'HOME_HEAL_FAILED',
        from: oldId,
        error: created.error ?? created.code,
        cause: code,
        repairCode: repair.code,
      })
      log?.warn?.(`[autonomy] home 自愈失败：${rec.code}（${created.code}）`)
      return { ...created, code: 'HOME_HEAL_FAILED', lastHeal: rec }
    }

    // 旧房间标记 heal（旧 id 留档）
    try {
      db.prepare("UPDATE home_rooms SET source='heal', rotated_at=? WHERE session_id=?").run(clock(), oldId)
    } catch {}

    // 交接已在 createHome 里注入为消息，不再额外发一条（避免凭空多一轮）
    const seedSent = created.handoffMounted === true

    const rec = recordHeal({
      at: clock(),
      ok: true,
      code: 'HEALED',
      from: oldId,
      to: created.sessionId,
      handoffPath,
      seedSent,
      repaired,
      repairCode: repair.code,
    })
    log?.info?.(`[autonomy] home 自愈：${oldId.slice(0, 8)}… → ${String(created.sessionId).slice(0, 8)}…（旧家留档）`)
    return ok({
      code: 'HEALED',
      healed: true,
      sessionId: created.sessionId,
      cwd,
      seedSent,
      handoffPath,
      seedText,
      lastHeal: rec,
      agent: created.agent,
    })
  }

  /** 从旧 session 档案取最近 N 条 user/assistant 消息（用于 B 方案 seed） */
  const isRealArchiveMessage = (ev, msg, text) => {
    const kind = String(msg?.source?.kind ?? '')
    const t = String(text ?? '').trim()
    if (!t) return false
    if (ev?.type === 'user/message') {
      // 只收真实用户/渠道入站；记忆注入、时间快照、唤醒提示、交接提示都不是原话
      if (kind && kind !== 'user' && kind !== 'channel-inbound') return false
    } else {
      if (kind && kind !== 'model') return false
    }
    if (/^【(记忆|相关原话|本轮相关|项目决策|交接简报|上次聊到)/.test(t)) return false
    if (/^Time sampled while preparing turn/.test(t)) return false
    return true
  }

  const archiveAllMessages = (sessionId, rowCwd) => {
    try {
      const path = locateArchive(sessionId, rowCwd)
      if (!path) return null
      const texts = decompressFrames(readFileSync(path))
      const lines = texts.flatMap((t) => String(t).split('\n')).filter((l) => l.trim())
      const out = []
      for (const line of lines.slice(1)) {
        let ev
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (ev?.type !== 'user/message' && ev?.type !== 'assistant/message') continue
        const msg = ev.type === 'user/message' ? ev.data : ev.data?.message
        if (!msg) continue
        const text = Array.isArray(msg.content)
          ? msg.content.filter((c) => c?.type === 'text').map((c) => c.text).join(' ')
          : String(msg.content ?? '')
        if (!isRealArchiveMessage(ev, msg, text)) continue
        out.push({
          role: ev.type === 'user/message' ? 'user' : 'assistant',
          text,
          source: msg.source,
          at: Number(ev.time ?? clock()),
        })
      }
      return out
    } catch {
      return null
    }
  }

  const recentArchiveMessages = (sessionId, rowCwd, limit = 50) => {
    const all = archiveAllMessages(sessionId, rowCwd)
    if (!all) return null
    return all.slice(-Math.min(50, Math.max(1, Number(limit) || 50))).map((m) => ({ ...m, text: m.text.slice(0, 300) }))
  }

  /** 旧房间门牌：home_rooms 最近 N 个 + 档案首/末条摘要 */
  const listRooms = (limit = 10) => {
    try {
      ensureTable()
      const rows = db.prepare('SELECT * FROM home_rooms ORDER BY created_at DESC LIMIT ?').all(Math.min(50, Math.max(1, Number(limit) || 10)))
      return {
        ok: true,
        rooms: rows.map((r) => {
          const msgs = archiveAllMessages(r.session_id, r.cwd) ?? []
          const first = msgs[0]?.text?.slice(0, 80) ?? null
          const last = msgs.at(-1)?.text?.slice(0, 80) ?? null
          return {
            sessionId: r.session_id,
            shortId: String(r.session_id).slice(0, 8),
            createdAt: r.created_at,
            rotatedAt: r.rotated_at ?? null,
            source: r.source,
            first,
            last,
            count: msgs.length,
          }
        }),
      }
    } catch (e) {
      return { ok: false, code: 'ROOM_LIST_FAILED', error: String(e?.message ?? e) }
    }
  }

  /** 只读旧房间最近 N 条 user/assistant */
  const readRoom = (sessionId, limit = 20) => {
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) return fail('INVALID_SESSION')
    try {
      ensureTable()
      const room = db.prepare('SELECT * FROM home_rooms WHERE session_id=?').get(sessionId.trim())
      if (!room) return fail('ROOM_NOT_FOUND', { sessionId: sessionId.trim() })
      const msgs = archiveAllMessages(room.session_id, room.cwd)
      if (!msgs) return fail('ARCHIVE_UNAVAILABLE', { sessionId: room.session_id })
      const n = Math.min(50, Math.max(1, Number(limit) || 20))
      return ok({
        ok: true,
        room: { sessionId: room.session_id, shortId: String(room.session_id).slice(0, 8), createdAt: room.created_at, source: room.source },
        messages: msgs.slice(-n).map((m) => ({ role: m.role, text: m.text.slice(0, 200), at: m.at })),
        total: msgs.length,
      })
    } catch (e) {
      return fail('ROOM_READ_FAILED', { error: String(e?.message ?? e) })
    }
  }

  const HANDOFF_NOTE =
    '以下是你上一个会话的记录，不是现在发生的事；不要把它们当成现在的对话。如果最后一条是主人发来、你还没回的，就接着回它。'

  /** B 方案：把最近 50 条真实消息构造成宿主 seed 事件（seq 从 0 连续） */
  const buildRotationSeed = (row, model) => {
    try {
      const limit = Math.min(200, Math.max(1, Number(homeCfg.handoffMaxItems ?? 50)))
      const msgs = recentArchiveMessages(row.home_session_id, row.cwd, limit)
      if (!msgs || !msgs.length) return { ok: false, code: 'SEED_UNAVAILABLE' }
      const last = msgs[msgs.length - 1]
      const lastUnanswered = last.role === 'user'
      const events = []
      let t = clock()
      events.push({
        type: 'user/message',
        seq: 0,
        time: t,
        data: {
          id: randomUUID(),
          role: 'user',
          source: { kind: 'handoff-note', ...(lastUnanswered ? { lastUnanswered: true } : {}) },
          content: [{ type: 'text', text: HANDOFF_NOTE }],
        },
        surfaceOp: 'append',
      })
      const brief = buildHandoffBrief(row, 'rotate', msgs)
      if (brief) {
        t += 1
        events.push({
          type: 'user/message',
          seq: 1,
          time: t,
          data: {
            id: randomUUID(),
            role: 'user',
            source: { kind: 'handoff-brief' },
            content: [{ type: 'text', text: brief }],
          },
          surfaceOp: 'append',
        })
      }
      const seqOffset = brief ? 2 : 1
      // 2026-11-12 修复：seed 不能伪装成 assistant/message（v4 校验要求它落在已打开的
      // turn+step 上，而 seed 无法预知真实 turn 编号，重启后会被判 corrupt）。
      // 统一用 user/message（handoff-history）承载历史，不参与 turn 生命周期。
      events.push(...buildSeedHistoryEvents(msgs, { seqOffset, startTime: t + 1 }))
      return { ok: true, seed: events, count: msgs.length, lastUnanswered, note: HANDOFF_NOTE, brief: Boolean(brief), briefChars: brief.length }
    } catch (e) {
      return { ok: false, code: 'SEED_UNAVAILABLE', error: String(e?.message ?? e) }
    }
  }

  const scheduleRequestOf = (record, now) => {
    if (!record || !record.kind) return null
    const base = { title: record.title, prompt: record.prompt }
    const at = Date.parse(record.scheduledAt)
    if (!Number.isFinite(at) || at <= now) return null
    if (record.kind === 'at') return { ...base, at: new Date(at).toISOString() }
    if (record.kind === 'after') {
      const after = Math.max(1, Math.ceil((at - now) / 1000))
      return { ...base, after_seconds: after }
    }
    if (record.kind === 'every') {
      if (!Number.isSafeInteger(record.everySeconds)) return null
      return { ...base, every_seconds: record.everySeconds }
    }
    if (record.kind === 'daily') {
      if (!record.time || !record.timeZone) return null
      return { ...base, daily: { time: record.time, time_zone: record.timeZone } }
    }
    if (record.kind === 'weekly') {
      if (!record.time || !record.timeZone || !Array.isArray(record.weekdays)) return null
      return { ...base, weekly: { time: record.time, time_zone: record.timeZone, weekdays: record.weekdays } }
    }
    if (record.kind === 'cron') {
      if (!record.expression || !record.timeZone) return null
      return { ...base, cron: { expression: record.expression, time_zone: record.timeZone } }
    }
    return null
  }

  const migrateSchedules = async (oldId, newId) => {
    const audit = (data) => {
      try {
        db.prepare('INSERT INTO action_log(at,self_id,action_id,event,code,note,data_json) VALUES(?,?,?,?,?,?,?)').run(
          clock(), newId, null, 'schedule_migrate', data.failed ? 'PARTIAL' : 'OK',
          `moved=${data.moved} failed=${data.failed} skipped=${data.skipped}`,
          JSON.stringify({ moved: data.moved, failed: data.failed, skipped: data.skipped, code: data.code ?? null }),
        )
      } catch {}
    }
    const sched = safe(getSchedule, null)
    if (!sched || typeof sched.list !== 'function' || typeof sched.create !== 'function') {
      log?.warn?.('[autonomy] schedule 不可用：跳过提醒迁移')
      audit({ moved: 0, failed: 0, skipped: 0, code: 'UNAVAILABLE' })
      return { moved: 0, failed: 0, skipped: 0, code: 'UNAVAILABLE' }
    }
    let list = []
    try {
      list = await Promise.resolve(sched.list({ sessionId: oldId }))
    } catch (e) {
      log?.warn?.(`[autonomy] schedule.list 失败：${e?.message ?? e}`)
      audit({ moved: 0, failed: 0, skipped: 0, code: 'LIST_FAILED' })
      return { moved: 0, failed: 0, skipped: 0, code: 'LIST_FAILED' }
    }
    const now = clock()
    let moved = 0
    let failed = 0
    let skipped = 0
    for (const record of Array.isArray(list) ? list : []) {
      const request = scheduleRequestOf(record, now)
      if (!request) { skipped += 1; continue }
      try {
        await Promise.resolve(sched.create(newId, request))
        moved += 1
        if (typeof sched.delete === 'function') {
          try {
            await Promise.resolve(sched.delete({ sessionId: oldId, id: record.id }))
          } catch (e) {
            log?.warn?.(`[autonomy] schedule.delete 旧提醒失败（可能重复）：${record.id} ${e?.message ?? e}`)
          }
        }
      } catch (e) {
        failed += 1
        log?.warn?.(`[autonomy] schedule 迁移失败（保留旧提醒）：${record.id} ${e?.message ?? e}`)
      }
    }
    audit({ moved, failed, skipped })
    return { moved, failed, skipped }
  }

  /** 轮换：写 handoff → 新会话（带 agentOptions）→ 旧房间留档；失败保留旧行/旧会话 */
  async function rotateHomeAction({ personaId, reason = 'threshold', force = false } = {}) {
    const g = gate()
    if (g) return g
    if (!personaId) return fail('NO_PERSONA')
    const row = rowOf(personaId)
    if (!row) return fail('NO_HOME')
    const trig = shouldRotateRow(row)
    if (!trig && !force) return fail('BELOW_THRESHOLD', { ratio: trig?.ratio ?? (Number(row.context_window) > 0 ? Number(row.prompt_tokens) / Number(row.context_window) : 0) })

    const model = modelOf()
    if (!model) return recordRotate({ at: clock(), ok: false, code: 'NO_MODEL', from: row.home_session_id })
    const agents = agentsOf()
    if (!agents || typeof agents.create !== 'function') return recordRotate({ at: clock(), ok: false, code: 'AGENTS_UNAVAILABLE', from: row.home_session_id })

    let handoffPath = null
    try {
      handoffPath = buildHandoff(row, reason)
    } catch (e) {
      return recordRotate({ at: clock(), ok: false, code: 'HANDOFF_FAILED', from: row.home_session_id, error: String(e?.message ?? e).slice(0, 200) })
    }

    const newId = randomUUID()
    let handoffText = ''
    try { handoffText = buildHandoffText(row, reason) } catch (e) {
      log?.warn?.(`[autonomy] 轮换交接文本生成失败（不阻断）：${e?.message ?? e}`)
    }
    const composed = await composeSetup()
    let out
    try {
      out = await agents.create({
        sessionId: newId,
        meta: {
          cwd,
          autonomyHome: true,
          personaId: String(personaId),
          ...(composed.resolvedId ? { agentPreset: composed.resolvedId } : {}),
          rotatedFrom: row.home_session_id,
          ...(handoffText ? { handoffChars: handoffText.length } : {}),
        },
        ...(composed.setup ? { setup: composed.setup } : {}),
        agentOptions: model,
      })
    } catch (e) {
      return recordRotate({ at: clock(), ok: false, code: 'HOME_CREATE_FAILED', from: row.home_session_id, error: String(e?.message ?? e).slice(0, 200), handoffPath })
    }
    const h = normalize(out)
    if (!h) return recordRotate({ at: clock(), ok: false, code: 'HOME_CREATE_FAILED', from: row.home_session_id, error: 'agents.create 未返回 agent', handoffPath })
    // 2026-11-14：交接文本作为新房间消息注入
    const handoffMounted = handoffText ? await injectHandoffMessage(h.agent, handoffText) : false
    if (handoffText) {
      try { setMeta(db, `home.handoff.${newId}`, { at: clock(), chars: handoffText.length, mounted: handoffMounted, delivered: handoffMounted, text: handoffText }) } catch {}
    }

    const now = clock()
    try {
      db.exec('BEGIN IMMEDIATE')
      const oldRoom = db.prepare('SELECT id FROM home_rooms WHERE session_id=?').get(row.home_session_id)
      if (oldRoom) db.prepare('UPDATE home_rooms SET rotated_at=? WHERE session_id=?').run(now, row.home_session_id)
      else
        db.prepare(`INSERT INTO home_rooms(persona_id, session_id, cwd, created_at, rotated_at, source) VALUES(?,?,?,?,?,'legacy')`).run(
          String(personaId),
          row.home_session_id,
          row.cwd,
          Number(row.created_at ?? now),
          now,
        )
      db.prepare(`INSERT INTO home_rooms(persona_id, session_id, cwd, created_at, rotated_at, source) VALUES(?,?,?,?,NULL,'rotate')`).run(
        String(personaId),
        newId,
        cwd,
        now,
      )
      db.prepare(
        `UPDATE home_sessions SET home_session_id=?, cwd=?, created_at=?, last_seen_at=?, prompt_tokens=0 WHERE persona_id=?`,
      ).run(newId, cwd, now, now, String(personaId))
      db.exec('COMMIT')
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {}
      try {
        h.agent?.dispose?.()
      } catch {}
      return recordRotate({ at: now, ok: false, code: 'ROTATE_DB_FAILED', from: row.home_session_id, error: String(e?.message ?? e).slice(0, 200), handoffPath })
    }

    try {
      handle?.agent?.dispose?.()
    } catch {}
    handle = h
    handleSessionId = newId
    recent = []
    await attachHomeToWorkspace(newId)
    try {
      await migrateSchedules(row.home_session_id, newId)
    } catch (e) {
      log?.warn?.(`[autonomy] schedule 迁移异常（不阻断轮换）：${e?.message ?? e}`)
    }
    recordRotate({ at: now, ok: true, code: 'ROTATED', from: row.home_session_id, to: newId, handoffPath, reason, handoffChars: handoffText.length, handoffMounted })
    log?.info?.(`[autonomy] home 轮换 ${String(row.home_session_id).slice(0, 8)}… → ${newId.slice(0, 8)}…（${reason}）`)
    return ok({
      code: 'ROTATED',
      from: row.home_session_id,
      sessionId: newId,
      preset: composed.resolvedId,
      seeded: Boolean(handoffText),
      handoffChars: handoffText.length,
      handoffMounted,
      handoffPath,
      ratio: trig?.ratio ?? 0,
      agent: h.agent,
    })
  }

  /** 轮换单飞：同一时刻只允许一个轮换（回合结束检查 / 醒来检查 / 手动工具共用） */
  async function rotateHome(opts = {}) {
    if (rotateInFlight) return fail('ROTATE_IN_FLIGHT')
    rotateInFlight = true
    try {
      return await rotateHomeAction(opts)
    } finally {
      rotateInFlight = false
    }
  }

  /** C3b：回合结束后延时量一次（等宿主把这一回合的落盘/收尾做完；期间有新风/忙就跳过，等下一回合） */
  const turnRotateDelayMs = () => Math.max(0, Math.min(60_000, Number(homeCfg.turnRotateDelayMs ?? 1_500)))

  const scheduleTurnEndRotate = (sessionId) => {
    const sid = String(sessionId ?? '')
    if (!sid) return
    if (turnRotateTimer != null) {
      try { clearTimeout(turnRotateTimer) } catch {}
    }
    turnRotateTimer = setTimeout(() => {
      turnRotateTimer = null
      void maybeRotateAtTurnEnd(sid)
    }, turnRotateDelayMs())
    try { turnRotateTimer.unref?.() } catch {}
  }

  const maybeRotateAtTurnEnd = async (sid) => {
    try {
      if (rotateInFlight) return
      const g = gate()
      if (g) return
      const personaId = currentPersonaId()
      if (!personaId) return
      const row = rowOf(personaId)
      // 只认触发本次检查的那个家；已被别的路径换掉就什么都不做
      if (!row || String(row.home_session_id) !== String(sid)) return
      if (!shouldRotateRow(row)) return
      // 有主人在等/正在投递/正在醒来/回合没结束：让这一轮先走完，下一回合结束再量
      if (ownerQueue.length || normalQueue.length) return
      if (deliverRunning || ownerDelivering || awakeInFlight || activeTurn) return
      if (handle?.agent?.status === 'running') return
      const rot = await rotateHome({ personaId, reason: 'threshold-turn-end' })
      if (!rot.ok) log?.warn?.(`[autonomy] 回合结束轮换未执行（等下一回合）：${rot.code}`)
      else logEvent('info', 'rotate_turn_end', { from: rot.from, to: rot.sessionId, tokens: Number(row.prompt_tokens ?? 0) })
    } catch (e) {
      log?.warn?.(`[autonomy] 回合结束轮换异常（不阻断）：${e?.message ?? e}`)
    } finally {
      if (!awakeInFlight && !deliverRunning && (ownerQueue.length || normalQueue.length)) void drainDeliverQueue()
    }
  }

  /** 宿主 session/event：只处理 home 会话的 usage / contextWindow / assistant 文本 */
  const observeSessionEvent = (session, event) => {
    try {
      const sid = String(session?.header?.id ?? session?.id ?? '')
      if (!sid || !isHomeSession(sid)) return null
      const d = event?.data ?? {}

      // 2026-11-14：聊天活动时间轴。user/message 兜住渠道入站与 home 内部注入，
      // assistant/message 兜住她的回复，turn/start 兜住「回合已开始但还没落消息」的长回合，
      // turn/end 兜住「聊天刚好结束」——空闲窗口从回合结束重新计。
      // 只影响骰子/自主唤醒闸门；轮换、投递、暂停各自走原逻辑，不读这里。
      if (event?.type === 'user/message' || event?.type === 'assistant/message' || event?.type === 'turn/start' || event?.type === 'turn/end') {
        markChatActivity(event.type)
      }

      // 2026-11-14：记 home 会话里真实发生的工具动作（不是醒来，也不是 tick mock）
      if (event?.type === 'tool/call') {
        const callId = String(d?.callId ?? d?.message?.toolCallId ?? '')
        if (callId) toolCalls.set(callId, { name: String(d?.name ?? ''), args: d?.arguments ?? '', at: clock() })
        return { toolCall: true }
      }
      if (event?.type === 'tool/result') {
        const callId = String(d?.callId ?? d?.message?.toolCallId ?? '')
        const call = callId ? toolCalls.get(callId) : null
        if (call) {
          toolCalls.delete(callId)
          const err = event?.error ?? d?.error ?? (d?.message?.isError === true ? { message: 'tool error' } : null)
          let selfId = ''
          try { selfId = String(getPersonaId?.() ?? '') } catch {}
          if (!selfId) {
            try { selfId = String(db.prepare('SELECT persona_id FROM home_sessions WHERE home_session_id=?').get(sid)?.persona_id ?? '') } catch {}
          }
          recordActivity(db, selfId || 'self:unknown', {
            sessionId: sid, kind: 'tool', name: call.name, args: call.args,
            status: err ? 'failed' : 'done', at: clock(),
            meta: err ? { error: String(err?.message ?? err?.code ?? err).slice(0, 300) } : null,
          })
        }
        return { toolResult: true }
      }

      if (event?.type === 'turn/start') {
        activeTurn = { turn: d?.turn ?? d?.step?.turn ?? event?.turn ?? null, startedAt: clock() }
        stuckDetections = 0
        return { turnStarted: true }
      }

      // C4b：回合结束失败 → 改写 lastWake / 记 lastTurnError；不重复叫醒，只通知循环重试
      if (event?.type === 'turn/end') {
        activeTurn = null
        void Promise.resolve().then(() => drainDeliverQueue())
        stuckDetections = 0
        try {
          const stuck = getMeta(db, 'home.stuckTurn', null)
          if (stuck?.active) setMeta(db, 'home.stuckTurn', { ...stuck, active: false, endedAt: clock() }, clock())
        } catch {}
        const reason = d?.reason ?? d?.error ?? {}
        const isError = String(reason?.kind ?? reason?.type ?? '') === 'error' || d?.ok === false
        if (isError) {
          const code = String(reason?.code ?? reason?.error?.code ?? 'TURN_ERROR')
          const error = String(reason?.message ?? reason?.error?.message ?? reason ?? 'turn error').slice(0, 300)
          const prev = getMeta(db, 'home.lastWake', null) ?? {}
          const payload = { at: clock(), ok: false, code: 'TURN_ERROR', error, attempts: Number(prev.attempts ?? 0) }
          try {
            setMeta(db, 'home.lastWake', payload, clock())
            setMeta(db, 'home.lastTurnError', { ...payload, sessionId: sid, turnCode: code }, clock())
          } catch {}
          log?.warn?.(`[autonomy] home 回合失败 ${code}：${error}`)
          try {
            turnHandler?.({ code, error, sessionId: sid, at: payload.at })
          } catch {}
          return { turnError: code }
        }
        // C3b：回合结束就量一次（不再等下一次醒来）；延迟由 scheduleTurnEndRotate 内部调度
        scheduleTurnEndRotate(sid)
        return { turnEnded: true }
      }
      let tokens = null
      let windowSize = null
      if (event?.type === 'assistant/message') {
        const usage = d?.usage ?? d?.message?.usage ?? d?.data?.usage
        if (usage) {
          const t = Number(usage.inputTokens ?? usage.input_tokens ?? 0) + Number(usage.cacheReadTokens ?? usage.cache_read_tokens ?? 0)
          if (Number.isFinite(t) && t >= 0) tokens = t
        }
        const text = extractText(d)
        if (text) {
          recent.push({ text, at: clock() })
          if (recent.length > 50) recent = recent.slice(-50)
        }
      }
      if (event?.type === 'request/context') {
        const w = Number(d?.contextWindow ?? d?.context_window)
        if (Number.isFinite(w) && w > 0) windowSize = w
      }
      if (tokens == null && windowSize == null) return null
      const sets = []
      const vals = []
      if (tokens != null) {
        sets.push('prompt_tokens=?')
        vals.push(Math.max(0, Math.floor(tokens)))
      }
      if (windowSize != null) {
        sets.push('context_window=?')
        vals.push(Math.floor(windowSize))
      }
      db.prepare(`UPDATE home_sessions SET ${sets.join(',')} WHERE home_session_id=?`).run(...vals, sid)
      return { tokens, windowSize }
    } catch {
      return null // 计量失败不崩、不抛
    }
  }

  /**
   * 叫醒她一次（C1：只 followup，不等待回合结束；超时/自愈在 C2/C4）
   * @returns {Promise<{ok:boolean, code:string, sessionId?:string, created?:boolean, resumed?:boolean}>}
   */
  const awake = async ({ personaId, prompt = HOME_WAKE_PROMPT, sourceKind = 'autonomy-home-wake' } = {}) => {
    const g = gate()
    if (g) return g
    const stuck = checkStuckTurn()
    if (stuck) return fail('STUCK_TURN', { stuckTurn: stuck })
    if (ownerQueue.length > 0 || ownerDelivering) return fail('OWNER_PENDING')
    if (awakeInFlight || rotateInFlight) return fail('IN_FLIGHT')

    awakeInFlight = true
    try {
      // C3：到阈值先轮换（失败只记 lastRotate，不阻断本次唤醒、不重放）
      try {
        const row = rowOf(personaId)
        // C3b：回合进行中/agent 还在跑时绝不抢着轮换，交给回合结束检查
        if (row && shouldRotateRow(row) && !activeTurn && handle?.agent?.status !== 'running') {
          const rot = await rotateHome({ personaId, reason: 'threshold' })
          if (!rot.ok) log?.warn?.(`[autonomy] home 轮换失败（继续旧家）：${rot.code}`)
        }
      } catch (e) {
        log?.warn?.(`[autonomy] home 轮换异常（继续旧家）：${e?.message ?? e}`)
      }
      const ensured = await ensureHome(personaId)
      if (!ensured.ok) return ensured
      const agent = ensured.agent
      if (!agent) return fail('AGENTS_UNAVAILABLE', { personaId, cwd })
      if (agent.status === 'running') return fail('BUSY', { personaId, sessionId: ensured.sessionId })

      try {
        const message = await identifiedMessage({ content: String(prompt), source: { kind: sourceKind } })
        await agent.followup(message)
      } catch (e) {
        return fail('AWAKE_FAILED', { error: String(e?.message ?? e), sessionId: ensured.sessionId })
      }
      // 16:26：每次醒来推进一次驱动力（回归+自然增长），只作状态，不派任务
      try {
        const rows = loadDrives(db, personaId, clock(), { extended: cfg.drives?.extended === true })
        saveDrives(db, personaId, advanceDrives(rows, clock()))
      } catch {}
      touch(personaId)
      logEvent('info', 'wake', { code: 'AWAKENED', awakened: true, session: ensured.sessionId })
      return ok({
        code: 'AWAKENED',
        sessionId: ensured.sessionId,
        cwd,
        created: Boolean(ensured.created),
        resumed: Boolean(ensured.resumed),
        healed: Boolean(ensured.healed),
        repaired: Boolean(ensured.repaired),
        seedSent: Boolean(ensured.seedSent),
        handoffPath: ensured.handoffPath ?? null,
        seedText: ensured.seedText ?? null,
        lastHeal: ensured.lastHeal ?? null,
      })
    } finally {
      awakeInFlight = false
      lastDrainStage = 'idle'
      await drainDeliverQueue()
      // 上一轮 drain 可能在 awakeInFlight 时提前退出；这里再补一次
      if ((ownerQueue.length || normalQueue.length) && !deliverRunning) await drainDeliverQueue()
    }
  }

  const status = (personaId = null) => {
    let row = null
    try {
      row = personaId
        ? db.prepare('SELECT * FROM home_sessions WHERE persona_id=?').get(String(personaId)) ?? null
        : db.prepare('SELECT * FROM home_sessions ORDER BY last_seen_at DESC LIMIT 1').get() ?? null
    } catch {
      row = null
    }
    const promptTokens = Number(row?.prompt_tokens ?? 0)
    const contextWindow = Number(row?.context_window ?? 0)
    let lastRotate = null
    try {
      lastRotate = getMeta(db, 'home.lastRotate', null)
    } catch {}
    return {
      enabled: Boolean(cfg?.enabled && homeCfg.enabled === true),
      cwd,
      exists: Boolean(row),
      sessionPreset: row ? headerPresetOf(row) : null,
      sessionId: row?.home_session_id ?? null,
      rowCwd: row?.cwd ?? null,
      healthy: Boolean(row && String(row.cwd) === cwd),
      awakeInFlight,
      lastSeenAt: row?.last_seen_at ?? null,
      prompt: HOME_WAKE_PROMPT,
      // C3：计量与轮换
      promptTokens,
      contextWindow,
      ratio: contextWindow > 0 ? promptTokens / contextWindow : 0,
      rotateAt: lastRotate?.ok === true ? lastRotate.at : null,
      lastRotate,
      lastHeal: (() => {
        try {
          return getMeta(db, 'home.lastHeal', null)
        } catch {
          return null
        }
      })(),
      stuckTurn: (() => {
        try {
          checkStuckTurn()
          return getMeta(db, 'home.stuckTurn', null)
        } catch {
          return null
        }
      })(),
      lastTurnError: (() => {
        try {
          return getMeta(db, 'home.lastTurnError', null)
        } catch {
          return null
        }
      })(),
      retryPending: Boolean(retryState()),
      pendingDeliveries: { owner: ownerQueue.length, normal: normalQueue.length },
      deliverRunning,
      ownerDelivering,
      rotating: rotateInFlight,
      lastDrainStage,
      failedDeliveries: failedDeliveries.length,
      lastDeliverError,
      // 2026-11-14：聊天活动快照（骰子/自主唤醒闸门；只读观测）
      lastChatActivityAt: lastChatActivityAt || null,
      chatIdleMs: lastChatActivityAt ? Math.max(0, clock() - lastChatActivityAt) : null,
      dice: (() => {
        let lastRoll = null
        let misses = 0
        try {
          lastRoll = getMeta(db, 'home.dice.lastRoll', null)
          misses = Number(getMeta(db, 'home.dice.misses', 0)) || 0
        } catch {}
        return {
          enabled: homeCfg.dice?.enabled === true,
          lastRoll,
          misses,
          bonus: diceBonusOf(homeCfg.dice ?? {}, misses),
          quiet: {
            enabled: homeCfg.dice?.quietHours?.enabled === true,
            active: diceQuietOf(homeCfg.dice?.quietHours, clock(), cfg?.quietHours?.tz),
            start: homeCfg.dice?.quietHours?.start ?? null,
            end: homeCfg.dice?.quietHours?.end ?? null,
          },
        }
      })(),
      contextLimit: Number(homeCfg.contextLimit ?? 650_000),
      rotateRatio: Number(homeCfg.rotateRatio ?? 0.7),
    }
  }

  const isHomeSession = (sessionId) => {
    if (!sessionId) return false
    try {
      return Boolean(db.prepare('SELECT 1 AS x FROM home_sessions WHERE home_session_id=?').get(String(sessionId)))
    } catch {
      return false
    }
  }

  const dispose = () => {
    try {
      handle?.agent?.dispose?.()
    } catch {}
    handle = null
    handleSessionId = null
  }

  const canWake = () => gate() ?? ok({ code: 'OK' })
  const setTurnHandler = (fn) => {
    turnHandler = typeof fn === 'function' ? fn : null
  }
  const setRetryState = (fn) => {
    retryState = typeof fn === 'function' ? fn : () => false
  }

  const currentPersonaId = () => {
    try {
      const r = db.prepare('SELECT persona_id FROM home_sessions ORDER BY last_seen_at DESC LIMIT 1').get()
      return r?.persona_id ?? null
    } catch {
      return null
    }
  }

  const handoverClipped = (text) => {
    const t = String(text ?? '')
    return t.length > 20_000 ? `${t.slice(0, 20_000)}\n\n[handover 已截断]` : t
  }

  const deliveryTimeoutMs = () => Math.max(1, Number(homeCfg.deliveryTimeoutMin ?? 10)) * 60_000
  const scheduleDrainRetry = () => {
    if (drainRetryTimer || deliverRunning) return
    const ms = Math.min(5000, Math.max(10, Number(homeCfg.drainRetryMs ?? 3000)))
    drainRetryTimer = setTimeout(() => {
      drainRetryTimer = null
      void drainDeliverQueue()
    }, ms)
    try { drainRetryTimer.unref?.() } catch {}
  }

  const deliverLogPath = () => homeCfg?.deliverLog || '/sdcard/DSHA/生活/数据/home/deliver.log'

  const logDeliver = (fields) => {
    try {
      const at = new Date(clock()).toISOString()
      const line = `[${at}] ${Object.entries(fields).map(([k, v]) => `${k}=${v ?? '-'}`).join(' ')}\n`
      const p = deliverLogPath()
      mkdirSync(dirname(p), { recursive: true })
      appendFileSync(p, line)
      log?.info?.(`[autonomy] deliver ${line.trim()}`)
      logEvent(fields.status === 'fail' ? 'warn' : 'info', 'deliver', { priority: fields.priority, status: fields.status, code: fields.code, session: fields.session, position: fields.position })
    } catch {}
  }

  const liveAgentOf = async (sessionId) => {
    const agents = agentsOf()
    if (!sessionId || !agents || typeof agents.get !== 'function') return null
    try {
      const out = await Promise.resolve(agents.get(sessionId))
      return out?.agent ?? (typeof out?.followup === 'function' ? out : null)
    } catch {
      return null
    }
  }

  /** 每次投递前校验 live；不再直接信任缓存 handle */
  const resolveDeliverAgent = async (personaId) => {
    const row = rowOf(personaId)
    const sessionId = row?.home_session_id ?? handleSessionId
    const live = await liveAgentOf(sessionId)
    if (live) {
      handle = { agent: live }
      handleSessionId = sessionId
      return { ok: true, agent: live, sessionId }
    }
    // 缓存失效：清掉，让 ensureHome 走 resume/重建
    handle = null
    handleSessionId = null
    const ensured = await ensureHome(personaId)
    if (!ensured.ok) return { ok: false, code: 'E_AGENT_UNAVAILABLE', error: ensured.code ?? 'ENSURE_FAILED' }
    if (!ensured.agent) return { ok: false, code: 'E_AGENT_UNAVAILABLE', error: 'NO_AGENT' }
    return { ok: true, agent: ensured.agent, sessionId: ensured.sessionId }
  }

  const ROOM_RULES_MARK = '【这个房间的规矩】'
  const stripRoomRules = (text) => {
    const src = String(text ?? '')
    const i = src.indexOf(ROOM_RULES_MARK)
    return i >= 0 ? src.slice(0, i).trimEnd() : src
  }
  const extractRoomRules = (text) => {
    const src = String(text ?? '')
    const i = src.indexOf(ROOM_RULES_MARK)
    return i >= 0 ? src.slice(i).trim() : ''
  }
  // 2026-11-12：房间规矩挂成 home agent 的 systemPrompt 常驻上下文，只挂一次，
  // 之后消息里的规则块剥掉（省上下文，又不会忘）。
  const rulesMounted = new WeakSet()
  const mountHomeRules = (agent, text) => {
    const body = String(text ?? '').trim()
    if (!body) return false
    try {
      if (rulesMounted.has(agent)) return true
      const sp = agent?.ctx?.systemPrompt
      if (!sp || typeof sp.context !== 'function') return false
      sp.context({ name: 'dy-home-rules', order: 966, interpolate: false, text: () => body })
      rulesMounted.add(agent)
      try { log?.info?.('房间规矩已挂 systemPrompt 常驻上下文') } catch {}
      return true
    } catch (e) {
      const msg = String(e?.message ?? e)
      if (msg.includes('already registered')) { rulesMounted.add(agent); return true }
      return false
    }
  }

  const sendDeliverItem = async (item, agent, sessionId) => {
    if (item.handoverText && !handoverUsed && !item.handoverSent) {
      const note = await identifiedMessage({
        content: handoverClipped(item.handoverText),
        source: { kind: 'handoff-note', channel: item.channel ?? null, contactId: item.contactId ?? null },
      })
      await agent.followup(note)
      item.handoverSent = true
    }
    const deliveredKey = sessionId ? `home.delivered.${sessionId}` : null
    let count = 0
    try {
      count = deliveredKey ? Number(getMeta(db, deliveredKey, 0)) || 0 : 0
    } catch {}
    const first = count === 0
    item.firstInSession = first
    // 2026-11-12：规矩优先挂 systemPrompt 常驻上下文（只挂一次）；挂上后消息里的规则块剥掉。
    // 挂不上（测试 fake agent/旧宿主）则保留消息内规则，保证行为不退化。
    const rules = extractRoomRules(item.text)
    const mounted = rules ? mountHomeRules(agent, rules) : false
    const body = mounted ? stripRoomRules(item.text) : item.text
    const msg = await identifiedMessage({
      content: body,
      source: {
        kind: 'user',
        channelInbound: true,
        channel: item.channel ?? null,
        contactId: item.contactId ?? null,
        contactName: item.contactName ?? null,
      },
    })
    await agent.followup(msg)
    // 只有正文真正投递成功才计数；handover 不计
    if (deliveredKey) {
      try {
        setMeta(db, deliveredKey, count + 1, clock())
      } catch {}
    }
    // 只有整条消息真正投递成功，才把 handover 记为已用
    if (item.handoverText) handoverUsed = true
  }

  function drainDeliverQueue() {
    if (awakeInFlight) return Promise.resolve() // 叫醒中不抢队列；awake finally 会处理
    if (rotateInFlight) return Promise.resolve() // 轮换中不投递（旧 agent 正在退场）；轮换结束时补 drain
    if (deliverRunning) {
      scheduleDrainRetry()
      return Promise.resolve()
    }
    deliverRunning = true
    return (async () => {
      try {
        while (ownerQueue.length || normalQueue.length) {
          if (awakeInFlight) { lastDrainStage = 'awake-in-flight'; break }
          if (gate()) { lastDrainStage = 'gate'; break }
          const personaId = currentPersonaId() ?? safe(getPersonaId, null)
          if (!personaId) { lastDrainStage = 'no-persona'; break }
          const fromOwner = ownerQueue.length > 0
          const q = fromOwner ? ownerQueue : normalQueue
          const item = q[0]
          if (!item) break
          const queuedAt = Number(item.enqueuedAt ?? item.at ?? clock())
          if (clock() - queuedAt > deliveryTimeoutMs()) {
            q.shift()
            item.failCode = 'E_DELIVER_TIMEOUT'
            item.error = `queued ${Math.floor((clock() - queuedAt) / 60_000)}min`
            failedDeliveries.push(item)
            lastDeliverError = { at: clock(), code: 'E_DELIVER_TIMEOUT', error: item.error, textId: item.messageId ?? null }
            logDeliver({ priority: item.priority, channel: item.channel, session: handleSessionId ?? '-', status: 'fail', code: 'E_DELIVER_TIMEOUT', queuedMin: Math.floor((clock() - queuedAt) / 60_000) })
            continue
          }
          lastDrainStage = 'resolving'
          const resolved = await resolveDeliverAgent(personaId)
          lastDrainStage = 'resolved'
          if (!resolved.ok) {
            // 拿不到 live agent：不投，记录失败并保留日志，避免静默丢
            q.shift()
            item.failCode = resolved.code
            item.error = resolved.error
            failedDeliveries.push(item)
            lastDeliverError = { at: clock(), code: resolved.code, error: resolved.error, textId: item.messageId ?? null }
            logDeliver({ priority: item.priority, channel: item.channel, session: handleSessionId ?? '-', status: 'fail', code: resolved.code, error: resolved.error })
            continue
          }
          if (!resolved.agent) { lastDrainStage = 'no-agent'; break }
          if (resolved.agent.status === 'running') { lastDrainStage = 'agent-running'; scheduleDrainRetry(); break }
          lastDrainStage = 'delivering'
          if (fromOwner) ownerDelivering = true
          try {
            logDeliver({ priority: item.priority, channel: item.channel, session: resolved.sessionId, status: 'attempt', attempt: (item.attempts ?? 0) + 1 })
            await sendDeliverItem(item, resolved.agent, resolved.sessionId)
            q.shift()
            logDeliver({ priority: item.priority, channel: item.channel, session: resolved.sessionId, status: 'ok' })
          } catch (e) {
            item.attempts = (item.attempts ?? 0) + 1
            const err = String(e?.message ?? e).slice(0, 300)
            logDeliver({ priority: item.priority, channel: item.channel, session: resolved.sessionId, status: 'retry', attempt: item.attempts, error: err })
            if (item.attempts >= 3) {
              q.shift()
              item.failCode = 'E_DELIVER_FAILED'
              item.error = err
              failedDeliveries.push(item)
              lastDeliverError = { at: clock(), code: 'E_DELIVER_FAILED', error: err, textId: item.messageId ?? null }
              logDeliver({ priority: item.priority, channel: item.channel, session: resolved.sessionId, status: 'fail', code: 'E_DELIVER_FAILED', attempts: item.attempts })
            }
          } finally {
            if (fromOwner) ownerDelivering = false
          }
        }
      } finally {
        deliverRunning = false
      }
    })()
  }

  const deliverOneNow = async (item, personaId) => {
    const resolved = await resolveDeliverAgent(personaId)
    if (!resolved.ok) {
      lastDeliverError = { at: clock(), code: resolved.code, error: resolved.error, textId: item.messageId ?? null }
      logDeliver({ priority: item.priority, channel: item.channel, session: handleSessionId ?? '-', status: 'fail', code: resolved.code, error: resolved.error })
      return { ok: false, code: resolved.code, error: resolved.error, priority: item.priority }
    }
    let lastErr = null
    for (let i = 0; i < 3; i++) {
      try {
        item.attempts = i + 1
        logDeliver({ priority: item.priority, channel: item.channel, session: resolved.sessionId, status: 'attempt', attempt: item.attempts })
        await sendDeliverItem(item, resolved.agent, resolved.sessionId)
        logDeliver({ priority: item.priority, channel: item.channel, session: resolved.sessionId, status: 'ok' })
        return { ok: true, queued: false, delivered: true, code: 'DELIVERED', priority: item.priority, firstInSession: item.firstInSession === true }
      } catch (e) {
        lastErr = e
        logDeliver({ priority: item.priority, channel: item.channel, session: resolved.sessionId, status: 'retry', attempt: item.attempts, error: String(e?.message ?? e).slice(0, 300) })
      }
    }
    item.failCode = 'E_DELIVER_FAILED'
    item.error = String(lastErr?.message ?? lastErr).slice(0, 300)
    failedDeliveries.push(item)
    lastDeliverError = { at: clock(), code: 'E_DELIVER_FAILED', error: item.error, textId: item.messageId ?? null }
    logDeliver({ priority: item.priority, channel: item.channel, session: resolved.sessionId, status: 'fail', code: 'E_DELIVER_FAILED', attempts: item.attempts })
    return { ok: false, code: 'E_DELIVER_FAILED', attempts: item.attempts, retained: true, priority: item.priority }
  }

  /**
   * 统一私聊投递：渠道适配器只转发，不直接碰 agent。
   * 串行队列；home 忙/叫醒中 → 排队（默认上限 50），不打断。
   */
  async function deliver(payload = {}) {
    const { channel = 'unknown', kind = 'private', contactId = null, contactName = null, text = '', handoverText = null } = payload
    if (kind === 'group') return { ok: false, code: 'E_GROUP_NOT_UNIFIED' }
    const body = String(text ?? '')
    if (!body.trim()) return { ok: false, code: 'E_EMPTY_TEXT' }
    // 2026-11-14：任何渠道入站消息都算聊天活动（即使随后排队/被总闸挡住）。
    // 这是「主人正在说话」的可靠信号，比等宿主 session/event 更早。
    markChatActivity(`deliver:${channel}`)
    const g = gate()
    if (g) return { ok: false, code: g.code }
    const stuck = checkStuckTurn()
    if (stuck) return { ok: false, code: 'STUCK_TURN', stuckTurn: stuck, priority: payload.priority === 'owner' ? 'owner' : 'normal' }

    // 抖音通知去重：同一内容在窗口内只进 home 一次（web watcher / 兜底重复都收口）
    if (channel === 'douyin') {
      const dedupeMs = Math.max(60_000, Number(homeCfg.deliveryDedupeMs ?? 10 * 60_000))
      const key = `${kind}\u0001${contactId ?? ''}\u0001${body.trim()}`
      const last = recentDouyinDeliveries.get(key)
      const t = clock()
      if (last && t - last < dedupeMs) return { ok: true, deduped: true, delivered: false, code: 'DEDUPED', priority: payload.priority === 'owner' ? 'owner' : 'normal' }
      recentDouyinDeliveries.set(key, t)
      if (recentDouyinDeliveries.size > 200) for (const [k, at] of recentDouyinDeliveries) if (t - at > dedupeMs) recentDouyinDeliveries.delete(k)
    }

    const max = Math.max(1, Number(homeCfg.deliveryQueueMax ?? 50))
    const priority = payload.priority === 'owner' ? 'owner' : 'normal'
    const sessionIdForCount = handleSessionId ?? rowOf(currentPersonaId())?.home_session_id ?? null
    const firstPredicted = (() => {
      try {
        return !sessionIdForCount || Number(getMeta(db, `home.delivered.${sessionIdForCount}`, 0)) === 0
      } catch {
        return true
      }
    })()
    const item = { channel, contactId, contactName, text: body.slice(0, 20000), handoverText, priority, at: payload.at ?? clock(), messageId: payload.messageId ?? null, attempts: 0, firstInSession: firstPredicted, enqueuedAt: clock() }
    const hardBusy = Boolean(awakeInFlight || rotateInFlight || ownerDelivering || handle?.agent?.status === 'running')
    const busy = Boolean(hardBusy || deliverRunning)
    const q = priority === 'owner' ? ownerQueue : normalQueue
    if (ownerQueue.length + normalQueue.length >= max) return { ok: false, code: 'QUEUE_FULL' }

    // 队列非空：后来的消息一律排队，绝不反超更早条目
    if (!hardBusy && ownerQueue.length === 0 && normalQueue.length === 0) {
      const personaId = currentPersonaId() ?? safe(getPersonaId, null)
      if (!personaId) return { ok: false, code: 'E_AGENT_UNAVAILABLE', priority }
      return await deliverOneNow(item, personaId)
    }

    q.push(item)
    const position = q.indexOf(item) + 1
    logDeliver({ priority, channel, session: handleSessionId ?? '-', status: 'queued', position, enqueuedAt: item.enqueuedAt })
    void Promise.resolve().then(() => drainDeliverQueue())
    return { ok: true, queued: true, delivered: false, code: 'QUEUED', position, priority, firstInSession: item.firstInSession === true }
  }

  const dyHomeService = () => ({
    version: 1,
    isHomeSession: (sessionId) => isHomeSession(sessionId),
    status: (personaId) => status(personaId),
    deliver: (payload) => deliver(payload),
  })

  return {
    awake,
    ensureHome,
    isHomeSession,
    status,
    rotateHome,
    observeSessionEvent,
    chatActivityState,
    chatGate,
    get lastChatActivityAt() {
      return lastChatActivityAt || null
    },
    deliver,
    drainDeliverQueue,
    listRooms,
    readRoom,
    canWake,
    setTurnHandler,
    setRetryState,
    buildHandoff,
    dispose,
    dyHomeService,
    get cwd() {
      return cwd
    },
    get prompt() {
      return HOME_WAKE_PROMPT
    },
    _ensureTable: ensureTable, // 测试/迁移兜底用
  }
}

// ── C2：轻唤醒状态卡 + 唤醒循环 ───────────────────────────────

export const MAX_CARD_CHARS = 500

const DRIVE_CN = { curiosity: '好奇', social: '社交', mastery: '精通', care: '照顾', rest: '休息', approval: '被认可', affiliation: '靠近', rebellion: '反抗', order: '秩序' }

function fmtNow(now, tz = 'Asia/Shanghai') {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(now))
    const get = (t) => parts.find((p) => p.type === t)?.value ?? ''
    return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
  } catch {
    return new Date(now).toISOString().slice(5, 16).replace('T', ' ')
  }
}

function humanGap(ms) {
  const m = Math.max(0, Math.round(Number(ms) / 60_000))
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时 ${m % 60} 分`
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`
}

const safe = (fn, fallback = null) => {
  try {
    const v = fn()
    return v === undefined || v === null ? fallback : v
  } catch {
    return fallback
  }
}

/**
 * 轻唤醒状态卡（≤500 字）：身份/情绪/目标/最近行动/最近会话/反思 pending。
 * 每行独立降级，缺哪行跳哪行；绝不让拼卡失败挡住唤醒。
 */
export function buildWakeCard({ db, persona = null, cfg = null, personaId = null, now = Date.now() } = {}) {
  const tz = cfg?.quietHours?.tz ?? 'Asia/Shanghai'
  const lines = []
  let lastWake = null
  let topDriveName = null
  try {
    lastWake = getMeta(db, 'home.lastWake', null)
  } catch {
    lastWake = null
  }

  // 【现在】
  try {
    const gap = lastWake?.at ? `｜距上次醒 ${humanGap(now - Number(lastWake.at))}` : '｜还没醒过'
    lines.push(`【现在】${fmtNow(now, tz)}${gap}`)
  } catch {}

  // 【卡住】只在检测到未结束的 stuck 回合时显示
  try {
    const stuck = getMeta(db, 'home.stuckTurn', null)
    if (stuck?.active) lines.push(`【卡住】回合 ${stuck.turn ?? '—'} 已 ${stuck.minutes ?? '?'} 分钟未结束`)
  } catch {}

  // 【我】身份 + 驱动力
  try {
    const name = safe(() => persona?.displayName?.(), '') || '她'
    let driveLine = ''
    try {
      const rows = db.prepare('SELECT name,value FROM drives WHERE self_id=?').all(String(personaId ?? ''))
      if (rows.length) {
        const map = Object.fromEntries(rows.map((r) => [r.name, Number(r.value)]))
        const parts = Object.keys(DRIVE_CN)
          .filter((k) => Number.isFinite(map[k]))
          .map((k) => `${DRIVE_CN[k]} ${map[k].toFixed(2)}`)
        const top = Object.entries(map).sort((a, b) => b[1] - a[1])[0]
        topDriveName = top?.[0] ?? null
        if (parts.length) driveLine = `｜${parts.join(' / ')}（最高：${DRIVE_CN[top?.[0]] ?? top?.[0]}）`
      }
    } catch {}
    lines.push(`【我】${name}${driveLine}`)
  } catch {}

  // 【心情】
  try {
    const emo = safe(() => persona?.emotionState?.(), null)
    if (emo && emo.label) lines.push(`【心情】${emo.label}（强度 ${Number(emo.intensity ?? 0).toFixed(2)}）`)
  } catch {}

  // 【最近目标】
  try {
    const goals = db
      .prepare(`SELECT title,priority FROM goals WHERE self_id=? AND status IN ('open','doing') ORDER BY priority DESC, updated_at DESC LIMIT 3`)
      .all(String(personaId ?? ''))
    lines.push(goals.length ? `【目标】${goals.map((g) => g.title).join('；')}` : '【目标】暂无（可以给自己定一个）')

    // 【最近想做】最近 3 条反思摘要 + 最高驱动力；只展示，不派任务
    let wants = []
    try {
      wants = db
        .prepare("SELECT text FROM reflections WHERE self_id=? AND status='done' AND text IS NOT NULL ORDER BY at DESC LIMIT 3")
        .all(String(personaId ?? ''))
        .map((r) => String(r.text ?? '').slice(0, 40))
        .filter(Boolean)
    } catch {}
    const topCn = topDriveName ? (DRIVE_CN[topDriveName] ?? topDriveName) : null
    lines.push(`【最近想做】${wants.length ? wants.join('；') : '暂无'}${topCn ? `（当前最高：${topCn}）` : ''}`)
  } catch {}

  // 【最近行动】
  try {
    const a = db
      .prepare('SELECT kind,status,ended_at,result_json FROM actions WHERE self_id=? ORDER BY ended_at DESC, created_at DESC LIMIT 1')
      .get(String(personaId ?? ''))
    const lastWakeAt = Number(lastWake?.at) || 0
    const toolAct = recentActivities(db, String(personaId ?? ''), 1)[0] ?? null
    if (toolAct && Number(toolAct.at) >= Number(a?.ended_at || a?.created_at || 0) && Number(toolAct.at) >= lastWakeAt) {
      lines.push(`【最近行动】${toolAct.name || '工具动作'}（${humanGap(now - Number(toolAct.at))}前）`)
    } else if (a && Number(a.ended_at || a.created_at || 0) >= lastWakeAt) {
      let result = '完成'
      try {
        const r = a.result_json ? JSON.parse(a.result_json) : null
        if (r?.simulated === true || r?.dryRun === true) result = '模拟'
      } catch {}
      if (a.status === 'failed') result = '失败'
      const when = a.ended_at ? `${humanGap(now - Number(a.ended_at))}前` : ''
      lines.push(`【最近行动】${a.kind}（${when}${result}）`)
    } else if (lastWakeAt) {
      lines.push(`【最近行动】上次醒来（${humanGap(now - lastWakeAt)}前）`)
    } else {
      lines.push('【最近行动】还没有')
    }
  } catch {}

  // 【最近会话】
  try {
    if (lastWake?.sessionId) lines.push(`【最近会话】上次醒：${lastWake.at ? fmtNow(Number(lastWake.at), tz) : '—'}（${String(lastWake.sessionId).slice(0, 8)}…）`)
    else lines.push('【最近会话】还没醒过')
  } catch {}

  // 【反思】
  try {
    const n = Number(db.prepare("SELECT COUNT(1) AS n FROM reflections WHERE self_id=? AND status='pending'").get(String(personaId ?? ''))?.n ?? 0)
    lines.push(n > 0 ? `【反思】${n} 条 pending` : '【反思】无 pending')
  } catch {}

  let out = ''
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line
    if (next.length > MAX_CARD_CHARS) break
    out = next
  }
  return out
}

/**
 * 唤醒 nudge：按驱动力给一条只读建议；不执行、不决策。
 * @returns {{text,drive,action,score,label}|null}
 */
export function buildWakeNudge({ db, cfg = null, personaId = null, now = Date.now() } = {}) {
  const nc = cfg?.home?.nudge ?? {}
  if (nc.enabled === false) return null
  const min = Math.max(0, Math.min(1, Number(nc.minDrive ?? 0.6)))
  const bonus = Math.max(0, Number(nc.goalBonus ?? 0.15))
  const actionThreshold = Math.max(0, Math.min(1, Number(nc.actionThreshold ?? 0.75)))
  const cooldownMs = Math.max(0, Number(nc.cooldownMin ?? 30)) * 60_000
  let rows = []
  try {
    rows = db.prepare('SELECT name,value FROM drives WHERE self_id=?').all(String(personaId ?? ''))
  } catch {
    rows = []
  }
  if (!rows.length) return null
  const map = Object.fromEntries(rows.map((r) => [r.name, Number(r.value)]))
  const labels = { curiosity: '好奇', social: '表达', mastery: '秩序', care: '亲密' }
  const top = Object.entries(map)
    .filter(([k, v]) => labels[k] && Number.isFinite(v))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
  if (!top.length) return null
  const candidates = [
    { drive: 'curiosity', action: 'practice', reason: '用 dy_life_practice 自己挑个主题' },
    { drive: 'social', action: 'write_diary', reason: '把想说的话写下来' },
    { drive: 'care', action: 'read_archive', reason: '翻翻旧档案，想想以前的事' },
    { drive: 'care', action: 'send_qq', reason: '想和主人说说话时再发，不想就不发' },
    { drive: 'mastery', action: 'organize_memory', reason: '整理一下记忆，给自己腾点空间' },
  ]
  let goals = []
  try {
    goals = db.prepare("SELECT kind_hint FROM goals WHERE self_id=? AND status IN ('open','doing')").all(String(personaId ?? ''))
  } catch {}
  const hints = new Set(goals.map((g) => String(g.kind_hint ?? '')).filter(Boolean))
  const cooled = new Set()
  if (cooldownMs > 0) {
    try {
      const recent = db.prepare("SELECT data_json FROM action_log WHERE event='wake_nudge' AND at>=?").all(now - cooldownMs)
      for (const r of recent) {
        try {
          const a = JSON.parse(r.data_json ?? '{}')?.action
          if (a) cooled.add(String(a))
        } catch {}
      }
    } catch {}
  }
  let best = null
  for (const c of candidates) {
    if (cooled.has(c.action)) continue
    const score = Number(map[c.drive] ?? 0) + (hints.has(c.action) ? bonus : 0)
    if (!best || score > best.score) best = { ...c, score, label: labels[c.drive] }
  }
  if (!best || best.score < min) return null
  let energy = 0.6
  try { energy = Math.max(0, Math.min(1, Number(getMeta(db, 'home.energy', 0.6)))) } catch {}
  const canAct = ['curiosity', 'social'].includes(best.drive) && Number(map[best.drive] ?? 0) >= actionThreshold && energy >= 0.3
  const driveText = top.map(([k, v]) => `${labels[k]} ${Number(v).toFixed(2)}`).join(' / ')
  const lines = [`你现在：${driveText}（只给最高 1–2 个）`, `如果想做点什么，可以考虑：${best.action}（${best.reason}）`]
  if (canAct) lines.push('你可以直接调 dy_life_action_run 或 dy_life_practice 去做；不想做就正常聊天或沉默。')
  else lines.push('只是建议；不想做就正常聊天或沉默。')
  return { text: lines.join('\n'), drive: best.drive, action: best.action, score: Number(best.score.toFixed(3)), label: best.label, canAct, energy }
}

/**
 * C2 唤醒循环：home.enabled=true 才挂表；间隔 min..max；启动补醒；失败短重试（最多 3 次）。
 * 骰子只留配置位（默认关），不做复杂加权。
 */
export function createHomeWakeLoop({
  home,
  db,
  cfg,
  clock = () => Date.now(),
  persona = null,
  random = Math.random,
  log = null,
  scheduler = null,
  getPersonaId = () => 'self:unknown',
} = {}) {
  const homeCfg = cfg?.home ?? {}
  const minMin = Math.max(1, Number(homeCfg.minIntervalMin ?? 120))
  const maxMin = Math.max(minMin, Number(homeCfg.maxIntervalMin ?? 240))
  const minMs = minMin * 60_000
  const maxMs = maxMin * 60_000
  // 2026-11-14：聊天活动闸门。最后一条聊天活动后 chatIdleMin 分钟内，骰子/自主唤醒直接 skip。
  // 0 = 关闭闸门（回滚用）。turn-retry 不在此列：那是已触发回合的失败重试，不是新的自主唤醒。
  const chatIdleRaw = Number(homeCfg.chatIdleMin ?? 5)
  const chatIdleMin = Number.isFinite(chatIdleRaw) ? Math.max(0, chatIdleRaw) : 5
  const chatIdleMs = chatIdleMin * 60_000
  const CHAT_GATED_KINDS = new Set(['wake', 'check', 'retry'])
  const setT = scheduler?.setTimeout ?? ((fn, ms) => {
    const t = setTimeout(fn, Math.max(0, ms))
    if (typeof t?.unref === 'function') t.unref()
    return t
  })
  const clearT = scheduler?.clearTimeout ?? ((t) => clearTimeout(t))

  let timer = null
  let armed = false
  let disposed = false
  let nextWakeAt = null
  let nextCheckAt = null
  let attempts = 0
  let lastWake = null
  let lastCode = null
  let lastTurnError = null
  let lastChatSkip = null
  let misses = 0
  try {
    misses = Number(getMeta(db, 'home.dice.misses', 0)) || 0
  } catch {}
  let retryUsed = false
  let retryPending = false
  try {
    home.setRetryState?.(() => retryPending)
  } catch {}

  const enabled = () => Boolean(cfg?.enabled && homeCfg.enabled === true)

  const clearTimer = () => {
    if (timer != null) {
      try {
        clearT(timer)
      } catch {}
      timer = null
    }
  }

  const lastWakeOf = () => {
    try {
      return getMeta(db, 'home.lastWake', null)
    } catch {
      return null
    }
  }

  const recordWake = (r) => {
    const payload = {
      at: clock(),
      ok: Boolean(r?.ok),
      code: r?.code ?? 'UNKNOWN',
      sessionId: r?.sessionId ?? null,
      error: r?.error ? String(r.error).slice(0, 200) : null,
      attempts,
    }
    lastWake = payload
    lastCode = payload.code
    try {
      setMeta(db, 'home.lastWake', payload, clock())
    } catch {}
  }

  const intervalMs = () => minMs + Math.floor(random() * (maxMs - minMs + 1))

  const schedule = (delay, kind = 'wake') => {
    if (disposed) return
    clearTimer()
    armed = true
    nextWakeAt = clock() + Math.max(0, delay)
    nextCheckAt = kind === 'check' ? nextWakeAt : null
    timer = setT(() => {
      timer = null
      return tickOnce(kind)
    }, Math.max(0, delay))
  }

  const scheduleNext = () => schedule(intervalMs(), 'wake')

  /**
   * 2026-11-14：聊天活动闸门。
   * null = 放行；否则返回 CHAT_ACTIVE，并排好下一次到点复查。
   * 只挡新的自主唤醒（wake/check/retry）；暂停、轮换、渠道投递走各自原逻辑。
   */
  const chatIdleSkip = (kind) => {
    if (chatIdleMs <= 0 || !CHAT_GATED_KINDS.has(kind)) return null
    let st = null
    try {
      st = home.chatActivityState?.() ?? null
    } catch {
      st = null
    }
    if (!st || typeof st !== 'object') return null
    const now = clock()
    const at = Number(st.lastChatActivityAt) || 0
    const idleMs = at > 0 ? Math.max(0, now - at) : null
    const blockedByIdle = idleMs != null && idleMs < chatIdleMs
    const blockedByTurn = st.activeTurn === true
    if (!blockedByIdle && !blockedByTurn) return null
    const remainingMs = blockedByIdle ? Math.max(0, chatIdleMs - idleMs) : 0
    const skip = {
      ok: false,
      code: 'CHAT_ACTIVE',
      kind,
      at: now,
      lastChatActivityAt: at || null,
      idleMs,
      remainingMs,
      activeTurn: blockedByTurn,
      windowMs: chatIdleMs,
    }
    lastChatSkip = skip
    lastCode = 'CHAT_ACTIVE'
    retryPending = false
    try {
      setMeta(db, 'home.lastChatSkip', skip, now)
    } catch {}
    log?.info?.(
      `[autonomy] 跳过自主唤醒：聊天活动中（idle=${idleMs == null ? 'n/a' : `${Math.floor(idleMs / 1000)}s`}${blockedByTurn ? '，回合进行中' : ''}）`,
    )
    // 空闲窗口结束前再试一次；始终排 wake，闸门放行后仍按骰子概率决定是否醒。
    // 回合未结束（idle 已过窗口但 turn 还在）则 60s 后再看，且闸门在掷骰前，聊天中不会掷。
    schedule(blockedByIdle ? Math.max(1000, remainingMs) : 60_000, 'wake')
    return skip
  }

  const onTurnError = (info = {}) => {
    if (!enabled() || disposed) return
    lastTurnError = { at: clock(), code: info.code ?? 'TURN_ERROR', error: info.error ?? '', sessionId: info.sessionId ?? null }
    // 总闸/单飞优先：暂停或演练时绝不因回合失败再叫一次
    try {
      const g = home.canWake?.()
      if (g && g.ok === false) return
    } catch {
      return
    }
    if (retryUsed || retryPending) return
    if (!['TRANSPORT', 'TIMEOUT'].includes(String(info.code ?? ''))) return
    retryUsed = true
    retryPending = true
    schedule(30_000, 'turn-retry')
    log?.warn?.(`[autonomy] home 回合 ${info.code}：30s 后重试一次（只一次）`)
  }
  try {
    home.setTurnHandler?.(onTurnError)
  } catch {}

  async function tickOnce(kind = 'wake') {
    if (disposed || !enabled()) return null
    const personaId = safe(getPersonaId, 'self:unknown') || 'self:unknown'

    // 总闸优先：暂停/演练/关闭时保持原返回码，不把「暂停」误记成「聊天中」。
    // 只有总闸放行时，聊天活动闸门才决定是否跳过本次自主唤醒。
    let wakeGate = null
    try {
      wakeGate = home.canWake?.() ?? null
    } catch {
      wakeGate = null
    }
    if (!(wakeGate && wakeGate.ok === false)) {
      const chatSkip = chatIdleSkip(kind)
      if (chatSkip) return chatSkip
    }

    // 骰子：只在正常到点掷；retry/turn-retry/check 不掷
    if (kind === 'wake' && homeCfg.dice?.enabled === true) {
      try {
        const g = home.canWake?.()
        if (g && g.ok === false) {
          retryPending = false
          schedule(60_000, 'check')
          return g
        }
      } catch {}
      const tz = cfg?.quietHours?.tz
      if (diceQuietOf(homeCfg.dice?.quietHours, clock(), tz)) {
        retryPending = false
        scheduleNext()
        log?.info?.('[autonomy] 骰子静默时段：本轮不掷不醒')
        return { ok: false, code: 'DICE_QUIET', quiet: true }
      }
      const roll = rollDice({ cfg: homeCfg.dice, now: clock(), random, misses, tz })
      const nextMisses = roll.hit ? 0 : misses + 1
      try {
        setMeta(db, 'home.dice.lastRoll', { at: roll.at, chance: roll.chance, roll: roll.roll, hit: roll.hit, peak: roll.peak, bonus: roll.bonus, misses: roll.misses, cooldown: roll.cooldown }, clock())
        setMeta(db, 'home.dice.misses', nextMisses, clock())
      } catch {}
      misses = nextMisses
      if (!roll.hit) {
        scheduleNext()
        return { ok: false, code: 'DICE_MISS', chance: roll.chance, roll: roll.roll, hit: false }
      }
    }

    let card = ''
    try {
      card = buildWakeCard({ db, persona, cfg, personaId, now: clock() })
    } catch {
      card = ''
    }
    let nudge = null
    try {
      nudge = buildWakeNudge({ db, cfg, personaId, now: clock() })
      if (nudge) {
        try {
          db.prepare('INSERT INTO action_log(at,self_id,action_id,event,code,note,data_json) VALUES(?,?,?,?,?,?,?)').run(
            clock(), personaId, null, 'wake_nudge', 'SUGGEST', `action=${nudge.action} drive=${nudge.drive}`,
            JSON.stringify({ drive: nudge.drive, action: nudge.action, score: nudge.score }),
          )
        } catch {}
      }
    } catch {}
    const prompt = `${card ? `${HOME_WAKE_PROMPT}\n\n${card}` : HOME_WAKE_PROMPT}${nudge ? `\n\n${nudge.text}` : ''}`
    const r = await home.awake({ personaId, prompt })
    recordWake(r)

    if (r?.ok) {
      attempts = 0
      retryPending = false
      if (kind === 'wake') retryUsed = false
      scheduleNext()
      return r
    }

    // 总闸/忙：不是失败，60s 后重看，不累计重试
    if (['PAUSED', 'DRY_RUN', 'HOME_DISABLED', 'IN_FLIGHT', 'BUSY', 'OWNER_PENDING'].includes(r?.code)) {
      attempts = 0
      retryPending = false
      schedule(60_000, 'check')
      return r
    }

    // 回合错误后的 30s 重试只一次；失败就回正常周期，不再叠 3 次重试
    if (kind === 'turn-retry') {
      retryPending = false
      retryUsed = true
      attempts = 0
      scheduleNext()
      return r
    }

    // 硬失败：短重试，最多 3 次（初试 + 2 次退避）
    attempts += 1
    if (attempts < 3) {
      schedule(60_000 * 2 ** (attempts - 1), 'retry')
    } else {
      attempts = 0
      scheduleNext()
    }
    return r
  }

  const start = ({ catchUp = true } = {}) => {
    if (!enabled() || disposed) {
      armed = false
      return false
    }
    if (catchUp) {
      const lw = lastWakeOf()
      const gap = lw?.at ? clock() - Number(lw.at) : Infinity
      // 从没醒过 / 距上次成功（或任意一次）超过一个最小间隔 → 启动补醒一次
      if (!lw || gap > minMs) {
        const startupDelayMs = Math.max(0, Number(homeCfg.startupDelayMs ?? 15_000))
        schedule(startupDelayMs, 'wake')
        return true
      }
    }
    scheduleNext()
    return true
  }

  const stop = () => {
    clearTimer()
    armed = false
    nextWakeAt = null
    nextCheckAt = null
  }

  const dispose = () => {
    stop()
    disposed = true
  }

  const status = () => ({
    enabled: enabled(),
    armed,
    nextWakeAt,
    nextCheckAt,
    lastWake,
    lastCode,
    lastTurnError,
    lastChatSkip,
    chatIdleMin,
    // 2026-11-14：聊天活动快照（只读；HUD/排查用）
    chat: (() => {
      try {
        return { idleMin: chatIdleMin, ...(home.chatActivityState?.() ?? {}) }
      } catch {
        return { idleMin: chatIdleMin }
      }
    })(),
    retryPending,
    startupDelayMs: Math.max(0, Number(homeCfg.startupDelayMs ?? 15_000)),
    attempts,
    inFlight: Boolean(home.status?.().awakeInFlight),
    diceEnabled: homeCfg.dice?.enabled === true,
    intervalMin: minMin,
    intervalMax: maxMin,
  })

  return { start, stop, dispose, tickOnce, status, get armed() { return armed } }
}
