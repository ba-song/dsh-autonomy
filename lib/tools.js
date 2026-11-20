/**
 * 工具注册：dy_life_status / dy_life_pause（阶段 2 最小可用）
 *
 * 只做本地读写，不需要模型参与。
 * 参数刻意做窄：暂停只有 all / kind / dry_run 三档，别让人误以为能「暂停某条消息」。
 */
import { getMeta, setMeta } from './store/db.js'
import { readLog } from './io/logs.js'
import { KNOWN_KINDS } from './config.js'
import { pauseActive } from './core/policy.js'

const OUT = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, detail: { type: 'string' } },
  required: ['ok', 'detail'],
  additionalProperties: false,
}
const pack = (obj) => ({ ok: obj?.ok !== false, detail: JSON.stringify(obj, null, 2) })
const render = (_a, v) => [{ type: 'text', text: v.detail }]

/** owner-only 工具判定：她的家，或主人目录前缀；子智能体一律拒绝 */
function isOwnerContext(api, exec) {
  try {
    const sess = exec?.agent?.session ?? exec?.session
    const h = sess?.header ?? {}
    if (h.parentSession || String(h.origin ?? '') === 'subagent' || Number(h.delegationDepth ?? 0) > 0) return false
    const sid = String(h.id ?? sess?.id ?? '')
    if (sid && api.home?.isHomeSession?.(sid)) return true
    const cwd = String(h.cwd ?? '')
    if (!cwd) return false
    const dirs = [api.cfg?.home?.cwd, ...(api.cfg?.owner?.privateDirs ?? [])].filter(Boolean)
    return dirs.some((d) => {
      const p = String(d).replace(/\/$/, '')
      return cwd === p || cwd.startsWith(`${p}/`)
    })
  } catch {
    return false
  }
}

export function registerTools({ ctx, api, log = null }) {
  const tools = ctx?.get?.('tools') ?? null
  if (!tools?.register) {
    log?.warn?.('[autonomy] tools 服务不可用：dy_life_* 未注册（插件其余部分照常）')
    return false
  }

  const reg = (def) => {
    try {
      tools.register(def)
      return true
    } catch (e) {
      log?.warn?.(`[autonomy] 注册 ${def.name} 失败：${e?.message ?? e}`)
      return false
    }
  }

  reg({
    name: 'dy_life_status',
    description:
      '看汐现在的「生活」状态：开关、dry_run、暂停、四条驱动力、配额、熔断、最近几次 tick 和行动。只读，不会触发任何行动。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OUT, render },
    execute: async () => pack(api.status()),
  })

  reg({
    name: 'dy_life_pause',
    description:
      '暂停 / 恢复汐的自主行动。scope=all 全停；scope=kind 只停某一类行动；scope=dry_run 只改「演练」开关（演练=照常决策但不执行）。暂停会写库，重启后仍然有效。',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['all', 'kind', 'dry_run'] },
        kind: { type: 'string', description: 'scope=kind 时必填，例如 read_archive / send_qq' },
        on: { type: 'boolean', description: 'true=暂停，false=恢复；默认 true' },
        until: { type: 'number', description: '可选：到期自动恢复的时间戳（Unix 毫秒）' },
        by: { type: 'string', description: '谁操作的（owner / self / gui）' },
      },
      required: ['scope'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}) => {
      const out = api.pause({
        scope: args.scope,
        kind: args.kind,
        on: args.on !== false,
        until: Number.isFinite(Number(args.until)) ? Number(args.until) : null,
        by: args.by ?? 'tool',
      })
      return pack(out)
    },
  })

  // ── 目标四件套（阶段 3） ───────────────────────────
  reg({
    name: 'dy_life_goal_add',
    description:
      '给自己加一个目标（会进行动打分的 goalAffinity）。kindHint 填行动名（如 read_archive / write_diary）表示只给那类行动加分；不填=通用目标，所有候选都吃到这份 priority。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '目标一句话' },
        note: { type: 'string', description: '可选备注（≤500 字）' },
        priority: { type: 'number', description: '0..1，默认 0.5' },
        kindHint: { type: 'string', description: '可选：只给这个行动加分' },
        dueAt: { type: 'number', description: '可选：截止时间（Unix 毫秒）' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}) =>
      pack(api.addGoal({ title: args.title, note: args.note, priority: args.priority, kindHint: args.kindHint, dueAt: args.dueAt, source: 'self' })),
  })

  reg({
    name: 'dy_life_goal_list',
    description: '列目标。status=open（默认，含 doing）/ doing / done / dropped / blocked / all。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'doing', 'done', 'dropped', 'blocked', 'all'] },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}) =>
      pack({ ok: true, goals: api.listGoals({ status: args.status ?? 'open', limit: args.limit ?? 20 }), counts: api.goalCounts() }),
  })

  reg({
    name: 'dy_life_goal_done',
    description: '把一个目标标记完成（终态，幂等）。已完成/已放弃的目标不会被改成别的状态。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, note: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}) => pack(api.closeGoal({ id: String(args.id ?? ''), status: 'done', note: args.note })),
  })

  reg({
    name: 'dy_life_goal_drop',
    description: '放弃一个目标（终态，幂等）。不删数据，只改状态，方便以后看「当时为什么放下」。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, note: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}) => pack(api.closeGoal({ id: String(args.id ?? ''), status: 'dropped', note: args.note })),
  })


  reg({
    name: 'dy_life_action_run',
    description: '她在自己会话里主动做一件事（不是定时任务）：read_archive / write_diary / organize_memory / find_sticker / browse_douyin / send_qq。owner/home 专用；过暂停与防刷屏；不会自动执行。',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['read_archive', 'write_diary', 'organize_memory', 'find_sticker', 'browse_douyin', 'send_qq'],
          description: '想做的行动',
        },
        reason: { type: 'string', description: '可选：为什么想做（≤200 字）' },
        text: { type: 'string', description: 'write_diary 时可选正文；不带则 NO_DRAFT' },
        goalId: { type: 'string', description: '可选：关联一个 open/doing 目标' },
        channel: { type: 'string', description: '可选：渠道标记（桥未接前只记录）' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      if (!isOwnerContext(api, exec)) return pack({ ok: false, error: '只有主人或她的家可以使用这个工具' })
      const r = await api.actionRun(String(args.kind ?? ''), {
        reason: args.reason,
        text: args.text,
        goalId: args.goalId,
        channel: args.channel,
      })
      return pack(r)
    },
  })

  reg({
    name: 'dy_life_reflect',
    description: '她自己写一条反思（owner/home 专用）：写入 reflections(status=done)，并消费一条 pending；空文本拒绝。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '反思正文（≤500 字，超出截断）' },
        importance: { type: 'number', description: '可选：0..10' },
        goalId: { type: 'string', description: '可选：关联目标' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      if (!isOwnerContext(api, exec)) return pack({ ok: false, error: '只有主人或她的家可以使用这个工具' })
      if (pauseActive(getMeta(api.db, 'pause.all', null), Date.now())) return pack({ ok: false, code: 'PAUSED' })
      const r = api.reflect({
        text: args.text,
        importance: Number.isFinite(Number(args.importance)) ? Number(args.importance) : 1,
        goalId: args.goalId ?? null,
      })
      return pack(r)
    },
  })

  // ── C3：home 验收/主人工具（owner-only） ─────────────
  reg({
    name: 'dy_life_home_archive_export',
    description: '手动执行一次 home 永久档案导出和压缩备份；仅主人或她的家可用。要求 homeArchiveMaintenance.enabled=true；不会写 raw/memories，也不会上传云端。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OUT, render },
    execute: async (args, exec) => {
      if (!isOwnerContext(api, exec)) return pack({ ok: false, code: 'E_PERMISSION' })
      const status = api.homeArchiveMaintenanceStatus?.() ?? { enabled: false }
      if (status.enabled !== true) return pack({ ok: false, code: 'E_DISABLED', message: 'homeArchiveMaintenance.enabled 当前为 false' })
      return pack(await api.runHomeArchiveMaintenance({ trigger: 'manual' }))
    },
  })

  reg({
    name: 'dy_life_home_status',
    description: '看汐的「家」当前状态：home_sessions 行、prompt_tokens/context_window/轮换信息。只读，不含对话正文。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OUT, render },
    execute: async (args, exec) => {
      if (!isOwnerContext(api, exec)) return pack({ ok: false, error: '只有主人或她的家可以使用这个工具' })
      let row = null
      try {
        row = api.db.prepare('SELECT * FROM home_sessions ORDER BY last_seen_at DESC LIMIT 1').get() ?? null
      } catch {}
      return pack({ ok: true, home: api.home.status(api.selfId()), row, wake: api.homeWakeState?.() ?? null })
    },
  })

  reg({
    name: 'dy_life_home_awake',
    description: '手动叫醒汐一次（走与定时器相同的总闸：enabled→pause→dryRun→单飞）。owner-only，审计记 trigger=manual。',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: '可选：为什么手动叫醒（≤200 字）' } },
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      if (!isOwnerContext(api, exec)) return pack({ ok: false, error: '只有主人或她的家可以使用这个工具' })
      const reason = String(args?.reason ?? 'manual').slice(0, 200)
      const r = await api.home.awake({ personaId: api.selfId(), sourceKind: 'autonomy-home-manual' })
      const out = r?.ok
        ? { ok: true, status: 'AWAKE', code: r.code, sessionId: r.sessionId ?? null }
        : { ok: false, status: 'SKIPPED', code: r?.code ?? 'UNKNOWN' }
      try {
        api.db
          .prepare('INSERT INTO action_log(at, self_id, action_id, event, code, note, data_json) VALUES(?,?,?,?,?,?,?)')
          .run(
            Date.now(),
            api.selfId(),
            null,
            'home_awake',
            out.code,
            `trigger=manual reason=${reason}`,
            JSON.stringify({ trigger: 'manual', reason, code: out.code, sessionId: out.sessionId ?? null }),
          )
      } catch {}
      return pack(out)
    },
  })

  reg({
    name: 'dy_life_home_rotate',
    description: '手动把 home 轮换成新会话（B 方案：最近 50 条 seed + handoff 提示 + home.agentPreset）；旧会话留档。owner-only，忙时拒绝。',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: '可选：为什么手动轮换（≤200 字）' } },
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      if (!isOwnerContext(api, exec)) return pack({ ok: false, error: '只有主人或她的家可以使用这个工具' })
      const st = api.home.status(api.selfId())
      const pending = (st.pendingDeliveries?.owner ?? 0) + (st.pendingDeliveries?.normal ?? 0)
      if (st.awakeInFlight || st.deliverRunning || st.ownerDelivering || pending > 0) {
        return pack({ ok: false, code: 'BUSY', error: 'home 正在唤醒/投递，稍后再轮换' })
      }
      const reason = String(args?.reason ?? 'manual').slice(0, 200)
      const r = await api.home.rotateHome({ personaId: api.selfId(), reason: 'manual', force: true })
      if (!r?.ok) return pack({ ok: false, code: r?.code ?? 'ROTATE_FAILED', error: r?.error ?? null, oldSessionId: r?.from ?? null })
      return pack({
        ok: true,
        oldSessionId: r.from,
        newSessionId: r.sessionId,
        preset: r.preset ?? null,
        seeded: r.seeded === true,
        count: r.count ?? 0,
        ...(r.fallback ? { fallback: r.fallback } : {}),
        handoffPath: r.handoffPath ?? null,
      })
    },
  })

  reg({
    name: 'dy_life_room_list',
    description: '列旧房间门牌（home_rooms 最近 10 个）：sessionId 前缀、时间、来源、档案首/末条摘要。owner-only、只读。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OUT, render },
    execute: async (args, exec) => {
      if (!isOwnerContext(api, exec)) return pack({ ok: false, error: '只有主人或她的家可以使用这个工具' })
      return pack(api.home.listRooms(10))
    },
  })

  reg({
    name: 'dy_life_room_read',
    description: '只读某个旧房间最近 N 条 user/assistant 文本（默认 20，每条截断 200 字）。owner-only。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '房间 session id' },
        limit: { type: 'number', description: '可选：1..50，默认 20' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      if (!isOwnerContext(api, exec)) return pack({ ok: false, error: '只有主人或她的家可以使用这个工具' })
      return pack(api.home.readRoom(args.sessionId, args.limit ?? 20))
    },
  })

  reg({
    name: 'dy_logs',
    description: '只读查看白名单日志（web/bridge/bridge-outbox/memory/home/autonomy/list）。默认 list，lines≤200，可 grep/since。owner/home 专用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['web', 'bridge', 'bridge-outbox', 'memory', 'home', 'autonomy', 'list'], description: '日志名，默认 list' },
        lines: { type: 'number', description: '可选：尾行数，默认 50，上限 200' },
        grep: { type: 'string', description: '可选：子串过滤' },
        since: { type: 'string', description: '可选：ISO 时间，按行首时间尽力过滤' },
      },
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      if (!isOwnerContext(api, exec)) return pack({ ok: false, error: '只有主人或她的家可以使用这个工具' })
      return pack(readLog({ name: args.name ?? 'list', lines: args.lines ?? 50, grep: args.grep ?? '', since: args.since ?? null }))
    },
  })

  reg({
    name: 'dy_mail_send',
    description: '给主人发一封邮件（只发白名单 MAIL_TO；默认不限流，可在配置里限制）。owner/home 专用；正文走 stdin，不记正文。',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '可选：主题' },
        body: { type: 'string', description: '正文（必填）' },
      },
      required: ['body'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      if (!isOwnerContext(api, exec)) return pack({ ok: false, error: '只有主人或她的家可以使用这个工具' })
      return pack(await api.mail.send({ subject: args.subject ?? '', body: args.body ?? '' }))
    },
  })

  reg({
    name: 'dy_life_practice',
    description: '学点东西并留下练习记录：读 生活/数据/学习/<topic>.md，追加 练习-YYYY-MM-DD.md。owner/home 专用；不调模型、不写记忆库。',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '学习主题（同名/模糊匹配 .md；不给返回 NO_TOPIC）' },
        note: { type: 'string', description: '可选：练习心得（≤500 字，超出截断）' },
        minutes: { type: 'number', description: '可选：练习分钟数' },
      },
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      if (!isOwnerContext(api, exec)) return pack({ ok: false, error: '只有主人或她的家可以使用这个工具' })
      return pack(api.practice.run({ topic: args.topic, note: args.note, minutes: args.minutes, source: 'self' }))
    },
  })

  reg({
    name: 'dy_life_interest',
    description: '她自己的学习兴趣：add/list/drop。add 默认 source=self；owner 建议可传 source=owner，但练不练由她自己决定。drop 只标记不删。home/owner 专用。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'drop', 'suggest'], description: '操作' },
        topic: { type: 'string', description: 'add/drop 时的主题' },
        note: { type: 'string', description: '可选备注' },
        source: { type: 'string', enum: ['self', 'owner', 'seed'], description: '可选来源，默认 self' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签：烧脑/放松/创造/安慰' },
        weight: { type: 'number', description: '可选权重 0.1-3' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      if (!isOwnerContext(api, exec)) return pack({ ok: false, error: '只有主人或她的家可以使用这个工具' })
      if (args.action === 'list') return pack(api.practice.listInterests())
      if (args.action === 'suggest') return pack(api.practice.suggestInterest())
      if (args.action === 'add') return pack(api.practice.addInterest({ topic: args.topic, note: args.note, source: args.source ?? 'self', tags: args.tags, weight: args.weight }))
      if (args.action === 'drop') return pack(api.practice.dropInterest({ topic: args.topic }))
      return pack({ ok: false, code: 'BAD_ACTION' })
    },
  })

  reg({
    name: 'dy_mail_reply',
    description: '回复最后一封主人邮件（To=该邮件 From，仅 owner 白名单；带 In-Reply-To/References）。owner/home 专用；正文≤5000 字，失败不重试。',
    parameters: {
      type: 'object',
      properties: {
        body: { type: 'string', description: '回复正文（必填，≤5000 字）' },
        subject: { type: 'string', description: '可选：主题，默认 Re: <原标题>' },
      },
      required: ['body'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      if (!isOwnerContext(api, exec)) return pack({ ok: false, error: '只有主人或她的家可以使用这个工具' })
      return pack(await api.mail.reply({ body: args.body ?? '', subject: args.subject ?? '' }))
    },
  })

  reg({
    name: 'dy_mail_poll',
    description: '手动补拉一次邮件（IMAP UID 游标），用于定时器异常时安全补拉；owner/home 专用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OUT, render },
    execute: async (args, exec) => {
      if (!isOwnerContext(api, exec)) return pack({ ok: false, error: '只有主人或她的家可以使用这个工具' })
      return pack(await api.pollMail())
    },
  })

  reg({
    name: 'dy_life_diary_append',
    description: '安全追加式日记：只 append /sdcard/DSHA/记忆/数据/diary/YYYY-MM-DD/append.md，不覆盖、不调 saveDiary；owner/home 专用，不自动执行。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '正文（必填，≤20000 字，超出截断）' },
        title: { type: 'string', description: '可选标题' },
        mood: { type: 'string', description: '可选心情' },
        tags: { type: 'string', description: '可选标签（逗号分隔）' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args = {}, exec) => {
      if (!isOwnerContext(api, exec)) return pack({ ok: false, error: '只有主人或她的家可以使用这个工具' })
      return pack(api.diaryAppend({ text: args.text, title: args.title, mood: args.mood, tags: args.tags }))
    },
  })

  return true
}

/** 供 API 复用：写暂停 / dry_run 状态（不经过工具层，便于测试） */
export function applyPause(db, { scope, kind = null, on = true, until = null, by = 'api', now = Date.now() }) {
  if (scope === 'all') {
    const value = { on, until: until ?? null, by, at: now }
    setMeta(db, 'pause.all', value, now)
    return { ok: true, scope, value }
  }
  if (scope === 'kind') {
    if (!kind) return { ok: false, error: 'scope=kind 需要 kind' }
    if (!KNOWN_KINDS.includes(String(kind))) return { ok: false, error: `未知行动 kind：${kind}（不在白名单目录里）` }
    const all = getMeta(db, 'pause.kinds', {}) ?? {}
    const next = { ...all, [kind]: { on, until: until ?? null, by, at: now } }
    setMeta(db, 'pause.kinds', next, now)
    return { ok: true, scope, kind, value: next[kind] }
  }
  if (scope === 'dry_run') {
    const value = { on, by, at: now }
    setMeta(db, 'dry_run', value, now)
    return { ok: true, scope, value }
  }
  return { ok: false, error: `未知 scope：${scope}` }
}

/** 读当前暂停总览（status / pause 工具共用） */
export function readPauseState(db, now = Date.now()) {
  const all = getMeta(db, 'pause.all', null)
  const kinds = getMeta(db, 'pause.kinds', {}) ?? {}
  const dry = getMeta(db, 'dry_run', null)
  return {
    all: pauseActive(all, now),
    allUntil: all?.until ?? null,
    kinds: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, pauseActive(v, now)])),
    dryRunOverride: dry?.on === true,
  }
}
