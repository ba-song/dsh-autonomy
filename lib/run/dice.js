/**
 * 骰子唤醒（D-007 后按主人 11-02 设计重建）
 *
 * 纯函数，不碰 DB/不调模型：
 *   bonus  = min(maxBonus, misses * bonusPerMiss)
 *   chance = clamp(baseChance + bonus + (peak ? peakChanceDelta : 0), 0.05, 0.95)
 *   hit    = random() < chance
 *
 * 峰时：周一–周五、[start,end) 小时；周末不应用。时区默认 Asia/Shanghai。
 */

import { minutesOfDayInTz, inQuietWindow } from '../core/policy.js'

const MIN_CHANCE = 0.05
const MAX_CHANCE = 0.95

export const DICE_DEFAULTS = Object.freeze({
  enabled: false,
  baseChance: 0.55,
  bonusPerMiss: 0.15,
  maxBonus: 0.45,
  peakHours: [
    [9, 12],
    [14, 18],
  ],
  peakChanceDelta: -0.15,
  quietHours: { enabled: false, start: '00:00', end: '08:00', tz: 'Asia/Shanghai' },
})

export function diceBonusOf(cfg = {}, misses = 0) {
  const maxBonus = Number(cfg.maxBonus ?? DICE_DEFAULTS.maxBonus)
  const perMiss = Number(cfg.bonusPerMiss ?? DICE_DEFAULTS.bonusPerMiss)
  const n = Math.max(0, Math.floor(Number(misses) || 0))
  return Math.min(maxBonus, n * perMiss)
}

const peakFmt = new Map()
function partsOf(now, tz) {
  let fmt = peakFmt.get(tz)
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', hour12: false })
    } catch {
      fmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: '2-digit', hour12: false })
    }
    peakFmt.set(tz, fmt)
  }
  const parts = fmt.formatToParts(new Date(now))
  const get = (t) => parts.find((p) => p.type === t)?.value ?? ''
  return { weekday: get('weekday'), hour: Number(get('hour')) }
}

/** 周一–周五 + 落在任一 [start,end) 小时；周末 false */
export function isPeakHour(now, peakHours = DICE_DEFAULTS.peakHours, tz = 'Asia/Shanghai') {
  if (!Array.isArray(peakHours) || !peakHours.length) return false
  const { weekday, hour } = partsOf(now, tz)
  if (weekday === 'Sat' || weekday === 'Sun') return false
  if (!Number.isFinite(hour)) return false
  return peakHours.some(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && s < e && hour >= s && hour < e)
}

export function diceChanceOf({ cfg = {}, now = Date.now(), misses = 0, tz = 'Asia/Shanghai' } = {}) {
  const base = Number(cfg.baseChance ?? DICE_DEFAULTS.baseChance)
  const bonus = diceBonusOf(cfg, misses)
  const peak = isPeakHour(now, cfg.peakHours ?? DICE_DEFAULTS.peakHours, tz)
  const delta = peak ? Number(cfg.peakChanceDelta ?? DICE_DEFAULTS.peakChanceDelta) : 0
  const raw = base + bonus + delta
  return Math.min(MAX_CHANCE, Math.max(MIN_CHANCE, raw))
}

/** @returns {{at:number,chance:number,roll:number,hit:boolean,peak:boolean,bonus:number,misses:number}} */
export function rollDice({ cfg = {}, now = Date.now(), random = Math.random, misses = 0, tz = 'Asia/Shanghai' } = {}) {
  const chance = diceChanceOf({ cfg, now, misses, tz })
  const roll = Number(random())
  const peak = isPeakHour(now, cfg.peakHours ?? DICE_DEFAULTS.peakHours, tz)
  return {
    at: now,
    chance,
    roll: Number.isFinite(roll) ? roll : 1,
    hit: Number(roll) < chance,
    peak,
    bonus: diceBonusOf(cfg, misses),
    misses: Math.max(0, Math.floor(Number(misses) || 0)),
  }
}


const parseHM = (v) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

/** 骰子夜间静默：只挡自主唤醒，不影响渠道投递 */
export function diceQuietOf(quiet, now = Date.now(), tz = 'Asia/Shanghai') {
  if (!quiet || quiet.enabled !== true) return false
  const s = parseHM(quiet.start)
  const e = parseHM(quiet.end)
  if (s == null || e == null || s === e) return false
  const minutes = minutesOfDayInTz(now, quiet.tz ?? tz)
  return inQuietWindow(minutes, s, e)
}
