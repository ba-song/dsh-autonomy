/**
 * 生活侧文件日志：只追加、失败静默；>5MB 轮转 .1。
 * 行格式：`ISO 时间 level event key=value ...`
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const DEFAULT_AUTONOMY_LOG = '/sdcard/DSHA/生活/数据/logs/autonomy.log'
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

const fmtValue = (v) => {
  if (v == null) return '-'
  return String(v).replace(/\s+/g, '_').slice(0, 200)
}

export function createFileLogger({ path = DEFAULT_AUTONOMY_LOG, maxBytes = DEFAULT_MAX_BYTES, now = Date.now } = {}) {
  const write = (level, event, fields = {}) => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      try {
        if (existsSync(path) && statSync(path).size >= maxBytes) {
          renameSync(path, `${path}.1`)
          writeFileSync(path, '')
        }
      } catch {}
      const at = new Date(now()).toISOString()
      const kv = Object.entries(fields ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${fmtValue(v)}`)
        .join(' ')
      appendFileSync(path, `${at} ${level} ${event}${kv ? ` ${kv}` : ''}\n`)
      return true
    } catch {
      return false
    }
  }
  return { path, write }
}
