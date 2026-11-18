/**
 * 插件身份（契约 v1.2 §5.1）
 *
 * autonomy 是**后台插件**：没有用户会话 header，也不许伪造。
 * 契约只给一个「写专用」身份，用于 dyMemory.addEpisode：
 *     { origin: 'plugin', plugin: 'dsh-autonomy' }
 *
 * 读方法（recall / episodeRecent / contactOf）**仍然拒绝**这个身份 —— 所以这里
 * 只有写身份，没有任何「读身份」的默认值。
 */

export const PLUGIN_ID = 'dsh-autonomy'

export const PLUGIN_WRITE_IDENTITY = Object.freeze({
  origin: 'plugin',
  plugin: PLUGIN_ID,
})

/** 用户会话 header 才有的字段：出现任何一个都说明这是伪造/串号，必须拒绝 */
export const USER_SESSION_FIELDS = Object.freeze([
  'id',
  'cwd',
  'sessionId',
  'parentSession',
  'delegationDepth',
  'session',
])

/** 是不是契约允许的写专用身份 */
export function isPluginWriteHeader(h) {
  if (!h || typeof h !== 'object') return false
  if (h.origin !== 'plugin' || h.plugin !== PLUGIN_ID) return false
  for (const k of ['id', 'cwd', 'sessionId', 'parentSession', 'delegationDepth', 'session']) {
    if (h[k] !== undefined && h[k] !== null && h[k] !== '') return false
  }
  return true
}

/** 每次给一份新的（避免调用方改到冻结对象） */
export function pluginWriteHeader() {
  return { ...PLUGIN_WRITE_IDENTITY }
}
