/**
 * 反思记账（阶段 3：只落 pending，不调模型）
 *
 * 为什么本阶段不生成正文：
 *  - 契约/门禁还没放行真实模型调用；先让「什么时候该反思」这件事可测、可审计
 *  - pending 记录就是阶段 4 的输入（窗口 + evidence 已经在表里）
 *
 * B2（2026-11-05）：加「超时作废」。pending 超过 `cfg.reflect.pendingTtlHours`（默认 24h）
 * 还没被消费 → 标 `expired`，不再永久挡住后续反思。选它而不是「生成正文」的理由：
 * 当前没有模型放行，硬造一段反思会违反「反思必须有证据」；等模型/消费路径批准后再补 text/done。
 */
import { decideReflection, reflectionProgress } from '../core/reflect.js'
import { appendLog } from './actions.js'
import { DAY, HOUR } from '../core/policy.js'

const DEFAULT_PENDING_TTL_HOURS = 24

/**
 * 把超时未消费的 pending 标记为 expired（幂等：只改 pending 且 at < cutoff）。
 * @returns {number} 本次作废条数
 */
export function expireStaleReflections(db, { selfId, now = Date.now(), ttlHours = DEFAULT_PENDING_TTL_HOURS } = {}) {
  try {
    const ttl = Number(ttlHours)
    const hours = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_PENDING_TTL_HOURS
    const cutoff = now - hours * HOUR
    const info = db
      .prepare(`UPDATE reflections SET status='expired' WHERE self_id=? AND status='pending' AND at < ?`)
      .run(selfId, cutoff)
    const expired = Number(info?.changes ?? 0)
    if (expired > 0) {
      appendLog(db, {
        at: now,
        selfId,
        event: 'reflect_expired',
        code: 'REFLECT_EXPIRED',
        note: `expired=${expired} ttlHours=${hours}`,
      })
    }
    return expired
  } catch {
    return 0 // 记账失败不许影响 tick
  }
}

export function maybeMarkReflection(db, { selfId, cfg, now = Date.now() }) {
  try {
    // B2：先作废超时的 pending，否则一条旧 pending 会永久挡住后续所有反思
    expireStaleReflections(db, { selfId, now, ttlHours: cfg?.reflect?.pendingTtlHours })

    const hasPending = Number(
      db.prepare(`SELECT COUNT(1) AS n FROM reflections WHERE self_id=? AND status='pending'`).get(selfId)?.n ?? 0,
    )
    if (hasPending > 0) return null

    const lastRow = db.prepare('SELECT MAX(at) AS t FROM reflections WHERE self_id=?').get(selfId)
    const lastReflectionAt = Number(lastRow?.t ?? 0) || null
    const since = lastReflectionAt ?? now - 7 * DAY

    const actions = db
      .prepare(
        `SELECT id, importance, created_at FROM actions
         WHERE self_id=? AND created_at>=? AND status IN ('done','failed')
         ORDER BY importance DESC, id DESC LIMIT 50`,
      )
      .all(selfId, since)

    const decision = decideReflection({
      now,
      cfg: cfg?.reflect ?? {},
      actions,
      lastReflectionAt,
      hasPending: false,
      windowStart: since,
    })
    if (!decision) return null

    const info = db
      .prepare(
        `INSERT INTO reflections(self_id, at, period, status, trigger, importance, window_start, window_end, evidence_json, text)
         VALUES(?,?,?,'pending',?,?,?,?,?,NULL)`,
      )
      .run(selfId, now, 'threshold', decision.trigger, decision.importance, decision.windowStart, decision.windowEnd, JSON.stringify(decision.evidence))

    const id = Number(info?.lastInsertRowid ?? 0)
    appendLog(db, {
      at: now,
      selfId,
      event: 'reflect_due',
      code: 'REFLECT_DUE',
      note: `trigger=${decision.trigger} importance=${decision.importance}`,
      data: { reflectionId: id, evidence: decision.evidence },
    })
    return { id, ...decision }
  } catch {
    return null // 记账失败不许影响 tick
  }
}

/** 她手动写一条反思：status=done，text≤500，并把最早 pending 标 consumed；返回 id */
export function recordReflection(db, { selfId, text, importance = 1, goalId = null, now = Date.now() } = {}) {
  const t = String(text ?? '').trim()
  if (!t) return { ok: false, code: 'EMPTY_TEXT' }
  const clipped = t.slice(0, 500)
  try {
    let pending = null
    try {
      pending = db.prepare("SELECT id FROM reflections WHERE self_id=? AND status='pending' ORDER BY id ASC LIMIT 1").get(selfId) ?? null
    } catch {}
    const info = db
      .prepare(
        `INSERT INTO reflections(self_id, at, period, status, trigger, importance, window_start, window_end, evidence_json, text, applied_json)
         VALUES(?,?,?,'done','MANUAL',?,?,?,?,?,?)`,
      )
      .run(
        selfId,
        now,
        'manual',
        Math.max(0, Number(importance) || 0),
        now,
        now,
        JSON.stringify([{ type: 'manual', goalId: goalId ?? null }]),
        clipped,
        JSON.stringify({ goalId: goalId ?? null }),
      )
    if (pending?.id) {
      try {
        db.prepare("UPDATE reflections SET status='consumed' WHERE id=? AND status='pending'").run(pending.id)
      } catch {}
    }
    try {
      appendLog(db, {
        at: now,
        selfId,
        event: 'reflection',
        code: 'REFLECT_MANUAL',
        note: `len=${clipped.length}${goalId ? ` goal=${goalId}` : ''}`,
        data: { reflectionId: Number(info?.lastInsertRowid ?? 0), consumed: pending?.id ?? null, goalId: goalId ?? null },
      })
    } catch {}
    return { ok: true, id: Number(info?.lastInsertRowid ?? 0), consumed: pending?.id ?? null, text: clipped }
  } catch (e) {
    return { ok: false, code: 'WRITE_FAILED', error: String(e?.message ?? e).slice(0, 200) }
  }
}

export function reflectionState(db, selfId, cfg, now = Date.now()) {
  let pending = 0
  let expired = 0
  let lastAt = null
  let lastTrigger = null
  try {
    pending = Number(db.prepare(`SELECT COUNT(1) AS n FROM reflections WHERE self_id=? AND status='pending'`).get(selfId)?.n ?? 0)
    expired = Number(db.prepare(`SELECT COUNT(1) AS n FROM reflections WHERE self_id=? AND status='expired'`).get(selfId)?.n ?? 0)
    const last = db.prepare('SELECT at, trigger FROM reflections WHERE self_id=? ORDER BY at DESC LIMIT 1').get(selfId)
    lastAt = Number(last?.at ?? 0) || null
    lastTrigger = last?.trigger ?? null
  } catch {
    /* 表还没建（理论不会）：按空状态 */
  }

  // 有 pending 时，进度按「pending 触发窗口」算（否则刚记完会显示 importance=0，很误导）
  let pendingRow = null
  try {
    pendingRow = db.prepare("SELECT * FROM reflections WHERE self_id=? AND status='pending' ORDER BY id DESC LIMIT 1").get(selfId) ?? null
  } catch {
    pendingRow = null
  }

  const since = pendingRow ? Number(pendingRow.window_start ?? 0) || now - 7 * DAY : lastAt ?? now - 7 * DAY
  let actions = []
  try {
    actions = db
      .prepare(
        `SELECT id, importance, created_at FROM actions WHERE self_id=? AND created_at>=? AND status IN ('done','failed')`,
      )
      .all(selfId, since)
  } catch {
    actions = []
  }

  const progress = reflectionProgress({
    now,
    cfg: cfg?.reflect ?? {},
    actions,
    // pending 期间用「触发窗口」重算（windowStart 优先），但 lastReflectionAt 照实展示
    lastReflectionAt: lastAt,
    hasPending: pending > 0,
    windowStart: pendingRow ? since : null,
  })
  // 注意：progress.pending 是布尔（"有没有 pending"），这里 pending 用**条数**，别混
  return {
    lastAt,
    lastTrigger,
    ...progress,
    hasPending: pending > 0,
    pendingCount: pending,
    pending,
    expiredCount: expired,
    pendingTtlHours: Number(cfg?.reflect?.pendingTtlHours ?? DEFAULT_PENDING_TTL_HOURS),
  }
}
