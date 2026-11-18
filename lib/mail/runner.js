/** Node ↔ Python 邮件脚本；密码只在 env 文件里，argv/stdin 不含密码 */
import { execFile as execFileCb } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

export const DEFAULT_SEND_SCRIPT = '/opt/qqai/bin/sendmail.py'
export const DEFAULT_POLL_SCRIPT = '/opt/qqai/bin/mail-poll.py'
export const DEFAULT_ENV_FILE = '/opt/qqai/run/mail.env'

const run = (execFileImpl, file, args, opts, input) =>
  new Promise((resolve, reject) => {
    try {
      const cb = (err, stdout, stderr) => {
        if (err && !stdout) return reject(err)
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), err })
      }
      const p = execFileImpl(file, args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, ...opts }, cb)
      if (input != null && p?.stdin) {
        p.stdin.end(input)
      } else if (input != null && !p?.stdin) {
        // execFile 同步/immediate 风格兜底
        try { p?.stdin?.end?.(input) } catch {}
      }
    } catch (e) {
      reject(e)
    }
  })

const parseJson = (s) => {
  try {
    return JSON.parse(String(s).trim().split('\n').filter(Boolean).at(-1) ?? '')
  } catch {
    return null
  }
}

export function createMailRunner({
  execFileImpl = execFileCb,
  sendScript = DEFAULT_SEND_SCRIPT,
  pollScript = DEFAULT_POLL_SCRIPT,
  envFile = DEFAULT_ENV_FILE,
} = {}) {
  const owners = () => {
    try {
      if (!existsSync(envFile)) return []
      const raw = readFileSync(envFile, 'utf8')
      for (const line of raw.split('\n')) {
        if (line.startsWith('MAIL_TO=')) {
          return line.slice('MAIL_TO='.length).split(',').map((x) => x.trim()).filter(Boolean)
        }
      }
    } catch {}
    return []
  }

  const send = async ({ subject = '', body = '', to = [], owners = [], inReplyTo = null, references = null } = {}) => {
    if (!existsSync(envFile)) return { ok: false, code: 'MAIL_ENV_MISSING' }
    try {
      // body via stdin；argv 只有 envFile/subject/收件人/引用头（不含密码/正文）
      const args = [sendScript, envFile, String(subject ?? '')]
      for (const a of Array.isArray(to) ? to : []) args.push('--to', String(a))
      for (const a of Array.isArray(owners) ? owners : []) args.push('--owner', String(a))
      if (inReplyTo) args.push('--in-reply-to', String(inReplyTo))
      if (references) args.push('--references', String(references))
      const { stdout } = await run(execFileImpl, 'python3', args, {}, String(body ?? ''))
      const out = parseJson(stdout)
      if (!out?.ok) return { ok: false, code: out?.code ?? 'MAIL_SEND_FAILED', error: out?.error }
      return { ok: true, to: out.to ?? [] }
    } catch (e) {
      return { ok: false, code: 'MAIL_SEND_FAILED', error: String(e?.message ?? e).slice(0, 300) }
    }
  }

  const poll = async ({ cursor = 0, attachmentDir = null } = {}) => {
    if (!existsSync(envFile)) return { ok: false, code: 'MAIL_ENV_MISSING' }
    try {
      const args = [pollScript, envFile, String(Math.max(0, Number(cursor) || 0))]
      if (attachmentDir) args.push(String(attachmentDir))
      const { stdout } = await run(execFileImpl, 'python3', args, {})
      const lines = String(stdout ?? '').split('\n').filter((l) => l.trim())
      const messages = []
      for (const line of lines) {
        const m = parseJson(line)
        if (m?.ok === false) return { ok: false, code: m.code ?? 'MAIL_POLL_FAILED', error: m.error }
        if (m && Number.isFinite(Number(m.uid))) messages.push(m)
      }
      return { ok: true, messages }
    } catch (e) {
      return { ok: false, code: 'MAIL_POLL_FAILED', error: String(e?.message ?? e).slice(0, 300) }
    }
  }

  return { send, poll, owners, envFile }
}
