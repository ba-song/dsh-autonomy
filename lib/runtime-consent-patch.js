/**
 * 每次 DSH 启动时，给 APK 的 native-consent SDK 打一个幂等补丁：
 * policy 只用 1.5s 的 AbortSignal 包住查询；App 偶发变慢时会把查询掐断并误报 CANCELLED。
 * 这里让 SDK 自己用 8s 网络超时，policy 的短信号不再提前终止查询；确认逻辑本身不变。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const FILE = '/run/dsha-launcher/native-consent.cjs'
const BACKUP = '/sdcard/DSHA/工作区/统筹/native-consent.cjs.autopatch.bak'

export function patchNativeConsentSdk(log = null) {
  try {
    if (!existsSync(FILE)) return { ok: false, code: 'SDK_MISSING' }
    let s = readFileSync(FILE, 'utf8')
    if (s.includes('queryTimeout') && s.includes('signal: queryTimeout')) {
      return { ok: true, code: 'ALREADY_PATCHED' }
    }
    const original = s
    if (!s.includes('const queryTimeout = AbortSignal.timeout(8000)')) {
      s = s.replace(
        'return new Promise((resolve, reject) => {',
        'return new Promise((resolve, reject) => {\n    const queryTimeout = AbortSignal.timeout(8000)',
      )
    }
    s = s.replace('signal: init.signal, agent: false', 'signal: queryTimeout, agent: false')
    if (s === original) return { ok: false, code: 'PATTERN_NOT_FOUND' }
    try { if (!existsSync(BACKUP)) copyFileSync(FILE, BACKUP) } catch {}
    writeFileSync(FILE, s, { encoding: 'utf8', mode: 0o600 })
    // policy 在动作执行时 require；清掉旧模块缓存，确保当前进程也加载补丁版
    try { const req = createRequire(import.meta.url); if (req.cache && req.cache[FILE]) delete req.cache[FILE] } catch {}
    log?.info?.('[autonomy] native-consent SDK 已应用 8s 超时补丁')
    return { ok: true, code: 'PATCHED' }
  } catch (e) {
    log?.warn?.(`[autonomy] native-consent SDK 补丁失败（不影响启动）：${String(e?.message ?? e).slice(0, 200)}`)
    return { ok: false, code: 'PATCH_FAILED', error: String(e?.message ?? e).slice(0, 200) }
  }
}
