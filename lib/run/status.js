/**
 * 状态拼装（给 dy_life_status / GUI 用；只读，不改任何东西）
 */
import { KINDS, capsOf } from '../config.js'
import { pauseActive, circuitState } from '../core/policy.js'
import { loadDrives, toMap } from '../core/drives.js'
import { readPauseState } from '../tools.js'
import { kindStats, recentActions, recentTickRuns } from './actions.js'
import { goalCounts, listGoals } from './goals.js'
import { reflectionState } from './reflect.js'
import { minePurposeSeeds } from '../core/purpose.js'
import { loadPurposeSeeds } from '../core/purpose-store.js'

export function buildStatus({ db, cfg, persona, memory, channel, dbInfo = null, executors = null, selfId = null, mailStatus = null }) {
  const now = Date.now()
  const sid = selfId ?? persona?.selfId?.() ?? 'self:unknown'
  const servicesReady = Boolean(persona?.available && memory?.available)
  const pauseState = readPauseState(db, now)
  const effectiveDryRun = cfg.dryRun || pauseState.dryRunOverride || !servicesReady

  const drives = loadDrives(db, sid, now, { extended: cfg.drives?.extended === true })
  const driveMap = toMap(drives)

  const quotas = {}
  const circuits = []
  for (const kind of cfg.allowedKinds) {
    const stats = kindStats(db, sid, kind, { now, tz: cfg.quietHours?.tz })
    const caps = capsOf(cfg, kind)
    quotas[kind] = {
      doneToday: stats.doneToday,
      perDay: caps.perDay,
      doneThisHour: stats.doneThisHour,
      perHour: caps.perHour || null,
      lastDoneAt: stats.lastDoneAt,
      // B1：演练/模拟单列，不占真实配额也不参与决策
      simulatedToday: stats.simulatedToday,
      simulatedThisHour: stats.simulatedThisHour,
      lastSimulatedAt: stats.lastSimulatedAt,
    }
    const c = circuitState(stats.consecutiveFails, stats.lastFailedAt, cfg.circuit, now)
    if (c.open) circuits.push({ kind, open: true, until: c.until, code: c.code })
  }

  const degraded = []
  if (!persona?.available) degraded.push('persona')
  if (!memory?.available) degraded.push('memory')

  let speakUp = { status: 'unknown' }
  try {
    speakUp = channel?.speakUpConflict?.() ?? { status: 'unknown' }
  } catch {
    speakUp = { status: 'unknown' }
  }

  const suggestion = (() => {
    const cn = { curiosity: '好奇', social: '社交', mastery: '精通', care: '照顾', rest: '休息', approval: '被认可', affiliation: '靠近', rebellion: '反抗', order: '秩序' }
    const top = Object.entries(driveMap).sort((a, b) => Number(b[1]) - Number(a[1]))[0]
    const goal = listGoals(db, sid, { status: 'open', limit: 1 })[0] ?? null
    const last = recentActions(db, sid, 1)[0] ?? null
    const bits = []
    if (top && cn[top[0]]) bits.push(`现在最想${cn[top[0]]}（${Number(top[1]).toFixed(2)}）`)
    if (goal) bits.push(`可以看看目标「${goal.title}」`)
    if (last) bits.push(`上次${last.kind}（${last.status}）`)
    if (!bits.length) return '暂无建议；可以什么都不做。'
    return `${bits.join('；')}。这只是展示，不会自动执行。`
  })()

  // 2026-11-14：Purpose 优先读持久化假设；旧库/未刷新时退回即时候选
  let purpose = []
  try {
    purpose = loadPurposeSeeds(db, sid, 5, now)
    if (!purpose.length) {
      const materials = recentActions(db, sid, 10).map((a) => ({ kind: 'self', title: a.kind, text: a.reason || a.kind, selfRef: true }))
      purpose = minePurposeSeeds({ materials, drives: driveMap, lastMasterAt: 0, limit: 5 })
    }
  } catch {}

  return {
    ok: true,
    selfId: sid,
    stage: channel?.stage ?? 'unknown',
    enabled: cfg.enabled,
    tickEnabled: cfg.tick?.enabled !== false,
    tick: { enabled: cfg.tick?.enabled !== false, last: recentTickRuns(db, sid, 1)[0] ?? null },
    triggers: cfg.triggers ?? null,
    dryRun: effectiveDryRun,
    dryRunReason: effectiveDryRun ? (servicesReady ? 'config' : 'services-missing') : 'off',
    sendEnabled: cfg.sendEnabled,
    services: {
      persona: Boolean(persona?.available),
      memory: Boolean(memory?.available),
      // 只报身份类别，不吐 header 内容（里面可能带会话 id）
      serviceWriteIdentity: cfg.serviceHeader?.origin === 'plugin' ? `plugin:${cfg.serviceHeader.plugin}` : null,
      serviceReadHeaderConfigured: Boolean(cfg.readServiceHeader),
      serviceHeaderConfigured: Boolean(cfg.serviceHeader),
    },
    servicesReady,
    degraded,
    paused: {
      all: pauseState.all,
      allUntil: pauseState.allUntil,
      kinds: pauseState.kinds,
    },
    drives: driveMap,
    goals: {
      ...goalCounts(db, sid),
      top: listGoals(db, sid, { status: 'open', limit: 3 }).map((g) => ({
        id: g.id,
        title: g.title,
        priority: g.priority,
        kind_hint: g.kind_hint,
        status: g.status,
      })),
    },
    reflections: reflectionState(db, sid, cfg, now),
    quotas,
    circuits,
    lastTicks: recentTickRuns(db, sid, 5),
    recentActions: recentActions(db, sid, 5),
    purpose,
    suggestion,
    mail: typeof mailStatus === 'function' ? mailStatus() : { enabled: cfg.mail?.enabled === true, lastPollAt: null, lastInbound: null, lastError: null, uidCursor: 0 },
    allowedKinds: [...cfg.allowedKinds],
    channel: {
      supportsRealChannel: Boolean(channel?.supportsRealChannel?.()),
      speakUp,
      sendEnabled: cfg.sendEnabled,
      // F9：只报白名单条数，不吐目标（目标可能是账号标识）
      ownerAllowlistSize: (cfg.outgoing?.ownerAllowlist ?? []).length,
    },
    executors: executors?.list?.() ?? [],
    quietHours: cfg.quietHours,
    db: dbInfo,
    at: now,
  }
}


