/**
 * 行动仓储：审计先行（先写 planned，再执行），租约防悬挂，统计供政策判定
 *
 * 状态机：
 *   planned → running → done | failed
 *   planned → aborted（政策拦下 / 崩溃回收）
 *   running → failed（租约过期，error='stale_lease'）
 */
import { randomUUID } from 'node:crypto'
import { HOUR, DAY, dayStartInTz } from '../core/policy.js'

export const TERMINAL = ['done', 'failed', 'aborted']

export function newActionId() {
  return `act_${randomUUID()}`
}

export function appendLog(db, { at = Date.now(), selfId, actionId = null, event, code = null, note = null, data = null }) {
  db.prepare(
    'INSERT INTO action_log(at, self_id, action_id, event, code, note, data_json) VALUES(?,?,?,?,?,?,?)',
  ).run(at, selfId, actionId, event, code, note, data == null ? null : JSON.stringify(data))
}

export function appendTickRun(db, { at = Date.now(), selfId, trigger, outcome, code = null, topKind = null, topScore = null, modelCalls = 0, durationMs = null, note = null }) {
  db.prepare(
    `INSERT INTO tick_runs(at, self_id, trigger, outcome, code, top_kind, top_score, model_calls, duration_ms, note)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(at, selfId, trigger, outcome, code, topKind, topScore, modelCalls, durationMs, note)
}

export function createAction(db, { id = newActionId(), selfId, kind, goalId = null, risk = 'low', reason = null, decision = null, evidence = null, costEstimate = 0, importance = 1, now = Date.now() }) {
  db.prepare(
    `INSERT INTO actions(id, self_id, kind, goal_id, status, risk, reason, decision_json, evidence_json, cost_estimate, importance, created_at)
     VALUES(?,?,?,?,'planned',?,?,?,?,?,?,?)`,
  ).run(
    id,
    selfId,
    kind,
    goalId,
    risk,
    reason,
    decision == null ? null : JSON.stringify(decision),
    evidence == null ? null : JSON.stringify(evidence),
    Number(costEstimate) || 0,
    Math.max(1, Number(importance) || 1),
    now,
  )
  return id
}

export function markRunning(db, id, { leaseUntil, now = Date.now() }) {
  db.prepare(`UPDATE actions SET status='running', started_at=?, lease_until=? WHERE id=? AND status='planned'`).run(
    now,
    leaseUntil,
    id,
  )
}

export function finishAction(db, id, { ok, result = null, error = null, episodeRef = null, evidence = null, now = Date.now(), attempt = null }) {
  const evidenceJson = Array.isArray(evidence) && evidence.length ? JSON.stringify(evidence) : null
  db.prepare(
    `UPDATE actions SET status=?, ended_at=?, lease_until=NULL,
       result_json=?, error=?, episode_ref=?, evidence_json=?, attempt=COALESCE(?, attempt)
     WHERE id=?`,
  ).run(
    ok ? 'done' : 'failed',
    now,
    result == null ? null : JSON.stringify(result),
    error == null ? null : String(error).slice(0, 500),
    episodeRef,
    evidenceJson,
    attempt == null ? null : Number(attempt),
    id,
  )
}

export function abortAction(db, id, { code, now = Date.now() }) {
  db.prepare(`UPDATE actions SET status='aborted', ended_at=?, error=? WHERE id=? AND status IN ('planned','running')`).run(
    now,
    code,
    id,
  )
}

/** 租约过期的 running → failed（进程被杀 / 卡死后的回收） */
export function recoverStale(db, { now = Date.now(), selfId = null } = {}) {
  const rows = selfId
    ? db.prepare(`SELECT id FROM actions WHERE status='running' AND lease_until IS NOT NULL AND lease_until < ? AND self_id=?`).all(now, selfId)
    : db.prepare(`SELECT id FROM actions WHERE status='running' AND lease_until IS NOT NULL AND lease_until < ?`).all(now)
  for (const r of rows) {
    db.prepare(`UPDATE actions SET status='failed', ended_at=?, lease_until=NULL, error='stale_lease' WHERE id=?`).run(now, r.id)
  }
  return rows.length
}

/** 还有未过期的 running 吗（第二道单飞保险） */
export function hasLiveRunning(db, { now = Date.now(), selfId = null } = {}) {
  const row = selfId
    ? db.prepare(`SELECT COUNT(1) AS n FROM actions WHERE status='running' AND (lease_until IS NULL OR lease_until >= ?) AND self_id=?`).get(now, selfId)
    : db.prepare(`SELECT COUNT(1) AS n FROM actions WHERE status='running' AND (lease_until IS NULL OR lease_until >= ?)`).get(now)
  return Number(row?.n ?? 0) > 0
}

/**
 * 单个 kind 的统计（给 select / 政策用）
 *
 * 配额口径（B1，2026-11-05）：
 *   - `doneToday` / `doneThisHour` / `lastDoneAt` 只算**真实完成**的行动；
 *   - `result_json.dryRun===true` 或 `simulated===true` 的行动是演练/模拟，
 *     审计照留（actions 行不动），但**不占真实配额**，单独记在 simulated*；
 *   - 这样 dry_run 跑 N 次不会把 perDay/perHour/minGap 烧掉。
 * @returns {{lastDoneAt:number|null,lastFailedAt:number|null,consecutiveFails:number,doneToday:number,doneThisHour:number,simulatedToday:number,simulatedThisHour:number,lastSimulatedAt:number|null,lastTerminalAt:number|null}}
 */
export function kindStats(db, selfId, kind, { now = Date.now(), tz = 'Asia/Shanghai' } = {}) {
  const dayStart = dayStartInTz(now, tz)
  const hourStart = now - HOUR

  // result_json 里带这两个 true 的都算「演练/模拟」，不占真实配额
  const SIM_DONE = `result_json IS NOT NULL AND (result_json LIKE '%"dryRun":true%' OR result_json LIKE '%"simulated":true%')`
  const REAL_DONE = `(result_json IS NULL OR (result_json NOT LIKE '%"dryRun":true%' AND result_json NOT LIKE '%"simulated":true%'))`

  const lastDone = db
    .prepare(`SELECT MAX(ended_at) AS t FROM actions WHERE self_id=? AND kind=? AND status='done' AND ${REAL_DONE}`)
    .get(selfId, kind)
  const lastFailed = db
    .prepare(`SELECT MAX(ended_at) AS t FROM actions WHERE self_id=? AND kind=? AND status='failed'`)
    .get(selfId, kind)
  const doneToday = db
    .prepare(`SELECT COUNT(1) AS n FROM actions WHERE self_id=? AND kind=? AND status='done' AND ${REAL_DONE} AND ended_at>=?`)
    .get(selfId, kind, dayStart)
  const doneThisHour = db
    .prepare(`SELECT COUNT(1) AS n FROM actions WHERE self_id=? AND kind=? AND status='done' AND ${REAL_DONE} AND ended_at>=?`)
    .get(selfId, kind, hourStart)
  const simulatedToday = db
    .prepare(`SELECT COUNT(1) AS n FROM actions WHERE self_id=? AND kind=? AND status='done' AND ${SIM_DONE} AND ended_at>=?`)
    .get(selfId, kind, dayStart)
  const simulatedThisHour = db
    .prepare(`SELECT COUNT(1) AS n FROM actions WHERE self_id=? AND kind=? AND status='done' AND ${SIM_DONE} AND ended_at>=?`)
    .get(selfId, kind, hourStart)
  const lastSimulated = db
    .prepare(`SELECT MAX(ended_at) AS t FROM actions WHERE self_id=? AND kind=? AND status='done' AND ${SIM_DONE}`)
    .get(selfId, kind)
  // D-007 防刷屏：跨 kind 的真实完成数（每小时/每天）
  const allDoneThisHour = db
    .prepare(`SELECT COUNT(1) AS n FROM actions WHERE self_id=? AND status='done' AND ${REAL_DONE} AND ended_at>=?`)
    .get(selfId, hourStart)
  const allDoneToday = db
    .prepare(`SELECT COUNT(1) AS n FROM actions WHERE self_id=? AND status='done' AND ${REAL_DONE} AND ended_at>=?`)
    .get(selfId, dayStart)
  const channelsToday = {}
  try {
    const rows = db
      .prepare(`SELECT decision_json FROM actions WHERE self_id=? AND status='done' AND ${REAL_DONE} AND ended_at>=?`)
      .all(selfId, dayStart)
    for (const r of rows) {
      let ch = 'unknown'
      try {
        ch = JSON.parse(r.decision_json ?? '{}')?.channel || 'default'
      } catch {}
      channelsToday[String(ch)] = (channelsToday[String(ch)] ?? 0) + 1
    }
  } catch {}

  // 连续失败：按 id 倒序看最近的终态，遇到 done 就停
  const recent = db
    .prepare(`SELECT status FROM actions WHERE self_id=? AND kind=? AND status IN ('done','failed') ORDER BY id DESC LIMIT 20`)
    .all(selfId, kind)
  let consecutiveFails = 0
  for (const r of recent) {
    if (r.status === 'failed') consecutiveFails += 1
    else break
  }

  return {
    lastDoneAt: lastDone?.t ?? null,
    lastFailedAt: lastFailed?.t ?? null,
    consecutiveFails,
    doneToday: Number(doneToday?.n ?? 0),
    doneThisHour: Number(doneThisHour?.n ?? 0),
    simulatedToday: Number(simulatedToday?.n ?? 0),
    simulatedThisHour: Number(simulatedThisHour?.n ?? 0),
    lastSimulatedAt: lastSimulated?.t ?? null,
    allDoneThisHour: Number(allDoneThisHour?.n ?? 0),
    allDoneToday: Number(allDoneToday?.n ?? 0),
    channelsToday,
    lastTerminalAt: Math.max(Number(lastDone?.t ?? 0), Number(lastFailed?.t ?? 0)) || null,
  }
}

/** 最近行动（status 工具用） */
export function recentActions(db, selfId, limit = 5) {
  return db
    .prepare(
      `SELECT id, kind, status, risk, reason, ended_at, created_at, error, episode_ref, goal_id AS goalId
       FROM actions WHERE self_id=? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(selfId, limit)
}

/** 最近 tick（status 工具用） */
export function recentTickRuns(db, selfId, limit = 5) {
  return db
    .prepare(`SELECT at, trigger, outcome, code, top_kind, top_score FROM tick_runs WHERE self_id=? ORDER BY at DESC LIMIT ?`)
    .all(selfId, limit)
}

export { HOUR, DAY }
