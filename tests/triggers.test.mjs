import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileTriggers } from '../lib/run/triggers.js'

test('文件触发：mtime 变了才触发，minGap 内不重复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autonomy-trigger-'))
  const f = join(dir, 'a.txt')
  // 2026-11-14：显式设置 mtime，不再依赖两次 writeFileSync 落在不同毫秒。
  // 本机 mtime 粒度粗时（实测 200 次里 81 次同毫秒）sleep 20ms 不能保证 mtime 变化，
  // 会让这个与业务无关的用例随机失败。mtime 与 now() 是两条独立时间轴，这里只需单调递增。
  const setMtime = (ms) => utimesSync(f, new Date(ms), new Date(ms))
  writeFileSync(f, '1')
  setMtime(1_700_000_000_000)
  const fired = []
  let t = 1_000_000
  const tr = createFileTriggers({ files: [f], minGapMs: 1000, now: () => t, onTrigger: (e) => fired.push(e) })
  tr.start()
  await tr.tick() // no change
  assert.equal(fired.length, 0)
  writeFileSync(f, '2')
  setMtime(1_700_000_001_000)
  await tr.tick()
  assert.equal(fired.length, 1)
  writeFileSync(f, '3')
  setMtime(1_700_000_002_000)
  await tr.tick()
  assert.equal(fired.length, 1, 'minGap 内不重复')
  t += 2000
  writeFileSync(f, '4')
  setMtime(1_700_000_003_000)
  await tr.tick()
  assert.equal(fired.length, 2)
  tr.stop()
  rmSync(dir, { recursive: true, force: true })
})
