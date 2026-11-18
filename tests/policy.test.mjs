/**
 * 纯函数测试：安静时段（F3）、退避、熔断、配置默认值
 * 全部不碰 DB、不碰网络。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  inQuietWindow,
  inQuietHours,
  backoffMs,
  circuitState,
  gapSatisfied,
  pauseActive,
  dayStartInTz,
  minutesOfDayInTz,
} from '../lib/core/policy.js'
import { loadConfig, parseHHMM, capsOf, sanitizeWriteHeader } from '../lib/config.js'

test('F3 / 安静时段：23:30-08:00 的边界与跨天', () => {
  const s = '23:30'
  const e = '08:00'
  assert.equal(inQuietWindow(parseHHMM('23:29'), s, e), false)
  assert.equal(inQuietWindow(parseHHMM('23:30'), s, e), true, '起点含')
  assert.equal(inQuietWindow(parseHHMM('00:00'), s, e), true, '跨天')
  assert.equal(inQuietWindow(parseHHMM('07:59'), s, e), true)
  assert.equal(inQuietWindow(parseHHMM('08:00'), s, e), false, '终点不含')
  assert.equal(inQuietWindow(parseHHMM('12:00'), s, e), false)
})

test('F3 / 安静时段：start === end 视为不启用（不能变全天静音）', () => {
  assert.equal(inQuietWindow(0, '00:00', '00:00'), false)
  assert.equal(inQuietWindow(720, '08:00', '08:00'), false)
})

test('F3 / 安静时段：同日窗口 08:00-12:00', () => {
  assert.equal(inQuietWindow(parseHHMM('07:59'), '08:00', '12:00'), false)
  assert.equal(inQuietWindow(parseHHMM('08:00'), '08:00', '12:00'), true)
  assert.equal(inQuietWindow(parseHHMM('11:59'), '08:00', '12:00'), true)
  assert.equal(inQuietWindow(parseHHMM('12:00'), '08:00', '12:00'), false)
})

test('F3 / inQuietHours 按 Asia/Shanghai 判定', () => {
  const quiet = { start: '23:30', end: '08:00', tz: 'Asia/Shanghai' }
  assert.equal(inQuietHours(Date.parse('2026-11-01T23:45:00+08:00'), quiet), true)
  assert.equal(inQuietHours(Date.parse('2026-11-02T07:59:00+08:00'), quiet), true)
  assert.equal(inQuietHours(Date.parse('2026-11-02T08:00:00+08:00'), quiet), false)
  assert.equal(inQuietHours(Date.parse('2026-11-01T12:00:00+08:00'), quiet), false)
})

test('时区换算：minutesOfDayInTz 与 UTC 不同', () => {
  const t = Date.parse('2026-11-01T00:00:00Z') // 上海 08:00
  assert.equal(minutesOfDayInTz(t, 'Asia/Shanghai'), 8 * 60)
  assert.equal(minutesOfDayInTz(t, 'UTC'), 0)
})

test('F6 / full jitter 退避：有上界、随尝试次数增长、不会无限涨', () => {
  const cfg = { baseSec: 60, factor: 2, capSec: 21_600 }
  const hi = () => 0.999999
  assert.ok(backoffMs(1, cfg, hi) <= 60_000)
  assert.ok(backoffMs(2, cfg, hi) <= 120_000)
  assert.ok(backoffMs(5, cfg, hi) <= 960_000)
  assert.ok(backoffMs(20, cfg, hi) <= 21_600_000, '封顶 6h')
  assert.equal(backoffMs(3, cfg, () => 0), 0, 'full jitter：可能取到 0')
})

test('熔断：连续失败到阈值才开，过窗口自动半开', () => {
  const cfg = { fails: 3, openMinutes: 360 }
  const t0 = 1_800_000_000_000
  assert.equal(circuitState(2, t0, cfg, t0).open, false)
  assert.equal(circuitState(3, t0, cfg, t0).open, true)
  assert.equal(circuitState(3, t0, cfg, t0 + 6 * 3600_000).open, false, '6h 后放行')
  assert.equal(circuitState(3, null, cfg, t0).open, false, '没有失败时间不算')
})

test('冷却与暂停判定', () => {
  const now = 1_800_000_000_000
  assert.equal(gapSatisfied(null, now, 30), true)
  assert.equal(gapSatisfied(now - 10 * 60_000, now, 30), false)
  assert.equal(gapSatisfied(now - 30 * 60_000, now, 30), true)
  assert.equal(pauseActive({ on: true }, now), true)
  assert.equal(pauseActive({ on: true, until: now - 1 }, now), false, '过期自动恢复')
  assert.equal(pauseActive({ on: false }, now), false)
})

test('dayStartInTz：当天起点，且落在 24h 内', () => {
  const now = Date.parse('2026-11-01T12:00:00+08:00')
  const start = dayStartInTz(now, 'Asia/Shanghai')
  assert.ok(start <= now)
  assert.ok(now - start < 24 * 3600_000)
})

test('配置默认值：默认关、默认 dry_run、真实外发被强制关', () => {
  const cfg = loadConfig({}, {})
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.dryRun, true)
  assert.equal(cfg.sendEnabled, false)
  assert.deepEqual(cfg.allowedKinds, ['read_archive', 'organize_memory'])
  assert.equal(cfg.tickMinutes, 10)
  assert.equal(cfg.quietHours.start, '23:30')
  assert.equal(cfg.quietHours.end, '08:00')
  // 契约 v1.2：写身份默认就是白名单里的 plugin 身份；读身份默认没有
  assert.deepEqual(cfg.serviceHeader, { origin: 'plugin', plugin: 'dsh-autonomy' })
  assert.equal(cfg.readServiceHeader, null)
})

test('契约 v1.2 / 写身份清洗：用户会话 header 一律复位为写专用身份', () => {
  assert.deepEqual(sanitizeWriteHeader(undefined), { origin: 'plugin', plugin: 'dsh-autonomy' })
  assert.deepEqual(sanitizeWriteHeader({ origin: 'plugin', plugin: 'dsh-autonomy' }), {
    origin: 'plugin',
    plugin: 'dsh-autonomy',
  })
  // 夹带用户字段 → 复位
  assert.deepEqual(sanitizeWriteHeader({ origin: 'plugin', plugin: 'dsh-autonomy', id: 's1' }), {
    origin: 'plugin',
    plugin: 'dsh-autonomy',
  })
  // 别的 plugin / 别的 origin → 复位
  assert.deepEqual(sanitizeWriteHeader({ origin: 'plugin', plugin: 'evil' }), {
    origin: 'plugin',
    plugin: 'dsh-autonomy',
  })
  assert.deepEqual(sanitizeWriteHeader({ origin: 'user', id: 's1' }), { origin: 'plugin', plugin: 'dsh-autonomy' })
  // 显式 null 才关闭（v1.0 兼容调试）
  assert.equal(sanitizeWriteHeader(null), null)
})

test('配置默认值：dryRun=true 时即便传 sendEnabled=true 也不生效', () => {
  const cfg = loadConfig({ enabled: true, dryRun: true, sendEnabled: true }, {})
  assert.equal(cfg.sendEnabled, false)
  const cfg2 = loadConfig({ enabled: true, dryRun: false, sendEnabled: true }, {})
  assert.equal(cfg2.sendEnabled, true)
})

test('配置：非法 kind 被过滤，空集合回落到默认', () => {
  const cfg = loadConfig({ allowedKinds: ['nope', 'read_archive'] }, {})
  assert.deepEqual(cfg.allowedKinds, ['read_archive'])
  const cfg2 = loadConfig({ allowedKinds: ['nope'] }, {})
  assert.deepEqual(cfg2.allowedKinds, ['read_archive', 'organize_memory'])
})

test('caps 合并：配置可覆盖目录默认', () => {
  const cfg = loadConfig({ caps: { send_qq: { perDay: 1 } } }, {})
  const c = capsOf(cfg, 'send_qq')
  assert.equal(c.perDay, 1)
  assert.equal(c.perHour, null, 'D-007：默认不设每小时上限')
  assert.equal(c.minGapMin, 0, 'D-007：同 kind 冷却移到 antiSpam' )
})
