/**
 * 适配层测试（契约 v1.2）
 *
 * 重点钉三件事：
 * 1. 服务缺失 / 抛错 → 降级，不抛到 tick
 * 2. **写**：addEpisode 自动带写专用身份 `{origin:'plugin',plugin:'dsh-autonomy'}`，并成功
 * 3. **读**：recall / episodeRecent / contactOf 不带写身份、被拒后降级；也绝不伪造用户会话 header
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPersonaAdapter } from '../lib/io/persona.js'
import { createMemoryAdapter, DEPRECATED_V10_MODE } from '../lib/io/memory.js'
import { createChannelAdapter } from '../lib/io/channel.js'
import { PLUGIN_WRITE_IDENTITY, isPluginWriteHeader, pluginWriteHeader } from '../lib/io/identity.js'

const WRITE = { origin: 'plugin', plugin: 'dsh-autonomy' }

test('identity / 写身份是冻结的、只含白名单字段', () => {
  assert.deepEqual({ ...PLUGIN_WRITE_IDENTITY }, WRITE)
  assert.equal(Object.isFrozen(PLUGIN_WRITE_IDENTITY), true)
  assert.equal(isPluginWriteHeader(WRITE), true)
  assert.deepEqual(pluginWriteHeader(), WRITE)

  // 用户会话 header 一律不认
  assert.equal(isPluginWriteHeader({ origin: 'plugin', plugin: 'dsh-autonomy', id: 'sid-1' }), false)
  assert.equal(isPluginWriteHeader({ origin: 'plugin', plugin: 'dsh-autonomy', cwd: '/root/x' }), false)
  assert.equal(isPluginWriteHeader({ origin: 'plugin', plugin: 'other-plugin' }), false)
  assert.equal(isPluginWriteHeader({ origin: 'user' }), false)
  assert.equal(isPluginWriteHeader(null), false)
})

test('persona：没有服务时全部降级，不抛', () => {
  const p = createPersonaAdapter({ getService: () => null })
  assert.equal(p.available, false)
  assert.equal(p.selfId(), null)
  assert.equal(p.displayName(), null)
  assert.equal(p.toneHint(), null)
  assert.equal(p.emotionState().degraded, true)
})

test('persona：服务方法抛错也不往外传', () => {
  const p = createPersonaAdapter({
    getService: () => ({
      selfId: () => {
        throw new Error('db down')
      },
      emotion: {
        state: () => {
          throw new Error('x')
        },
      },
    }),
  })
  assert.equal(p.available, true)
  assert.equal(p.selfId(), null)
  assert.equal(p.emotionState().degraded, true)
})

test('memory：没有服务时返回空值，不抛', async () => {
  const m = createMemoryAdapter({ getService: () => null })
  assert.equal(m.available, false)
  assert.deepEqual(await m.recall('q'), [])
  assert.deepEqual(await m.episodeRecent(7, 20), [])
  assert.equal(await m.addEpisode({ text: 't' }), null)
  assert.equal(await m.contactOf('qq', 'x'), null)
  assert.equal(m.lastUserMessageAt(), null)
})

test('memory：服务抛错时降级为空（不把异常带给 tick）', async () => {
  const m = createMemoryAdapter({
    getService: () => ({
      recall: async () => {
        throw new Error('E_PERMISSION')
      },
      addEpisode: async () => {
        throw new Error('E_PERMISSION')
      },
      lastUserMessageAt: () => {
        throw new Error('x')
      },
    }),
  })
  assert.deepEqual(await m.recall('q'), [])
  assert.equal(await m.addEpisode({ text: 't' }), null)
  assert.equal(m.lastUserMessageAt(), null)
})

test('v1.2 / 写：addEpisode 自动带写专用身份并成功，且不夹带用户字段', async () => {
  const seen = []
  const service = {
    addEpisode: async (input) => {
      seen.push(input)
      return { id: 'ep_ok' }
    },
  }
  const m = createMemoryAdapter({ getService: () => service })

  const out = await m.addEpisode({ text: '翻到一段旧档案', source: 'autonomy', actionId: 'act_1' })
  assert.equal(out.id, 'ep_ok')
  assert.deepEqual(seen[0].header, WRITE, '必须带写专用 header')
  assert.equal(seen[0].header.id, undefined)
  assert.equal(seen[0].header.cwd, undefined)
  assert.equal(seen[0].text, '翻到一段旧档案')
  assert.equal(seen[0].source, 'autonomy')
})

test('v1.2 / 读：recall/episodeRecent/contactOf 不带写身份，被拒后降级为空', async () => {
  const seen = { recall: [], episodeRecent: [], contactOf: [] }
  const service = {
    recall: async (q, opts) => {
      seen.recall.push(opts)
      throw new Error('E_PERMISSION')
    },
    episodeRecent: async (d, n, opts) => {
      seen.episodeRecent.push(opts)
      throw new Error('E_PERMISSION')
    },
    contactOf: async (c, id, opts) => {
      seen.contactOf.push(opts)
      throw new Error('E_PERMISSION')
    },
  }
  const m = createMemoryAdapter({ getService: () => service })

  assert.deepEqual(await m.recall('今天'), [])
  assert.deepEqual(await m.episodeRecent(7, 20), [])
  assert.equal(await m.contactOf('qq', 'u1'), null)

  // 读调用里不该出现写身份（也不该凭空造 header）
  assert.equal(seen.recall[0].header, undefined)
  assert.equal(seen.episodeRecent[0], undefined)
  assert.equal(seen.contactOf[0], undefined)
})

test('v1.2 / 读身份可显式配置（将来授权），写身份不被读方法借用', async () => {
  const seen = []
  const readHeader = { id: 'owner-session', cwd: '/root/qq-agent/QQ会话/私聊_owner' }
  const service = {
    recall: async (q, opts) => {
      seen.push({ method: 'recall', opts })
      return [{ id: 'm1', text: 'x', kind: 'fact', score: 0.9 }]
    },
    episodeRecent: async (d, n, opts) => {
      seen.push({ method: 'episodeRecent', opts })
      return []
    },
    contactOf: async (c, id, opts) => {
      seen.push({ method: 'contactOf', opts })
      return null
    },
    addEpisode: async (input) => {
      seen.push({ method: 'addEpisode', input })
      return { id: 'ep_2' }
    },
  }
  const m = createMemoryAdapter({ getService: () => service, header: readHeader })

  const hits = await m.recall('q')
  assert.equal(hits.length, 1)
  assert.deepEqual(seen[0].opts.header, readHeader)

  await m.addEpisode({ text: 't' })
  const writeCall = seen.find((s) => s.method === 'addEpisode')
  assert.deepEqual(writeCall.input.header, WRITE, '写仍用写专用身份，不借用读身份')
})

test('v1.2 / 写身份配错（塞用户会话 header）→ 复位默认写身份，绝不伪造', async () => {
  const seen = []
  const warnings = []
  const service = {
    addEpisode: async (input) => {
      seen.push(input)
      return { id: 'ep_3' }
    },
  }
  const m = createMemoryAdapter({
    getService: () => service,
    log: { info() {}, warn: (m2) => warnings.push(String(m2)) },
    writeHeader: { id: 'owner-session-id', origin: 'plugin', plugin: 'dsh-autonomy' },
  })

  await m.addEpisode({ text: 't' })
  assert.deepEqual(seen[0].header, WRITE, '带上用户字段的 header 必须被拒并复位')
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('不会伪造用户 header'))
})

test('v1.2 / 显式 writeHeader=null 回到 v1.0（已废弃路径，仅调试）', async () => {
  const seen = []
  const service = {
    addEpisode: async (input) => {
      seen.push(input)
      return null // v1.2 下会被 E_PERMISSION 拒，这里模拟「被拒 → 降级」
    },
  }
  const m = createMemoryAdapter({ getService: () => service, writeHeader: null })
  const out = await m.addEpisode({ text: 't' })
  assert.equal(out, null)
  assert.equal(seen[0].header, undefined)
  assert.equal(DEPRECATED_V10_MODE.header, null)
  assert.ok(DEPRECATED_V10_MODE.reason.includes('deprecated'))
})

test('channel：阶段 2 写死没有真实通道', () => {
  const ch = createChannelAdapter({ getService: () => null })
  assert.equal(ch.stage, 'offline-mock-only')
  assert.equal(ch.supportsRealChannel(), false)
  assert.equal(ch.canSendReal(), false)
  assert.equal(ch.canBrowseReal(), false)
  assert.equal(ch.speakUpConflict().status, 'unknown')
})
