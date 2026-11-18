/**
 * 驱动力：纯算术，不调模型
 *
 * 模型（方案 §4.4）：
 *   value = baseline + (value - baseline) * exp(-dt/halfLife)   // 向基线回归
 *   value += growth * dt                                        // 自然积累
 *   value = clamp(value + actionDelta, 0, 1)                    // 行动影响 + 边界
 */
import { clamp01, HOUR } from './policy.js'

export const CORE_DRIVE_NAMES = ['curiosity', 'social', 'mastery', 'care']
// 2026-11-12：9 驱力扩展（素材视频 172552）。默认只启用核心 4 个；extended=true 才读写这 5 个。
export const EXTRA_DRIVE_NAMES = ['rest', 'approval', 'affiliation', 'rebellion', 'order']
export const DRIVE_NAMES = [...CORE_DRIVE_NAMES, ...EXTRA_DRIVE_NAMES]

export const DRIVE_DEFAULTS = {
  curiosity: { baseline: 0.45, growth: 0.05, halfLifeH: 6 },
  social: { baseline: 0.4, growth: 0.04, halfLifeH: 4 },
  mastery: { baseline: 0.35, growth: 0.03, halfLifeH: 8 },
  care: { baseline: 0.5, growth: 0.02, halfLifeH: 12 },
  rest: { baseline: 0.35, growth: 0.03, halfLifeH: 5 },
  approval: { baseline: 0.35, growth: 0.03, halfLifeH: 6 },
  affiliation: { baseline: 0.4, growth: 0.03, halfLifeH: 6 },
  rebellion: { baseline: 0.15, growth: 0.01, halfLifeH: 12 },
  order: { baseline: 0.4, growth: 0.02, halfLifeH: 8 },
}

/** 单次行动成功/失败对驱动力的影响（方案 §4.4 表） */
export const OUTCOME_DELTA = {
  read_archive: { curiosity: 0.1 },
  organize_memory: { mastery: 0.08, care: 0.05 },
  write_diary: { mastery: 0.08 },
  find_sticker: { social: 0.1 },
  browse_douyin: { curiosity: 0.15 },
  send_qq: { social: 0.2, care: 0.12, affiliation: 0.12, approval: 0.05 },
  read_archive_extra: { rest: 0.02, order: 0.02 },
}
// 扩展驱力对行动的权重（只有 extended=true 时 score 才用）
export const EXTENDED_DRIVE = {
  read_archive: { curiosity: 0.45, approval: 0.1, social: 0.1, mastery: 0.1, care: 0.1, order: 0.1, rest: 0.05 },
  organize_memory: { mastery: 0.3, order: 0.35, care: 0.15, approval: 0.1, rest: 0.1 },
  write_diary: { mastery: 0.25, approval: 0.2, social: 0.15, care: 0.1, order: 0.15, rest: 0.1, affiliation: 0.05 },
  find_sticker: { social: 0.25, affiliation: 0.3, approval: 0.2, care: 0.15, rest: 0.1 },
  browse_douyin: { curiosity: 0.4, rest: 0.3, social: 0.1, affiliation: 0.1, rebellion: 0.1 },
  send_qq: { social: 0.25, affiliation: 0.3, care: 0.2, approval: 0.15, rebellion: 0.1 },
}

const FAIL_DELTA = -0.05

/** 默认四行（没落库时用） */
export function defaultDriveRows(now = Date.now(), { extended = false } = {}) {
  return (extended ? DRIVE_NAMES : CORE_DRIVE_NAMES).map((name) => ({
    name,
    value: DRIVE_DEFAULTS[name].baseline,
    baseline: DRIVE_DEFAULTS[name].baseline,
    growth: DRIVE_DEFAULTS[name].growth,
    updated_at: now,
  }))
}

/** 按经过时间推进（纯函数） */
export function advanceDrives(rows, now) {
  return rows.map((row) => {
    const def = DRIVE_DEFAULTS[row.name] ?? DRIVE_DEFAULTS.curiosity
    const baseline = Number.isFinite(row.baseline) ? row.baseline : def.baseline
    const growth = Number.isFinite(row.growth) ? row.growth : def.growth
    const dtH = Math.max(0, (now - (row.updated_at ?? now)) / HOUR)
    const halfLife = def.halfLifeH
    const decayed = baseline + ((Number(row.value ?? baseline) - baseline) * Math.exp(-dtH / halfLife))
    const value = clamp01(decayed + growth * dtH)
    return { ...row, value, baseline, growth, updated_at: now }
  })
}

/** 行动结果回写（纯函数）：成功加上限，失败 -0.05 */
export function applyOutcome(rows, kind, ok) {
  const deltas = ok ? (OUTCOME_DELTA[kind] ?? {}) : {}
  return rows.map((row) => {
    let d = 0
    if (ok) d = Number(deltas[row.name] ?? 0)
    else d = FAIL_DELTA
    return { ...row, value: clamp01(Number(row.value ?? 0.5) + d) }
  })
}

/** 读成 { curiosity: 0.5, ... } 方便打分 */
export function toMap(rows) {
  const map = {}
  for (const r of rows) map[r.name] = Number(r.value ?? 0)
  for (const name of DRIVE_NAMES) if (!(name in map)) map[name] = DRIVE_DEFAULTS[name].baseline
  return map
}

/** 驱力冲突度（0=完全一致，越大越分裂）：用于状态/日志，不做决策。 */
export function driveConflict(map) {
  const vals = Object.values(map ?? {}).map(Number).filter((x) => Number.isFinite(x))
  if (vals.length < 2) return 0
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length)
  return Number(Math.min(1, sd * 2).toFixed(3))
}

// ── 落库 ──────────────────────────────────────────────

export function loadDrives(db, selfId, now = Date.now(), { extended = false } = {}) {
  const names = extended ? DRIVE_NAMES : CORE_DRIVE_NAMES
  let rows = []
  try {
    rows = db
      .prepare('SELECT name, value, baseline, growth, updated_at FROM drives WHERE self_id = ?')
      .all(selfId)
  } catch {
    rows = []
  }
  if (!rows.length) return defaultDriveRows(now, { extended })
  const byName = new Map(rows.map((r) => [r.name, r]))
  return names.map((name) => {
    const r = byName.get(name)
    const def = DRIVE_DEFAULTS[name]
    return {
      name,
      value: clamp01(Number(r?.value ?? def.baseline)),
      baseline: Number(r?.baseline ?? def.baseline),
      growth: Number(r?.growth ?? def.growth),
      updated_at: Number(r?.updated_at ?? now),
    }
  })
}

export function saveDrives(db, selfId, rows) {
  const stmt = db.prepare(
    `INSERT INTO drives(self_id, name, value, baseline, growth, updated_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(self_id, name) DO UPDATE SET
       value = excluded.value, baseline = excluded.baseline,
       growth = excluded.growth, updated_at = excluded.updated_at`,
  )
  for (const r of rows) stmt.run(selfId, r.name, r.value, r.baseline, r.growth, r.updated_at)
  return rows
}
