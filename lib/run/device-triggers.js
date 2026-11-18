/**
 * 屏幕/通知类事件触发（2026-11-13，默认关）
 * 通过 DSHA 3090 桥的 /app/ui/dump（无障碍）轮询当前屏幕文本变化；命中变化才唤醒一次。
 * 通知栏没有独立读接口；通知栏打开时其文本会出现在 dump 里，因此可被这里的“屏幕变化”间接触发。
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

function readHeaders(file) {
  try {
    const out = {}
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf(':')
      if (i <= 0) continue
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    return out
  } catch { return {} }
}

export function normalizeDump(body) {
  try {
    const outer = typeof body === 'string' ? JSON.parse(body) : body
    const inner = typeof outer?.result === 'string' ? JSON.parse(outer.result) : outer?.result ?? outer
    const text = String(inner?.text ?? '')
    const app = (text.match(/窗口应用:\s*([^\n]+)/) ?? [])[1] ?? ''
    // 只取前 24 行可见文本，避免时钟/电量之类的微小变化也触发
    const lines = text.split('\n').slice(0, 24).join('\n')
    return { ok: Boolean(inner?.ok !== false && text), app: app.trim(), text: lines }
  } catch { return { ok: false, app: '', text: '' } }
}

export function createDeviceTriggers({
  cfg = {}, fetchImpl = globalThis.fetch, onTrigger = null, log = null, now = () => Date.now(),
} = {}) {
  const c = cfg.device ?? cfg ?? {}
  const endpoint = String(c.endpoint ?? 'http://127.0.0.1:3090')
  const headers = readHeaders(String(c.headersFile ?? '/root/.dsh/.bridge_headers'))
  const intervalMs = Math.max(15_000, Number(c.intervalSec ?? 60) * 1000)
  const minGapMs = Math.max(60_000, Number(c.minGapMin ?? 30) * 60000)
  const excludeApps = new Set((Array.isArray(c.excludeApps) ? c.excludeApps : []).map(String))
  const debugLog = String(c.debugLog ?? '/sdcard/DSHA/生活/数据/logs/device-trigger.log')
  let lastReason = ''
  const dbg = (obj) => { try { appendFileSync(debugLog, `${new Date().toISOString()} ${JSON.stringify(obj)}\n`) } catch {} }
  let timer = null, running = false, lastHash = '', lastFire = 0, lastApp = ''

  const poll = async () => {
    if (running) return { fired: false, reason: 'busy' }
    running = true
    try {
      const res = await fetchImpl(`${endpoint}/app/ui/dump`, { headers, signal: AbortSignal.timeout(10_000) })
      const body = await res.text()
      const d = normalizeDump(body)
      if (!d.ok) { dbg({ ev: 'poll', reason: 'no-dump' }); return { fired: false, reason: 'no-dump' } }
      if (d.app && excludeApps.has(d.app)) { lastHash = createHash('sha1').update(d.text).digest('hex'); lastApp = d.app; if (lastReason !== 'excluded') { lastReason = 'excluded'; dbg({ ev: 'poll', reason: 'excluded', app: d.app }) } return { fired: false, reason: 'excluded' } }
      const hash = createHash('sha1').update(d.text).digest('hex')
      const appChanged = d.app && lastApp && d.app !== lastApp
      if (!lastHash) { lastHash = hash; lastApp = d.app; dbg({ ev: 'poll', reason: 'seed', app: d.app }); return { fired: false, reason: 'seed' } }
      if (hash === lastHash) { if (lastReason !== 'same') { lastReason = 'same'; dbg({ ev: 'poll', reason: 'same', app: d.app }) } return { fired: false, reason: 'same' } }
      lastHash = hash
      lastApp = d.app
      const t = now()
      if (t - lastFire < minGapMs) { dbg({ ev: 'poll', reason: 'gap', app: d.app }); return { fired: false, reason: 'gap' } }
      lastFire = t
      await onTrigger?.({ reason: appChanged ? 'app-change' : 'screen-change', app: d.app, summary: d.text.slice(0, 300), at: t })
      dbg({ ev: 'fired', app: d.app })
      return { fired: true, app: d.app }
    } catch (e) {
      dbg({ ev: 'error', message: String(e?.message ?? e).slice(0, 120) })
      return { fired: false, reason: String(e?.message ?? e).slice(0, 80) }
    } finally { running = false }
  }

  return {
    start() {
      if (timer) return false
      timer = setInterval(() => { void poll() }, intervalMs)
      timer.unref?.()
      void poll()
      return true
    },
    stop() { if (timer) clearInterval(timer); timer = null },
    poll,
  }
}
