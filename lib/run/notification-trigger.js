/**
 * 通知触发（2026-11-13，A2 方案）：
 * 轮询本机通知转发 App 的 127.0.0.1:3091/notifications，有新通知就带内容叫醒汐。
 * 转发 App 必须有“通知使用权”；插件只读本机 HTTP，不联网。
 */
import { appendFileSync } from 'node:fs'

const DEFAULT_ALLOW = ['com.ss.android.ugc.aweme', 'com.ss.android.ugc.aweme.lite']

export function createNotificationTrigger({
  cfg = {}, fetchImpl = globalThis.fetch, onNotification = null, log = null, now = () => Date.now(), getWebStatus = null,
} = {}) {
  const c = cfg.notification ?? cfg ?? {}
  const endpoint = String(c.endpoint ?? 'http://127.0.0.1:3091')
  const intervalMs = Math.max(2000, Number(c.intervalSec ?? 5) * 1000)
  const minGapMs = Math.max(3000, Number(c.minGapSec ?? 10) * 1000)
  const allow = new Set((Array.isArray(c.allowPackages) && c.allowPackages.length ? c.allowPackages : DEFAULT_ALLOW).map(String))
  const maxAgeMs = Math.max(60_000, Number(c.maxAgeSec ?? 600) * 1000)
  const debugLog = String(c.debugLog ?? '/sdcard/DSHA/生活/数据/logs/notification-trigger.log')
  let timer = null, running = false, since = 0, lastFire = 0, seeded = false
  const webPrimary = c.webPrimary === true
  const webHealthyMs = Math.max(60_000, Number(c.webHealthyMs ?? 300_000) || 300_000)
  const webHealthy = () => {
    if (!webPrimary || typeof getWebStatus !== 'function') return false
    try {
      const st = getWebStatus()
      return Boolean(st && st.cfgEnabled === true && st.lastOkAt && now() - Number(st.lastOkAt) <= webHealthyMs)
    } catch { return false }
  }
  const dbg = (obj) => { try { appendFileSync(debugLog, `${new Date().toISOString()} ${JSON.stringify(obj)}\n`) } catch {} }

  const poll = async () => {
    if (running) return { fired: false, reason: 'busy' }
    running = true
    try {
      const res = await fetchImpl(`${endpoint}/notifications?since=${since}`, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) { dbg({ ev: 'poll', reason: `http-${res.status}` }); return { fired: false, reason: 'http' } }
      const body = await res.json()
      if (!body?.ok) { dbg({ ev: 'poll', reason: 'bad-body' }); return { fired: false, reason: 'bad-body' } }
      if (body.listener === false) dbg({ ev: 'poll', reason: 'listener-off' })
      const all = Array.isArray(body.items) ? body.items : []
      if (!seeded) {
        seeded = true
        if (c.seedOnStart !== false && all.length) {
          since = Math.max(...all.map((x) => Number(x.id) || 0))
          dbg({ ev: 'seed', count: all.length })
          return { fired: false, reason: 'seed' }
        }
      }
      const nowMs = now()
      const items = all
        .filter((x) => x && x.id > since && allow.has(String(x.package)))
        // 旧通知不补投：postTime 超过窗口的直接丢弃
        .filter((x) => {
          if (!Object.prototype.hasOwnProperty.call(x, 'postTime')) return true
          const t = Number(x.postTime)
          return Number.isFinite(t) && t > 0 && nowMs - t <= maxAgeMs
        })
        .slice(0, Math.max(1, Number(c.maxItems ?? 3)))
      if (!items.length) return { fired: false, reason: 'none' }
      const nextSince = Math.max(...items.map((x) => Number(x.id) || 0))
      // 网页 watcher 健康时它做主监听，APP 通知只推进游标、不重复投递；网页失败/超时才兜底
      if (webHealthy()) {
        since = nextSince
        dbg({ ev: 'web-primary-skip', count: items.length })
        return { fired: false, reason: 'web-primary' }
      }
      const t = now()
      if (t - lastFire < minGapMs) { dbg({ ev: 'poll', reason: 'gap', count: items.length }); return { fired: false, reason: 'gap' } }
      lastFire = t
      // 只有成功唤醒才推进游标；忙碌/限速时下轮还能补上，避免丢通知
      since = nextSince
      const lines = items.map((x) => `【${x.title || '通知'}】${x.text || ''}`).join('\n')
      const prompt = `手机通知来了。看一下要不要回；如果是我能处理的，就处理完再决定说不说。\n如果抖音发送/打开超时或失败，不要重试，直接告诉主人「发送功能还没完善」。\n\n${lines}`.slice(0, 1200)
      await onNotification?.({ items, prompt, at: t })
      dbg({ ev: 'fired', count: items.length, packages: items.map((x) => x.package) })
      return { fired: true, count: items.length }
    } catch (e) {
      dbg({ ev: 'error', message: String(e?.message ?? e).slice(0, 120) })
      return { fired: false, reason: String(e?.message ?? e).slice(0, 60) }
    } finally { running = false }
  }

  return {
    start() { if (timer) return false; timer = setInterval(() => { void poll() }, intervalMs); timer.unref?.(); void poll(); return true },
    stop() { if (timer) clearInterval(timer); timer = null },
    poll,
    get since() { return since },
  }
}
