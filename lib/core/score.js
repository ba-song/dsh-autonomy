/**
 * 打分：规则优先（方案 §4.5）
 *
 * score = clamp01(
 *     w.drive * driveAff + w.goal * goalAff + w.novelty * novelty
 *   - w.cost  * cost      - w.risk * riskPen   - w.repeat * repeatPen )
 *
 * 这里只做算术；「能不能做」由 select.js 过滤，「要不要调模型」由 tick 决定。
 */
import { KINDS } from '../config.js'
import { clamp01, MINUTE } from './policy.js'
import { EXTENDED_DRIVE } from './drives.js'

// 说明：方案 §4.5 写的是 high=1.0，但实测该值会让 send_qq 的分数上限只有 0.275，
// 永远低于 thetaLow=0.35 —— 等于「高风险行动永远选不中」，政策门形同虚设。
// 这里改成 medium=0.2 / high=0.5：仍然显著压低，但驱动力很高时选得中，
// 再由 allowedKinds / sendEnabled / 证据门去兜底。变更写进变更说明。
export const RISK_PENALTY = { low: 0, medium: 0.2, high: 0.5 }

export const DEFAULT_WEIGHTS = {
  drive: 0.45,
  goal: 0.25,
  novelty: 0.2,
  cost: 0.15,
  risk: 0.3,
  repeat: 0.25,
}

/** 该 kind 对四个驱动力的加权亲和度（0..1） */
export function driveAffinity(kind, driveMap = {}) {
  const extended = 'rest' in driveMap || 'affiliation' in driveMap || 'order' in driveMap
  const spec = extended && EXTENDED_DRIVE[kind] ? EXTENDED_DRIVE[kind] : KINDS[kind]?.drive
  if (!spec) return 0
  let sum = 0
  let total = 0
  for (const [name, w] of Object.entries(spec)) {
    const weight = Number(w) || 0
    sum += weight * Number(driveMap[name] ?? 0)
    total += weight
  }
  // 目录里四个权重之和都是 1；万一以后调成别的和，按比例归一到 0..1
  return total > 0 ? clamp01(sum / total) : 0
}

/** 新鲜度：距上次做越久越高；从没做过 = 1 */
export function noveltyOf(lastDoneAt, now, windowMin) {
  if (!lastDoneAt) return 1
  const window = Math.max(1, Number(windowMin) || 360)
  return clamp01((now - Number(lastDoneAt)) / (window * MINUTE))
}

/**
 * 重复惩罚：
 * - **失败不在这里罚**：失败的治理交给 select 的退避窗口 + 熔断（时间精确、可测）；
 *   这里再罚一次会让「刚失败过」直接够不到阈值，退避/熔断永远跑不到（实测踩过）。
 * - 成功做过 → 按「近期程度」最多 0.3，避免同一件事连着刷。
 */
export function repeatPenaltyOf({ lastDoneAt, lastFailedAt }, now) {
  if (lastFailedAt && now - Number(lastFailedAt) < 2 * 60 * MINUTE) return 0
  if (!lastDoneAt) return 0
  const specWindow = 6 * 60 // 兜底窗口
  const novelty = noveltyOf(lastDoneAt, now, specWindow)
  return 0.3 * (1 - novelty)
}

/**
 * 单个 kind 打分。
 * @returns {{score:number, parts:object}}
 */
export function scoreKind({ kind, driveMap, goalAffinity = 0, stats = {}, now = Date.now(), weights = DEFAULT_WEIGHTS }) {
  const spec = KINDS[kind]
  if (!spec) return { score: 0, parts: { unknownKind: true } }
  const w = { ...DEFAULT_WEIGHTS, ...(weights ?? {}) }

  const driveAff = driveAffinity(kind, driveMap)
  const novelty = noveltyOf(stats.lastDoneAt, now, spec.noveltyWindowMin)
  const cost = Number(spec.cost ?? 0)
  const riskPen = RISK_PENALTY[spec.risk] ?? 0.4
  const repeatPen = repeatPenaltyOf(stats, now)

  const raw =
    w.drive * driveAff +
    w.goal * clamp01(goalAffinity) +
    w.novelty * novelty -
    w.cost * cost -
    w.risk * riskPen -
    w.repeat * repeatPen

  const parts = {
    driveAffinity: round(driveAff),
    goalAffinity: round(clamp01(goalAffinity)),
    novelty: round(novelty),
    cost,
    riskPenalty: riskPen,
    repeatPenalty: round(repeatPen),
    raw: round(raw),
  }
  return { score: clamp01(raw), parts }
}

/** 排序：分数降序；并列时按目录顺序（稳定） */
export function rankCandidates(scored) {
  return [...scored].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.kind.localeCompare(b.kind)
  })
}

/** 是否属于「边界歧义」：前两名都过线且差距小于 delta */
export function isTieBreak(ranked, cfg = {}) {
  const theta = Number(cfg?.urge?.thetaLow ?? 0.35)
  const delta = Number(cfg?.urge?.delta ?? 0.08)
  if (ranked.length < 2) return false
  const [a, b] = ranked
  return a.score >= theta && b.score >= theta && a.score - b.score < delta
}

const round = (x) => Math.round(Number(x) * 1000) / 1000
