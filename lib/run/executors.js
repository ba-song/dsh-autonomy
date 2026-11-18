/**
 * 执行器注册表
 *
 * 阶段 2 只装 mock：**没有任何真实通道**（不发 QQ、不刷抖音、不写日记到生产目录）。
 * 以后接真实通道时，也必须先过这里的注册安全校验：
 *   - kind 必须在目录里
 *   - risk=high 的 kind，只有「非 dryRun + sendEnabled」时才允许注册真实实现
 *
 * executor 契约（两种）：
 *   1) 单段式：async (ctx) => { ok, result?, evidence?, episodeText?, error? }
 *   2) 两段式（外发类推荐）：{ prepare(ctx) => {ok, content, evidence}, deliver(ctx, content) => {ok, result} }
 *      两段式的意义：**证据门在 deliver 之前**（F10），没证据就不发。
 *   ctx = { selfId, actionId, kind, dryRun, now, deps, timeoutMs }
 */
import { KINDS, isKnownKind } from '../config.js'

export function createRegistry({ cfg, log = null } = {}) {
  const map = new Map()

  function register(kind, fn, opts = {}) {
    if (!isKnownKind(kind)) throw new Error(`未知行动 kind：${kind}`)
    const twoPhase = opts.twoPhase === true
    if (twoPhase) {
      if (typeof fn?.prepare !== 'function' || typeof fn?.deliver !== 'function') {
        throw new Error(`两段式执行器需要 prepare/deliver：${kind}`)
      }
    } else if (typeof fn !== 'function') {
      throw new Error(`executor 必须是函数：${kind}`)
    }
    const spec = KINDS[kind]
    const isReal = opts.mock !== true
    // 高风险真实执行：必须 dryRun=false 且 sendEnabled=true，二者缺一不可
    if (isReal && spec.risk === 'high' && !(cfg?.dryRun === false && cfg?.sendEnabled === true)) {
      throw new Error(`拒绝注册高风险真实执行器：${kind}（需要 dryRun=false 且 sendEnabled=true）`)
    }
    map.set(kind, { kind, fn, twoPhase, mock: opts.mock === true, risk: spec.risk, registeredAt: Date.now() })
    log?.info?.(`[autonomy] executor 注册：${kind}${opts.mock === true ? '（mock）' : ''}${twoPhase ? '（两段式）' : ''}`)
    return () => map.delete(kind)
  }

  const get = (kind) => map.get(kind)?.fn ?? null
  const entry = (kind) => map.get(kind) ?? null
  const has = (kind) => map.has(kind)
  const list = () => [...map.values()].map((e) => ({ kind: e.kind, mock: e.mock, twoPhase: e.twoPhase, risk: e.risk }))
  return { register, get, entry, has, list }
}

/** 阶段 2 的内置 mock：全部只返回「本来会做什么」，不碰任何真实通道
 *  B4（2026-11-05）：mock 不产出 episodeText —— 模拟结果绝不能写进真记忆（冲突表 B7）。
 *  保留 result.simulated=true，tick 侧还有一道过滤兜底。
 */
export function installMockExecutors(registry, { log = null } = {}) {
  const mock = (kind) =>
    async (ctx) => ({
      ok: true,
      result: { simulated: true, mock: true, kind, dryRun: ctx.dryRun, at: ctx.now },
      evidence: [],
      episodeText: null,
    })

  const kinds = ['read_archive', 'organize_memory', 'write_diary', 'find_sticker', 'browse_douyin', 'send_qq']
  for (const kind of kinds) {
    try {
      registry.register(kind, mock(kind), { mock: true })
    } catch (e) {
      log?.warn?.(`[autonomy] mock 注册失败 ${kind}：${e?.message ?? e}`)
    }
  }
  return registry
}
