/**
 * 契约测试（阶段 4，全 mock，不真实调用）
 * - dyMemory：写身份成功 / 读拒绝 / 未知 plugin 拒绝
 * - dyPersona：缺失 / 抛错 / 异步(超时) 降级
 * - dyMemory 超时：episodeRecent 1s 降级为空
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPersonaAdapter } from '../lib/io/persona.js'
import { createMemoryAdapter } from '../lib/io/memory.js'
import { startPlugin, withServices, mockPersona, mockMemory, makeClock, row, count } from './helpers.mjs'

const WRITE = { origin: 'plugin', plugin: 'dsh-autonomy' }

test('契约 / dyMemory：写身份成功、读拒绝、未知 plugin 拒绝', async (t) => {
  const mem = mockMemory()
  const adapter = createMemoryAdapter({ getService: () => mem })

  // 写：成功且带写身份
  const ep = await adapter.addEpisode({ text: '契约测试 episode', source: 'autonomy', actionId: 'act_c1' })
  assert.equal(ep.id, 'ep_1')
  assert.deepEqual(mem.calls.addEpisode[0].header, WRITE)

  // 读：带身份也拒绝 → 适配层降级
  assert.deepEqual(await adapter.recall('随便'), [])
  assert.deepEqual(await adapter.episodeRecent(7, 5), [])
  assert.equal(await adapter.contactOf('qq', 'u1'), null)
  assert.ok(mem.calls.reads.length >= 3, '三次读都被调用过')

  // 未知 plugin：契约只给 dsh-autonomy 放行
  await assert.rejects(
    () => mem.addEpisode({ text: 'evil', header: { origin: 'plugin', plugin: 'evil' } }),
    (e) => e?.code === 'E_PERMISSION',
  )
})

test('契约 / dyPersona 缺失：适配层降级，tick 只能 dry_run', async (t) => {
  const p = createPersonaAdapter({ getService: () => null })
  assert.equal(p.available, false)
  assert.equal(p.selfId(), null)
  assert.equal(p.emotionState().degraded, true)

  const env = startPlugin({
    cfg: {
      enabled: true,
      dryRun: false, // 故意想真跑
      minTickGapMinutes: 0,
      allowedKinds: ['read_archive'],
    },
    services: { dyMemory: mockMemory() }, // 有 memory，没 persona（withServices 会把 null 补成 mock）
  })
  t.after(env.cleanup)

  const r = await env.api.tick()
  assert.equal(r.code, 'DRY_RUN', 'persona 缺失 → 强制 dry_run')

  const st = env.api.status()
  assert.equal(st.services.persona, false)
  assert.equal(st.servicesReady, false)
  assert.ok(st.degraded.includes('persona'))
})

test('契约 / dyPersona 抛错：每个方法都不外传异常，tick 不崩', async (t) => {
  const boom = () => {
    throw new Error('persona db down')
  }
  const broken = {
    selfId: boom,
    displayName: boom,
    personaText: boom,
    voice: boom,
    version: boom,
    emotion: { state: boom, toneHint: boom, why: boom },
  }
  const p = createPersonaAdapter({ getService: () => broken })
  assert.equal(p.selfId(), null)
  assert.equal(p.displayName(), null)
  assert.equal(p.toneHint(), null)
  assert.equal(p.emotionState().degraded, true)

  const env = startPlugin({
    cfg: { enabled: true, dryRun: true, minTickGapMinutes: 0, allowedKinds: ['read_archive'] },
    services: { dyPersona: broken, dyMemory: mockMemory() },
  })
  t.after(env.cleanup)

  const r = await env.api.tick()
  assert.notEqual(r.code, 'TICK_EXCEPTION', 'persona 抛错不能把 tick 打死')

  const a = row(env.api, 'SELECT self_id FROM actions ORDER BY created_at DESC, rowid DESC LIMIT 1')
  assert.equal(a.self_id, 'self:unknown', '拿不到 self_id 时用占位，不编造')
})

test('契约 / dyPersona 异步实现（不兼容/超时）：按同步契约降级，不把 Promise 当值', async (t) => {
  const asyncPersona = {
    ...mockPersona(),
    selfId: () => Promise.resolve('self:async-x'),
    displayName: () => Promise.resolve('异步名字'),
  }
  const p = createPersonaAdapter({ getService: () => asyncPersona })
  assert.equal(p.selfId(), null, 'Promise 不能当字符串用')
  assert.equal(p.displayName(), null)

  const env = startPlugin({
    cfg: { enabled: true, dryRun: true, minTickGapMinutes: 0, allowedKinds: ['read_archive'] },
    services: { dyPersona: asyncPersona, dyMemory: mockMemory() },
  })
  t.after(env.cleanup)

  await env.api.tick()
  const a = row(env.api, 'SELECT self_id FROM actions ORDER BY created_at DESC, rowid DESC LIMIT 1')
  assert.equal(a.self_id, 'self:unknown')
  assert.ok(!String(a.self_id).includes('Promise'), '绝不能把 Promise 序列化进库')
})

test('契约 / dyMemory 超时：episodeRecent 约 1s 降级为空，不抛', async (t) => {
  const never = () => new Promise(() => {})
  const adapter = createMemoryAdapter({
    getService: () => ({ episodeRecent: never, recall: never, contactOf: never }),
  })

  const t0 = Date.now()
  const out = await adapter.episodeRecent(7, 5)
  const cost = Date.now() - t0

  assert.deepEqual(out, [])
  assert.ok(cost < 2_000, `应在 1s 契约附近返回，实际 ${cost}ms`)
})
