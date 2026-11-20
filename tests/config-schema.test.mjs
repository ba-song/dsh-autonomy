import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { Config } from '../lib/index.js'
import { DEFAULTS, loadConfig, unwrapVolatile } from '../lib/config.js'

const PROFILE_PATCH = process.env.DSH_PROFILE_PATCH ?? '/root/.dsh/profiles/web/cordis.patch.yml'

/** 读 profile 里 autonomy 的 config 片段；拿不到就返回 undefined（测试可跳过）。 */
async function readProfileAutonomyConfig() {
  if (!existsSync(PROFILE_PATCH)) return undefined
  const { parse } = await import('yaml')
  const entries = parse(readFileSync(PROFILE_PATCH, 'utf8'))
  const entry = Array.isArray(entries) ? entries.find((row) => row?.id === 'autonomy') : undefined
  return entry?.config
}

/** 把 schema 的 dict 树里标了 volatile 的路径全找出来（排序后返回）。 */
function volatilePaths(schema, path = []) {
  const out = []
  for (const [key, child] of Object.entries(schema.dict ?? {})) {
    const target = [...path, key]
    if (child.meta?.volatile) out.push(target.join('.'))
    out.push(...volatilePaths(child, target))
  }
  return out.sort()
}

test('Config：导出的 schemastery schema 能解析 DEFAULTS', () => {
  assert.equal(typeof Config?.['~standard']?.validate, 'function')
  const result = Config['~standard'].validate(structuredClone(DEFAULTS))
  assert.equal(result.issues, undefined)
  assert.equal(result.value.enabled.get(), DEFAULTS.enabled)
  assert.equal(result.value.home.enabled.get(), DEFAULTS.home.enabled)
  assert.equal(result.value.home.minIntervalMin.get(), DEFAULTS.home.minIntervalMin)
  assert.equal(result.value.home.maxIntervalMin.get(), DEFAULTS.home.maxIntervalMin)
  // 未声明的键（mail/tick/allowedKinds/home.dice…）必须原样保留
  assert.deepEqual(result.value.mail, DEFAULTS.mail)
  assert.deepEqual(result.value.tick, DEFAULTS.tick)
  assert.deepEqual(result.value.allowedKinds, DEFAULTS.allowedKinds)
  assert.deepEqual(result.value.home.dice, DEFAULTS.home.dice)
})

test('Config：解析后 loadConfig 与解析前完全一致（运行时行为不变）', () => {
  const resolved = Config['~standard'].validate(structuredClone(DEFAULTS)).value
  assert.deepEqual(loadConfig(resolved), loadConfig(structuredClone(DEFAULTS)))
})

test('Config：volatile 字段集合与设置卡片一致，永久档案调度配置不暴露为设置项', () => {
  assert.deepEqual(volatilePaths(Config), ['drives.extended', 'enabled', 'home.enabled', 'home.maxIntervalMin', 'home.minIntervalMin', 'pauseAll', 'purpose.enabled', 'triggers.device.enabled', 'triggers.notification.enabled'])
  assert.deepEqual(volatilePaths(Config.dict.homeArchiveMaintenance), [])
  const resolved = Config['~standard'].validate(structuredClone(DEFAULTS)).value
  assert.deepEqual(loadConfig(resolved).homeArchiveMaintenance, loadConfig(structuredClone(DEFAULTS)).homeArchiveMaintenance)
})

test('Config：minIntervalMin/maxIntervalMin 范围 15..1440', () => {
  const ok = (v) => Config['~standard'].validate({ home: { minIntervalMin: v } })
  assert.equal(ok(15).issues, undefined)
  assert.equal(ok(1440).issues, undefined)
  assert.notEqual(ok(14).issues, undefined)
  assert.notEqual(ok(1441).issues, undefined)
  assert.equal(ok(45).value.home.minIntervalMin.get(), 45)
})

test('Config：能解析 profile 里现有的 autonomy 配置片段', async (t) => {
  const profileConfig = await readProfileAutonomyConfig()
  if (profileConfig === undefined) {
    t.skip(`profile patch 不存在或没有 autonomy 条目：${PROFILE_PATCH}`)
    return
  }
  const result = Config['~standard'].validate(structuredClone(profileConfig))
  assert.equal(result.issues, undefined)
  const value = result.value
  assert.equal(value.enabled.get(), profileConfig.enabled)
  assert.equal(value.home.enabled.get(), profileConfig.home.enabled)
  assert.equal(value.home.minIntervalMin.get(), profileConfig.home.minIntervalMin)
  assert.equal(value.home.maxIntervalMin.get(), profileConfig.home.maxIntervalMin)
  // 未声明的大配置必须逐键保留
  for (const key of ['mail', 'tick', 'dryRun', 'sendEnabled', 'allowedKinds']) {
    assert.deepEqual(value[key], profileConfig[key], `未声明键 ${key} 必须原样保留`)
  }
  for (const key of ['cwd', 'respectDryRun', 'agentPreset', 'rotateRatio', 'contextLimit', 'dice']) {
    assert.deepEqual(value.home[key], profileConfig.home[key], `home.${key} 必须原样保留`)
  }
  // 解析后的配置跑 loadConfig 必须和原来的 profile 片段一致
  assert.deepEqual(loadConfig(value), loadConfig(structuredClone(profileConfig)))
})

test('loadConfig：入口解开 volatile 引用（含裸 {get}）', () => {
  const cfg = loadConfig({ home: { minIntervalMin: { get: () => 45 } }, enabled: { get: () => true } })
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.home.minIntervalMin, 45)
  assert.equal(cfg.home.maxIntervalMin, DEFAULTS.home.maxIntervalMin)

  // 真实 schemastery 解析出来的引用（带 cosmokit 标记）同样要解开
  const resolved = Config['~standard'].validate({ enabled: true, home: { enabled: true, minIntervalMin: 45 } }).value
  const cfg2 = loadConfig(resolved)
  assert.equal(cfg2.enabled, true)
  assert.equal(cfg2.home.enabled, true)
  assert.equal(cfg2.home.minIntervalMin, 45)
  assert.equal(cfg2.home.maxIntervalMin, DEFAULTS.home.maxIntervalMin)

  // 普通配置不受影响（引用解开对纯 JSON 是 no-op）
  assert.deepEqual(unwrapVolatile({ home: { minIntervalMin: 45 } }), { home: { minIntervalMin: 45 } })
  assert.equal(typeof unwrapVolatile(resolved.enabled), 'boolean')
})

test('设置服务：describe 只暴露已声明的设置卡片字段，不暴露永久档案调度配置', async (t) => {
  let SettingsForms
  try {
    ({ SettingsForms } = await import('@deepseek-ai/dsh-settings'))
  } catch {
    t.skip('@deepseek-ai/dsh-settings 不可解析，跳过 Host 设置管线集成测试')
    return
  }
  const profileConfig = (await readProfileAutonomyConfig()) ?? {
    enabled: true,
    home: { enabled: true, minIntervalMin: 30, maxIntervalMin: 60 },
  }
  const inherited = {
    enabled: false,
    home: { enabled: false, minIntervalMin: DEFAULTS.home.minIntervalMin, maxIntervalMin: DEFAULTS.home.maxIntervalMin },
  }
  const merged = { ...inherited, ...profileConfig, home: { ...inherited.home, ...profileConfig.home } }
  const resolved = Config['~standard'].validate(structuredClone(merged)).value
  let captured
  let entry
  entry = {
    id: 'autonomy',
    options: { id: 'autonomy', name: 'dsh-autonomy', config: merged },
    fiber: { uid: 8, runtime: { Config }, state: 2, config: resolved },
  }
  const ctx = {
    reflect: { provide() {} },
    effect(fn) {
      fn()
      return () => {}
    },
    on() {},
    emit() {},
    logger: { error() {} },
    // 挂起：跳过 legacy settings.yaml 迁移（它需要真实 profileContext）
    root: { loader: { await: () => new Promise(() => {}) } },
    configEditor: {
      documentPath: PROFILE_PATCH,
      configuration: () => [{ entry, inherited, override: profileConfig }],
      entries: () => [entry],
      edit: async (subject, change) => {
        captured = change(structuredClone(subject.options.config), inherited)
      },
    },
  }
  const forms = new SettingsForms(ctx)
  const descriptors = forms.describe()
  const descriptor = descriptors.find((row) => row.ns === 'autonomy')
  assert.ok(descriptor, 'autonomy 必须出现在 describe 里')
  assert.deepEqual(descriptor.value, {
    enabled: profileConfig.enabled,
    pauseAll: profileConfig.pauseAll ?? false,
    drives: { extended: profileConfig?.drives?.extended ?? false },
    purpose: { enabled: profileConfig?.purpose?.enabled ?? false },
    triggers: { device: { enabled: profileConfig?.triggers?.device?.enabled ?? false }, notification: { enabled: profileConfig?.triggers?.notification?.enabled ?? false } },
    home: {
      enabled: profileConfig.home.enabled,
      minIntervalMin: profileConfig.home.minIntervalMin,
      maxIntervalMin: profileConfig.home.maxIntervalMin,
    },
  })
  // describe 给的是 toJSON() 信封 { uid, refs }，客户端用它 rehydrate
  const root = descriptor.schema.refs[descriptor.schema.uid]
  assert.deepEqual(Object.keys(root.dict).sort(), ['drives', 'enabled', 'home', 'pauseAll', 'purpose', 'triggers'])

  // 客户端 decode 用的就是这份 form schema + value
  const z = (await import('@deepseek-ai/schemastery')).default
  const FormSchema = new z(descriptor.schema)
  assert.deepEqual(Object.keys(FormSchema.dict.home.dict).sort(), ['enabled', 'maxIntervalMin', 'minIntervalMin'])
  assert.equal(FormSchema['~standard'].validate(descriptor.value).issues, undefined)

  await forms.mutate('autonomy', [{ op: 'set', path: ['home', 'minIntervalMin'], value: Math.min(25, profileConfig.home.maxIntervalMin) }], descriptor.revision)
  assert.equal(captured.home.minIntervalMin, Math.min(25, profileConfig.home.maxIntervalMin))
  assert.equal(typeof captured.home.minIntervalMin, 'number')
  // 非表单字段必须原样保留
  assert.equal(captured.enabled, profileConfig.enabled)
  assert.equal(captured.home.enabled, profileConfig.home.enabled)
  for (const key of ['dryRun', 'sendEnabled', 'allowedKinds', 'mail', 'tick']) {
    assert.deepEqual(captured[key], profileConfig[key], `未声明键 ${key} 必须原样保留`)
  }
  for (const key of ['cwd', 'respectDryRun', 'agentPreset', 'rotateRatio', 'contextLimit', 'dice']) {
    assert.deepEqual(captured.home[key], profileConfig.home[key], `home.${key} 必须原样保留`)
  }
  assert.equal(loadConfig(captured).home.minIntervalMin, Math.min(25, profileConfig.home.maxIntervalMin))
})
