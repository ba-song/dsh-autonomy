import test from 'node:test'
import assert from 'node:assert/strict'
import { PURPOSE_NEEDS, needAffinity, appraiseMaterial, minePurposeSeeds } from '../lib/core/purpose.js'

test('需求亲和 + appraisal', () => {
  assert.ok(needAffinity('一起打游戏吗').play > 0)
  assert.ok(needAffinity('这个插件怎么用').learn > 0)
  assert.equal(appraiseMaterial({ text: '我好想你', need: 'connect' }), 'affectionate')
  assert.equal(appraiseMaterial({ text: '别人都在玩', need: 'share' }), 'envious')
  assert.equal(appraiseMaterial({ text: '有点累', need: 'care' }), 'worried')
})

test('目标假设：带归属/证据/置信度/风险', () => {
  const seeds = minePurposeSeeds({ materials: [{ title: '想玩新游戏', text: '一起开黑吗', kind: 'owner' }], drives: {} })
  assert.equal(seeds.length, 1)
  assert.ok(PURPOSE_NEEDS.includes(seeds[0].need))
  assert.ok(seeds[0].confidence >= 0 && seeds[0].confidence <= 1)
  assert.ok(seeds[0].risk >= 0)
  assert.ok(seeds[0].evidence.includes('开黑'))
})
