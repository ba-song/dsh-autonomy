/**
 * 目标四件套（阶段 3）：add / list / done / drop + 进打分（goalAffinity）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startPlugin, withServices, row, rows } from './helpers.mjs'

function open(cfg = {}) {
  return startPlugin({
    cfg: { enabled: false, dryRun: true, ...cfg },
    services: withServices(),
  })
}

test('goal_add：默认 open、priority 夹到 0..1、kindHint 校验', async (t) => {
  const env = open()
  t.after(env.cleanup)

  const r = env.api.addGoal({ title: '想学会整理相册', priority: 1.7, kindHint: 'organize_memory' })
  assert.equal(r.ok, true)
  assert.equal(r.goal.status, 'open')
  assert.equal(r.goal.priority, 1)
  assert.equal(r.goal.kind_hint, 'organize_memory')
  assert.equal(r.goal.source, 'self')
  assert.ok(String(r.goal.id).startsWith('goal_'))

  assert.equal(env.api.addGoal({ title: '   ' }).ok, false, '空标题要拒')
  assert.equal(env.api.addGoal({ title: 'x'.repeat(121) }).ok, false, '超长标题要拒')
  assert.equal(env.api.addGoal({ title: '学习', kindHint: 'nope' }).ok, false, '未知 kind 要拒')

  const bad = env.api.addGoal({ title: '学习', priority: -3 })
  assert.equal(bad.ok, true)
  assert.equal(bad.goal.priority, 0, '负数夹到 0')
})

test('goal_list：open 含 doing；all 能看到终态；计数对得上', async (t) => {
  const env = open()
  t.after(env.cleanup)

  const a = env.api.addGoal({ title: 'A', priority: 0.9 })
  const b = env.api.addGoal({ title: 'B', priority: 0.3 })
  env.api.addGoal({ title: 'C', priority: 0.5 })

  env.api.closeGoal({ id: b.goal.id, status: 'done' })

  const openList = env.api.listGoals({ status: 'open' })
  assert.equal(openList.length, 2, 'open 默认含 doing，不含 done')
  assert.ok(openList.every((g) => g.status === 'open' || g.status === 'doing'))

  const all = env.api.listGoals({ status: 'all' })
  assert.equal(all.length, 3)

  const counts = env.api.goalCounts()
  assert.equal(counts.open, 2)
  assert.equal(counts.done, 1)

  // 按 priority 降序
  assert.equal(openList[0].id, a.goal.id)
})

test('goal_done / goal_drop：终态幂等，互相不能改', async (t) => {
  const env = open()
  t.after(env.cleanup)

  const g = env.api.addGoal({ title: '想写一篇日记', kindHint: 'write_diary' }).goal

  const done1 = env.api.closeGoal({ id: g.id, status: 'done', note: '写完了' })
  assert.equal(done1.ok, true)
  assert.equal(done1.noop, false)
  assert.equal(done1.goal.status, 'done')

  const done2 = env.api.closeGoal({ id: g.id, status: 'done' })
  assert.equal(done2.ok, true)
  assert.equal(done2.noop, true, '重复 done 要幂等')

  const drop = env.api.closeGoal({ id: g.id, status: 'dropped' })
  assert.equal(drop.ok, false, '已是终态不能改成另一个终态')

  assert.equal(env.api.closeGoal({ id: 'goal_nope', status: 'done' }).ok, false, '不存在的目标要报错')
  assert.equal(env.api.closeGoal({ id: g.id, status: 'open' }).ok, false, '只支持 done/drop')
})

test('goalAffinity：指定 kind 的高优先目标能改变选择', async (t) => {
  // 基线：没有目标时，read_archive 分数更高（读类更便宜）
  const env1 = open({ enabled: true, dryRun: true, minTickGapMinutes: 0, allowedKinds: ['read_archive', 'organize_memory'] })
  t.after(env1.cleanup)
  const r1 = await env1.api.tick()
  assert.equal(r1.kind, 'read_archive', '没目标时应该选 read_archive')

  // 加一个指向 organize_memory 的高优先目标 → 应该改选 organize_memory
  const env2 = open({ enabled: true, dryRun: true, minTickGapMinutes: 0, allowedKinds: ['read_archive', 'organize_memory'] })
  t.after(env2.cleanup)
  env2.api.addGoal({ title: '把记忆整理干净', priority: 1, kindHint: 'organize_memory' })

  const r2 = await env2.api.tick()
  assert.equal(r2.kind, 'organize_memory', '目标应该把 organize_memory 抬上来')

  const d = JSON.parse(row(env2.api, 'SELECT decision_json FROM actions ORDER BY rowid DESC LIMIT 1').decision_json)
  const picked = d.ranked.find((x) => x.kind === 'organize_memory')
  assert.ok(picked, 'decision 里要有打分记录')
  assert.equal(d.parts.goalAffinity, 1, '命中目标时 goalAffinity=priority')
})

test('goal 工具：四个都注册且能用', async (t) => {
  const env = open()
  t.after(env.cleanup)

  const names = env.registered.map((d) => d.name)
  for (const n of ['dy_life_goal_add', 'dy_life_goal_list', 'dy_life_goal_done', 'dy_life_goal_drop']) {
    assert.ok(names.includes(n), `缺工具 ${n}`)
  }

  const add = env.registered.find((d) => d.name === 'dy_life_goal_add')
  const out = await add.execute({ title: '整理一下表情包', priority: 0.7 })
  assert.equal(out.ok, true)
  const goal = JSON.parse(out.detail).goal

  const list = env.registered.find((d) => d.name === 'dy_life_goal_list')
  const listed = JSON.parse((await list.execute({})).detail)
  assert.equal(listed.goals.length, 1)
  assert.equal(listed.goals[0].id, goal.id)

  const done = env.registered.find((d) => d.name === 'dy_life_goal_done')
  const doneOut = await done.execute({ id: goal.id })
  assert.equal(doneOut.ok, true)
  assert.equal(JSON.parse(doneOut.detail).goal.status, 'done')

  const drop = env.registered.find((d) => d.name === 'dy_life_goal_drop')
  const dropOut = await drop.execute({ id: goal.id })
  assert.equal(dropOut.ok, false, '已 done 不能再 drop')

  const bad = await drop.execute({ id: 'goal_missing' })
  assert.equal(bad.ok, false)
})
