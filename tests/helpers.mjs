/**
 * 测试脚手架：临时目录 + 假时钟 + mock 服务 + 假 ctx
 * 原则：不碰真实通道、不碰生产目录、不读任何真实 DB。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

export const TEST_FIXTURE_ISO = '1999-01-01T12:00:00+08:00'

export function makeClock(startIso = TEST_FIXTURE_ISO) {
  let now = Date.parse(startIso)
  return {
    now: () => now,
    set: (ms) => {
      now = ms
    },
    advance: (ms) => {
      now += ms
    },
    iso: () => new Date(now).toISOString(),
  }
}

export function makeTempDir(prefix = 'autonomy-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export function mockPersona({ selfId = 'self:test-1', displayName = '汐', toneHint = '温和，短句', emotion = null } = {}) {
  return {
    selfId: () => selfId,
    displayName: () => displayName,
    personaText: () => '（mock 人格文本）',
    voice: () => '口语、短句',
    block: () => ({ mode: 'full', text: '（mock）' }),
    version: () => ({ personaVersion: 1, nameVersion: 1, hash: 'mock' }),
    emotion: {
      state: () => emotion ?? { valence: 0.1, arousal: 0.2, certainty: 0.6, label: '平静', intensity: 0.2 },
      toneHint: () => toneHint,
      why: () => ({ points: [] }),
    },
  }
}

/**
 * v1.2 口径的 dyMemory mock：
 * - addEpisode：必须带写专用 header `{origin:'plugin',plugin:'dsh-autonomy'}`，否则 E_PERMISSION
 * - recall / episodeRecent / contactOf：**一律拒绝**（后台插件没有读授权）
 * - lastUserMessageAt：不敏感，不要求 header
 * 记录每次调用的 header，供测试断言「写带身份、读不带身份」。
 */
export function mockMemory({ lastUserMessageAt = null, episodes = [], requireWriteHeader = true } = {}) {
  const calls = { addEpisode: [], episodeRecent: [], recall: [], contactOf: [], reads: [] }

  const err = (msg) => {
    const e = new Error(`E_PERMISSION: ${msg}`)
    e.code = 'E_PERMISSION'
    return e
  }
  const rejectRead = (method, payload) => {
    calls[method].push(payload)
    calls.reads.push({ method, payload })
    throw err(`${method} 拒绝后台插件读`)
  }

  return {
    calls,
    recall: async (q, opts) => rejectRead('recall', { q, opts }),
    episodeRecent: async (d, n, opts) => rejectRead('episodeRecent', { d, n, opts }),
    contactOf: async (c, id, opts) => rejectRead('contactOf', { c, id, opts }),
    addEpisode: async (input) => {
      calls.addEpisode.push(input)
      const h = input?.header
      const ok =
        !requireWriteHeader ||
        (h && h.origin === 'plugin' && h.plugin === 'dsh-autonomy' && h.id === undefined && h.cwd === undefined)
      if (!ok) throw err('addEpisode 缺写专用 header')
      return { id: `ep_${calls.addEpisode.length}` }
    },
    lastUserMessageAt: () => lastUserMessageAt,
  }
}

export function makeCtx({ services = {}, logger = null } = {}) {
  const registered = []
  const intervalJobs = []
  const timeoutJobs = []
  const listeners = {}
  const provided = {}
  const log = logger ?? { info() {}, warn() {} }

  const ctx = {
    logger: log,
    get(name) {
      if (name === 'tools') return { register: (def) => registered.push(def) }
      return services[name] ?? null
    },
    provide(name, value) {
      provided[name] = value
      return () => {
        delete provided[name]
      }
    },
    interval(cb, ms) {
      intervalJobs.push({ cb, ms })
      return () => {
        const i = intervalJobs.findIndex((j) => j.cb === cb)
        if (i >= 0) intervalJobs.splice(i, 1)
      }
    },
    timeout(cb, ms) {
      timeoutJobs.push({ cb, ms })
      return () => {}
    },
    on(event, fn) {
      ;(listeners[event] ??= []).push(fn)
    },
    emit(event, ...args) {
      // 原生 session/event 是 (session, event) 两个参数；旧测试只传 payload 也兼容
      for (const fn of listeners[event] ?? []) fn(...args)
    },
  }

  return { ctx, registered, intervalJobs, timeoutJobs, listeners, provided, log }
}

/**
 * 起一个插件实例（临时库）
 * @returns {{ api, ctx, registered, clock, dir, close, cleanup, services }}
 */
export function startPlugin({ cfg = {}, services = {}, clock = null, random = Math.random, dir: givenDir = null, mailRunner = null } = {}) {
  const own = givenDir == null
  const { dir, cleanup: rmDir } = own ? makeTempDir() : { dir: givenDir, cleanup: () => {} }
  const clk = clock ?? makeClock()
  const wired = makeCtx({ services })

  // 测试隔离：所有 home 日志默认落到本次 tmp；显式传值优先
  const isolatedCfg = cfg.home
    ? { ...cfg, home: { ...cfg.home, logPath: cfg.home.logPath ?? join(dir, 'logs', 'autonomy.log'), deliverLog: cfg.home.deliverLog ?? join(dir, 'home', 'deliver.log') } }
    : cfg
  const api = apply(wired.ctx, {
    dataDir: dir,
    dbPath: join(dir, 'autonomy.db'),
    homeLoop: false, // 测试默认不自动挂 home 定时器；C2 测试显式传 homeLoop:true
    ...isolatedCfg,
    ...(mailRunner ? { mailRunner } : {}),
    clock: clk.now,
    random,
  })

  const close = () => {
    try {
      api.stopTimer()
    } catch {}
    try {
      api.db.close()
    } catch {}
  }
  const cleanup = () => {
    close()
    if (own) rmDir()
  }
  return { api, ctx: wired.ctx, registered: wired.registered, provided: wired.provided, intervalJobs: wired.intervalJobs, timeoutJobs: wired.timeoutJobs, clock: clk, dir, close, cleanup, services }
}

/** 便捷：带「人格 + 记忆」两个 mock 服务 */
export function withServices({ persona = null, memory = null } = {}) {
  return {
    dyPersona: persona ?? mockPersona(),
    dyMemory: memory ?? mockMemory(),
  }
}

/** 读 DB 小工具 */
export function rows(api, sql, ...params) {
  return api.db.prepare(sql).all(...params)
}
export function row(api, sql, ...params) {
  return api.db.prepare(sql).get(...params) ?? null
}

export function count(api, table) {
  return Number(row(api, `SELECT COUNT(1) AS n FROM ${table}`)?.['n'] ?? 0)
}
