/**
 * 集成测试：接**真实 dsh-memory-core**（临时目录 + 测试库，不动生产）
 *
 * 验证三件事：
 * 1. 写：autonomy 的写身份 {origin:'plugin',plugin:'dsh-autonomy'} 能真的写进 dyMemory.addEpisode
 * 2. 幂等：同 dedupeKey 第二次返回同一个 id（duplicate:true），不重复写
 * 3. 读：recall / episodeRecent / contactOf 仍拒绝 plugin 身份；适配层降级为空
 *
 * 说明：这里 import 的是隔壁插件的**代码**（只读使用），不改它的文件、不碰它的生产库。
 * 它不在旁边时测试会 skip，而不是失败 —— 免得把 L 的套件绑死在 M 的环境上。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mockPersona, startPlugin, makeClock } from './helpers.mjs'
import { createMemoryAdapter } from '../lib/io/memory.js'

const WRITE = { origin: 'plugin', plugin: 'dsh-autonomy' }

// ⚠ 必须在 import memory 插件之前设置：它的 DATA_DIR 是模块级常量
const MEM_DIR = mkdtempSync(join(tmpdir(), 'autonomy-mem-int-'))
process.env.DY_MEMORY_DIR = MEM_DIR

let memoryMod = null
let memCfgMod = null
let importError = null
try {
  memCfgMod = await import(new URL('../../dsh-memory-core/lib/config.js', import.meta.url).href)
  memoryMod = await import(new URL('../../dsh-memory-core/lib/index.js', import.meta.url).href)
} catch (e) {
  importError = e
}

function makeMemoryCtx(persona) {
  const services = new Map()
  const ctx = {
    get(n) {
      if (n === 'tools') return { register: () => () => {} }
      if (n === 'systemPrompt') return { context: () => () => {} }
      if (n === 'agents') return { list: () => [] }
      if (n === 'dyPersona') return persona
      return services.get(n) ?? null
    },
    provide(n, v) {
      services.set(n, v)
      return () => services.delete(n)
    },
    on() {},
    emit() {},
    logger: { info() {}, warn() {} },
  }
  return { ctx, services }
}

test('集成 / 真实 dyMemory：写身份能落库，dedupe 幂等，读仍被拒', async (t) => {
  if (!memoryMod) {
    t.skip(`dsh-memory-core 不可用（${importError?.message ?? 'not found'}），跳过集成测试`)
    return
  }
  t.after(() => rmSync(MEM_DIR, { recursive: true, force: true }))

  // 硬保险：memory 插件必须落在临时目录，绝不能碰生产 memory.db
  assert.equal(memCfgMod.DATA_DIR, MEM_DIR, '集成测试必须使用临时 DY_MEMORY_DIR')

  const persona = mockPersona({ selfId: 'self:integration-1' })
  const mem = makeMemoryCtx(persona)
  memoryMod.apply(mem.ctx, { ownerQQ: '1000000001' })

  const svc = mem.services.get('dyMemory')
  assert.ok(svc, '真实 memory 插件应 provide dyMemory')
  for (const m of ['recall', 'episodeRecent', 'addEpisode', 'contactOf', 'lastUserMessageAt']) {
    assert.equal(typeof svc[m], 'function', `dyMemory 缺方法 ${m}`)
  }

  const ownerHeader = { id: 's-owner', cwd: '/root/qq-agent/QQ会话/私聊_1000000001' }

  // ── 1. 走 autonomy 的适配层写一条 episode（= tick 成功后的真实路径） ──
  const env = startPlugin({
    cfg: { enabled: true, dryRun: false, minTickGapMinutes: 0, allowedKinds: ['read_archive'] },
    services: { dyPersona: persona, dyMemory: svc },
    // 真实 memory episodeRecent 按真实 now 回溯 7 天：显式用近几日，避免 1999 fixture 标记
    clock: makeClock(new Date(Date.now() - 3600_000).toISOString()),
  })
  t.after(env.cleanup)

  env.api.registerExecutor(
    'read_archive',
    async () => ({ ok: true, result: { note: 'ok' }, episodeText: '集成测试：翻到一段旧档案，想起没说完的话。' }),
    { mock: true },
  )

  const r = await env.api.tick()
  assert.equal(r.outcome, 'ran')
  assert.ok(r.episodeRef != null, `episode_ref 应回写，实际 ${r.episodeRef}`)

  const rowData = env.api.db.prepare('SELECT episode_ref FROM actions WHERE id=?').get(r.actionId)
  assert.ok(rowData.episode_ref != null, 'actions.episode_ref 要落库')

  // 用主人 header 读回来（memory 的读接口只给 owner）
  const eps = await svc.episodeRecent(7, 20, { header: ownerHeader })
  assert.ok(Array.isArray(eps) && eps.length >= 1, '应能读到刚写的 episode')
  assert.ok(eps.some((e) => String(e.text).includes('集成测试')), '读回的 episode 文本要能对上')

  // ── 2. dedupeKey：同键第二次 → duplicate:true、同一个 id、不重复写 ──
  const a = await svc.addEpisode({ text: '去重测试 episode', source: 'autonomy', dedupeKey: 'int-dedupe-1', header: WRITE })
  const b = await svc.addEpisode({ text: '去重测试 episode', source: 'autonomy', dedupeKey: 'int-dedupe-1', header: WRITE })
  assert.ok(a?.id != null)
  assert.equal(Number(b.id), Number(a.id), '同 dedupeKey 应返回同一个 id')
  assert.equal(b.duplicate, true, '第二次要标 duplicate:true')

  const before = (await svc.episodeRecent(7, 200, { header: ownerHeader })).filter((e) => String(e.text).includes('去重测试')).length
  assert.equal(before, 1, '同 dedupeKey 只该有一条')

  // ── 3. 读仍拒绝 plugin 身份 ──
  await assert.rejects(
    () => svc.recall('档案', { header: WRITE, limit: 3 }),
    (e) => e?.code === 'E_PERMISSION',
    'recall 不该给 plugin 身份放行',
  )
  await assert.rejects(
    () => svc.episodeRecent(7, 5, { header: WRITE }),
    (e) => e?.code === 'E_PERMISSION',
    'episodeRecent 不该给 plugin 身份放行',
  )
  await assert.rejects(
    () => svc.contactOf('qq', 'u1', { header: WRITE }),
    (e) => e?.code === 'E_PERMISSION',
    'contactOf 不该给 plugin 身份放行',
  )

  // ── 4. 适配层：读被拒 → 降级为空，不抛 ──
  const adapter = createMemoryAdapter({ getService: () => svc })
  assert.deepEqual(await adapter.recall('档案'), [])
  assert.deepEqual(await adapter.episodeRecent(7, 5), [])
  assert.equal(await adapter.contactOf('qq', 'u1'), null)

  // ── 5. allowlist：别的 plugin 名写不进去 ──
  await assert.rejects(
    () => svc.addEpisode({ text: 'efi', header: { origin: 'plugin', plugin: 'evil' } }),
    (e) => e?.code === 'E_PERMISSION',
    '不在 allowlist 的 plugin 必须被拒',
  )
})
