/**
 * B4 · mock/模拟结果不许进真记忆（2026-11-05）
 *
 * 两道保险：
 * 1. 内置 mock 不再返回 episodeText；
 * 2. tick 成功分支即使收到 episodeText，只要 result.simulated/dryRun（或本次是 dry_run）就跳过 addEpisode。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startPlugin, withServices, mockMemory, mockPersona, makeClock, row } from './helpers.mjs'

const PERSONA = 'self:test-b4'

function open({ memory = mockMemory(), dryRun = false, allowedKinds = ['read_archive'] } = {}) {
  return startPlugin({
    cfg: {
      enabled: true,
      dryRun,
      minTickGapMinutes: 0,
      allowedKinds,
      urge: { thetaLow: 0.2, thetaHigh: 0.9, delta: 0.01 },
      caps: { read_archive: { perDay: 8, minGapMin: 0 } },
    },
    services: withServices({ persona: mockPersona({ selfId: PERSONA }), memory }),
    clock: makeClock(),
  })
}

test('B4 / 内置 mock：simulated 结果不写 episode（真记忆 0 条）', async (t) => {
  const memory = mockMemory()
  const env = open({ memory })
  t.after(env.cleanup)

  const r = await env.api.tick()
  assert.equal(r.outcome, 'ran')
  assert.equal(r.code, 'OK')
  assert.equal(memory.calls.addEpisode.length, 0, '模拟结果绝不能进真记忆')
  const a = row(env.api, 'SELECT episode_ref, result_json FROM actions ORDER BY created_at DESC LIMIT 1')
  assert.equal(a.episode_ref, null)
  assert.equal(JSON.parse(a.result_json).simulated, true)
})

test('B4 / 真执行：正常写 episode（不被过滤误伤）', async (t) => {
  const memory = mockMemory()
  const env = open({ memory })
  t.after(env.cleanup)

  env.api.registerExecutor('read_archive', async () => ({
    ok: true,
    result: { real: true, note: '真实执行' },
    evidence: [],
    episodeText: '翻到一段真实的旧档案',
  }))

  const r = await env.api.tick()
  assert.equal(r.code, 'OK')
  assert.equal(memory.calls.addEpisode.length, 1)
  const input = memory.calls.addEpisode[0]
  assert.equal(input.text, '翻到一段真实的旧档案')
  assert.equal(input.source, 'autonomy')
  assert.equal(input.header.origin, 'plugin')
  const a = row(env.api, 'SELECT episode_ref FROM actions ORDER BY created_at DESC LIMIT 1')
  assert.equal(a.episode_ref, 'ep_1')
})
