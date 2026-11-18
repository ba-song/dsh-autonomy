/**
 * B3 · 手动行动（她在自己会话里主动调用才执行）
 *
 * 硬约束：
 * - tick 不接这里；tick 仍 dry-run/只记录；
 * - 只由 `dy_life_action_run` 调用，owner/home 会话；
 * - 过 pause + antiSpam；不真调外部通道；
 * - 每个 kind 只做只读或明确 UNAVAILABLE，不假装成功。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { KINDS, isKnownKind } from '../config.js'
import { loadDrives, saveDrives } from '../core/drives.js'
import { pauseActive, gapSatisfied } from '../core/policy.js'
import { getMeta } from '../store/db.js'
import { kindStats, createAction, markRunning, finishAction, appendLog, newActionId } from './actions.js'

const DEFAULT_ARCHIVE = '/sdcard/DSHA/记忆/档案'
const DEFAULT_RAW = '/sdcard/DSHA/记忆/数据/raw'
const DEFAULT_STICKERS = ['/sdcard/DSHA/表情包', '/sdcard/DSHA/生活/数据/stickers', '/sdcard/Pictures/表情包']
const IMG = /\.(png|jpe?g|webp|gif)$/i

const listDirs = (root) => {
  try {
    return readdirSync(root).filter((n) => {
      try {
        return statSync(join(root, n)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

const filesOf = (dir) => {
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.md') || n.endsWith('.txt')).map((n) => join(dir, n))
  } catch {
    return []
  }
}

function archiveCandidates(cfg) {
  const roots = [cfg?.archiveDir ?? DEFAULT_ARCHIVE, cfg?.rawDir ?? DEFAULT_RAW].filter(Boolean)
  const limitDays = Math.max(1, Number(cfg?.archiveRecentDays ?? 7))
  const out = []
  for (const root of roots) {
    const days = listDirs(root).sort().reverse().slice(0, limitDays)
    for (const day of days) for (const file of filesOf(join(root, day))) out.push({ root, day, file })
  }
  return out
}

export function createManualActions({ db, cfg, memory = null, now = () => Date.now(), random = Math.random, log = null } = {}) {
  const antiOf = (selfId, kind, at) => {
    const stats = kindStats(db, selfId, kind, { now: at, tz: cfg?.quietHours?.tz })
    const anti = cfg?.antiSpam ?? {}
    if (anti.enabled !== false) {
      if (Number(anti.perHour) > 0 && Number(stats.allDoneThisHour) >= Number(anti.perHour)) return { code: 'RATE_LIMIT_HOUR', stats }
      if (Number(anti.perDay) > 0 && Number(stats.allDoneToday) >= Number(anti.perDay)) return { code: 'RATE_LIMIT_DAY', stats }
      if (Number(anti.sameKindMinGapMin) > 0 && !gapSatisfied(stats.lastDoneAt, at, Number(anti.sameKindMinGapMin))) return { code: 'MIN_GAP', stats }
    }
    return null
  }

  const execute = async (kind, { text = '' } = {}) => {
    if (kind === 'read_archive') {
      const candidates = archiveCandidates(cfg)
      if (!candidates.length) return { ok: false, code: 'NO_ARCHIVE' }
      const pick = candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]
      const file = pick.file
      let body = ''
      try {
        body = readFileSync(file, 'utf8')
      } catch {
        return { ok: false, code: 'READ_FAILED' }
      }
      const clean = body.replace(/^---[\s\S]*?---\s*/, '').trim()
      if (!clean) return { ok: false, code: 'NO_ARCHIVE' }
      return {
        ok: true,
        evidence: [{ type: 'archive', ref: file }],
        episodeText: `翻了档案：${clean.slice(0, 500)}`,
        result: { file, chars: Math.min(clean.length, 500) },
      }
    }

    if (kind === 'write_diary') {
      const t = String(text ?? '').trim()
      if (!t) return { ok: false, code: 'NO_DRAFT' }
      if (!memory || typeof memory.saveDiary !== 'function') return { ok: false, code: 'UNAVAILABLE' }
      const r = await memory.saveDiary({ text: t.slice(0, 20_000), at: now() })
      if (!r?.ok) return { ok: false, code: r?.code ?? 'SAVE_FAILED', error: r?.error }
      return { ok: true, evidence: [{ type: 'diary', ref: r.id ?? null }], result: { id: r.id ?? null, bytes: r.bytes ?? null }, episodeText: '写了一篇日记。' }
    }

    if (kind === 'organize_memory') {
      const roots = [cfg?.archiveDir ?? DEFAULT_ARCHIVE, cfg?.rawDir ?? DEFAULT_RAW].filter(Boolean)
      const days = []
      for (const root of roots) for (const d of listDirs(root)) days.push({ root, day: d })
      if (!days.length) return { ok: false, code: 'NO_ARCHIVE' }
      const suggestions = []
      const byDay = new Map()
      for (const it of days) {
        const n = filesOf(join(it.root, it.day)).length
        byDay.set(it.day, (byDay.get(it.day) ?? 0) + n)
        if (n > 12) suggestions.push(`${it.day} 有 ${n} 个文件，可合并成一份日摘要`)
      }
      if (!suggestions.length) suggestions.push(`最近 ${Math.min(days.length, 7)} 天内没有明显需要合并的档案`)
      return {
        ok: true,
        evidence: days.slice(-3).map((x) => ({ type: 'archive_dir', ref: join(x.root, x.day) })),
        result: { suggestions: suggestions.slice(0, 10), days: days.length },
        episodeText: `整理建议：${suggestions.slice(0, 3).join('；')}`.slice(0, 500),
      }
    }

    if (kind === 'find_sticker') {
      const dirs = Array.isArray(cfg?.stickerDirs) ? cfg.stickerDirs : DEFAULT_STICKERS
      for (const dir of dirs) {
        try {
          const imgs = readdirSync(dir).filter((n) => IMG.test(n)).map((n) => join(dir, n))
          if (imgs.length) return { ok: true, evidence: [{ type: 'sticker', ref: imgs[0] }], result: { count: imgs.length }, episodeText: `翻到 ${imgs.length} 张表情包。` }
        } catch {}
      }
      return { ok: false, code: 'UNAVAILABLE' }
    }

    if (kind === 'browse_douyin' || kind === 'send_qq') return { ok: false, code: 'UNAVAILABLE' }
    return { ok: false, code: 'UNKNOWN_KIND' }
  }

  async function run(kind, { selfId = 'self:unknown', reason = '', text = '', goalId = null, channel = null, source = 'self' } = {}) {
    if (!isKnownKind(kind)) return { ok: false, kind, code: 'UNKNOWN_KIND' }
    const at = now()
    try {
      if (pauseActive(getMeta(db, 'pause.all', null), at)) return { ok: false, kind, code: 'PAUSED' }
      const kindPause = getMeta(db, 'pause.kinds', {})?.[kind]
      if (pauseActive(kindPause, at)) return { ok: false, kind, code: 'PAUSED_KIND' }
      const anti = antiOf(selfId, kind, at)
      if (anti) return { ok: false, kind, code: anti.code }
    } catch {
      return { ok: false, kind, code: 'POLICY_CHECK_FAILED' }
    }

    let goal = null
    if (goalId != null && String(goalId).trim()) {
      try {
        goal = db.prepare('SELECT id,status FROM goals WHERE id=? AND self_id=?').get(String(goalId), selfId) ?? null
      } catch {
        goal = null
      }
      if (!goal) return { ok: false, kind, code: 'GOAL_NOT_FOUND' }
      if (!['open', 'doing'].includes(String(goal.status))) return { ok: false, kind, code: 'GOAL_CLOSED' }
    }

    const actionId = newActionId()
    createAction(db, {
      id: actionId,
      selfId,
      kind,
      goalId: goal?.id ?? null,
      risk: KINDS[kind].risk,
      reason: String(reason || `她手动想做一次 ${kind}`).slice(0, 200),
      decision: { trigger: 'manual', kind, source, channel: channel ? String(channel).slice(0, 40) : null },
      evidence: null,
      importance: 1,
      now: at,
    })
    markRunning(db, actionId, { leaseUntil: at + 60_000, now: at })

    let out
    try {
      out = await execute(kind, { text })
    } catch (e) {
      out = { ok: false, code: 'EXECUTOR_FAILED', error: String(e?.message ?? e) }
    }
    const evidence = Array.isArray(out.evidence) ? out.evidence : []
    if (out.ok) {
      finishAction(db, actionId, { ok: true, result: out.result ?? null, evidence, now: now() })
      appendLog(db, { at: now(), selfId, actionId, event: 'done', code: 'OK', note: `manual ${kind}`, data: { evidence, source } })
      try {
        const driveName = { read_archive: 'curiosity', write_diary: 'social', organize_memory: 'mastery', find_sticker: 'social', browse_douyin: 'curiosity', send_qq: 'social' }[kind]
        if (driveName) {
          const rows = loadDrives(db, selfId, now(), { extended: cfg.drives?.extended === true })
          const next = rows.map((r) => (r.name === driveName ? { ...r, value: Math.max(0, Math.min(1, Number(r.value) - 0.1)), updated_at: now() } : r))
          saveDrives(db, selfId, next)
        }
      } catch {}
    } else {
      finishAction(db, actionId, { ok: false, error: out.code, evidence, now: now() })
      appendLog(db, { at: now(), selfId, actionId, event: 'fail', code: out.code, note: `manual ${kind}`, data: { evidence } })
    }
    return { ...out, actionId, evidence }
  }

  return { run, execute }
}
