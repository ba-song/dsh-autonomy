import test from 'node:test'
import assert from 'node:assert/strict'
import { createDeviceTriggers, normalizeDump } from '../lib/run/device-triggers.js'

const dump = (text) => JSON.stringify({ result: JSON.stringify({ ok: true, text }) })

test('dump 归一化：取窗口应用与前 24 行', () => {
  const d = normalizeDump(dump('窗口应用: com.tencent.mm\n[1] "微信"\n[2] "在吗"'))
  assert.equal(d.app, 'com.tencent.mm')
  assert.ok(d.text.includes('在吗'))
})

test('屏幕触发：首次 seed 不触发，变化才触发，gap 内不重复', async () => {
  let body = dump('窗口应用: a\n屏幕1')
  let t = 1_000_000
  const fired = []
  const tr = createDeviceTriggers({ cfg: { device: { minGapMin: 1, intervalSec: 15 } }, fetchImpl: async () => ({ text: async () => body }), now: () => t, onTrigger: (e) => fired.push(e) })
  await tr.poll()
  assert.equal(fired.length, 0)
  body = dump('窗口应用: a\n屏幕2')
  await tr.poll()
  assert.equal(fired.length, 1)
  body = dump('窗口应用: a\n屏幕3')
  await tr.poll()
  assert.equal(fired.length, 1, 'gap 内不重复')
  t += 120000
  body = dump('窗口应用: a\n屏幕4')
  await tr.poll()
  assert.equal(fired.length, 2)
})
