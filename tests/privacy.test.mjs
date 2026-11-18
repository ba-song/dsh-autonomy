/**
 * 隐私守卫：本插件目录里不允许出现真实账号标识（QQ 号 / 手机号 / 抖音号）。
 *
 * 为什么写成「拼接后再比」：
 * 如果把真实号明文写进测试文件，测试本身就成了泄露源。这里拆开拼，
 * 磁盘上不会出现连续的完整号码，但运行时能精确匹配。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const FORBIDDEN = [
  ['2971', '030080'].join(''), // 主人 QQ（占位符化之前的真号）
  ['19073', '859346'].join(''), // 绑定手机
  ['1215', '284570'].join(''), // 主人抖音号
  ['5363', '1618573'].join(''), // 汐的抖音号
]

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(js|mjs|cjs|json|md|yml|yaml|txt)$/.test(name)) out.push(p)
  }
  return out
}

test('隐私：插件目录内没有真实 QQ / 手机 / 抖音号', () => {
  const files = walk(ROOT)
  assert.ok(files.length > 10, '应该扫到代码与文档')

  const hit = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    for (const needle of FORBIDDEN) {
      if (text.includes(needle)) hit.push(`${f.replace(ROOT, '')} → ${needle.slice(0, 3)}***`)
    }
  }
  assert.deepEqual(hit, [], `发现真实账号标识：\n${hit.join('\n')}`)
})

test('隐私：契约要求用占位符，不用真实号', () => {
  const cfg = readFileSync(join(ROOT, 'lib/config.js'), 'utf8')
  // 插件不硬编码任何 owner 标识；owner 相关内容只应出现在测试/文档的占位形式里
  assert.ok(!/ownerQQ|ownerPhone|QQ号\s*[:：]\s*\d{6,}/.test(cfg), 'config.js 不该硬编码 owner 号码')
})
