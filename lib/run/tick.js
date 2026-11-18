/**
 * tick 状态机（方案 §4.2 / §4.3）
 *
 * 硬规矩（阶段 2 就生效，不靠以后补）：
 * 1. 单飞：同一时刻只跑一个 tick；重叠的直接 IN_FLIGHT
 * 2. 不补跑：只看 last_tick_at，错过多少都不补
 * 3. 审计先行：action 先写 planned，再改 running，再做
 * 4. 租约：running 带 lease_until，过期回收成 failed(stale_lease)
 * 5. 失败退避（full jitter）+ 连续失败熔断
 * 6. 暂停/降级：暂停从 meta 读（重启不丢）；服务不全 → 只 dry_run
 * 7. 任何异常都不许抛给宿主：tick 自己兜底并落一条 failed 的 tick_runs
 */
import { KINDS, capsOf } from '../config.js'
import { MINUTE, HOUR, DAY, pauseActive, inQuietHours, backoffMs, dayStartInTz } from '../core/policy.js'
import { loadDrives, saveDrives, advanceDrives, applyOutcome, toMap } from '../core/drives.js'
import { minePurposeSeeds, NEED_TO_KIND } from '../core/purpose.js'
import { loadPurposeSeeds } from '../core/purpose-store.js'
import { scoreKind, rankCandidates } from '../core/score.js'
import { buildCandidates, goalAffinityOf, dominantBlockCode } from '../core/select.js'
import { getMeta, setMeta } from '../store/db.js'
import { maybeMarkReflection } from './reflect.js'
import {
  appendLog,
  appendTickRun,
  createAction,
  markRunning,
  finishAction,
  abortAction,
  recoverStale,
  hasLiveRunning,
  kindStats,
  newActionId,
} from './actions.js'

function withTimeout(promise, ms) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true }), ms)
    if (typeof timer?.unref === 'function') timer.unref()
  })
  return Promise.race([Promise.resolve(promise).catch((e) => ({ __error: e })), timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export function createTick({
  db,
  getCfg,
  clock = () => Date.now(),
  random = Math.random,
  executors,
  persona,
  memory,
  channel,
  log = null,
  selfIdFallback = 'self:unknown',
  now,
}) {
  const cfgOf = typeof getCfg === 'function' ? getCfg : () => getCfg
  const nowOf = typeof now === 'function' ? now : clock
  let inFlight = false

  function resolveSelfId() {
    try {
      return persona?.selfId?.() || selfIdFallback
    } catch {
      return selfIdFallback
    }
  }

  function recordTick({ at, selfId, trigger, outcome, code = null, topKind = null, topScore = null, modelCalls = 0, durationMs = null, note = null }) {
    try {
      appendTickRun(db, { at, selfId, trigger, outcome, code, topKind, topScore, modelCalls, durationMs, note })
    } catch (e) {
      log?.warn?.(`[autonomy] tick_runs 写入失败：${e?.message ?? e}`)
    }
  }

  function skip({ at, selfId, trigger, started, code, outcome = 'skipped', top = null, note = null, blocked = null }) {
    recordTick({
      at,
      selfId,
      trigger,
      outcome,
      code,
      topKind: top?.kind ?? null,
      topScore: top?.score ?? null,
      durationMs: nowOf() - started,
      note: note ?? (blocked?.length ? `blocked=${blocked.map((b) => `${b.kind}:${b.code}`).join(',')}` : null),
    })
    try {
      appendLog(db, { at, selfId, event: 'skip', code, note, data: top ? { kind: top.kind, score: top.score } : null })
    } catch {
      /* 审计失败也不能让 tick 崩 */
    }
    return { outcome, code, kind: top?.kind ?? null, score: top?.score ?? null, modelCalls: 0 }
  }

  async function runOnce({ trigger, started }) {
    const cfg = cfgOf()
    const selfId = resolveSelfId()
    const at = nowOf()

    // ── 门 0：tick 独立开关（false 时零写入，home 不受影响） ──
    if (cfg.tick?.enabled === false) {
      return { outcome: 'disabled', code: 'TICK_DISABLED', modelCalls: 0 }
    }

    // ── 门 1：插件启用 ───────────────────────────────
    if (!cfg.enabled) {
      return skip({ at, selfId, trigger, started, code: 'DISABLED', outcome: 'disabled' })
    }

    // ── 门 2：全局暂停（持久化在 meta） ──────────────
    if (pauseActive(getMeta(db, 'pause.all', null), at)) {
      return skip({ at, selfId, trigger, started, code: 'PAUSED' })
    }

    // ── 门 3：单飞（第二道保险：未过期的 running） ────
    if (hasLiveRunning(db, { now: at, selfId })) {
      return skip({ at, selfId, trigger, started, code: 'IN_FLIGHT' })
    }

    // ── 门 4：tick 间隔（错过就跳过，不补跑） ────────
    const last = Number(getMeta(db, 'last_tick_at', null)?.at ?? 0)
    if (last && at - last < cfg.minTickGapMinutes * MINUTE) {
      return skip({ at, selfId, trigger, started, code: 'TICK_GAP' })
    }

    // 过了门 4：立刻记下这次 tick，防重入/防补跑
    setMeta(db, 'last_tick_at', { at }, at)

    // 阶段 3：只记「该反思了」，不生成正文（模型留到阶段 4）
    const markReflection = () => {
      try {
        maybeMarkReflection(db, { selfId, cfg, now: nowOf() })
      } catch {
        /* 记账失败不影响 tick */
      }
    }

    // 回收悬挂（进程被杀后留下的 running）
    try {
      recoverStale(db, { now: at, selfId })
    } catch (e) {
      log?.warn?.(`[autonomy] 悬挂回收失败：${e?.message ?? e}`)
    }

    // ── 驱动力推进（纯算术） ─────────────────────────
    let drives = loadDrives(db, selfId, at, { extended: cfg.drives?.extended === true })
    drives = advanceDrives(drives, at)
    try {
      saveDrives(db, selfId, drives)
    } catch (e) {
      log?.warn?.(`[autonomy] 驱动力落库失败：${e?.message ?? e}`)
    }

    markReflection()

    const servicesReady = Boolean(persona?.available && memory?.available)
    // dry_run 三源：配置、暂停工具写的 override、服务不全（服务不全时强制 dry_run）
    const dryOverride = getMeta(db, 'dry_run', null)?.on === true
    const effectiveDryRun = cfg.dryRun || dryOverride || !servicesReady
    const degraded = []
    if (!persona?.available) degraded.push('persona')
    if (!memory?.available) degraded.push('memory')
    if (!channel?.supportsRealChannel?.()) degraded.push('channel')

    // ── 候选过滤 ─────────────────────────────────────
    const kindPauses = getMeta(db, 'pause.kinds', {}) ?? {}
    const statsCache = new Map()
    const statsOf = (kind) => {
      if (!statsCache.has(kind)) {
        statsCache.set(kind, kindStats(db, selfId, kind, { now: at, tz: cfg.quietHours?.tz }))
      }
      return statsCache.get(kind)
    }

    const { candidates, blocked } = buildCandidates({
      cfg,
      servicesReady,
      now: at,
      statsOf,
      pauseOf: (kind) => (pauseActive(kindPauses?.[kind], at) ? kindPauses[kind] : null),
      random,
    })

    if (!candidates.length) {
      return skip({ at, selfId, trigger, started, code: dominantBlockCode(blocked), blocked })
    }

    // ── 打分 ─────────────────────────────────────────
    const openGoals = db
      .prepare(`SELECT id, priority, kind_hint, status FROM goals WHERE self_id=? AND status IN ('open','doing')`)
      .all(selfId)
    const driveMap = toMap(drives)
    // 2026-11-13：Purpose Engine shadow/可选加分（默认关；不改变默认行为）
    let purposeSeeds = []
    try {
      if (cfg.purpose?.enabled === true) {
        purposeSeeds = loadPurposeSeeds(db, selfId, 5, at)
        if (!purposeSeeds.length) {
          const materials = openGoals.map((g) => ({ kind: 'self', title: g.kind_hint || g.title || '目标', text: String(g.title || g.note || ''), selfRef: true }))
          purposeSeeds = minePurposeSeeds({ materials, drives: driveMap, limit: 5 })
        }
      }
    } catch {}
    const purposeKinds = new Set(purposeSeeds.map((s) => NEED_TO_KIND[s.need]).filter(Boolean))
    const purposeBonus = Math.max(0, Math.min(1, Number(cfg.purpose?.bonus ?? 0.08)))
    const scored = candidates.map(({ kind }) => {
      const stats = statsOf(kind)
      const goalAffinity = goalAffinityOf(kind, openGoals)
      const base = scoreKind({ kind, driveMap, goalAffinity, stats, now: at, weights: cfg.weights })
      const purpose = purposeKinds.has(kind) ? purposeBonus : 0
      return { kind, score: Math.min(1, base.score + purpose), parts: { ...base.parts, purpose }, stats, goalAffinity }
    })
    const ranked = rankCandidates(scored)
    const top = ranked[0]

    if (top.score < cfg.urge.thetaLow) {
      return skip({ at, selfId, trigger, started, code: 'LOW_URGE', top, blocked })
    }

    // ── 门 5/6：外发类专属（安静时段 / 主人正在说话） ─
    const spec = KINDS[top.kind]
    if (spec.outgoing) {
      // F9-a 白名单：没配允许的外发目标 = 一律不发（默认空）
      const allow = cfg.outgoing?.ownerAllowlist ?? []
      if (!allow.length) {
        return skip({ at, selfId, trigger, started, code: 'NO_ALLOWLIST', top, note: 'ownerAllowlist 为空：禁止一切外发' })
      }
      // F2/F9-b 安静时段
      if (cfg.quietHours?.enabled === true && inQuietHours(at, cfg.quietHours)) {
        return skip({ at, selfId, trigger, started, code: 'QUIET_HOURS', top })
      }
      const lastUser = cfg.ownerActiveEnabled === true ? (memory?.lastUserMessageAt?.() ?? null) : null
      const ownerActive = cfg.ownerActiveEnabled === true && (lastUser == null || at - lastUser < cfg.ownerActiveWindowMin * MINUTE)
      if (ownerActive) {
        return skip({ at, selfId, trigger, started, code: 'OWNER_ACTIVE', top, note: lastUser == null ? '无 owner 信号：保守跳过' : null })
      }
    }

    // ── 门 9：模型预算（阶段 2 没有模型调用，先把门留住） ─
    const modelCallsToday = countModelCallsToday(db, selfId, at, cfg.quietHours?.tz)
    if (spec.needsModel && cfg.model.dailyCap != null && modelCallsToday >= cfg.model.dailyCap) {
      appendLog(db, { at, selfId, event: 'skip', code: 'MODEL_BUDGET', note: `today=${modelCallsToday}` })
      recordTick({ at, selfId, trigger, outcome: 'skipped', code: 'MODEL_BUDGET', topKind: top.kind, topScore: top.score, durationMs: nowOf() - started })
      return { outcome: 'skipped', code: 'MODEL_BUDGET', kind: top.kind, score: top.score, modelCalls: 0 }
    }

    // ── 审计先行：先写 planned ───────────────────────
    const actionId = newActionId()
    const reason = buildReason(top, {
      displayName: persona?.displayName?.() ?? null,
      degraded,
    })
    const chosenGoal = openGoals.find((g) => g.kind_hint && g.kind_hint === top.kind) ?? openGoals.find((g) => !g.kind_hint) ?? null
    const decision = {
      score: top.score,
      parts: top.parts,
      topKind: top.kind,
      ranked: ranked.slice(0, 5).map((r) => ({ kind: r.kind, score: Math.round(r.score * 1000) / 1000 })),
      blocked,
      thetaLow: cfg.urge.thetaLow,
      dryRun: effectiveDryRun,
      servicesReady,
      degraded,
      goalId: chosenGoal?.id ?? null,
      purpose: purposeSeeds.slice(0, 5),
    }
    createAction(db, {
      id: actionId,
      selfId,
      kind: top.kind,
      goalId: chosenGoal?.id ?? null,
      risk: spec.risk,
      reason,
      decision,
      evidence: null,
      costEstimate: spec.cost,
      importance: 1 + (spec.needsModel ? 2 : 0) + (spec.risk === 'high' ? 2 : 0),
      now: at,
    })
    appendLog(db, { at, selfId, actionId, event: 'select', code: 'OK', note: reason, data: decision })

    // ── 高风险真实执行的政策闸 ───────────────────────
    if (spec.risk === 'high' && !effectiveDryRun && !cfg.sendEnabled) {
      abortAction(db, actionId, { code: 'SEND_DISABLED', now: at })
      appendLog(db, { at, selfId, actionId, event: 'skip', code: 'SEND_DISABLED' })
      recordTick({ at, selfId, trigger, outcome: 'skipped', code: 'SEND_DISABLED', topKind: top.kind, topScore: top.score, durationMs: nowOf() - started })
      return { outcome: 'skipped', code: 'SEND_DISABLED', kind: top.kind, score: top.score, actionId, modelCalls: 0 }
    }

    if (!executors?.has?.(top.kind)) {
      abortAction(db, actionId, { code: 'NO_EXECUTOR', now: at })
      appendLog(db, { at, selfId, actionId, event: 'skip', code: 'NO_EXECUTOR' })
      recordTick({ at, selfId, trigger, outcome: 'skipped', code: 'NO_EXECUTOR', topKind: top.kind, topScore: top.score, durationMs: nowOf() - started })
      return { outcome: 'skipped', code: 'NO_EXECUTOR', kind: top.kind, score: top.score, actionId, modelCalls: 0 }
    }

    // ── dry_run：决策照做，执行器不调 ────────────────
    if (effectiveDryRun) {
      markRunning(db, actionId, { leaseUntil: at + cfg.leaseSec * 1000, now: at })
      finishAction(db, actionId, { ok: true, result: { dryRun: true, simulated: true, kind: top.kind }, now: at })
      appendLog(db, { at, selfId, actionId, event: 'dry_run', code: 'DRY_RUN', note: reason })
      markReflection()
      recordTick({ at, selfId, trigger, outcome: 'ran', code: 'DRY_RUN', topKind: top.kind, topScore: top.score, durationMs: nowOf() - started })
      return { outcome: 'ran', code: 'DRY_RUN', kind: top.kind, score: top.score, actionId, modelCalls: 0 }
    }

    // ── 真执行（阶段 3 也只有 mock executor） ────────
    markRunning(db, actionId, { leaseUntil: at + cfg.leaseSec * 1000, now: at })
    const entry = executors.entry?.(top.kind) ?? null
    const execCtx = {
      selfId,
      actionId,
      kind: top.kind,
      dryRun: effectiveDryRun,
      now: at,
      deps: { persona, memory, channel, cfg },
      timeoutMs: cfg.tickTimeoutMs,
    }
    let out
    try {
      if (entry?.twoPhase) {
        // 两段式（F10 正解）：prepare 生成内容 + 证据 → 证据够了才 deliver
        const prepared = await withTimeout(entry.fn.prepare(execCtx), cfg.tickTimeoutMs)
        if (prepared?.__timeout) {
          out = { __timeout: true }
        } else if (prepared?.__error || prepared?.ok !== true) {
          out = { ok: false, error: prepared?.__error?.message ?? prepared?.error ?? 'prepare 失败' }
        } else {
          const evidence = Array.isArray(prepared.evidence) ? prepared.evidence : []
          if (spec.requiresEvidence && evidence.length === 0) {
            out = { ok: false, error: 'NO_EVIDENCE', evidence: [], __noEvidence: true }
          } else {
            const delivered = await withTimeout(entry.fn.deliver(execCtx, { content: prepared.content, evidence }), cfg.tickTimeoutMs)
            out = delivered?.__timeout ? { __timeout: true } : { ...(delivered ?? { ok: false }), evidence }
          }
        }
      } else {
        out = await withTimeout(entry?.fn?.(execCtx), cfg.tickTimeoutMs)
      }
    } catch (e) {
      out = { __error: e }
    }

    const doneAt = nowOf()

    // F10：prepare 没给证据 → 直接失败，**deliver 一次都没调**
    if (out?.__noEvidence) {
      finishAction(db, actionId, { ok: false, error: 'NO_EVIDENCE', evidence: [], now: doneAt })
      appendLog(db, { at: doneAt, selfId, actionId, event: 'fail', code: 'NO_EVIDENCE', note: 'prepare 未给出证据，未 deliver' })
      drives = applyOutcome(drives, top.kind, false)
      saveDrives(db, selfId, drives)
      markReflection()
      recordTick({ at: doneAt, selfId, trigger, outcome: 'failed', code: 'NO_EVIDENCE', topKind: top.kind, topScore: top.score, durationMs: doneAt - started })
      return { outcome: 'failed', code: 'NO_EVIDENCE', kind: top.kind, score: top.score, actionId, modelCalls: 0 }
    }

    if (out?.__timeout) {
      finishAction(db, actionId, { ok: false, error: 'timeout', now: doneAt })
      appendLog(db, { at: doneAt, selfId, actionId, event: 'fail', code: 'TIMEOUT' })
      drives = applyOutcome(drives, top.kind, false)
      saveDrives(db, selfId, drives)
      markReflection()
      recordTick({ at: doneAt, selfId, trigger, outcome: 'failed', code: 'TIMEOUT', topKind: top.kind, topScore: top.score, durationMs: doneAt - started })
      return { outcome: 'failed', code: 'TIMEOUT', kind: top.kind, score: top.score, actionId, modelCalls: 0 }
    }

    if (out?.__error || out?.ok !== true) {
      const msg = String(out?.__error?.message ?? out?.error ?? 'executor 未返回 ok')
      finishAction(db, actionId, { ok: false, error: msg, now: doneAt })
      const wait = backoffMs((statsOf(top.kind).consecutiveFails ?? 0) + 1, cfg.backoff, random)
      appendLog(db, { at: doneAt, selfId, actionId, event: 'fail', code: 'EXECUTOR_FAILED', note: msg, data: { nextRetryInMs: wait } })
      drives = applyOutcome(drives, top.kind, false)
      saveDrives(db, selfId, drives)
      markReflection()
      const modelCallsUsed = Number(out?.modelCalls ?? 0) || 0
      recordTick({ at: doneAt, selfId, trigger, outcome: 'failed', code: 'EXECUTOR_FAILED', topKind: top.kind, topScore: top.score, durationMs: doneAt - started, note: msg, modelCalls: modelCallsUsed })
      return { outcome: 'failed', code: 'EXECUTOR_FAILED', kind: top.kind, score: top.score, actionId, modelCalls: modelCallsUsed }
    }

    // 单段式外发的兜底证据门（正解是两段式，见 F10 用例）；失败也把证据落库
    const evidence = Array.isArray(out.evidence) ? out.evidence : []
    if (spec.outgoing && evidence.length === 0) {
      finishAction(db, actionId, { ok: false, error: 'NO_EVIDENCE', evidence: [], now: doneAt })
      appendLog(db, { at: doneAt, selfId, actionId, event: 'fail', code: 'NO_EVIDENCE' })
      drives = applyOutcome(drives, top.kind, false)
      saveDrives(db, selfId, drives)
      markReflection()
      recordTick({ at: doneAt, selfId, trigger, outcome: 'failed', code: 'NO_EVIDENCE', topKind: top.kind, topScore: top.score, durationMs: doneAt - started })
      return { outcome: 'failed', code: 'NO_EVIDENCE', kind: top.kind, score: top.score, actionId, modelCalls: 0 }
    }

    // ── 成功：写 action / episode / 驱动力 ───────────
    // B4：模拟/演练结果绝不写进真记忆（即使执行器误返回 episodeText）
    const simulatedResult =
      out?.result?.simulated === true || out?.result?.dryRun === true || out?.simulated === true || effectiveDryRun
    let episodeRef = null
    if (out.episodeText && memory?.available && !simulatedResult) {
      try {
        const ep = await memory.addEpisode({
          text: String(out.episodeText).slice(0, 500),
          at: doneAt,
          source: 'autonomy',
          actionId,
        })
        episodeRef = ep?.id ?? null
      } catch {
        episodeRef = null
      }
    }
    finishAction(db, actionId, {
      ok: true,
      result: out.result ?? { ok: true },
      episodeRef,
      evidence,
      now: doneAt,
    })
    appendLog(db, { at: doneAt, selfId, actionId, event: 'done', code: 'OK', note: reason, data: { episodeRef, evidence } })
    drives = applyOutcome(drives, top.kind, true)
    saveDrives(db, selfId, drives)
    markReflection()
    const modelCallsUsed = Number(out?.modelCalls ?? 0) || 0
    recordTick({ at: doneAt, selfId, trigger, outcome: 'ran', code: 'OK', topKind: top.kind, topScore: top.score, durationMs: doneAt - started, modelCalls: modelCallsUsed })

    return { outcome: 'ran', code: 'OK', kind: top.kind, score: top.score, actionId, episodeRef, modelCalls: modelCallsUsed }
  }

  async function tick({ trigger = 'interval' } = {}) {
    const started = nowOf()
    const selfId = resolveSelfId()
    if (inFlight) {
      recordTick({ at: started, selfId, trigger, outcome: 'skipped', code: 'IN_FLIGHT' })
      return { outcome: 'skipped', code: 'IN_FLIGHT', modelCalls: 0 }
    }
    inFlight = true
    try {
      return await runOnce({ trigger, started })
    } catch (e) {
      // 最后一道兜底：tick 永不把异常抛给宿主
      const msg = String(e?.message ?? e)
      log?.warn?.(`[autonomy] tick 异常（已兜底）：${msg}`)
      try {
        recordTick({ at: nowOf(), selfId, trigger, outcome: 'failed', code: 'TICK_EXCEPTION', durationMs: nowOf() - started, note: msg })
        appendLog(db, { at: nowOf(), selfId, event: 'fail', code: 'TICK_EXCEPTION', note: msg })
      } catch {
        /* 审计也失败就只打日志 */
      }
      return { outcome: 'failed', code: 'TICK_EXCEPTION', error: msg, modelCalls: 0 }
    } finally {
      inFlight = false
    }
  }

  return { tick, isBusy: () => inFlight, capsOf: (kind) => capsOf(cfgOf(), kind) }
}

function countModelCallsToday(db, selfId, now, tz) {
  try {
    const start = dayStartInTz(now, tz ?? 'Asia/Shanghai')
    const row = db
      .prepare(`SELECT COALESCE(SUM(model_calls),0) AS n FROM tick_runs WHERE self_id=? AND at>=?`)
      .get(selfId, start)
    return Number(row?.n ?? 0)
  } catch {
    return 0
  }
}

function buildReason(top, { displayName = null, degraded = [] } = {}) {
  const parts = top.parts ?? {}
  const who = displayName ? `${displayName}` : '她'
  const bits = [
    `想在「${top.kind}」上动一下（score=${top.score.toFixed(2)}）`,
    `驱动 ${Number(parts.driveAffinity ?? 0).toFixed(2)}`,
    `新鲜 ${Number(parts.novelty ?? 0).toFixed(2)}`,
  ]
  if (degraded.length) bits.push(`降级 ${degraded.join('/')}`)
  return `${who}${bits.join('，')}`
}

export { buildReason }
