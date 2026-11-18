/**
 * 政策：纯函数集合（不摸 DB、不调模型、不发消息）
 *
 * 全部纯函数的原因：tick 里最容易出错的就是这几条判定，
 * 纯函数才能用固定时间把「安静时段 / 冷却 / 退避 / 熔断」逐条钉死。
 */
import { parseHHMM } from '../config.js'

export const MINUTE = 60_000
export const HOUR = 3_600_000
export const DAY = 86_400_000

export function clamp01(x) {
  if (!Number.isFinite(x)) return 0
  return x < 0 ? 0 : x > 1 ? 1 : x
}

const tzFormatters = new Map()

/** 取某时区的「一天中的分钟数」（0..1439）；时区非法时退回本机时区 */
export function minutesOfDayInTz(nowMs, tz = 'Asia/Shanghai') {
  let fmt = tzFormatters.get(tz)
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    } catch {
      fmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
    }
    tzFormatters.set(tz, fmt)
  }
  try {
    const parts = fmt.formatToParts(new Date(nowMs))
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
    return ((h % 24) + 24) % 24 * 60 + m
  } catch {
    const d = new Date(nowMs)
    return d.getHours() * 60 + d.getMinutes()
  }
}

/**
 * 是否在安静时段。
 * - start === end → 视为不启用（避免 00:00-00:00 变成全天静音）
 * - start > end → 跨天（例 23:30-08:00）
 * @param {number} minutes 一天中的分钟（0..1439）
 */
export function inQuietWindow(minutes, start, end) {
  const s = typeof start === 'number' ? start : parseHHMM(start)
  const e = typeof end === 'number' ? end : parseHHMM(end)
  if (s == null || e == null || s === e) return false
  if (s < e) return minutes >= s && minutes < e
  return minutes >= s || minutes < e
}

/** 是否在安静时段（按 now 与 cfg.quietHours 判定） */
export function inQuietHours(nowMs, quietHours = {}) {
  const minutes = minutesOfDayInTz(nowMs, quietHours?.tz ?? 'Asia/Shanghai')
  return inQuietWindow(minutes, quietHours?.start, quietHours?.end)
}

/**
 * full jitter 退避：random_between(0, min(cap, base * factor^(attempt-1)))
 * 参考 AWS Architecture Blog；防的是「固定间隔重试 → 重试风暴」。
 * @param {number} attempt 从 1 开始
 */
export function backoffMs(attempt, cfg = {}, random = Math.random) {
  const baseSec = Number(cfg.baseSec ?? 60)
  const factor = Number(cfg.factor ?? 2)
  const capSec = Number(cfg.capSec ?? 21_600)
  const n = Math.max(1, Math.floor(Number(attempt) || 1))
  const raw = Math.min(capSec, baseSec * Math.pow(factor, n - 1)) * 1000
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.floor(random() * raw)
}

/**
 * 熔断状态。
 * @param {number} consecutiveFails 连续失败次数
 * @param {number|null} lastFailAt 最后一次失败时间
 * @returns {{open:boolean, until:number|null, code:string|null}}
 */
export function circuitState(consecutiveFails, lastFailAt, cfg = {}, now = Date.now()) {
  const threshold = Number(cfg.fails ?? 3)
  const openMinutes = Number(cfg.openMinutes ?? 360)
  if (!Number.isFinite(consecutiveFails) || consecutiveFails < threshold || !lastFailAt) {
    return { open: false, until: null, code: null }
  }
  const until = lastFailAt + openMinutes * MINUTE
  if (now < until) return { open: true, until, code: 'CIRCUIT_OPEN' }
  return { open: false, until, code: null }
}

/** 暂停对象是否生效：{on:true, until?:ms|null} */
export function pauseActive(pause, now = Date.now()) {
  if (!pause || pause.on !== true) return false
  if (pause.until != null && now >= Number(pause.until)) return false
  return true
}

/** 距上次 >= minGapMin 分钟？lastAt 为空视为满足 */
export function gapSatisfied(lastAt, nowMs, minGapMin) {
  if (!lastAt) return true
  const gap = Number(minGapMin) || 0
  return nowMs - Number(lastAt) >= gap * MINUTE
}

/** 取「当地一天的起点」毫秒（用于 perDay 统计） */
export function dayStartInTz(nowMs, tz = 'Asia/Shanghai') {
  const offsetMs = tzOffsetMs(nowMs, tz)
  const local = nowMs + offsetMs
  const dayStartLocal = Math.floor(local / DAY) * DAY
  return dayStartLocal - offsetMs
}

/** 粗暴但够用的时区偏移：用 Intl 反推（毫秒） */
export function tzOffsetMs(nowMs, tz) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    const parts = dtf.formatToParts(new Date(nowMs))
    const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0)
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
    return asUtc - nowMs
  } catch {
    return 0
  }
}
