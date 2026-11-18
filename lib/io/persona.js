/**
 * dyPersona 适配层（契约 v1.0 §2）
 *
 * 原则：
 * - 服务缺失 / 方法抛错 → 返回 null 或中性值，**绝不把异常抛给 tick**
 * - 不直接打开 persona.db（只走服务；这是插件边界的硬线）
 * - 阶段 2 用 mock 服务对齐签名
 */
const NEUTRAL_EMOTION = { valence: 0, arousal: 0, certainty: 0.5, label: '平静', intensity: 0, degraded: true }

function call(fn, fallback) {
  if (typeof fn !== 'function') return fallback
  try {
    const v = fn()
    // 契约要求同步返回；拿到 Promise 说明实现不兼容/正在超时，直接降级，别把 Promise 当值用
    if (v && typeof v.then === 'function') return fallback
    return v === undefined || v === null ? fallback : v
  } catch {
    return fallback
  }
}

export function createPersonaAdapter({ getService = () => null, log = null } = {}) {
  // 每次调用都重新解析：服务可能晚于 autonomy 挂载（cordis 启动竞态）。
  // 不在创建时缓存 service —— 曾经因为缓存 null 把整个插件永久锁成 dry_run。
  const resolve = () => {
    try {
      return getService() ?? null
    } catch {
      return null
    }
  }
  if (!resolve()) log?.info?.('[autonomy] dyPersona 不可用：降级（只 dry_run）')

  return {
    /** 服务当前是否可用（getter：晚挂载后会变 true） */
    get available() {
      return Boolean(resolve())
    },
    selfId: () => call(() => resolve()?.selfId?.(), null),
    displayName: () => call(() => resolve()?.displayName?.(), null),
    personaText: () => call(() => resolve()?.personaText?.(), null),
    voice: () => call(() => resolve()?.voice?.(), null),
    version: () => call(() => resolve()?.version?.(), null),
    emotionState: () => call(() => resolve()?.emotion?.state?.(), { ...NEUTRAL_EMOTION }),
    toneHint: () => call(() => resolve()?.emotion?.toneHint?.(), null),
  }
}
