/**
 * dsh-autonomy · 生活插件骨架（阶段 2：只 dry_run + mock）
 *
 * 它决定「汐想做什么、什么时候做」，但**不定义她是谁、不存她的记忆**：
 *   - 人格/情绪只走 dyPersona 服务（缺失就降级，绝不直读 persona.db）
 *   - 记忆只走 dyMemory 服务（缺失就不写 episode、不真实外发）
 *   - 真实通道本版本不存在（io/channel.js 写死 supportsRealChannel=false）
 *
 * 本文件只做装配：配置 → DB → 适配层 → 执行器 → tick → 工具 → 定时器。
 * 具体逻辑在 core/（纯函数）与 run/（副作用）里，方便单测。
 */
import { appendFileSync } from 'node:fs'
import { loadConfig, DEFAULTS } from './config.js'
import { openDb } from './store/db.js'
import { getMeta } from './store/db.js'
import { loadDrives, toMap } from './core/drives.js'
import { minePurposeSeeds } from './core/purpose.js'
import { loadPurposeSeeds, savePurposeSeeds } from './core/purpose-store.js'
import { createPersonaAdapter } from './io/persona.js'
import { createMemoryAdapter } from './io/memory.js'
import { createChannelAdapter } from './io/channel.js'
import { createRegistry, installMockExecutors } from './run/executors.js'
import { createHomeService, createHomeWakeLoop, buildWakeCard, buildWakeNudge, HOME_WAKE_PROMPT } from './run/home.js'
import { createFileTriggers } from './run/triggers.js'
import { createDeviceTriggers } from './run/device-triggers.js'
import { createNotificationTrigger } from './run/notification-trigger.js'
import { createManualActions } from './run/manual-actions.js'
import { createRealExecutors } from './run/real-executors.js'
import { createTick } from './run/tick.js'
import { patchNativeConsentSdk } from './runtime-consent-patch.js'
import { createDouyinInbox } from './run/douyin-inbox.js'
import { buildStatus } from './run/status.js'
import { createMailRunner } from './mail/runner.js'
import { createMailService } from './mail/service.js'
import { createPractice } from './run/practice.js'
import { appendDiary } from './run/diary-append.js'
import { createFileLogger, DEFAULT_AUTONOMY_LOG } from './log-file.js'
import { recordReflection } from './run/reflect.js'
import { createHomeArchiveMaintenance } from './run/home-archive-maintenance.js'
import { registerTools, applyPause, readPauseState } from './tools.js'
import { addGoal, listGoals, closeGoal, goalCounts, getGoal } from './run/goals.js'
import { pauseActive } from './core/policy.js'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-autonomy'

/**
 * 依赖声明（顺序 = cordis 等待顺序）：
 * - tools/timer：工具注册与定时器（timer 拿不到时只保留手动 tick）
 * - dyPersona / dyMemory：persona-core / memory-core 的服务。
 *   必须声明，否则 autonomy 会先于两个 provider apply，适配层创建时拿到 undefined
 *   → services-missing → 整个插件永久 dry_run（2026-11-01 窗口8 已踩过一次）。
 */
export const inject = ['tools', 'timer', 'dyPersona', 'dyMemory']

/**
 * 设置页只认识 Config schema 里标了 `.volatile()` 的字段（dsh-settings 的
 * `volatileForm`/`isVolatilePath`），所以这里只声明设置卡片要读写的 4 个字段：
 *   - enabled
 *   - home.enabled / home.minIntervalMin / home.maxIntervalMin
 * 未声明的键（mail/tick/dryRun/sendEnabled/allowedKinds/home 的 cwd/respectDryRun/
 * agentPreset/rotateRatio/contextLimit/dice 等）走 schemastery 的非 strict 合并原样保留，
 * loadConfig 入口先用 unwrapVolatile 还原 .volatile() 引用，运行时行为不变。
 */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).volatile(),
  pauseAll: z.boolean().default(false).volatile(),
  homeArchiveMaintenance: z.object({
    enabled: z.boolean().default(DEFAULTS.homeArchiveMaintenance.enabled).volatile(),
    pollMinutes: z.number().default(DEFAULTS.homeArchiveMaintenance.pollMinutes).min(5).max(1440).volatile(),
    retryCount: z.number().default(DEFAULTS.homeArchiveMaintenance.retryCount).min(0).max(2).volatile(),
    retryDelayMs: z.number().default(DEFAULTS.homeArchiveMaintenance.retryDelayMs).min(1000).max(60000).volatile(),
    exportScript: z.string().default(DEFAULTS.homeArchiveMaintenance.exportScript).volatile(),
    memoryDbPath: z.string().default(DEFAULTS.homeArchiveMaintenance.memoryDbPath).volatile(),
    homeCwd: z.string().default(DEFAULTS.homeArchiveMaintenance.homeCwd).volatile(),
    archiveRoot: z.string().default(DEFAULTS.homeArchiveMaintenance.archiveRoot).volatile(),
    backupDir: z.string().default(DEFAULTS.homeArchiveMaintenance.backupDir).volatile(),
  }).default({}),
  home: z.object({
    enabled: z.boolean().default(DEFAULTS.home.enabled).volatile(),
    minIntervalMin: z.number().default(DEFAULTS.home.minIntervalMin).min(15).max(1440).volatile(),
    maxIntervalMin: z.number().default(DEFAULTS.home.maxIntervalMin).min(15).max(1440).volatile(),
  }),
  drives: z.object({ extended: z.boolean().default(false).volatile() }).default({}),
  purpose: z.object({ enabled: z.boolean().default(false).volatile(), intervalMin: z.number().default(60) }).default({}),
  triggers: z.object({
    device: z.object({ enabled: z.boolean().default(false).volatile() }).default({}),
    notification: z.object({ enabled: z.boolean().default(false).volatile() }).default({}),
  }).default({}),
})

export function apply(ctx, raw = {}) {
  const cfg = loadConfig(raw)
  const log =
    ctx?.logger && typeof ctx.logger.info === 'function'
      ? ctx.logger
      : { info: (...a) => console.log(...a), warn: (...a) => console.warn(...a) }

  try { patchNativeConsentSdk(log) } catch {}
  const dbInfo = openDb({ dbPath: cfg.dbPath, log })
  const db = dbInfo.db
  // 2026-11-13：设置页总暂停开关；启动时以配置为准（HUD 里的即时按钮仍可在运行时改）
  try {
    const currentPause = getMeta(db, 'pause.all', null)
    if (cfg.pauseAll === true) applyPause(db, { scope: 'all', on: true, by: 'settings' })
    else if (currentPause?.by === 'settings' && currentPause?.on === true) applyPause(db, { scope: 'all', on: false, by: 'settings' })
  } catch {}

  const getSvc = (name) => {
    try {
      return ctx?.get?.(name) ?? null
    } catch {
      return null
    }
  }

  const persona = createPersonaAdapter({ getService: () => getSvc('dyPersona'), log })
  const memory = createMemoryAdapter({
    getService: () => getSvc('dyMemory'),
    log,
    header: cfg.readServiceHeader, // 读身份（默认 null）
    writeHeader: cfg.serviceHeader, // 写专用身份（契约 v1.2）
  })
  const channel = createChannelAdapter({ getService: getSvc })

  const executors = createRegistry({ cfg, log })
  installMockExecutors(executors, { log })

  const clock = typeof raw.clock === 'function' ? raw.clock : () => Date.now()
  const random = typeof raw.random === 'function' ? raw.random : Math.random

  /**
   * 触发式唤醒（文件/屏幕）也带完整上下文卡片（2026-11-14）。
   * 以前这两处只传默认 HOME_WAKE_PROMPT（80 字），醒来没有【现在】【我】【心情】【目标】，
   * 看起来就像"提示词变短了"。卡片与定时唤醒用同一套构建器；失败就回退基础语，不阻断唤醒。
   */
  function wakePromptWithCard(personaId) {
    let card = ''
    try {
      card = buildWakeCard({ db, persona, cfg, personaId, now: clock() })
    } catch {
      card = ''
    }
    let nudge = null
    try {
      nudge = buildWakeNudge({ db, cfg, personaId, now: clock() })
    } catch {
      nudge = null
    }
    return `${card ? `${HOME_WAKE_PROMPT}\n\n${card}` : HOME_WAKE_PROMPT}${nudge ? `\n\n${nudge.text}` : ''}`
  }

  // home 影子会话（C1 骨架：默认关；只有 home.enabled=true 才允许建/唤醒）
  // 2026-11-13：文件触发（默认关）
  let fileTriggers = null
  try {
    if (cfg.triggers?.enabled === true && cfg.triggers.files?.length) {
      fileTriggers = createFileTriggers({
        files: cfg.triggers.files,
        intervalMs: Number(cfg.triggers.intervalSec ?? 120) * 1000,
        minGapMs: Number(cfg.triggers.minGapMin ?? 10) * 60000,
        log,
        onTrigger: async (e) => {
          const gate = home.chatGate?.('file')
          if (gate) { log?.info?.(`[autonomy] 文件触发被聊天闸门挡住：${gate.remainingMs ?? 0}ms`); return }
          const pid = persona.selfId() ?? 'self:unknown'
          try { await home.awake({ personaId: pid, prompt: wakePromptWithCard(pid), reason: `trigger:${e.reason}` }) } catch (err) { log?.warn?.(`[autonomy] 触发唤醒失败：${err?.message ?? err}`) }
        },
      })
      fileTriggers.start()
      log.info?.(`文件触发已启用：${cfg.triggers.files.length} 个文件`)
    }
  } catch (e) { log.warn?.(`[autonomy] 文件触发注册失败：${e?.message ?? e}`) }

  // 默认模型选择器（home / 抖音独立会话共用；11-01 事故后 create/resume 必须带 agentOptions）
  const defaultModelSelection = () => {
    const svc = getSvc('agentDefaultModel')
    try {
      return svc?.currentSelection?.() ?? null
    } catch {
      return null
    }
  }

  const home = createHomeService({
    db,
    cfg,
    getAgents: () => getSvc('agents'),
    getDefaultModel: defaultModelSelection,
    // 与 tick 同源的 dryRun：配置 || dry_run override || 服务缺失
    getDryRun: () => Boolean(cfg.dryRun) || getMeta(db, 'dry_run', null)?.on === true || !(persona.available && memory.available),
    getSessionPersistence: () => getSvc('sessionPersistence'),
    getPresets: () => getSvc('agentPresets'),
    getWorkspaceRegistry: () => getSvc('workspaceRegistry'),
    getPractice: () => practice,
    getSchedule: () => getSvc('schedule'),
    getMemory: () => getSvc('dyMemory'),
    getPersonaId: () => persona.selfId() ?? 'self:unknown',
    clock,
    log,
  })
  // 2026-11-14：抖音私信/互动消息路由
  // 主人 → home.deliver（不另开会话）；其他联系人 → 独立抖音会话（不占 home 上下文）
  // 事件源只读：ctx.get('dyDouyin').dmWatch / dmWatchStatus / dmWatchSubscribe
  // 测试/调试可传 raw.douyinInboxLoop=false 关掉自动订阅（手动 poll 仍可用）
  const douyinInbox = createDouyinInbox({
    db,
    cfg: cfg.douyinInbox,
    getService: () => getSvc('dyDouyin'),
    getHome: () => home,
    getAgents: () => getSvc('agents'),
    getDefaultModel: defaultModelSelection,
    getPresets: () => getSvc('agentPresets'),
    getDryRun: () => Boolean(cfg.dryRun) || getMeta(db, 'dry_run', null)?.on === true || !(persona.available && memory.available),
    clock,
    log,
  })
  // 2026-11-13：屏幕/通知类触发（默认关；依赖 3090 桥的无障碍 dump）
  let deviceTriggers = null
  let notificationTrigger = null
  try { appendFileSync('/sdcard/DSHA/生活/数据/logs/device-trigger.log', `${new Date().toISOString()} ${JSON.stringify({ ev: 'apply', triggers: cfg.triggers })}\n`) } catch {}
  try {
    if (cfg.triggers?.device?.enabled === true) {
      try { appendFileSync('/sdcard/DSHA/生活/数据/logs/device-trigger.log', `${new Date().toISOString()} ${JSON.stringify({ ev: 'branch-enter' })}\n`) } catch {}
      deviceTriggers = createDeviceTriggers({
        cfg: cfg.triggers,
        log,
        onTrigger: async (e) => {
          const gate = home.chatGate?.('device')
          if (gate) { log?.info?.(`[autonomy] 屏幕触发被聊天闸门挡住：${gate.remainingMs ?? 0}ms`); return }
          const pid = persona.selfId() ?? 'self:unknown'
          try { await home.awake({ personaId: pid, prompt: wakePromptWithCard(pid), reason: `trigger:${e.reason}` }) } catch (err) { log?.warn?.(`[autonomy] 屏幕触发唤醒失败：${err?.message ?? err}`) }
        },
      })
      try { appendFileSync('/sdcard/DSHA/生活/数据/logs/device-trigger.log', `${new Date().toISOString()} ${JSON.stringify({ ev: 'created', hasStart: typeof deviceTriggers?.start })}\n`) } catch {}
      deviceTriggers.start()
      try { appendFileSync('/sdcard/DSHA/生活/数据/logs/device-trigger.log', `${new Date().toISOString()} ${JSON.stringify({ ev: 'started' })}\n`) } catch {}
      log.info?.('[autonomy] 屏幕触发已启用（无障碍 dump 轮询）')
    }
  } catch (e) {
    try { appendFileSync('/sdcard/DSHA/生活/数据/logs/device-trigger.log', `${new Date().toISOString()} ${JSON.stringify({ ev: 'create-error', error: String(e?.stack ?? e).slice(0, 600) })}\n`) } catch {}
    log.warn?.(`[autonomy] 屏幕触发注册失败：${e?.message ?? e}`)
  }

      // 2026-11-13：通知转发 App 触发（A2）；默认关，开启后带通知正文唤醒
      try {
        const ncfg = cfg.triggers?.notification || {}
        if (ncfg.enabled === true) {
          notificationTrigger = createNotificationTrigger({
            cfg: ncfg,
            log,
            getWebStatus: () => { try { return ctx?.get?.('dyDouyin')?.notifyStatus?.() ?? null } catch { return null } },
            onNotification: async (e) => {
              const gate = home.chatGate?.('notify')
              if (gate) { log?.info?.(`[autonomy] 通知触发被聊天闸门挡住：${gate.remainingMs ?? 0}ms`); return }
              const r = await home.awake({ personaId: persona.selfId() ?? 'self:unknown', prompt: e.prompt })
              if (!r?.ok) log?.warn?.(`[autonomy] 通知唤醒未成功：${r?.code ?? 'unknown'}`)
            },
          })
          notificationTrigger.start()
          try { appendFileSync('/sdcard/DSHA/生活/数据/logs/notification-trigger.log', `${new Date().toISOString()} ${JSON.stringify({ ev: 'created' })}\n`) } catch {}
        }
      } catch (e) { log?.warn?.(`[autonomy] 通知触发注册失败：${e?.message ?? e}`) }
  // 2026-11-14：Purpose 完整版——每小时从近期 episode/行动提炼目标假设并持久化
  let purposeTimer = null
  const refreshPurpose = async () => {
    try {
      if (cfg.purpose?.enabled !== true) return
      const sid = persona.selfId?.()
      if (!sid) return
      const materials = []
      try {
        const eps = await memory.episodeRecent(7, 20)
        for (const e of eps) {
          const t = String(e?.text ?? e?.summary ?? '').trim()
          if (t) materials.push({ kind: 'memory', title: t.slice(0, 120), text: t, selfRef: true })
        }
      } catch {}
      // 读记忆服务可能因身份权限返回空；至少用她自己的行动/目标做 fallback，保证 purpose 不空转
      try {
        for (const a of db.prepare('SELECT kind,reason FROM actions ORDER BY created_at DESC LIMIT 10').all()) {
          const t = String(a.reason ?? a.kind ?? '').trim()
          if (t) materials.push({ kind: 'action', title: String(a.kind ?? '行动'), text: t, selfRef: false })
        }
        for (const g of db.prepare("SELECT title FROM goals WHERE status IN ('open','doing') ORDER BY priority DESC LIMIT 5").all()) {
          const t = String(g.title ?? '').trim()
          if (t) materials.push({ kind: 'goal', title: '目标', text: t, selfRef: false })
        }
      } catch {}
      const drives = toMap(loadDrives(db, sid, clock(), { extended: cfg.drives?.extended === true }))
      const seeds = minePurposeSeeds({ materials, drives, limit: 10, lastMasterAt: memory.lastUserMessageAt?.() ?? 0 })
      const n = savePurposeSeeds(db, sid, seeds, { now: clock() })
      if (n) log.info?.(`[autonomy] purpose 更新 ${n} 条假设`)
    } catch (e) { log.warn?.(`[autonomy] purpose 刷新失败：${e?.message ?? e}`) }
  }
  if (cfg.purpose?.enabled === true) {
    try {
      const iv = Math.max(10, Number(cfg.purpose?.intervalMin ?? 60)) * 60000
      purposeTimer = setInterval(() => { void refreshPurpose() }, iv)
      purposeTimer.unref?.()
      setTimeout(() => { void refreshPurpose() }, 15000).unref?.()
    } catch {}
  }

  // 2026-11-13：给 HUD/设置页一个手动暂停/恢复入口
  try {
    if (typeof ctx?.provide === 'function') {
      ctx.provide('dyAutonomy', {
        version: 1,
        pause: (opts = {}) => applyPause(db, opts),
        readPause: () => readPauseState(db),
        limits: () => ({ contextLimit: Number(cfg.home?.contextLimit) || 650000, rotateRatio: Number(cfg.home?.rotateRatio) || 0.62 }),
        flags: () => ({ dryRun: Boolean(cfg.dryRun), tickEnabled: cfg.tick?.enabled !== false, purposeEnabled: cfg.purpose?.enabled === true }),
      })
    }
  } catch (e) { log.warn?.(`[autonomy] provide('dyAutonomy') 失败：${e?.message ?? e}`) }
  try {
    if (typeof ctx?.provide === 'function') ctx.provide('dyHome', home.dyHomeService())
    else log.warn?.('[autonomy] ctx.provide 不可用：dyHome 服务未注册')
  } catch (e) {
    log.warn?.(`[autonomy] provide('dyHome') 失败：${e?.message ?? e}`)
  }
  try {
    if (typeof ctx?.provide === 'function') {
      ctx.provide('dyMail', {
        send: (payload) => mail.sendTo(payload),
        reply: (payload) => mail.reply(payload),
        ownerAddresses: () => mail.ownerAddresses(),
      })
    }
  } catch (e) {
    log.warn?.(`[autonomy] provide('dyMail') 失败：${e?.message ?? e}`)
  }

  // C3：宿主 session/event → home 计量（只处理 home_sessions 里的会话，失败不抛）
  // 2026-11-14：抖音独立会话的 assistant 文本 / turn end → 自动回复（QQ auto 标准；只认 replyWatches 里挂过的会话）
  try {
    ctx?.on?.('session/event', (session, event) => {
      try {
        home.observeSessionEvent(session, event)
      } catch {}
      try {
        douyinInbox.observeSessionEvent(session, event)
      } catch {}
    })
  } catch {}

  const manual = createManualActions({ db, cfg, memory, now: clock, random, log })
  // 2026-11-14：主人明确允许三类真实动作；tick.realSafe 时全部换真实执行器，没有服务就 UNAVAILABLE
  if (cfg.tick?.realSafe === true) {
    const real = createRealExecutors({ db, cfg, memory, ctx, getPersonaId: () => persona.selfId() ?? 'self:unknown', clock, log })
    const realKinds = {
      read_archive: async () => manual.execute('read_archive', { text: '' }),
      organize_memory: async () => manual.execute('organize_memory', { text: '' }),
      find_sticker: async () => manual.execute('find_sticker', { text: '' }),
      write_diary: (execCtx) => real.writeDiary(execCtx),
      browse_douyin: (execCtx) => real.browseDouyin(execCtx),
      send_qq: (execCtx) => real.sendQQ(execCtx),
    }
    for (const [kind, fn] of Object.entries(realKinds)) {
      try {
        executors.register(kind, fn, { mock: false })
        log.info?.(`[autonomy] tick 真实执行器：${kind}`)
      } catch (e) { log.warn?.(`[autonomy] tick 真实执行器注册失败 ${kind}：${e?.message ?? e}`) }
    }
  }
  const mailRunner = raw.mailRunner ?? createMailRunner({ envFile: cfg.mail.envFile })
  const mailLog = createFileLogger({ path: cfg.home?.logPath || DEFAULT_AUTONOMY_LOG, now: clock })
  const mail = createMailService({ db, cfg, runner: mailRunner, deliver: (payload) => home.deliver(payload), memory, now: clock, log, fileLog: (level, event, fields) => mailLog.write(level, event, fields) })
  const practice = createPractice({ db, cfg, selfId: persona.selfId() ?? 'self:practice', now: clock, log })

  const ticker = createTick({
    db,
    getCfg: () => cfg,
    clock,
    random,
    executors,
    persona,
    memory,
    channel,
    log,
  })

  let timerDispose = null
  let bootDispose = null
  let homeLoop = null
  let mailTimer = null
  let mailBootTimer = null
  let homeArchiveMaintenanceTimer = null
  const homeArchiveMaintenance = createHomeArchiveMaintenance({ cfg: cfg.homeArchiveMaintenance, db, dataDir: cfg.dataDir, log })

  const api = {
    name: 'dsh-autonomy',
    cfg,
    db,
    dbInfo: { file: dbInfo.file, schemaVersion: dbInfo.schemaVersion, version: dbInfo.version?.() ?? null },

    tick: (opts = {}) => ticker.tick(opts),
    mail,
    practice,
    diaryAppend: (payload) => appendDiary(payload),
    pollMail: () => mail.poll(),
    runHomeArchiveMaintenance: (opts = {}) => homeArchiveMaintenance.runOnce(opts),
    homeArchiveMaintenanceStatus: () => homeArchiveMaintenance.status(),

    status: () => ({
      ...buildStatus({
        db,
        cfg,
        persona,
        memory,
        channel,
        executors,
        mailStatus: () => mail.status(),
        dbInfo: { file: dbInfo.file, schemaVersion: dbInfo.schemaVersion, version: dbInfo.version?.() ?? null },
        selfId: persona.selfId() ?? 'self:unknown',
      }),
      // 2026-11-14：抖音私信路由状态（只读观测；不含消息正文）
      douyinInbox: douyinInbox.status(),
    }),

    pause: (opts) => {
      const out = applyPause(db, opts)
      try {
        db.prepare('INSERT INTO action_log(at, self_id, action_id, event, code, note, data_json) VALUES(?,?,?,?,?,?,?)').run(
          Date.now(),
          persona.selfId() ?? 'self:unknown',
          null,
          'policy',
          `PAUSE_${String(opts?.scope ?? '?').toUpperCase()}`,
          opts?.by ?? 'api',
          JSON.stringify({ on: opts?.on !== false, kind: opts?.kind ?? null, until: opts?.until ?? null }),
        )
      } catch {
        /* 审计失败不影响暂停本身 */
      }
      return out
    },

    // 目标四件套（给工具 / GUI 用）
    addGoal: (opts = {}) => addGoal(db, { selfId: api.selfId(), ...opts }),
    listGoals: (opts = {}) => listGoals(db, api.selfId(), opts),
    closeGoal: (opts = {}) => closeGoal(db, { selfId: api.selfId(), ...opts }),
    getGoal: (id) => getGoal(db, api.selfId(), id),
    goalCounts: () => goalCounts(db, api.selfId()),

    /** 当前 self_id（人格服务缺失时用占位，不伪造） */
    selfId: () => persona.selfId() ?? 'self:unknown',

    registerExecutor: (kind, fn, opts) => executors.register(kind, fn, opts),
    listExecutors: () => executors.list(),

    // home（C1 骨架 + C2 唤醒循环；骰子/自愈在 C3/C4）
    home,
    homeStatus: (personaId = null) => home.status(personaId ?? (persona.selfId() ?? 'self:unknown')),
    // 2026-11-14：手动叫醒（dy_life_home_awake）也带完整上下文卡片，不再只有 80 字默认语
    awakeHome: (opts = {}) => { const pid = (typeof opts?.personaId === 'string' && opts.personaId) ? opts.personaId : (persona.selfId() ?? 'self:unknown'); return home.awake({ ...opts, personaId: pid, prompt: opts?.prompt ?? wakePromptWithCard(pid) }) },
    reflect: (opts = {}) => recordReflection(db, { selfId: persona.selfId() ?? 'self:unknown', ...opts }),
    actionRun: (kind, opts = {}) => manual.run(kind, { selfId: persona.selfId() ?? 'self:unknown', ...opts }),
    homeWakeState: () =>
      homeLoop?.status?.() ?? {
        enabled: Boolean(cfg.enabled && cfg.home.enabled),
        armed: false,
        nextWakeAt: null,
        nextCheckAt: null,
        lastWake: null,
        lastCode: null,
        attempts: 0,
        inFlight: Boolean(home.status?.()?.awakeInFlight),
        diceEnabled: cfg.home?.dice?.enabled === true,
      },
    startHomeLoop,
    stopHomeLoop,

    // 抖音私信路由：实例常驻（构造零 IO），只有 douyinInbox.enabled=true 才自动订阅/轮询
    douyinInbox,
    douyinInboxStatus: () => douyinInbox.status(),
    pollDouyinInbox: (opts = {}) => douyinInbox.pollOnce(opts),
    startDouyinInbox,
    stopDouyinInbox,

    startTimer,
    stopTimer,
    isBusy: () => ticker.isBusy(),
  }

  registerTools({ ctx, api, log })

  // ── 定时器：只有 enabled=true 才挂表（关着就别每 10 分钟写一行 tick_runs） ──
  function startTimer() {
    if (timerDispose) return
    if (!cfg.enabled) {
      log.info?.('[autonomy] 未启用（enabled=false）：不挂定时器')
      return
    }
    if (cfg.homeArchiveMaintenance?.enabled === true && !homeArchiveMaintenanceTimer && typeof ctx?.interval === 'function') {
      const pollMs = Math.max(5, Number(cfg.homeArchiveMaintenance.pollMinutes ?? 60)) * 60_000
      homeArchiveMaintenanceTimer = ctx.interval(() => { void homeArchiveMaintenance.tick().catch((e) => log.warn?.(`[autonomy] 永久档案调度失败：${e?.message ?? e}`)) }, pollMs)
      log.info?.(`[autonomy] home 永久档案导出调度已挂：每 ${pollMs / 60000} 分钟检查一次，成功后间隔 ${cfg.homeArchiveMaintenance.intervalDays} 天`)
    }
    if (cfg.homeArchiveMaintenance?.enabled === true && typeof ctx?.interval !== 'function') {
      log.warn?.('[autonomy] home 永久档案调度未挂：timer 服务不可用，可通过 api.runHomeArchiveMaintenance 手动执行')
    }
    if (cfg.mail?.enabled && !mailTimer) {
      const seconds = Number.isFinite(Number(cfg.mail.pollSeconds)) ? Math.max(30, Number(cfg.mail.pollSeconds)) : 300
      if (typeof ctx?.interval === 'function') {
        mailTimer = ctx.interval(() => { void api.pollMail().catch(() => {}) }, seconds * 1000)
        mailLog.write('info', 'mail_timer', { mounted: true, seconds })
        log.info?.(`[autonomy] mail 轮询已挂：每 ${seconds}s`)
      } else {
        mailLog.write('warn', 'mail_timer', { mounted: false, reason: 'ctx.interval unavailable' })
        log.warn?.('[autonomy] mail：ctx.interval 不可用，需手动 poll')
      }
      // 启动后 5s 先补拉一次（不替代周期轮询）
      if (typeof ctx?.timeout === 'function') {
        try {
          mailBootTimer = ctx.timeout(() => { mailBootTimer = null; void api.pollMail().catch(() => {}) }, 5_000)
          mailLog.write('info', 'mail_timer', { bootPoll: true, afterMs: 5000 })
        } catch {}
      }
    }
    if (cfg.tick?.enabled === false) {
      log.info?.('[autonomy] tick 已单独关闭（tick.enabled=false）：不挂 tick 定时器，home 不受影响')
      return
    }
    if (typeof ctx?.interval !== 'function') {
      log.warn?.('[autonomy] 拿不到 timer 服务：只保留手动 tick(trigger=manual)')
      return
    }
    timerDispose = ctx.interval(() => {
      void api.tick({ trigger: 'interval' }).catch((e) => log.warn?.(`[autonomy] tick 异常：${e?.message ?? e}`))
    }, cfg.tickMinutes * 60_000)
    log.info?.(`[autonomy] 定时器已挂：每 ${cfg.tickMinutes} 分钟`)

    // 插件起来后延迟 60s 跑一次「恢复」tick（只跑一轮，不补跑历史）
    if (typeof ctx.timeout === 'function') {
      try {
        bootDispose = ctx.timeout(() => {
          void api.tick({ trigger: 'resume' }).catch(() => {})
        }, 60_000)
      } catch {
        /* 老版本 timer 没有 timeout 就算了 */
      }
    }
  }

  function stopTimer() {
    if (homeArchiveMaintenanceTimer) { try { homeArchiveMaintenanceTimer() } catch {}; homeArchiveMaintenanceTimer = null }
    if (mailTimer) {
      try { mailTimer() } catch {}
      mailTimer = null
    }
    if (mailBootTimer) {
      try { mailBootTimer() } catch {}
      mailBootTimer = null
    }
    if (timerDispose) {
      try {
        timerDispose()
      } catch {
        /* 已经收走就算了 */
      }
      timerDispose = null
    }
    if (bootDispose) {
      try {
        bootDispose()
      } catch {
        /* 同上 */
      }
      bootDispose = null
    }
    stopHomeLoop()
    stopDouyinInbox()
  }

  startTimer()
  startHomeLoop()
  startDouyinInbox()

  // ── C2 唤醒循环：只有 cfg.enabled + home.enabled 才挂表 ──
  function startHomeLoop() {
    if (homeLoop) return homeLoop
    if (raw.homeLoop === false) {
      log.info?.('[autonomy] home 唤醒循环被 homeLoop=false 关闭（测试/调试用）')
      return null
    }
    if (!cfg.enabled || !cfg.home.enabled) return null
    homeLoop = createHomeWakeLoop({
      home,
      db,
      cfg,
      clock,
      persona,
      random,
      log,
      getPersonaId: () => persona.selfId() ?? 'self:unknown',
    })
    homeLoop.start()
    log.info?.(`[autonomy] home 唤醒循环已挂：${cfg.home.minIntervalMin}–${cfg.home.maxIntervalMin} 分钟`)
    return homeLoop
  }

  function stopHomeLoop() {
    if (homeLoop) {
      try {
        homeLoop.dispose()
      } catch {}
      homeLoop = null
    }
  }

  /** 抖音私信路由：只有「总开关 + douyinInbox.enabled」同时成立才自动挂 */
  function startDouyinInbox() {
    if (raw.douyinInboxLoop === false) {
      log.info?.('[autonomy] 抖音 inbox 循环被 douyinInboxLoop=false 关闭（测试/调试用）')
      return null
    }
    if (!cfg.enabled || cfg.douyinInbox?.enabled !== true) return null
    try {
      const r = douyinInbox.start()
      if (r?.ok) log.info?.('[autonomy] 抖音私信路由已启用（主人→home，其他人→独立会话）')
      return r
    } catch (e) {
      log.warn?.(`[autonomy] 抖音 inbox 启动失败：${e?.message ?? e}`)
      return null
    }
  }

  function stopDouyinInbox() {
    try {
      douyinInbox.stop()
    } catch {}
  }

  // 插件卸载时收表（cordis 通常自己会收，这里显式兜一层）
  try {
    ctx?.on?.('dispose', () => {
      stopTimer()
      stopHomeLoop()
      stopDouyinInbox()
      try { if (purposeTimer) clearInterval(purposeTimer) } catch {}
      try { if (deviceTriggers) deviceTriggers.stop?.() } catch {}
      try { if (notificationTrigger) notificationTrigger.stop?.() } catch {}
      purposeTimer = null
      try {
        home.dispose()
      } catch {}
    })
  } catch {
    /* 事件总线没有也无所谓 */
  }

  const paused = pauseActive(getMeta(db, 'pause.all', null), Date.now())
  log.info?.(
    `[autonomy] 骨架就绪：enabled=${cfg.enabled} dryRun=${cfg.dryRun} paused=${paused} ` +
      `kinds=[${cfg.allowedKinds.join(',')}] services={persona:${persona.available},memory:${memory.available}}`,
  )

  return api
}
