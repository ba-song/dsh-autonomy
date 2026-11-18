/**
 * speak-up × autonomy 双发送测试（阶段 4）
 *
 * ⚠ 本文件**只测不修**：不实施 speak-up 降级（归统筹 C 任务卡），不改 speak-up 插件。
 * 目的：把「当前到底会不会双发」变成可执行结论，而不是靠嘴说。
 *
 * 做法：用测试替身模拟 speak-up（有 active()/send()），autonomy 走真实 tick + 两段式发送执行器。
 * 结论（见文件末尾断言）：
 *   1) autonomy 的 status 能识别 conflict（只报告）
 *   2) tick **不看**这个状态 —— 没有互斥门，conflict 时照发
 *   3) 两个入口同时可用时，一次窗口内总外发 = 2 条（双发成立）
 *   4) 因此 C 任务卡（speak-up 降级/收口）完成前，不能把 sendEnabled 打开
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startPlugin, withServices, mockMemory, makeClock, row } from './helpers.mjs'

const NOON = '2026-11-01T12:00:00+08:00'

/** speak-up 测试替身：active() 模拟「它现在也能开口」，send() 记录它发了几条 */
function makeSpeakUpStub({ active = true } = {}) {
  const sent = []
  return {
    active: () => active,
    enabled: () => active,
    send: (text) => {
      sent.push(text)
      return true
    },
    __sent: sent,
  }
}

function openSend({ speakUp = null } = {}) {
  const clock = makeClock(NOON)
  const services = withServices({ memory: mockMemory({ lastUserMessageAt: clock.now() - 2 * 3600_000 }) })
  if (speakUp) services['speak-up'] = speakUp

  const env = startPlugin({
    cfg: {
      enabled: true,
      dryRun: false,
      sendEnabled: true,
      minTickGapMinutes: 0,
      allowedKinds: ['send_qq'],
      outgoing: { ownerAllowlist: ['qq:owner'] },
      urge: { thetaLow: 0.1, thetaHigh: 0.62, delta: 0.08 },
    },
    services,
    clock,
  })

  let delivered = 0
  env.api.registerExecutor(
    'send_qq',
    {
      prepare: async () => ({ ok: true, content: 'autonomy 发的一条', evidence: [{ type: 'episode', id: 'e1' }] }),
      deliver: async () => {
        delivered += 1
        return { ok: true, result: { sent: true } }
      },
    },
    { twoPhase: true, mock: true },
  )

  return { env, speakUp, delivered: () => delivered }
}

test('双发 / 1：speak-up 活跃时，status 能报 conflict（只是报告，不是门）', async (t) => {
  const stub = makeSpeakUpStub({ active: true })
  const { env } = openSend({ speakUp: stub })
  t.after(env.cleanup)

  const st = env.api.status()
  assert.equal(st.channel.speakUp.status, 'conflict')
  assert.equal(st.channel.sendEnabled, true)
  assert.equal(st.channel.ownerAllowlistSize, 1)
})

test('双发 / 2：conflict 状态下 autonomy 照发（没有互斥门）', async (t) => {
  const stub = makeSpeakUpStub({ active: true })
  const { env, delivered } = openSend({ speakUp: stub })
  t.after(env.cleanup)

  const r = await env.api.tick()
  assert.equal(r.outcome, 'ran', '当前实现不会因为 speak-up 活跃而停')
  assert.equal(delivered(), 1, 'autonomy 的 deliver 确实被调了')

  // 审计里没有 SPEAKUP_CONFLICT 这道门（证明"没实现互斥"）
  const logCodes = env.api.db
    .prepare('SELECT code FROM action_log')
    .all()
    .map((x) => x.code)
  assert.ok(!logCodes.includes('SPEAKUP_CONFLICT'), '尚无 SPEAKUP_CONFLICT 拦截记录')

  const tickCodes = env.api.db
    .prepare('SELECT code FROM tick_runs')
    .all()
    .map((x) => x.code)
  assert.ok(!tickCodes.includes('SPEAKUP_CONFLICT'))
})

test('双发 / 3：同一窗口内两个入口各发一条 → 总外发 2（双发成立）', async (t) => {
  const stub = makeSpeakUpStub({ active: true })
  const { env } = openSend({ speakUp: stub })
  t.after(env.cleanup)

  // 模拟 speak-up 自己的定时器到点发一条
  stub.send('speak-up 发的一条')
  // autonomy 同一窗口 tick 一次
  const r = await env.api.tick()
  assert.equal(r.outcome, 'ran')

  assert.equal(stub.__sent.length, 1)
  assert.equal(env.api.db.prepare("SELECT COUNT(1) AS n FROM actions WHERE kind='send_qq' AND status='done'").get().n, 1)
  assert.equal(stub.__sent.length + 1, 2, '一次窗口内两条外发 → 双发')
})

test('双发 / 4：speak-up 不活跃 → status=ok，autonomy 正常发', async (t) => {
  const stub = makeSpeakUpStub({ active: false })
  const { env, delivered } = openSend({ speakUp: stub })
  t.after(env.cleanup)

  assert.equal(env.api.status().channel.speakUp.status, 'ok')
  const r = await env.api.tick()
  assert.equal(r.outcome, 'ran')
  assert.equal(delivered(), 1)
})

test('双发 / 5：没有 speak-up 服务 → unknown（现状默认，无法自动判定）', async (t) => {
  const { env } = openSend({ speakUp: null })
  t.after(env.cleanup)

  const st = env.api.status()
  assert.equal(st.channel.speakUp.status, 'unknown')
  assert.ok(String(st.channel.speakUp.reason).includes('C 任务卡'), '要把「归 C 收口」写在状态里')

  const r = await env.api.tick()
  assert.equal(r.outcome, 'ran', 'unknown 也不构成拦截')
})

test('双发 / 结论：当前版本必须保持 sendEnabled=false，直到 C 任务卡收口', async (t) => {
  const stub = makeSpeakUpStub({ active: true })
  const { env } = openSend({ speakUp: stub })
  t.after(env.cleanup)

  // 事实断言：冲突可被识别，但没有门；这是本阶段的已知限制，不是 bug 修复
  assert.equal(env.api.status().channel.speakUp.status, 'conflict')
  const r = await env.api.tick()
  assert.equal(r.outcome, 'ran')

  const audit = row(env.api, "SELECT COUNT(1) AS n FROM action_log WHERE code='SPEAKUP_CONFLICT'")
  assert.equal(Number(audit.n), 0)
  // 说明：生产默认 sendEnabled=false（见 config 默认值测试），所以离线阶段不构成真实双发风险
  assert.equal(env.api.cfg.sendEnabled, true, '本用例是显式打开的测试场景')
})
