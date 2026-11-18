import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSeedHistoryEvents } from '../lib/run/home.js'

/**
 * 轮换 seed 不能用 assistant/message：v4 会话校验要求它落在已打开的 turn+step 上，
 * 而宿主每会话的 turn 从 1 开始、seed 无法预知，重启后会被判 corrupt。
 * 这里锁定新契约：seed 历史一律是 user/message（handoff-history），不产生任何 turn。
 */
test('seed 历史只用 user/message，且不伪装成 assistant', () => {
  const msgs = [
    { role: 'user', text: '早' },
    { role: 'assistant', text: '早呀' },
    { role: 'user', text: '   ' },
    { role: 'assistant', text: '吃了吗' },
  ]
  const events = buildSeedHistoryEvents(msgs, { seqOffset: 2, startTime: 1000 })
  assert.equal(events.length, 3, '空消息要跳过')
  assert.ok(events.every((e) => e.type === 'user/message'))
  assert.ok(events.every((e) => e.data.role === 'user'))
  assert.ok(events.every((e) => e.data.source.kind === 'handoff-history'))
  assert.deepEqual(events.map((e) => e.seq), [2, 3, 4])
  assert.equal(events[0].data.content[0].text, '主人：早')
  assert.equal(events[1].data.content[0].text, '汐：早呀')
  assert.ok(!events.some((e) => 'turn' in e.data || 'step' in e.data), '不能带 turn/step')
})
