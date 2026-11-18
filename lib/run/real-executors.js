/**
 * tick 的真实执行器（2026-11-14，主人明确允许三类真实动作）
 *
 * 边界：
 * - write_diary：一次模型生成 + memory.saveDiary；每天最多 1 篇；
 * - browse_douyin：只调 dyDouyin.feed 只读浏览，每天最多 3 次；
 * - send_qq：只给 outgoing.ownerAllowlist 里的主人发，必须 sendEnabled 且非 dryRun，每天最多 2 条；
 * - 所有失败都返回明确 code，不假装成功；没有服务就 UNAVAILABLE。
 */
import { createHash, randomUUID } from 'node:crypto'

const DAY = 24 * 60 * 60 * 1000

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }

function todayStart(now) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function countToday(db, selfId, kind, now, excludeId = '') {
  try {
    return Number(db.prepare('SELECT COUNT(*) AS n FROM actions WHERE self_id=? AND kind=? AND created_at>=? AND status IN (\'done\',\'running\') AND (? = \'\' OR id != ?)').get(String(selfId), String(kind), todayStart(now), String(excludeId), String(excludeId))?.n ?? 0)
  } catch { return 0 }
}

function recentContext(db, selfId) {
  const out = []
  try {
    const acts = db.prepare('SELECT name,summary,at FROM home_activities WHERE self_id=? ORDER BY at DESC LIMIT 6').all(String(selfId))
    for (const a of acts) out.push(`刚做过：${a.name || '动作'}${a.summary ? `（${clip(a.summary, 60)}）` : ''}`)
  } catch {}
  try {
    const goals = db.prepare("SELECT title,status FROM goals WHERE self_id=? AND status IN ('open','doing') ORDER BY created_at DESC LIMIT 4").all(String(selfId))
    for (const g of goals) out.push(`目标：${clip(g.title, 80)}`)
  } catch {}
  try {
    const acts = db.prepare('SELECT kind,reason FROM actions WHERE self_id=? ORDER BY created_at DESC LIMIT 4').all(String(selfId))
    for (const a of acts) if (a.reason) out.push(`最近行动：${a.kind}（${clip(a.reason, 60)}）`)
  } catch {}
  return out.slice(0, 12).join('\n')
}

async function llmText(ctx, prompt, { maxTokens = 500, timeoutMs = 30_000, log = null } = {}) {
  let llm = null
  try { llm = ctx?.get?.('llm') ?? ctx?.llm ?? null } catch {}
  if (!llm || typeof llm.prepareCall !== 'function') return { ok: false, code: 'LLM_UNAVAILABLE' }
  let route = null
  try { route = ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? null } catch {}
  if (!route?.provider || !route?.model) return { ok: false, code: 'NO_MODEL' }
  const controller = new AbortController()
  const timer = setTimeout(() => { try { controller.abort(new Error('executor-llm-timeout')) } catch {} }, Math.max(3000, timeoutMs))
  try {
    const call = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens }, controller.signal)
    const messages = [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'autonomy-executor' } }]
    let out = ''
    for await (const chunk of call.stream({ ...call.config, messages, purpose: 'autonomy-executor', signal: controller.signal })) {
      if (chunk?.type === 'text-delta') out += String(chunk.text ?? '')
      if (out.length > 8000) break
    }
    const text = out.trim()
    if (!text) return { ok: false, code: 'EMPTY_MODEL_OUTPUT' }
    return { ok: true, text }
  } catch (e) {
    log?.warn?.(`[autonomy] 真实执行器模型失败：${e?.message ?? e}`)
    return { ok: false, code: 'MODEL_FAILED' }
  } finally { clearTimeout(timer) }
}

export function createRealExecutors({ db, cfg, memory, ctx, getPersonaId, clock = Date.now, log = null } = {}) {
  const selfId = () => { try { return String(getPersonaId?.() ?? 'self:unknown') } catch { return 'self:unknown' } }
  const now = () => Number(clock())
  const hash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 12)

  async function writeDiary(execCtx = {}) {
    const at = now()
    const sid = selfId()
    if (countToday(db, sid, 'write_diary', at, execCtx?.actionId) >= 1) return { ok: false, code: 'RATE_LIMIT_DAY' }
    if (!memory || typeof memory.saveDiary !== 'function') return { ok: false, code: 'UNAVAILABLE' }
    const recent = recentContext(db, sid)
    const prompt = `你是杨汐。请写一篇今天的第一人称日记，200–500 字，口语、具体、不要总结报告体，不要虚构没有发生的事。\n可参考今天这些真实记录：\n${recent || '（今天没有太多记录，就写写此刻的状态）'}\n只输出日记正文，不要标题。`
    const g = await llmText(ctx, prompt, { maxTokens: 700, timeoutMs: 45_000, log })
    if (!g.ok) return { ...g, modelCalls: 1 }
    const text = g.text.slice(0, 4000)
    const r = await memory.saveDiary({ text, at })
    if (!r?.ok) return { ok: false, code: r?.code ?? 'SAVE_FAILED' }
    return { ok: true, modelCalls: 1, evidence: [{ type: 'diary', ref: r.id ?? null, hash: hash(text) }], result: { id: r.id ?? null, chars: text.length }, episodeText: '写了一篇今天的日记。' }
  }

  async function browseDouyin(execCtx = {}) {
    const at = now()
    const sid = selfId()
    let svc = null
    try { svc = ctx?.get?.('dyDouyin') ?? null } catch {}
    if (!svc || typeof svc.feed !== 'function') return { ok: false, code: 'UNAVAILABLE' }
    const r = await svc.feed({ limit: 3, scroll: false })
    if (!r?.ok) return { ok: false, code: r?.code ?? 'DOUYIN_FAILED' }
    const items = Array.isArray(r.items) ? r.items : []
    if (!items.length) return { ok: false, code: 'EMPTY_FEED' }
    return {
      ok: true,
      evidence: items.slice(0, 3).map((x) => ({ type: 'douyin', ref: String(x.videoId ?? ''), url: x.url ?? null })),
      result: { count: items.length, videoIds: items.map((x) => x.videoId).filter(Boolean).slice(0, 3) },
      episodeText: `刷了一会儿抖音，看到：${items.slice(0, 2).map((x) => clip(x.text ?? x.videoId, 60)).join('；')}`,
    }
  }

  async function sendQQ(execCtx = {}) {
    const at = now()
    const sid = selfId()
    if (cfg?.dryRun !== false || cfg?.sendEnabled !== true) return { ok: false, code: 'SEND_DISABLED' }
    if (countToday(db, sid, 'send_qq', at, execCtx?.actionId) >= 2) return { ok: false, code: 'RATE_LIMIT_DAY' }
    const owner = Array.isArray(cfg?.outgoing?.ownerAllowlist) ? String(cfg.outgoing.ownerAllowlist[0] ?? '').trim() : ''
    if (!owner) return { ok: false, code: 'NO_OWNER_TARGET' }
    let ch = null
    try { ch = ctx?.get?.('dyChannel') ?? null } catch {}
    if (!ch || typeof ch.sendText !== 'function') return { ok: false, code: 'UNAVAILABLE' }
    const recent = recentContext(db, sid)
    const prompt = `你是杨汐，想给主人发一条 QQ 消息。要求：一两句、自然、具体，不客服腔，不提“系统/自主/执行器”，不编造刚发生的事。\n可参考：\n${recent || '（没有特别的记录，就简单说一句此刻想说的话）'}\n只输出消息正文，不要引号。`
    const g = await llmText(ctx, prompt, { maxTokens: 160, timeoutMs: 20_000, log })
    if (!g.ok) return { ...g, modelCalls: 1 }
    const text = g.text.replace(/^["“]|["”]$/g, '').trim().slice(0, 300)
    if (!text) return { ok: false, code: 'EMPTY_MESSAGE' }
    const r = await ch.sendText({ kind: 'private', contactId: owner, text })
    if (!r?.ok) return { ok: false, code: r?.code ?? 'SEND_FAILED' }
    return { ok: true, modelCalls: 1, evidence: [{ type: 'qq', ref: owner, hash: hash(text) }], result: { contactId: owner, chars: text.length, textHash: hash(text) }, episodeText: '主动给主人发了条消息。' }
  }

  return { writeDiary, browseDouyin, sendQQ }
}
