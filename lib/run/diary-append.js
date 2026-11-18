/** 安全新建式日记：与 saveDiary 相同的日期目录/文件名格式，永远不覆盖已有条目 */
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export const DIARY_APPEND_ROOT = '/sdcard/DSHA/记忆/数据/diary'
const TZ = 'Asia/Shanghai'

const pad = (n) => String(n).padStart(2, '0')
const dateOf = (now) => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
  } catch {
    return new Date(now).toISOString().slice(0, 10)
  }
}
const clockOf = (now) => {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(now)).replaceAll(':', '')
  } catch {
    return new Date(now).toISOString().slice(11, 19).replaceAll(':', '')
  }
}
const oneLine = (v, max = 200) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max)

function render({ id, date, at, seq, title, mood, tags, text }) {
  const head = ['---', `id: ${id}`, `date: ${date}`, `at: ${at}`, `seq: ${seq}`, 'author: self']
  if (mood) head.push(`mood: ${mood}`)
  if (tags) head.push(`tags: ${tags}`)
  if (title) head.push(`title: ${title}`)
  head.push('schema: 1', '---')
  return head.join('\n') + '\n\n' + text + '\n'
}

export function appendDiary({ text, title = '', mood = '', tags = null, now = Date.now(), root = DIARY_APPEND_ROOT } = {}) {
  const body = String(text ?? '').replace(/\r\n/g, '\n').trim()
  if (!body) return { ok: false, code: 'EMPTY_TEXT' }
  const clipped = body.slice(0, 20_000)
  const date = dateOf(now)
  const clock = clockOf(now)
  const tagText = Array.isArray(tags) ? tags.map((x) => oneLine(x, 20)).filter(Boolean).join(',') : oneLine(tags, 120)
  const dir = join(root, date)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (e) {
    return { ok: false, code: 'WRITE_FAILED', error: String(e?.message ?? e) }
  }

  for (let seq = 1; seq <= 999; seq++) {
    const id = `${date.replaceAll('-', '')}-${clock}-${pad(seq)}`
    const file = join(dir, `${clock}-${pad(seq)}.md`)
    const entry = render({ id, date, at: now, seq, title: oneLine(title, 80), mood: oneLine(mood, 20), tags: tagText, text: clipped })
    let fd = null
    try {
      fd = openSync(file, 'wx') // 只新建；已存在就换 seq，绝不覆盖
      writeSync(fd, entry)
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      return { ok: true, file, bytes: Buffer.byteLength(entry), date, seq, id }
    } catch (e) {
      if (e?.code === 'EEXIST') continue
      return { ok: false, code: 'WRITE_FAILED', error: String(e?.message ?? e) }
    } finally {
      try { if (fd !== null) closeSync(fd) } catch {}
    }
  }
  return { ok: false, code: 'TOO_MANY_ENTRIES' }
}
