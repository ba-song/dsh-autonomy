/**
 * 反思触发器（纯函数；阶段 3 **不调模型**）
 *
 * 只回答一个问题：现在「该不该记一笔反思待办」。
 * 真正的反思正文留到阶段 4（那时才调模型），本阶段只落一条 pending 记录 + 审计。
 *
 * 触发条件（满足任一）：
 *   1. IMPORTANCE_THRESHOLD：距上次反思以来，已完成/失败行动的 importance 之和 ≥ 阈值
 *   2. DAILY：距上次反思 ≥ 24h（或从没反思过）且窗口内行动数 ≥ dailyMinActions
 *
 * 去重/节流：
 *   - 已有 pending 记录 → 不再堆（避免每个 tick 都记一条）
 *   - 距上次反思 < minGapHours → 不触发
 */
import { HOUR } from './policy.js'

export const REFLECT_TRIGGERS = ['IMPORTANCE_THRESHOLD', 'DAILY']

/**
 * @param {object} args
 * @param {number} args.now
 * @param {object} args.cfg        cfg.reflect
 * @param {Array<{id:string|number, importance:number, created_at:number}>} args.actions 窗口内行动
 * @param {number|null} args.lastReflectionAt
 * @param {boolean} args.hasPending
 * @param {number} [args.windowStart] 窗口起点（默认取上次反思时间或 7 天前）
 * @returns {{trigger:string, importance:number, evidence:string[], windowStart:number, windowEnd:number}|null}
 */
export function decideReflection({ now, cfg = {}, actions = [], lastReflectionAt = null, hasPending = false, windowStart = null }) {
  if (hasPending) return null

  const minGapHours = Number(cfg.minGapHours ?? 20)
  if (lastReflectionAt && now - Number(lastReflectionAt) < minGapHours * HOUR) return null

  const start = Number.isFinite(Number(windowStart))
    ? Number(windowStart)
    : lastReflectionAt
      ? Number(lastReflectionAt)
      : now - 7 * 24 * HOUR

  const list = (actions ?? []).filter((a) => a && Number(a.created_at ?? 0) >= start)
  if (!list.length) return null

  const importance = list.reduce((s, a) => s + Math.max(0, Number(a.importance ?? 0)), 0)
  const evidence = [...list]
    .sort((a, b) => Number(b.importance ?? 0) - Number(a.importance ?? 0) || Number(b.created_at ?? 0) - Number(a.created_at ?? 0))
    .slice(0, 5)
    .map((a) => String(a.id))

  const threshold = Number(cfg.importanceThreshold ?? 12)
  if (importance >= threshold) {
    return { trigger: 'IMPORTANCE_THRESHOLD', importance, evidence, windowStart: start, windowEnd: now }
  }

  const dailyMin = Number(cfg.dailyMinActions ?? 3)
  const sinceLast = lastReflectionAt ? now - Number(lastReflectionAt) : Infinity
  if (sinceLast >= 24 * HOUR && list.length >= dailyMin) {
    return { trigger: 'DAILY', importance, evidence, windowStart: start, windowEnd: now }
  }

  return null
}

/** 给 status / GUI：还差多少 importance 触发 */
export function reflectionProgress({ now, cfg = {}, actions = [], lastReflectionAt = null, hasPending = false, windowStart = null }) {
  const threshold = Number(cfg.importanceThreshold ?? 12)
  const since = Number.isFinite(Number(windowStart))
    ? Number(windowStart)
    : lastReflectionAt
      ? Number(lastReflectionAt)
      : now - 7 * 24 * HOUR
  const list = (actions ?? []).filter((a) => a && Number(a.created_at ?? 0) >= since)
  const importance = list.reduce((s, a) => s + Math.max(0, Number(a.importance ?? 0)), 0)
  return {
    pending: Boolean(hasPending),
    importance,
    threshold,
    remaining: Math.max(0, threshold - importance),
    actions: list.length,
    lastReflectionAt: lastReflectionAt ?? null,
  }
}
