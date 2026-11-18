/**
 * 目标仓储（阶段 3：dy_life_goal_* 四件套）
 *
 * 目标只影响**打分**（goalAffinity），不直接触发行动：
 *   - kind_hint 为空 = 通用目标，所有候选都拿到这份 priority（相当于「总体想做点事」）
 *   - kind_hint 指定 = 只给那个行动加分
 *
 * 状态：open / doing / done / dropped / blocked
 * 规矩：done / dropped 是终态，重复操作幂等（noop），不报错。
 */
import { randomUUID } from 'node:crypto'
import { isKnownKind } from '../config.js'

export const GOAL_STATUSES = ['open', 'doing', 'done', 'dropped', 'blocked']
export const TERMINAL_STATUSES = ['done', 'dropped']

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5)

export function addGoal(db, { selfId, title, note = null, priority = 0.5, kindHint = null, dueAt = null, source = 'self', now = Date.now() }) {
  const t = String(title ?? '').trim()
  if (!t) return { ok: false, error: 'title 不能为空' }
  if (t.length > 120) return { ok: false, error: 'title 超过 120 字' }
  const hintRaw = kindHint == null ? '' : String(kindHint).trim()
  const hint = hintRaw === '' ? null : hintRaw
  if (hint && !isKnownKind(hint)) return { ok: false, error: `未知 kind_hint：${hint}` }

  let due = null
  if (dueAt !== null && dueAt !== undefined && dueAt !== '') {
    const n = Number(dueAt)
    if (!Number.isFinite(n)) return { ok: false, error: 'dueAt 不是有效时间戳（Unix 毫秒）' }
    due = n
  }

  const pri = clamp01(Number(priority))
  const id = `goal_${randomUUID()}`
  db.prepare(
    `INSERT INTO goals(id, self_id, title, note, source, priority, status, kind_hint, due_at, last_touched_at, created_at, updated_at)
     VALUES(?,?,?,?,?,?,'open',?,?,?,?,?)`,
  ).run(id, selfId, t, note == null ? null : String(note).slice(0, 500), String(source), pri, hint, due, now, now, now)
  return { ok: true, goal: getGoal(db, selfId, id) }
}

export function getGoal(db, selfId, id) {
  try {
    return db.prepare('SELECT * FROM goals WHERE self_id = ? AND id = ?').get(selfId, id) ?? null
  } catch {
    return null
  }
}

/**
 * 列表。
 * @param {string} status open(默认，含 doing) / doing / done / dropped / blocked / all
 */
export function listGoals(db, selfId, { status = 'open', limit = 50 } = {}) {
  // 缺省 50；显式传 0 的按 1 处理（别把「0 条」静默变成 50 条）
  const rawLim = limit === undefined || limit === null ? 50 : Number(limit)
  const lim = Math.min(200, Math.max(1, Number.isFinite(rawLim) ? rawLim : 50))
  try {
    if (status === 'all') {
      return db.prepare('SELECT * FROM goals WHERE self_id = ? ORDER BY status, priority DESC, created_at DESC LIMIT ?').all(selfId, lim)
    }
    if (status === 'open') {
      return db
        .prepare(`SELECT * FROM goals WHERE self_id = ? AND status IN ('open','doing') ORDER BY priority DESC, created_at DESC LIMIT ?`)
        .all(selfId, lim)
    }
    return db
      .prepare('SELECT * FROM goals WHERE self_id = ? AND status = ? ORDER BY priority DESC, created_at DESC LIMIT ?')
      .all(selfId, status, lim)
  } catch {
    return []
  }
}

/**
 * 收尾：done / drop（终态）。
 * 已在该状态的重复调用 → ok:true, noop:true（幂等）
 */
export function closeGoal(db, { selfId, id, status, note = null, now = Date.now() }) {
  if (!TERMINAL_STATUSES.includes(status)) return { ok: false, error: `只支持 ${TERMINAL_STATUSES.join(' / ')}` }
  const goal = getGoal(db, selfId, id)
  if (!goal) return { ok: false, error: `目标不存在：${id}` }
  if (goal.status === status) return { ok: true, noop: true, goal }
  if (TERMINAL_STATUSES.includes(goal.status)) return { ok: false, error: `目标已是终态（${goal.status}），不能改成 ${status}` }

  db.prepare(
    'UPDATE goals SET status = ?, note = COALESCE(?, note), last_touched_at = ?, updated_at = ? WHERE self_id = ? AND id = ?',
  ).run(status, note == null ? null : String(note).slice(0, 500), now, now, selfId, id)
  return { ok: true, noop: false, goal: getGoal(db, selfId, id) }
}

/** 目标完成时的统计（tick 里顺带刷新 last_touched_at 用；阶段 3 只做读取） */
export function goalCounts(db, selfId) {
  try {
    const rows = db.prepare('SELECT status, COUNT(1) AS n FROM goals WHERE self_id = ? GROUP BY status').all(selfId)
    const out = { open: 0, doing: 0, done: 0, dropped: 0, blocked: 0 }
    for (const r of rows) out[r.status] = Number(r.n)
    return out
  } catch {
    return { open: 0, doing: 0, done: 0, dropped: 0, blocked: 0 }
  }
}
