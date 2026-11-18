/**
 * 候选过滤（纯函数）
 *
 * 顺序即优先级：白名单 → 服务依赖 → 暂停 → 熔断 → 配额 → 冷却 → 退避。
 * 每条被挡掉的都要带 code，tick 才能写出一句「为什么没动」。
 */
import { KINDS, capsOf } from '../config.js'
import { backoffMs, circuitState, gapSatisfied } from './policy.js'

/**
 * @param {object} args
 * @param {object} args.cfg
 * @param {boolean} args.servicesReady
 * @param {number} args.now
 * @param {(kind:string)=>{lastDoneAt:number|null,lastFailedAt:number|null,consecutiveFails:number,doneToday:number,doneThisHour:number}} args.statsOf
 * @param {(kind:string)=>object|null} args.pauseOf
 * @param {()=>number} args.random
 */
export function buildCandidates({ cfg, servicesReady, now, statsOf, pauseOf = () => null, random = Math.random }) {
  const candidates = []
  const blocked = []

  for (const kind of cfg.allowedKinds ?? []) {
    const spec = KINDS[kind]
    if (!spec) {
      blocked.push({ kind, code: 'UNKNOWN_KIND' })
      continue
    }
    if (spec.requiresServices && !servicesReady) {
      blocked.push({ kind, code: 'NEEDS_SERVICES' })
      continue
    }
    if (pauseOf(kind)) {
      blocked.push({ kind, code: 'PAUSED_KIND' })
      continue
    }

    const stats = statsOf(kind)
    const circuit = circuitState(stats.consecutiveFails, stats.lastFailedAt, cfg.circuit, now)
    if (circuit.open) {
      blocked.push({ kind, code: 'CIRCUIT_OPEN', until: circuit.until })
      continue
    }

    const anti = cfg.antiSpam ?? {}
    if (anti.enabled !== false) {
      if (Number(anti.perHour) > 0 && Number(stats.allDoneThisHour ?? 0) >= Number(anti.perHour)) {
        blocked.push({ kind, code: 'RATE_LIMIT_HOUR', done: stats.allDoneThisHour, cap: anti.perHour })
        continue
      }
      if (Number(anti.perDay) > 0 && Number(stats.allDoneToday ?? 0) >= Number(anti.perDay)) {
        blocked.push({ kind, code: 'RATE_LIMIT_DAY', done: stats.allDoneToday, cap: anti.perDay })
        continue
      }
    }
    const caps = capsOf(cfg, kind)
    if (caps.perDay && stats.doneToday >= caps.perDay) {
      blocked.push({ kind, code: 'DAILY_CAP', done: stats.doneToday, cap: caps.perDay })
      continue
    }
    if (caps.perHour && stats.doneThisHour >= caps.perHour) {
      blocked.push({ kind, code: 'HOURLY_CAP', done: stats.doneThisHour, cap: caps.perHour })
      continue
    }
    if (!gapSatisfied(stats.lastDoneAt, now, caps.minGapMin)) {
      blocked.push({ kind, code: 'MIN_GAP', cap: caps.minGapMin })
      continue
    }
    // D-007 防刷屏：同 kind 默认 10 分钟最多 1 次（可配）
    if (Number(anti.sameKindMinGapMin) > 0 && !gapSatisfied(stats.lastDoneAt, now, Number(anti.sameKindMinGapMin))) {
      blocked.push({ kind, code: 'MIN_GAP', cap: anti.sameKindMinGapMin })
      continue
    }

    if (stats.consecutiveFails > 0 && stats.lastFailedAt) {
      const wait = backoffMs(stats.consecutiveFails, cfg.backoff, random)
      if (now - stats.lastFailedAt < wait) {
        blocked.push({ kind, code: 'BACKOFF', waitMs: wait })
        continue
      }
    }

    candidates.push({ kind, spec })
  }

  return { candidates, blocked }
}

/** open goals 里指向该 kind 的最高优先级（0..1）；没有就是 0 */
export function goalAffinityOf(kind, goals = []) {
  let best = 0
  for (const g of goals) {
    if (g?.status !== 'open' && g?.status !== 'doing') continue
    if (g?.kind_hint && g.kind_hint !== kind) continue
    const p = Number(g?.priority ?? 0)
    if (p > best) best = p
  }
  return best
}

/**
 * 全部被挡时，给一个最有信息量的原因码（而不是笼统的 NO_CANDIDATE）。
 * 顺序 = 越「人工干预能解决」的越靠前。
 */
export function dominantBlockCode(blocked = []) {
  const order = [
    'PAUSED_KIND',
    'CIRCUIT_OPEN',
    'RATE_LIMIT_HOUR',
    'RATE_LIMIT_DAY',
    'BACKOFF',
    'DAILY_CAP',
    'HOURLY_CAP',
    'MIN_GAP',
    'NEEDS_SERVICES',
    'UNKNOWN_KIND',
  ]
  for (const code of order) if (blocked.some((b) => b.code === code)) return code
  return 'NO_CANDIDATE'
}
