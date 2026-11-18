import test from 'node:test'
import assert from 'node:assert/strict'
import { createNotificationTrigger } from '../lib/run/notification-trigger.js'

test('通知触发：只转发白名单，带标题正文，去重', async () => {
  let called = null
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, listener: true, items: [
    { id: 1, package: 'com.ss.android.ugc.aweme', title: '抖音', text: '有人给你发消息' },
    { id: 2, package: 'com.other.app', title: '别的', text: '不该转发' },
  ] }) })
  const t = createNotificationTrigger({ cfg: { notification: { allowPackages: ['com.ss.android.ugc.aweme'], minGapSec: 0, seedOnStart: false } }, fetchImpl, onNotification: async (x) => { called = x } })
  await t.poll()
  assert.ok(called)
  assert.ok(called.prompt.includes('有人给你发消息'))
  assert.equal(called.items.length, 1)
})

test('loadConfig 保留 triggers.notification', async () => {
  const { loadConfig } = await import('../lib/config.js')
  const c = loadConfig({ triggers: { notification: { enabled: true, intervalSec: 5, allowPackages: ['com.ss.android.ugc.aweme'] } } })
  assert.equal(c.triggers.notification.enabled, true)
  assert.deepEqual(c.triggers.notification.allowPackages, ['com.ss.android.ugc.aweme'])
})

test('启动先 seed：已有旧通知不补唤醒', async () => {
  let called = 0
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, listener: true, items: [
    { id: 9, package: 'com.ss.android.ugc.aweme', title: '旧', text: '旧消息' },
  ] }) })
  const t = createNotificationTrigger({ cfg: { notification: { seedOnStart: true, minGapSec: 0 } }, fetchImpl, onNotification: async () => { called += 1 } })
  await t.poll()
  assert.equal(called, 0)
  assert.equal(t.since, 9)
})

test('网页优先：web watcher 健康时 APP 通知只推进游标不重复投', async () => {
  let called = 0
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, listener: true, items: [
    { id: 5, package: 'com.ss.android.ugc.aweme', title: '抖音', text: '新消息' },
  ] }) })
  const t = createNotificationTrigger({
    cfg: { notification: { allowPackages: ['com.ss.android.ugc.aweme'], minGapSec: 0, seedOnStart: false, webPrimary: true, webHealthyMs: 300000 } },
    fetchImpl,
    now: () => 1_800_000_000_000,
    getWebStatus: () => ({ cfgEnabled: true, lastOkAt: 1_800_000_000_000 - 1000 }),
    onNotification: async () => { called += 1 },
  })
  const r = await t.poll()
  assert.equal(r.fired, false)
  assert.equal(r.reason, 'web-primary')
  assert.equal(called, 0)
  assert.equal(t.since, 5)
})

test('网页优先：web watcher 超过健康窗口时 APP 兜底', async () => {
  let called = 0
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, listener: true, items: [
    { id: 6, package: 'com.ss.android.ugc.aweme', title: '抖音', text: '兜底消息' },
  ] }) })
  const t = createNotificationTrigger({
    cfg: { notification: { allowPackages: ['com.ss.android.ugc.aweme'], minGapSec: 0, seedOnStart: false, webPrimary: true, webHealthyMs: 300000 } },
    fetchImpl,
    now: () => 1_800_000_000_000,
    getWebStatus: () => ({ cfgEnabled: true, lastOkAt: 1_800_000_000_000 - 900000 }),
    onNotification: async () => { called += 1 },
  })
  const r = await t.poll()
  assert.equal(r.fired, true)
  assert.equal(called, 1)
})
