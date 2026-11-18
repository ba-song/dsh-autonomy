/**
 * dyMemory 适配层（契约 v1.2）
 *
 * v1.2 的关键变化（见 /sdcard/我的文档/接口契约-v1.2.md §5.1）：
 *   - **写**：`addEpisode` 使用写专用身份 `{origin:'plugin', plugin:'dsh-autonomy'}`
 *   - **读**：`recall` / `episodeRecent` / `contactOf` 仍拒绝该身份；本插件默认**不带任何 header**，
 *           拿不到就降级（空数组 / null），绝不伪造用户会话 header
 *
 * ⚠ v1.0 的「addEpisode 不带 header」路径已废弃（deprecated）：
 *    那段只在契约 v1.0 时代成立，现在会被 memory 以 E_PERMISSION 拒绝。
 *    保留 `DEPRECATED_V10_MODE` 常量只是为了把「已废弃」写进代码，不要再用。
 *
 * 超时口径按契约：recall 3s / episodeRecent 1s / addEpisode 1s / contactOf 200ms。
 * 一律不抛到 tick：超时 / 异常都降级成空值。不直接读 memory.db。
 */
import { PLUGIN_WRITE_IDENTITY, isPluginWriteHeader } from './identity.js'

const TIMEOUTS = { recall: 3000, episodeRecent: 1000, addEpisode: 1000, contactOf: 200 }

/** @deprecated 契约 v1.0 口径（无 header）；v1.2 起不再使用 */
export const DEPRECATED_V10_MODE = Object.freeze({
  header: null,
  reason: 'contract v1.0 no-header path is deprecated by v1.2',
})

function withTimeout(promise, ms, fallback) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
    if (typeof timer?.unref === 'function') timer.unref()
  })
  return Promise.race([Promise.resolve(promise).catch(() => fallback), timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export function createMemoryAdapter({
  getService = () => null,
  log = null,
  header = null, // 读身份（默认没有；将来统筹者显式授权才配）
  writeHeader = PLUGIN_WRITE_IDENTITY, // 写身份（v1.2 默认就是契约白名单）
} = {}) {
  // 每次调用都重新解析：服务可能晚于 autonomy 挂载（cordis 启动竞态）。
  // 不在创建时缓存 service —— 曾经因为缓存 null 把整个插件永久锁成 dry_run。
  const resolve = () => {
    try {
      return getService() ?? null
    } catch {
      return null
    }
  }
  if (!resolve()) log?.info?.('[autonomy] dyMemory 不可用：降级（不写 episode、不发消息）')

  // 写身份只认契约白名单；配错（例如塞了用户会话 header）就退回默认写身份，绝不伪造。
  let writeIdentity = { ...PLUGIN_WRITE_IDENTITY }
  if (writeHeader === null) {
    writeIdentity = null // 显式关闭：仅用于调试 v1.0 兼容路径
  } else if (isPluginWriteHeader(writeHeader)) {
    writeIdentity = { origin: 'plugin', plugin: writeHeader.plugin }
  } else {
    log?.warn?.('[autonomy] serviceHeader 不是契约允许的写专用身份，已退回默认（不会伪造用户 header）')
  }

  return {
    /** 服务当前是否可用（getter：晚挂载后会变 true） */
    get available() {
      return Boolean(resolve())
    },

    /** 当前写身份（状态/调试用；不含任何用户字段） */
    writeIdentity: () => (writeIdentity ? { ...writeIdentity } : null),

    async recall(query, opts = {}) {
      const service = resolve()
      if (typeof service?.recall !== 'function') return []
      // 读：只用显式配置的读身份；绝不把写身份带进读方法
      const args = header ? { limit: 5, ...opts, header } : { limit: 5, ...opts }
      let pending
      try {
        pending = service.recall(query, args)
      } catch {
        return []
      }
      const out = await withTimeout(pending, TIMEOUTS.recall, [])
      return Array.isArray(out) ? out : []
    },

    async episodeRecent(days = 7, limit = 20) {
      const service = resolve()
      if (typeof service?.episodeRecent !== 'function') return []
      let pending
      try {
        pending = header ? service.episodeRecent(days, limit, { header }) : service.episodeRecent(days, limit)
      } catch {
        return []
      }
      const out = await withTimeout(pending, TIMEOUTS.episodeRecent, [])
      return Array.isArray(out) ? out : []
    },

    /** @returns {Promise<{id:string, duplicate?:boolean}|null>} v1.2：自动带写专用 header */
    async addEpisode(input = {}) {
      const service = resolve()
      if (typeof service?.addEpisode !== 'function') return null
      try {
        const payload = writeIdentity ? { ...input, header: writeIdentity } : input
        const out = await withTimeout(service.addEpisode(payload), TIMEOUTS.addEpisode, null)
        return out && typeof out === 'object' ? out : null
      } catch {
        return null
      }
    },

    /** 契约 v1.3 saveDiary：后台插件写身份；不抛，返回 {ok,id|code} */
    async saveDiary(input = {}) {
      const service = resolve()
      if (typeof service?.saveDiary !== 'function') return { ok: false, code: 'UNAVAILABLE' }
      try {
        const payload = writeIdentity ? { ...input, header: writeIdentity } : input
        const out = await withTimeout(service.saveDiary(payload), 3000, null)
        if (!out || typeof out !== 'object') return { ok: false, code: 'SAVE_FAILED' }
        return { ok: true, ...out }
      } catch (e) {
        return { ok: false, code: e?.code ?? 'SAVE_FAILED', error: String(e?.message ?? e).slice(0, 300) }
      }
    },

    /** 契约：saveEmail 写入渠道/email 原话 + owner episode，按 messageId 去重 */
    async saveEmail(input = {}) {
      const service = resolve()
      if (typeof service?.saveEmail !== 'function') return { ok: false, code: 'UNAVAILABLE' }
      try {
        const payload = writeIdentity ? { ...input, header: writeIdentity } : input
        const out = await withTimeout(service.saveEmail(payload), 5000, null)
        if (!out || typeof out !== 'object') return { ok: false, code: 'SAVE_FAILED' }
        return { ok: true, ...out }
      } catch (e) {
        return { ok: false, code: e?.code ?? 'SAVE_FAILED', error: String(e?.message ?? e).slice(0, 200) }
      }
    },

    async contactOf(channel, externalId) {
      const service = resolve()
      if (typeof service?.contactOf !== 'function') return null
      let pending
      try {
        pending = header ? service.contactOf(channel, externalId, { header }) : service.contactOf(channel, externalId)
      } catch {
        return null
      }
      const out = await withTimeout(pending, TIMEOUTS.contactOf, null)
      return out && typeof out === 'object' ? out : null
    },

    /** 契约里是同步方法、不敏感；也容忍实现返回 Promise（视为不支持） */
    lastUserMessageAt() {
      const service = resolve()
      if (typeof service?.lastUserMessageAt !== 'function') return null
      try {
        const v = service.lastUserMessageAt()
        if (v && typeof v.then === 'function') return null
        const n = Number(v)
        return Number.isFinite(n) && n > 0 ? n : null
      } catch {
        return null
      }
    },
  }
}
