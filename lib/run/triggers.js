/**
 * 事件触发（2026-11-13 P1，默认关）：不是让模型常驻思考，而是外部信号触发一次唤醒。
 * 目前只做文件 mtime 监听（屏幕/通知监听需要 Android 权限，单独评估）。
 */
import { statSync } from 'node:fs'

export function createFileTriggers({ files = [], intervalMs = 60_000, minGapMs = 5 * 60_000, onTrigger = null, log = null, now = () => Date.now() } = {}) {
  const list = (Array.isArray(files) ? files : []).map(String).filter(Boolean)
  const state = new Map()
  let timer = null
  let lastFire = 0
  let running = false

  const seed = () => {
    for (const f of list) {
      try { state.set(f, statSync(f).mtimeMs) } catch { state.set(f, 0) }
    }
  }

  const tick = async () => {
    if (running) return
    running = true
    try {
      const changed = []
      for (const f of list) {
        let m = 0
        try { m = statSync(f).mtimeMs } catch { m = 0 }
        const prev = state.get(f) ?? 0
        if (m > prev) changed.push({ file: f, mtime: m, prev })
        state.set(f, m)
      }
      if (!changed.length) return
      const t = now()
      if (t - lastFire < minGapMs) return
      lastFire = t
      log?.info?.(`[autonomy] 文件触发：${changed.map((x) => x.file).join(',')}`)
      await onTrigger?.({ reason: 'file-change', changed, at: t })
    } catch (e) {
      log?.warn?.(`[autonomy] 文件触发失败：${e?.message ?? e}`)
    } finally { running = false }
  }

  return {
    start() {
      if (timer) return false
      seed()
      timer = setInterval(() => { void tick() }, Math.max(5_000, Number(intervalMs) || 60_000))
      timer.unref?.()
      return true
    },
    stop() { if (timer) clearInterval(timer); timer = null },
    tick,
    files: [...list],
  }
}
