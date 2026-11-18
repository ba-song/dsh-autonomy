/**
 * 目标边界测试（阶段 4）：空/超长/未知 kind/重复/终态/limit/空库
 * 只测仓储层，不涉及外发。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startPlugin, withServices } from './helpers.mjs'

function open() {
  return startPlugin({ cfg: { enabled: false, dryRun: true }, services: withServices() })
}

test('goal 边界：title 正好 120 可建，121 拒；空白拒', async (t) => {
  const env = open()
  t.after(env.cleanup)

  const exact = env.api.addGoal({ title: '啊'.repeat(120) })
  assert.equal(exact.ok, true, '120 字应允许')

  const tooLong = env.api.addGoal({ title: '啊'.repeat(121) })
  assert.equal(tooLong.ok, false)
  assert.ok(tooLong.error.includes('120'))

  assert.equal(env.api.addGoal({ title: '\n\t  ' }).ok, false, '纯空白不许')
  assert.equal(env.api.addGoal({}).ok, false, '缺 title 不许')
})

test('goal 边界：kindHint 去空格；空串=通用；__proto__ 不算 kind', async (t) => {
  const env = open()
  t.after(env.cleanup)

  const trimmed = env.api.addGoal({ title: 'A', kindHint: '  read_archive  ' })
  assert.equal(trimmed.ok, true)
  assert.equal(trimmed.goal.kind_hint, 'read_archive', '应该 trim')

  const blank = env.api.addGoal({ title: 'B', kindHint: '   ' })
  assert.equal(blank.ok, true)
  assert.equal(blank.goal.kind_hint, null, '空白 = 通用目标')

  const proto = env.api.addGoal({ title: 'C', kindHint: '__proto__' })
  assert.equal(proto.ok, false, '原型链名字不能当 kind')
  assert.equal(env.api.addGoal({ title: 'D', kindHint: 'constructor' }).ok, false)
})

test('goal 边界：priority 夹取与脏值兜底', async (t) => {
  const env = open()
  t.after(env.cleanup)

  assert.equal(env.api.addGoal({ title: 'p1' }).goal.priority, 0.5, '缺省 0.5')
  assert.equal(env.api.addGoal({ title: 'p2', priority: 2 }).goal.priority, 1)
  assert.equal(env.api.addGoal({ title: 'p3', priority: -1 }).goal.priority, 0)
  assert.equal(env.api.addGoal({ title: 'p4', priority: '0.7' }).goal.priority, 0.7, '数字字符串可接受')
  assert.equal(env.api.addGoal({ title: 'p5', priority: Number.NaN }).goal.priority, 0.5, 'NaN 回落 0.5')
})

test('goal 边界：dueAt 非法拒、空串=无、数值保留', async (t) => {
  const env = open()
  t.after(env.cleanup)

  assert.equal(env.api.addGoal({ title: 'd1', dueAt: 'abc' }).ok, false, '非法时间戳要拒')
  const empty = env.api.addGoal({ title: 'd2', dueAt: '' })
  assert.equal(empty.ok, true)
  assert.equal(empty.goal.due_at, null)

  const ts = 1_800_000_000_000
  assert.equal(env.api.addGoal({ title: 'd3', dueAt: ts }).goal.due_at, ts)
})

test('goal 边界：note 超长截断到 500，不报错', async (t) => {
  const env = open()
  t.after(env.cleanup)

  const r = env.api.addGoal({ title: 'n1', note: 'x'.repeat(900) })
  assert.equal(r.ok, true)
  assert.equal(r.goal.note.length, 500)
})

test('goal 边界：同标题可建多个（不做隐式去重），id 不同', async (t) => {
  const env = open()
  t.after(env.cleanup)

  const a = env.api.addGoal({ title: '重复标题' }).goal
  const b = env.api.addGoal({ title: '重复标题' }).goal
  assert.notEqual(a.id, b.id)
  assert.equal(env.api.listGoals({ status: 'open' }).length, 2)
  assert.equal(env.api.goalCounts().open, 2)
})

test('goal 边界：blocked 可关闭；已终态互改被拒；未知状态拒', async (t) => {
  const env = open()
  t.after(env.cleanup)

  const g = env.api.addGoal({ title: '被卡住的目标' }).goal
  env.api.db.prepare("UPDATE goals SET status='blocked' WHERE id=?").run(g.id)

  const done = env.api.closeGoal({ id: g.id, status: 'done' })
  assert.equal(done.ok, true, 'blocked 不是终态，可以 done')

  assert.equal(env.api.closeGoal({ id: g.id, status: 'open' }).ok, false, '只支持 done/drop')
  assert.equal(env.api.closeGoal({ id: g.id, status: 'dropped' }).ok, false, '已 done 不能改 drop')
})

test('goal 边界：limit 夹取 1..200；空库计数为 0', async (t) => {
  const env = open()
  t.after(env.cleanup)

  for (let i = 0; i < 5; i++) env.api.addGoal({ title: `批量 ${i}` })

  assert.equal(env.api.listGoals({ status: 'open', limit: 0 }).length, 1, 'limit 0 夹到 1')
  assert.equal(env.api.listGoals({ status: 'open', limit: 3 }).length, 3)
  assert.ok(env.api.listGoals({ status: 'open', limit: 999 }).length <= 200)

  const empty = open()
  t.after(empty.cleanup)
  assert.deepEqual(empty.api.goalCounts(), { open: 0, doing: 0, done: 0, dropped: 0, blocked: 0 })
  assert.deepEqual(empty.api.listGoals({ status: 'all' }), [])
})
