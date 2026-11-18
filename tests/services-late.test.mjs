/**
 * A2 · services-missing 修复的回归测试（2026-11-05）
 *
 * 钉两件事：
 * 1. `inject` 必须声明 dyPersona / dyMemory —— cordis 按 inject 等待 provider，
 *    不声明就会先 apply，适配层创建时拿到 undefined（历史 bug）。
 * 2. 适配层不再「创建时缓存 service」：fake ctx 先返回 null、后提供 service 时，
 *    `available` / `selfId` / `status` 必须跟着变，不需要重建插件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { inject } from '../lib/index.js'
import { startPlugin, mockPersona, mockMemory } from './helpers.mjs'

test('A2 / inject：必须声明 dyPersona 与 dyMemory（避免启动竞态永久降级）', () => {
  assert.ok(Array.isArray(inject), 'inject 应是数组')
  assert.ok(inject.includes('tools'))
  assert.ok(inject.includes('timer'))
  assert.ok(inject.includes('dyPersona'), 'inject 缺 dyPersona：会先于 persona 挂载导致 services-missing')
  assert.ok(inject.includes('dyMemory'), 'inject 缺 dyMemory：会先于 memory 挂载导致 services-missing')
})

test('A2 / 服务晚于 autonomy 挂载：available 与 selfId 随 ctx.get 变化，不需要重建', () => {
  // services 对象是引用：makeCtx 每次 get 都重新读它，模拟「provider 后 apply」
  const services = { dyPersona: null, dyMemory: null }
  const h = startPlugin({ services, cfg: { enabled: false } })
  try {
    // 挂载前：两个服务都不可见 → 降级
    assert.equal(h.api.status().services.persona, false)
    assert.equal(h.api.status().services.memory, false)
    assert.equal(h.api.status().servicesReady, false)
    assert.equal(h.api.status().selfId, 'self:unknown')
    assert.equal(h.api.status().dryRunReason, 'services-missing')

    // provider 后到（模拟 persona/memory 的 apply 晚于 autonomy）
    services.dyPersona = mockPersona({ selfId: 'self:late-1', displayName: '汐' })
    services.dyMemory = mockMemory()

    // 同一个插件实例、同一个适配器，必须立刻看到服务
    assert.equal(h.api.status().services.persona, true)
    assert.equal(h.api.status().services.memory, true)
    assert.equal(h.api.status().servicesReady, true)
    assert.equal(h.api.status().selfId, 'self:late-1')
    assert.equal(h.api.selfId(), 'self:late-1')
    // dryRun 仍由配置决定（默认 true），但原因不再是 services-missing
    assert.equal(h.api.status().dryRun, true)
    assert.equal(h.api.status().dryRunReason, 'config')
  } finally {
    h.cleanup()
  }
})
