/**
 * dsh-autonomy 配置
 *
 * 口径（阶段 2 冻结）：
 * - enabled 默认 false：装上不会自己动，必须显式开
 * - dryRun 默认 true：就算开了也只记账，不调真实通道
 * - sendEnabled 默认 false：真实外发总闸，阶段 2 永远不开
 *
 * ⚠ 本文件不做 IO，只做「把外部输入洗成确定结构」，方便单测。
 */
import { join } from 'node:path'
import { PLUGIN_WRITE_IDENTITY, isPluginWriteHeader } from './io/identity.js'

// cosmokit 的 volatile 引用标记（dsh-settings 的 .volatile() 字段解析后就是这种只读引用）
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * 把 schemastery `.volatile()` 解析出来的引用还原成普通 JSON 值。
 * cordis 在调用 apply 前会用插件导出的 Config schema 解析 profile 配置，
 * volatile 字段会变成 `{ get() }` 只读引用；loadConfig 是唯一配置读入口，
 * 所以先还原再清洗。对原本就是普通对象的配置零影响。
 */
export function unwrapVolatile(value, seen = new Set()) {
  // 真实的 volatile 引用带 cosmokit 标记；裸 `{ get() }`（单测/手工构造）也认，
  // 因为 JSON/YAML 配置不可能合法地产生「只有 get 函数的普通对象」。
  const isPlain =
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  const isVolatileRef =
    value !== null &&
    typeof value === 'object' &&
    typeof value.get === 'function' &&
    (VOLATILE_WRITE in value || (isPlain && Reflect.ownKeys(value).length === 1))
  if (isVolatileRef) return unwrapVolatile(value.get(), seen)
  if (Array.isArray(value)) {
    if (seen.has(value)) return value
    seen.add(value)
    const out = value.map((item) => unwrapVolatile(item, seen))
    seen.delete(value)
    return out
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    if (seen.has(value)) return value
    seen.add(value)
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = unwrapVolatile(item, seen)
    seen.delete(value)
    return out
  }
  return value
}

export const DEFAULT_DATA_DIR =
  process.env.DSH_AUTONOMY_DIR || '/sdcard/DSHA/生活/数据'

/** 行动目录（与实施方案 §5.1 一致） */
export const KINDS = {
  read_archive: {
    risk: 'low',
    outgoing: false,
    needsModel: false,
    requiresServices: false,
    cost: 0.05,
    noveltyWindowMin: 360,
    caps: { perDay: null, perHour: null, minGapMin: 0 },
    drive: { curiosity: 0.7, social: 0.1, mastery: 0.1, care: 0.1 },
  },
  organize_memory: {
    risk: 'low',
    outgoing: false,
    needsModel: false,
    requiresServices: false,
    cost: 0.05,
    noveltyWindowMin: 720,
    caps: { perDay: null, perHour: null, minGapMin: 0 },
    drive: { curiosity: 0.1, social: 0.1, mastery: 0.6, care: 0.2 },
  },
  write_diary: {
    risk: 'low',
    outgoing: false,
    needsModel: true,
    requiresServices: true,
    cost: 0.2,
    noveltyWindowMin: 1440,
    caps: { perDay: null, perHour: null, minGapMin: 0 },
    drive: { curiosity: 0.3, social: 0.1, mastery: 0.4, care: 0.2 },
  },
  find_sticker: {
    risk: 'low',
    outgoing: false,
    needsModel: true,
    requiresServices: true,
    cost: 0.2,
    noveltyWindowMin: 720,
    caps: { perDay: null, perHour: null, minGapMin: 0 },
    drive: { curiosity: 0.4, social: 0.6, mastery: 0, care: 0 },
  },
  browse_douyin: {
    risk: 'medium',
    outgoing: false,
    needsModel: false,
    requiresServices: true,
    cost: 0.35,
    noveltyWindowMin: 240,
    caps: { perDay: null, perHour: null, minGapMin: 0 },
    drive: { curiosity: 0.8, social: 0.2, mastery: 0, care: 0 },
  },
  send_qq: {
    risk: 'high',
    outgoing: true,
    requiresEvidence: true, // F10：外发必须有真实来源，否则不许发
    needsModel: true,
    requiresServices: true,
    cost: 0.5,
    noveltyWindowMin: 1440,
    caps: { perDay: null, perHour: null, minGapMin: 0 },
    drive: { curiosity: 0, social: 0.7, mastery: 0, care: 0.3 },
  },
}

export const KNOWN_KINDS = Object.keys(KINDS)

/** 只认目录里真实存在的 kind（防 `__proto__`/`constructor` 这类原型链名字混进来） */
export const isKnownKind = (kind) => typeof kind === 'string' && Object.hasOwn(KINDS, kind)

export const DEFAULTS = {
  enabled: false,
  pauseAll: false,
  // 主人 16:26：tick 独立开关；false 时 home 不受影响
  tick: { enabled: true },
  // 邮件通道（凭据只从 envFile 读，不落代码/日志/状态）
  mail: {
    enabled: true,
    envFile: '/opt/qqai/run/mail.env',
    pollSeconds: 300,
    maxPerHour: 0, // 0 = 不限
    minGapSec: 0, // 0 = 不限
    maxBody: 8000,
    // 公开仓库不写死真实主人邮箱；生产在 profile 的 autonomy.config.mail.ownerAddresses 配置
    ownerAddresses: [],
    replyHint: false,
    attachmentDir: '/sdcard/DSHA/渠道/email/附件',
  },
  dryRun: true,
  // home 永久档案导出+备份调度：默认关闭；启用/部署必须由负责人另行授权。
  homeArchiveMaintenance: {
    enabled: false,
    intervalDays: 15,
    pollMinutes: 60,
    retryCount: 1,
    retryDelayMs: 5000,
    exportScript: '/root/.dsh/plugin-src/dsh-memory-core/scripts/export-home-archive.mjs',
    memoryDbPath: '/sdcard/DSHA/记忆/数据/memory.db',
    homeCwd: '/sdcard/DSHA/生活/数据/home',
    archiveRoot: '/sdcard/DSHA/记忆/档案/永久',
    backupDir: '/sdcard/DSHA/备份',
  },
  sendEnabled: false,
  tickMinutes: 10,
  minTickGapMinutes: 5,
  tickTimeoutMs: 60_000,
  leaseSec: 90,
  allowedKinds: ['read_archive', 'organize_memory'],
  // D-007：安静时段默认取消（保留配置位）
  quietHours: { enabled: false, start: '23:30', end: '08:00', tz: 'Asia/Shanghai' },
  ownerActiveWindowMin: 30,
  ownerActiveEnabled: false, // D-007：主人在场跳过默认关闭
  // D-007：唯一保留的防刷屏
  antiSpam: { enabled: true, sameKindMinGapMin: 10, perHour: 20, perDay: 200 },
  urge: { thetaLow: 0, thetaHigh: 0.62, delta: 0.08 }, // D-007：thetaLow 不再当硬闸
  model: { maxPerTick: 1, dailyCap: null }, // D-007：默认不限
  backoff: { baseSec: 60, factor: 2, capSec: 21_600 },
  circuit: { fails: 3, openMinutes: 360 },
  // 反思触发器（阶段 3：只记账，不调模型；正文阶段 4 生成）
  // pendingTtlHours：pending 超过这个时长还没被消费就作废（expired），否则会永久挡住后续反思
  reflect: { importanceThreshold: 12, minGapHours: 20, dailyMinActions: 3, pendingTtlHours: 24 },
  // 她自己的家（C1：默认关；只有 enabled=true 才允许建/唤醒）
  drives: { extended: false },
  purpose: { enabled: false, bonus: 0.08, intervalMin: 60 },
  // 2026-11-13：外部事件触发（默认关；目前只有文件 mtime，屏幕/通知要 Android 权限）
  triggers: {
    enabled: false,
    files: [],
    intervalSec: 120,
    minGapMin: 10,
    // 2026-11-13：屏幕/通知类触发（无障碍 dump 轮询；默认关，开启有唤醒频率）
    notification: { enabled: false, endpoint: 'http://127.0.0.1:3091', intervalSec: 5, minGapSec: 10, maxItems: 3, seedOnStart: true, webPrimary: false, webHealthyMs: 300000, maxAgeSec: 600, allowPackages: ['com.ss.android.ugc.aweme', 'com.ss.android.ugc.aweme.lite'] },
    device: { enabled: false, endpoint: 'http://127.0.0.1:3090', headersFile: '/root/.dsh/.bridge_headers', intervalSec: 60, minGapMin: 30, excludeApps: ['dsh.android.client'] },
  },
  home: {
    enabled: false,
    cwd: '/sdcard/DSHA/生活/数据/home',
    minIntervalMin: 120,
    maxIntervalMin: 240,
    respectDryRun: true,
    startupDelayMs: 15_000,
    // 2026-11-14：聊天活动闸门——最后一条 user/assistant 消息（或入站投递）后，
    // 至少空闲这么多分钟才允许骰子/自主唤醒；0 = 关闭闸门（回滚用）。
    chatIdleMin: 5,
    agentPreset: 'standard',
    deliveryQueueMax: 50,
    nudge: { enabled: true, minDrive: 0.6, goalBonus: 0.15, actionThreshold: 0.75, cooldownMin: 30 },
    deliveryTimeoutMin: 10,
    drainRetryMs: 3000,
    deliverLog: '/sdcard/DSHA/生活/数据/home/deliver.log',
    logPath: '/sdcard/DSHA/生活/数据/logs/autonomy.log',
    // 骰子唤醒（按 11-02 设计重建；默认关）
    dice: {
      enabled: false,
      baseChance: 0.55,
      bonusPerMiss: 0.15,
      maxBonus: 0.45,
      peakHours: [
        [9, 12],
        [14, 18],
      ],
      peakChanceDelta: -0.15,
      quietHours: { enabled: false, start: '00:00', end: '08:00', tz: 'Asia/Shanghai' },
    },
    // C3：650k 计量与轮换（2026-11-12 主人定；1M 窗口下 0.62≈650k）
    contextLimit: 650_000,
    rotateRatio: 0.62,
    // C3b：回合结束后延迟多久量一次（毫秒；0=立即，给宿主落盘留时间默认 1.5s）
    turnRotateDelayMs: 1_500,
    handoffMaxItems: 50,
    handoffMaxChars: 12_000,
    handoffBriefMaxChars: 1200,
  },
  // 2026-11-14：抖音私信/互动消息路由（默认关；开了才订阅/轮询 dmWatch）
  // 主人 → home.deliver；其他联系人 → 统一一个抖音会话（总接待室；自动回复按事件 conversationId 回各自私信）
  douyinInbox: {
    enabled: false,
    mode: 'auto', // auto=优先订阅、退回轮询；subscribe=只订阅；poll=只轮询
    pollMs: 3000,
    attachRetryMs: 5000,
    cwd: '/sdcard/DSHA/渠道/douyin', // 统一会话 cwd（固定；不再按联系人拆子目录）
    cwdRoot: '/sdcard/DSHA', // cwd 白名单根（同 channel-bridge ensureCwd 口径）
    agentPreset: '', // 空 = 用宿主默认预设（与 home 配置口径一致）
    denyTools: [], // 可选：会话里裁掉的工具名（同 QQ 的 tools.restrict deny）
    limit: 20,
    maxSeen: 1000,
    skipFromMe: true, // 她自己用 web 发出的消息（fromMe）不投递
    respectDryRun: true, // dryRun 时不建会话（不花模型调用）
    // 2026-11-14：非主人自动回复（回合结束把最后一段 assistant 文本按各事件 conversationId 发回）
    reply: {
      enabled: true, // 只影响非主人；owner 永远只进 home
      maxChars: 500, // dmSend 文本上限 1–500
      timeoutMs: 180_000, // 回合迟迟不结束：超时不发、不重试
      pollMs: 1000, // push 事件漏收时扫 agent.session.log 的兜底间隔
    },
    // 2026-11-14：通知事件源（dyDouyin.notifyWatchSubscribe/notifyWatchStatus）
    // owner 通知 → home；其他 → 统一会话；**只投递/提示，不自动回复**
    notify: { enabled: true },
  },
  // owner-only 工具（C3）：除她的家以外，允许的主人目录前缀
  owner: { privateDirs: [] },
  // B3 手动行动：只读档案/表情包目录
  archiveDir: '/sdcard/DSHA/记忆/档案',
  practiceDir: '/sdcard/DSHA/生活/数据/学习',
  practice: { curiosityThreshold: 0.6, energyMin: 0.3, selfDailyCap: 4, defaultEnergy: 0.6 },
  archiveRecentDays: 7,
  rawDir: '/sdcard/DSHA/记忆/数据/raw',
  stickerDirs: ['/sdcard/DSHA/表情包', '/sdcard/DSHA/生活/数据/stickers', '/sdcard/Pictures/表情包'],
  caps: {}, // 覆盖 KINDS[kind].caps 用，空表示全用目录默认
  weights: {
    drive: 0.45,
    goal: 0.25,
    novelty: 0.2,
    cost: 0.15,
    risk: 0.3,
    repeat: 0.25,
  },
  ownerSignal: { selfObserve: true },
  // 外发白名单（F9）：空数组 = 禁止一切外发。阶段 3 没有真实发送，这里只做判据。
  outgoing: { ownerAllowlist: [] },
  log: { includeText: false },
}

const num = (v, def, min, max) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, n))
}
const bool = (v, def) => (typeof v === 'boolean' ? v : def)
const str = (v, def) => (typeof v === 'string' && v.trim() ? v.trim() : def)

/** "HH:MM" -> 一天中的分钟数；非法返回 null */
export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

export function loadConfig(raw = {}, env = process.env) {
  raw = unwrapVolatile(raw)
  const dataDir = str(raw.dataDir, str(env.DSH_AUTONOMY_DIR, DEFAULT_DATA_DIR))
  const allowed = Array.isArray(raw.allowedKinds)
    ? raw.allowedKinds.filter((k) => KNOWN_KINDS.includes(k))
    : [...DEFAULTS.allowedKinds]

  const quietStart = str(raw?.quietHours?.start, DEFAULTS.quietHours.start)
  const quietEnd = str(raw?.quietHours?.end, DEFAULTS.quietHours.end)

  const cfg = {
    dataDir,
    dbPath: str(raw.dbPath, join(dataDir, 'autonomy.db')),
    enabled: bool(raw.enabled, DEFAULTS.enabled),
    pauseAll: bool(raw?.pauseAll, DEFAULTS.pauseAll),
    tick: { enabled: bool(raw?.tick?.enabled, DEFAULTS.tick.enabled), realSafe: bool(raw?.tick?.realSafe, DEFAULTS.tick.realSafe) },
    drives: { extended: bool(raw?.drives?.extended, DEFAULTS.drives.extended) },
    purpose: { enabled: bool(raw?.purpose?.enabled, DEFAULTS.purpose.enabled), bonus: num(raw?.purpose?.bonus, DEFAULTS.purpose.bonus, 0, 0.5), intervalMin: num(raw?.purpose?.intervalMin, DEFAULTS.purpose.intervalMin, 10, 1440) },
    triggers: {
      enabled: bool(raw?.triggers?.enabled, DEFAULTS.triggers.enabled),
      files: Array.isArray(raw?.triggers?.files) ? raw.triggers.files.map(String).filter(Boolean) : [...DEFAULTS.triggers.files],
      intervalSec: num(raw?.triggers?.intervalSec, DEFAULTS.triggers.intervalSec, 10, 3600),
      minGapMin: num(raw?.triggers?.minGapMin, DEFAULTS.triggers.minGapMin, 1, 1440),
      notification: {
        enabled: bool(raw?.triggers?.notification?.enabled, DEFAULTS.triggers.notification.enabled),
        endpoint: str(raw?.triggers?.notification?.endpoint, DEFAULTS.triggers.notification.endpoint),
        intervalSec: num(raw?.triggers?.notification?.intervalSec, DEFAULTS.triggers.notification.intervalSec, 2, 60),
        minGapSec: num(raw?.triggers?.notification?.minGapSec, DEFAULTS.triggers.notification.minGapSec, 3, 600),
        maxItems: num(raw?.triggers?.notification?.maxItems, DEFAULTS.triggers.notification.maxItems, 1, 10),
        allowPackages: Array.isArray(raw?.triggers?.notification?.allowPackages) ? raw.triggers.notification.allowPackages.map(String) : [...DEFAULTS.triggers.notification.allowPackages],
        webPrimary: bool(raw?.triggers?.notification?.webPrimary, DEFAULTS.triggers.notification.webPrimary),
        webHealthyMs: num(raw?.triggers?.notification?.webHealthyMs, DEFAULTS.triggers.notification.webHealthyMs, 60_000, 24 * 60 * 60 * 1000),
        maxAgeSec: num(raw?.triggers?.notification?.maxAgeSec, DEFAULTS.triggers.notification.maxAgeSec, 60, 24 * 60 * 60),
      },
      device: {
        enabled: bool(raw?.triggers?.device?.enabled, DEFAULTS.triggers.device.enabled),
        endpoint: str(raw?.triggers?.device?.endpoint, DEFAULTS.triggers.device.endpoint),
        headersFile: str(raw?.triggers?.device?.headersFile, DEFAULTS.triggers.device.headersFile),
        intervalSec: num(raw?.triggers?.device?.intervalSec, DEFAULTS.triggers.device.intervalSec, 15, 3600),
        minGapMin: num(raw?.triggers?.device?.minGapMin, DEFAULTS.triggers.device.minGapMin, 1, 1440),
        excludeApps: Array.isArray(raw?.triggers?.device?.excludeApps) ? raw.triggers.device.excludeApps.map(String) : [...DEFAULTS.triggers.device.excludeApps],
      },
    },
    mail: {
      enabled: bool(raw?.mail?.enabled, DEFAULTS.mail.enabled),
      envFile: str(raw?.mail?.envFile, DEFAULTS.mail.envFile),
      pollSeconds: num(raw?.mail?.pollSeconds, DEFAULTS.mail.pollSeconds, 30, 3600),
      maxPerHour: num(raw?.mail?.maxPerHour, DEFAULTS.mail.maxPerHour, 0, 1000),
      minGapSec: num(raw?.mail?.minGapSec, DEFAULTS.mail.minGapSec, 0, 3600),
      maxBody: num(raw?.mail?.maxBody, DEFAULTS.mail.maxBody, 100, 8000),
      replyHint: bool(raw?.mail?.replyHint, DEFAULTS.mail.replyHint),
      attachmentDir: str(raw?.mail?.attachmentDir, DEFAULTS.mail.attachmentDir),
      ownerAddresses: Array.isArray(raw?.mail?.ownerAddresses) ? raw.mail.ownerAddresses.map((a) => String(a ?? '').trim().toLowerCase()).filter(Boolean) : [...DEFAULTS.mail.ownerAddresses],
    },
    dryRun: bool(raw.dryRun, DEFAULTS.dryRun),
    homeArchiveMaintenance: {
      enabled: bool(raw?.homeArchiveMaintenance?.enabled, DEFAULTS.homeArchiveMaintenance.enabled),
      intervalDays: 15,
      pollMinutes: num(raw?.homeArchiveMaintenance?.pollMinutes, DEFAULTS.homeArchiveMaintenance.pollMinutes, 5, 1440),
      retryCount: num(raw?.homeArchiveMaintenance?.retryCount, DEFAULTS.homeArchiveMaintenance.retryCount, 0, 2),
      retryDelayMs: num(raw?.homeArchiveMaintenance?.retryDelayMs, DEFAULTS.homeArchiveMaintenance.retryDelayMs, 1000, 60000),
      exportScript: str(raw?.homeArchiveMaintenance?.exportScript, DEFAULTS.homeArchiveMaintenance.exportScript),
      memoryDbPath: str(raw?.homeArchiveMaintenance?.memoryDbPath, DEFAULTS.homeArchiveMaintenance.memoryDbPath),
      homeCwd: str(raw?.homeArchiveMaintenance?.homeCwd, DEFAULTS.homeArchiveMaintenance.homeCwd),
      archiveRoot: str(raw?.homeArchiveMaintenance?.archiveRoot, DEFAULTS.homeArchiveMaintenance.archiveRoot),
      backupDir: str(raw?.homeArchiveMaintenance?.backupDir, DEFAULTS.homeArchiveMaintenance.backupDir),
    },
    sendEnabled: bool(raw.sendEnabled, DEFAULTS.sendEnabled),
    tickMinutes: num(raw.tickMinutes, DEFAULTS.tickMinutes, 1, 240),
    minTickGapMinutes: num(raw.minTickGapMinutes, DEFAULTS.minTickGapMinutes, 0, 240),
    tickTimeoutMs: num(raw.tickTimeoutMs, DEFAULTS.tickTimeoutMs, 1_000, 600_000),
    leaseSec: num(raw.leaseSec, DEFAULTS.leaseSec, 10, 3_600),
    allowedKinds: allowed.length ? allowed : [...DEFAULTS.allowedKinds],
    quietHours: {
      enabled: bool(raw?.quietHours?.enabled, DEFAULTS.quietHours.enabled),
      start: quietStart,
      end: quietEnd,
      tz: str(raw?.quietHours?.tz, DEFAULTS.quietHours.tz),
    },
    ownerActiveEnabled: bool(raw?.ownerActiveEnabled, DEFAULTS.ownerActiveEnabled),
    antiSpam: {
      enabled: bool(raw?.antiSpam?.enabled, DEFAULTS.antiSpam.enabled),
      sameKindMinGapMin: num(raw?.antiSpam?.sameKindMinGapMin, DEFAULTS.antiSpam.sameKindMinGapMin, 0, 10_000),
      perHour: num(raw?.antiSpam?.perHour, DEFAULTS.antiSpam.perHour, 0, 100_000),
      perDay: num(raw?.antiSpam?.perDay, DEFAULTS.antiSpam.perDay, 0, 1_000_000),
    },
    ownerActiveWindowMin: num(raw.ownerActiveWindowMin, DEFAULTS.ownerActiveWindowMin, 0, 1_440),
    urge: {
      thetaLow: num(raw?.urge?.thetaLow, DEFAULTS.urge.thetaLow, 0, 1),
      thetaHigh: num(raw?.urge?.thetaHigh, DEFAULTS.urge.thetaHigh, 0, 1),
      delta: num(raw?.urge?.delta, DEFAULTS.urge.delta, 0, 1),
    },
    model: {
      maxPerTick: num(raw?.model?.maxPerTick, DEFAULTS.model.maxPerTick, 0, 10),
      dailyCap:
        raw?.model?.dailyCap == null
          ? DEFAULTS.model.dailyCap
          : num(raw?.model?.dailyCap, DEFAULTS.model.dailyCap, 0, 10_000),
    },
    backoff: {
      baseSec: num(raw?.backoff?.baseSec, DEFAULTS.backoff.baseSec, 1, 3_600),
      factor: num(raw?.backoff?.factor, DEFAULTS.backoff.factor, 1, 10),
      capSec: num(raw?.backoff?.capSec, DEFAULTS.backoff.capSec, 60, 86_400),
    },
    circuit: {
      fails: num(raw?.circuit?.fails, DEFAULTS.circuit.fails, 1, 100),
      openMinutes: num(raw?.circuit?.openMinutes, DEFAULTS.circuit.openMinutes, 1, 10_080),
    },
    reflect: {
      importanceThreshold: num(raw?.reflect?.importanceThreshold, DEFAULTS.reflect.importanceThreshold, 1, 1_000),
      minGapHours: num(raw?.reflect?.minGapHours, DEFAULTS.reflect.minGapHours, 1, 720),
      dailyMinActions: num(raw?.reflect?.dailyMinActions, DEFAULTS.reflect.dailyMinActions, 1, 100),
      pendingTtlHours: num(raw?.reflect?.pendingTtlHours, DEFAULTS.reflect.pendingTtlHours, 1, 720),
    },
    home: (() => {
      const min = num(raw?.home?.minIntervalMin, DEFAULTS.home.minIntervalMin, 15, 1_440)
      const max = num(raw?.home?.maxIntervalMin, DEFAULTS.home.maxIntervalMin, 15, 1_440)
      return {
        enabled: bool(raw?.home?.enabled, DEFAULTS.home.enabled),
        cwd: str(raw?.home?.cwd, DEFAULTS.home.cwd),
        minIntervalMin: Math.min(min, max),
        maxIntervalMin: Math.max(min, max),
        respectDryRun: bool(raw?.home?.respectDryRun, DEFAULTS.home.respectDryRun),
        startupDelayMs: num(raw?.home?.startupDelayMs, DEFAULTS.home.startupDelayMs, 0, 300_000),
        // 0 = 关闭聊天活动闸门；默认 5 分钟
        chatIdleMin: num(raw?.home?.chatIdleMin, DEFAULTS.home.chatIdleMin, 0, 1440),
        agentPreset: typeof raw?.home?.agentPreset === 'string' ? raw.home.agentPreset.trim() : DEFAULTS.home.agentPreset,
        deliveryQueueMax: num(raw?.home?.deliveryQueueMax, DEFAULTS.home.deliveryQueueMax, 1, 500),
        nudge: {
          enabled: bool(raw?.home?.nudge?.enabled, DEFAULTS.home.nudge.enabled),
          minDrive: num(raw?.home?.nudge?.minDrive, DEFAULTS.home.nudge.minDrive, 0, 1),
          goalBonus: num(raw?.home?.nudge?.goalBonus, DEFAULTS.home.nudge.goalBonus, 0, 1),
          actionThreshold: num(raw?.home?.nudge?.actionThreshold, DEFAULTS.home.nudge.actionThreshold, 0, 1),
          cooldownMin: num(raw?.home?.nudge?.cooldownMin, DEFAULTS.home.nudge.cooldownMin, 0, 1440),
        },
        deliveryTimeoutMin: num(raw?.home?.deliveryTimeoutMin, DEFAULTS.home.deliveryTimeoutMin, 1, 1440),
        drainRetryMs: num(raw?.home?.drainRetryMs, DEFAULTS.home.drainRetryMs, 10, 5000),
        deliverLog: str(raw?.home?.deliverLog, DEFAULTS.home.deliverLog),
        logPath: str(raw?.home?.logPath, DEFAULTS.home.logPath),
        dice: (() => {
          const d = raw?.home?.dice ?? {}
          const peak = Array.isArray(d.peakHours)
            ? d.peakHours
                .filter((p) => Array.isArray(p) && p.length === 2)
                .map(([a, b]) => [Number(a), Number(b)])
                .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b <= 24 && a < b)
            : [...DEFAULTS.home.dice.peakHours]
          return {
            enabled: bool(d.enabled, DEFAULTS.home.dice.enabled),
            baseChance: num(d.baseChance, DEFAULTS.home.dice.baseChance, 0, 1),
            bonusPerMiss: num(d.bonusPerMiss, DEFAULTS.home.dice.bonusPerMiss, 0, 1),
            maxBonus: num(d.maxBonus, DEFAULTS.home.dice.maxBonus, 0, 1),
            peakHours: peak,
            peakChanceDelta: num(d.peakChanceDelta, DEFAULTS.home.dice.peakChanceDelta, -1, 1),
            quietHours: (() => {
              const q = d.quietHours ?? {}
              const start = str(q.start, DEFAULTS.home.dice.quietHours.start)
              const end = str(q.end, DEFAULTS.home.dice.quietHours.end)
              const valid = parseHHMM(start) != null && parseHHMM(end) != null && parseHHMM(start) !== parseHHMM(end)
              return {
                enabled: valid ? bool(q.enabled, DEFAULTS.home.dice.quietHours.enabled) : false,
                start,
                end,
                tz: str(q.tz, DEFAULTS.home.dice.quietHours.tz),
              }
            })(),
          }
        })(),
        contextLimit: num(raw?.home?.contextLimit, DEFAULTS.home.contextLimit, 1_000, 10_000_000),
        rotateRatio: num(raw?.home?.rotateRatio, DEFAULTS.home.rotateRatio, 0.05, 1),
        turnRotateDelayMs: num(raw?.home?.turnRotateDelayMs, DEFAULTS.home.turnRotateDelayMs, 0, 60_000),
        handoffMaxItems: num(raw?.home?.handoffMaxItems, DEFAULTS.home.handoffMaxItems, 1, 200),
        handoffMaxChars: num(raw?.home?.handoffMaxChars, DEFAULTS.home.handoffMaxChars, 500, 50_000),
        handoffBriefMaxChars: num(raw?.home?.handoffBriefMaxChars, DEFAULTS.home.handoffBriefMaxChars, 100, 5000),
      }
    })(),
    // 2026-11-14：抖音私信/互动消息路由（见 lib/run/douyin-inbox.js）
    douyinInbox: (() => {
      const d = raw?.douyinInbox ?? {}
      const mode = ['auto', 'subscribe', 'poll'].includes(String(d.mode)) ? String(d.mode) : DEFAULTS.douyinInbox.mode
      return {
        enabled: bool(d.enabled, DEFAULTS.douyinInbox.enabled),
        mode,
        pollMs: num(d.pollMs, DEFAULTS.douyinInbox.pollMs, 1000, 300_000),
        attachRetryMs: num(d.attachRetryMs, DEFAULTS.douyinInbox.attachRetryMs, 1000, 600_000),
        cwd: str(d.cwd, DEFAULTS.douyinInbox.cwd),
        cwdRoot: str(d.cwdRoot, DEFAULTS.douyinInbox.cwdRoot),
        agentPreset: typeof d.agentPreset === 'string' ? d.agentPreset.trim() : DEFAULTS.douyinInbox.agentPreset,
        denyTools: Array.isArray(d.denyTools) ? d.denyTools.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 50) : [...DEFAULTS.douyinInbox.denyTools],
        limit: num(d.limit, DEFAULTS.douyinInbox.limit, 1, 100),
        maxSeen: num(d.maxSeen, DEFAULTS.douyinInbox.maxSeen, 50, 5000),
        skipFromMe: bool(d.skipFromMe, DEFAULTS.douyinInbox.skipFromMe),
        respectDryRun: bool(d.respectDryRun, DEFAULTS.douyinInbox.respectDryRun),
        reply: {
          enabled: bool(d?.reply?.enabled, DEFAULTS.douyinInbox.reply.enabled),
          maxChars: num(d?.reply?.maxChars, DEFAULTS.douyinInbox.reply.maxChars, 1, 500),
          timeoutMs: num(d?.reply?.timeoutMs, DEFAULTS.douyinInbox.reply.timeoutMs, 10_000, 1_800_000),
          pollMs: num(d?.reply?.pollMs, DEFAULTS.douyinInbox.reply.pollMs, 200, 60_000),
        },
        notify: {
          enabled: bool(d?.notify?.enabled, DEFAULTS.douyinInbox.notify.enabled),
        },
      }
    })(),
    archiveDir: str(raw.archiveDir, DEFAULTS.archiveDir),
    practiceDir: str(raw.practiceDir, DEFAULTS.practiceDir),
    practice: {
      curiosityThreshold: num(raw?.practice?.curiosityThreshold, DEFAULTS.practice.curiosityThreshold, 0, 1),
      energyMin: num(raw?.practice?.energyMin, DEFAULTS.practice.energyMin, 0, 1),
      selfDailyCap: num(raw?.practice?.selfDailyCap, DEFAULTS.practice.selfDailyCap, 1, 20),
      defaultEnergy: num(raw?.practice?.defaultEnergy, DEFAULTS.practice.defaultEnergy, 0, 1),
    },
    archiveRecentDays: num(raw.archiveRecentDays, DEFAULTS.archiveRecentDays, 1, 90),
    rawDir: str(raw.rawDir, DEFAULTS.rawDir),
    stickerDirs: Array.isArray(raw.stickerDirs) ? raw.stickerDirs.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 10) : [...DEFAULTS.stickerDirs],
    owner: {
      privateDirs: Array.isArray(raw?.owner?.privateDirs)
        ? raw.owner.privateDirs.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 20)
        : [...DEFAULTS.owner.privateDirs],
    },
    caps: raw?.caps && typeof raw.caps === 'object' ? raw.caps : {},
    weights: { ...DEFAULTS.weights },
    ownerSignal: { selfObserve: bool(raw?.ownerSignal?.selfObserve, true) },
    outgoing: {
      ownerAllowlist: Array.isArray(raw?.outgoing?.ownerAllowlist)
        ? raw.outgoing.ownerAllowlist.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 20)
        : [...DEFAULTS.outgoing.ownerAllowlist],
    },
  // 写身份（契约 v1.2 §5.1）：默认就是白名单里的 {origin:'plugin',plugin:'dsh-autonomy'}。
  // 配错/配成用户会话 header 会被复位，绝不伪造。显式传 null 才关闭（v1.0 兼容调试用）。
  serviceHeader: sanitizeWriteHeader(raw?.serviceHeader),
  // 读身份：契约 v1.2 仍拒绝 plugin 身份读 memory；默认无。将来若要读，由统筹者显式配。
  readServiceHeader: raw?.readServiceHeader && typeof raw.readServiceHeader === 'object' ? { ...raw.readServiceHeader } : null,
    log: { includeText: bool(raw?.log?.includeText, false) },
  }

  // 真实外发必须以「插件启用 + 非 dryRun + sendEnabled」三者同时成立
  if (!cfg.enabled || cfg.dryRun) cfg.sendEnabled = false
  return cfg
}

/** 写身份清洗：只接受契约白名单，其它一律复位为默认写身份 */
export function sanitizeWriteHeader(raw) {
  if (raw === null) return null
  if (!raw || typeof raw !== 'object') return { ...PLUGIN_WRITE_IDENTITY }
  if (!isPluginWriteHeader(raw)) return { ...PLUGIN_WRITE_IDENTITY }
  return { origin: 'plugin', plugin: raw.plugin }
}

/** 合并某个 kind 的 caps（配置可覆盖目录默认） */
export function capsOf(cfg, kind) {
  const base = KINDS[kind]?.caps ?? { perDay: 0, minGapMin: 0 }
  const over = cfg?.caps?.[kind] ?? {}
  const n = (v, def) => (v == null ? def : num(v, def, 0, 1_000_000))
  return {
    perDay: n(over.perDay, base.perDay ?? null),
    perHour: n(over.perHour, base.perHour ?? null),
    minGapMin: n(over.minGapMin, base.minGapMin ?? 0),
  }
}
