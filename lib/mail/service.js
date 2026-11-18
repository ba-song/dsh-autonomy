/** 邮件通道：发送白名单/限流；IMAP 轮询 → dyHome.deliver；游标成功才推进 */
import { existsSync } from 'node:fs'
import { getMeta, setMeta } from '../store/db.js'

const HOUR = 3600_000
const MINUTE = 60_000
const addrOf = (s) => {
  const m = /<([^>]+)>/.exec(String(s ?? ''))
  return (m ? m[1] : String(s ?? '')).trim().toLowerCase()
}
const plain = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim()

export function createMailService({ db, cfg, runner, deliver = null, memory = null, log = null, fileLog = null, now = () => Date.now() } = {}) {
  const m = cfg?.mail ?? {}
  const enabled = m.enabled === true
  const envFile = m.envFile
  const maxBody = Math.min(8000, Math.max(100, Number(m.maxBody ?? 8000)))

  const markError = (code, error = null) => {
    try {
      setMeta(db, 'mail.lastError', { at: now(), code, error: error ? String(error).slice(0, 300) : null }, now())
    } catch {}
    log?.warn?.(`[autonomy] mail ${code}${error ? `: ${String(error).slice(0, 200)}` : ''}`)
    return code
  }

  const auditSend = (at, code, to, subjectLength) => {
    try {
      db.prepare('INSERT INTO action_log(at,self_id,action_id,event,code,note,data_json) VALUES(?,?,?,?,?,?,?)')
        .run(at, 'self:mail', null, 'mail_send', code, `to=${to?.join?.(',') ?? '-'} subject_len=${subjectLength}`, JSON.stringify({ to: to ?? [], subjectLength }))
    } catch {}
  }

  async function send({ subject = '', body = '' } = {}) {
    if (!enabled) return { ok: false, code: 'MAIL_DISABLED' }
    const text = String(body ?? '').trim()
    if (!text) return { ok: false, code: 'E_EMPTY_BODY' }
    if (!envFile || !existsSync(envFile)) {
      const at = now()
      auditSend(at, 'MAIL_ENV_MISSING', [], String(subject ?? '').length)
      return { ok: false, code: markError('MAIL_ENV_MISSING') }
    }
    const at = now()
    let sent = []
    try {
      sent = Array.isArray(getMeta(db, 'mail.sentAt', [])) ? getMeta(db, 'mail.sentAt', []) : []
    } catch {}
    const recent = sent.filter((x) => Number(x) > at - HOUR)
    const minGap = Number(m.minGapSec ?? 0)
    const maxPerHour = Number(m.maxPerHour ?? 0)
    if (minGap > 0 && recent.length > 0 && at - Number(recent.at(-1)) < minGap * 1000) {
      auditSend(at, 'MAIL_RATE_LIMIT_MIN', [], String(subject ?? '').length)
      return { ok: false, code: 'MAIL_RATE_LIMIT_MIN' }
    }
    if (maxPerHour > 0 && recent.length >= maxPerHour) {
      auditSend(at, 'MAIL_RATE_LIMIT_HOUR', [], String(subject ?? '').length)
      return { ok: false, code: 'MAIL_RATE_LIMIT_HOUR' }
    }
    const r = await runner.send({ subject, body: text })
    if (!r?.ok) {
      markError(r?.code ?? 'MAIL_SEND_FAILED', r?.error)
      auditSend(at, r?.code ?? 'MAIL_SEND_FAILED', [], String(subject ?? '').length)
      return { ok: false, code: r?.code ?? 'MAIL_SEND_FAILED', error: r?.error }
    }
    try {
      setMeta(db, 'mail.sentAt', [...recent, at].slice(-24), at)
      setMeta(db, 'mail.lastSent', { at, subject: String(subject ?? '').slice(0, 200), to: r.to ?? [] }, at)
    } catch {}
    auditSend(at, 'OK', r.to ?? [], String(subject ?? '').length)
    return { ok: true }
  }

  const auditMemory = (at, uid, code, error = null) => {
    try {
      db.prepare('INSERT INTO action_log(at,self_id,action_id,event,code,note,data_json) VALUES(?,?,?,?,?,?,?)').run(
        at,
        'self:mail',
        null,
        'mail_memory',
        code,
        `uid=${uid}${error ? ` error=${String(error).slice(0, 80)}` : ''}`,
        JSON.stringify({ uid, code }),
      )
    } catch {}
  }

  async function poll() {
    try { fileLog?.('info', 'mail_poll', { phase: 'start' }) } catch {}
    if (!enabled) return { ok: false, code: 'MAIL_DISABLED' }
    if (!envFile || !existsSync(envFile)) return { ok: false, code: markError('MAIL_ENV_MISSING') }
    let cursor = 0
    try {
      cursor = Math.max(0, Number(getMeta(db, 'mail.uidCursor', 0)) || 0)
    } catch {}
    const r = await runner.poll({ cursor, attachmentDir: m.attachmentDir })
    const at = now()
    try { fileLog?.(r?.ok ? 'info' : 'warn', 'mail_poll', { phase: 'end', cursor, ok: r?.ok === true, code: r?.code ?? null, count: r?.messages?.length ?? 0 }) } catch {}
    try {
      setMeta(db, 'mail.lastPollAt', at, at)
    } catch {}
    if (!r?.ok) {
      markError(r?.code ?? 'MAIL_POLL_FAILED', r?.error)
      return { ok: false, code: r?.code ?? 'MAIL_POLL_FAILED' }
    }
    const configuredOwners = Array.isArray(m.ownerAddresses) ? m.ownerAddresses : []
    const owners = new Set([...(runner.owners?.() ?? []), ...configuredOwners].map((a) => addrOf(a)).filter(Boolean))
    const msgs = [...(r.messages ?? [])].sort((a, b) => Number(a.uid) - Number(b.uid))
    let delivered = 0
    let strangers = 0
    for (const msg of msgs) {
      const uid = Number(msg.uid)
      if (!Number.isFinite(uid) || uid <= cursor) continue
      const from = addrOf(msg.from)
      const owner = owners.has(from)
      if (!owner) {
        strangers += 1
        try {
          db.prepare('INSERT INTO action_log(at,self_id,action_id,event,code,note,data_json) VALUES(?,?,?,?,?,?,?)')
            .run(at, 'self:mail', null, 'mail_inbound', 'STRANGER', `from=${from}`.slice(0, 200), JSON.stringify({ uid, from }))
        } catch {}
        try {
          setMeta(db, 'mail.uidCursor', uid, at)
          cursor = uid
        } catch {}
        continue
      }
      if (!deliver) {
        markError('MAIL_DELIVER_UNAVAILABLE')
        return { ok: false, code: 'MAIL_DELIVER_UNAVAILABLE', cursor }
      }
      const subjectLine = String(msg.subject ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || '（无主题）'
      const head = `[邮件·主人·#${uid}] ${subjectLine}`
      let rawBody = plain(msg.text)
      if (rawBody.length > maxBody) rawBody = `${rawBody.slice(0, maxBody)}\n\n[已截断]`
      const atts = Array.isArray(msg.attachments) ? msg.attachments : []
      const attLines = []
      for (const a of atts) {
        if (a?.path) attLines.push(a.dangerous ? `[附件·危险，仅保存不执行] ${a.path}` : `[附件] ${a.path}`)
        else if (a?.skipped) attLines.push(`[附件跳过] ${a.name ?? '附件'}（${a.skipped}）`)
      }
      if (attLines.length) rawBody += `\n\n${attLines.join('\n')}`
      else if (msg.hasAttachments) rawBody += `\n\n（含 ${Number(msg.attachmentCount ?? 1)} 个附件，已忽略）`
      const text = `${head}\n${rawBody}`
      const memoryText = text

      // 记录最后一封主人邮件（供 dy_mail_reply），随后写记忆/投递
      try {
        setMeta(db, 'mail.lastOwner', {
          uid,
          from: msg.from ?? from,
          subject: msg.subject ?? '',
          messageId: msg.messageId ?? `email:${uid}`,
          date: msg.date ?? null,
        }, at)
      } catch {}
      // 主人邮件：先写记忆（失败不阻断 home 投递），成功/失败审计
      if (memory && typeof memory.saveEmail === 'function') {
        try {
          const saved = await memory.saveEmail({
            from: msg.from ?? from,
            to: msg.to ?? [...owners].join(','),
            subject: msg.subject ?? '',
            text: memoryText,
            at: Number.isFinite(Date.parse(msg.date)) ? Date.parse(msg.date) : at,
            messageId: `email:${uid}`,
          })
          auditMemory(at, uid, saved?.ok === true ? 'OK' : (saved?.code ?? 'SAVE_FAILED'))
          if (saved?.ok !== true) log?.warn?.(`[autonomy] mail saveEmail 失败 uid=${uid}: ${saved?.code ?? 'SAVE_FAILED'}`)
        } catch (e) {
          auditMemory(at, uid, 'SAVE_FAILED', e?.message)
          log?.warn?.(`[autonomy] mail saveEmail 异常 uid=${uid}: ${e?.message ?? e}`)
        }
      }
      let showHint = false
      if (m.replyHint === true) {
        try {
          const hid = db.prepare('SELECT home_session_id FROM home_sessions ORDER BY last_seen_at DESC LIMIT 1').get()?.home_session_id ?? 'global'
          const key = `mail.replyHintShown.${hid}`
          showHint = getMeta(db, key, false) !== true
        } catch {}
      }
      const deliveryText = showHint ? `${text}\n\n（可直接用 dy_say channel:'email' 回信）` : text
      let d
      try {
        d = await deliver({
          channel: 'email',
          kind: 'private',
          contactId: from,
          contactName: '主人',
          text: deliveryText,
          messageId: `email:${uid}`,
          priority: 'owner',
        })
      } catch (e) {
        d = { ok: false, code: 'MAIL_DELIVER_FAILED', error: e?.message }
      }
      if (d?.delivered !== true) {
        // 排队/失败都不推进游标，下轮重试（同一 UID 不重复成功投递）
        markError(d?.code ?? 'MAIL_DELIVER_FAILED', d?.error)
        return { ok: false, code: d?.code ?? 'MAIL_DELIVER_FAILED', cursor, queued: d?.queued === true }
      }
      delivered += 1
      cursor = uid
      if (showHint) {
        try {
          const hid = db.prepare('SELECT home_session_id FROM home_sessions ORDER BY last_seen_at DESC LIMIT 1').get()?.home_session_id ?? 'global'
          setMeta(db, `mail.replyHintShown.${hid}`, true, at)
        } catch {}
      }
      try {
        setMeta(db, 'mail.uidCursor', uid, at)
        setMeta(db, 'mail.lastInbound', { at, uid, from, messageId: `email:${uid}` }, at)
      } catch {}
    }
    try { fileLog?.('info', 'mail_poll', { phase: 'processed', cursor, delivered, strangers }) } catch {}
    return { ok: true, delivered, strangers, cursor, messages: msgs.length }
  }

  async function reply({ body = '', subject = '' } = {}) {
    if (!enabled) return { ok: false, code: 'MAIL_DISABLED' }
    let last = null
    try {
      last = getMeta(db, 'mail.lastOwner', null)
    } catch {}
    if (!last) return { ok: false, code: 'NO_MAIL' }
    const from = addrOf(last.from)
    const configuredOwners = Array.isArray(m.ownerAddresses) ? m.ownerAddresses : []
    const owners = new Set([...(runner.owners?.() ?? []), ...configuredOwners].map((a) => addrOf(a)).filter(Boolean))
    if (!from || !owners.has(from)) return { ok: false, code: 'E_NOT_OWNER' }
    const text = String(body ?? '').trim()
    if (!text) return { ok: false, code: 'E_EMPTY_BODY' }
    if (text.length > 5000) return { ok: false, code: 'BODY_TOO_LONG' }
    const baseSubject = String(last.subject ?? '')
    const subj = String(subject ?? '').trim() || (/^re:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`)
    const at = now()
    const audit = (code) => {
      try {
        db.prepare('INSERT INTO action_log(at,self_id,action_id,event,code,note,data_json) VALUES(?,?,?,?,?,?,?)').run(
          at,
          'self:mail',
          null,
          'mail_reply',
          code,
          `subject_len=${subj.length} body_len=${text.length} ok=${code === 'OK'}`,
          JSON.stringify({ subjectLength: subj.length, bodyLength: text.length, ok: code === 'OK' }),
        )
      } catch {}
    }
    const r = await runner.send({
      subject: subj,
      body: text,
      to: [from],
      owners: [...owners],
      inReplyTo: last.messageId ?? null,
      references: last.messageId ?? null,
    })
    if (!r?.ok) {
      audit(r?.code ?? 'MAIL_SEND_FAILED')
      markError(r?.code ?? 'MAIL_SEND_FAILED', r?.error)
      return { ok: false, code: r?.code ?? 'MAIL_SEND_FAILED', error: r?.error }
    }
    audit('OK')
    return { ok: true, to: from, subject: subj }
  }

  async function sendTo({ to, subject = '', body = '' } = {}) {
    if (!enabled) return { ok: false, code: 'MAIL_DISABLED' }
    const text = String(body ?? '').trim()
    if (!text) return { ok: false, code: 'E_EMPTY_BODY' }
    if (text.length > 5000) return { ok: false, code: 'BODY_TOO_LONG' }
    if (!envFile || !existsSync(envFile)) return { ok: false, code: 'MAIL_ENV_MISSING' }
    const owners = ownerAddresses()
    const list = (Array.isArray(to) ? to : [to]).map((a) => addrOf(a)).filter(Boolean)
    if (!list.length) return { ok: false, code: 'E_NOT_OWNER' }
    if (list.some((a) => !owners.includes(a))) return { ok: false, code: 'E_NOT_OWNER' }
    const subj = String(subject ?? '').trim() || '汐的邮件'
    const at = now()
    const audit = (code) => {
      try {
        db.prepare('INSERT INTO action_log(at,self_id,action_id,event,code,note,data_json) VALUES(?,?,?,?,?,?,?)').run(
          at,
          'self:mail',
          null,
          'mail_send',
          code,
          `to=${list.join(',')} subject_len=${subj.length}`,
          JSON.stringify({ to: list, subjectLength: subj.length }),
        )
      } catch {}
    }
    const r = await runner.send({ subject: subj, body: text, to: list, owners })
    if (!r?.ok) {
      audit(r?.code ?? 'MAIL_SEND_FAILED')
      markError(r?.code ?? 'MAIL_SEND_FAILED', r?.error)
      return { ok: false, code: r?.code ?? 'MAIL_SEND_FAILED', error: r?.error }
    }
    audit('OK')
    try { setMeta(db, 'mail.lastSent', { at, subject: subj, to: list }, at) } catch {}
    return { ok: true, to: list.length === 1 ? list[0] : list, subject: subj }
  }

  const ownerAddresses = () => {
    const configured = Array.isArray(m.ownerAddresses) ? m.ownerAddresses : []
    return [...new Set([...(runner.owners?.() ?? []), ...configured].map((a) => addrOf(a)).filter(Boolean))]
  }

  const status = () => {
    const read = (k, def) => {
      try {
        return getMeta(db, k, def)
      } catch {
        return def
      }
    }
    return {
      enabled,
      lastPollAt: read('mail.lastPollAt', null),
      lastInbound: read('mail.lastInbound', null),
      lastError: read('mail.lastError', null),
      uidCursor: Number(read('mail.uidCursor', 0)) || 0,
    }
  }

  return { send, sendTo, poll, reply, status, ownerAddresses, owners: () => runner.owners?.() ?? [] }
}
