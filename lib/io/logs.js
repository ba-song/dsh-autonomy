/**
 * 只读日志工具：白名单路径 + 从文件尾读取，不把大文件整个读进内存。
 * 只给 dy_logs 用；不写文件、不执行命令。
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'

export const LOG_PATHS = {
  web: '/root/dsh-web.log',
  bridge: '/root/.dsh/dsh-channel-bridge.log',
  'bridge-outbox': '/root/.dsh/dsh-channel-bridge-outbox.log',
  memory: '/sdcard/DSHA/记忆/数据/logs/memory.log',
  home: '/sdcard/DSHA/生活/数据/home/deliver.log',
  autonomy: '/sdcard/DSHA/生活/数据/logs/autonomy.log',
}

export const LOG_NAMES = Object.keys(LOG_PATHS)

const MAX_LINE = 500
const MAX_READ_BYTES = 512 * 1024

const pathsWith = (overrides) => ({ ...LOG_PATHS, ...(overrides && typeof overrides === 'object' ? overrides : {}) })

function countLines(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(64 * 1024)
    let total = 0
    let bytes
    while ((bytes = readSync(fd, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < bytes; i++) if (buf[i] === 10) total += 1
    }
    return total
  } catch {
    return 0
  } finally {
    if (fd != null) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

/** 读文件尾部若干行（按字节上限截取，避免大文件全读） */
function readTail(path, maxLines = 1000) {
  let fd
  try {
    const size = statSync(path).size
    fd = openSync(path, 'r')
    const readBytes = Math.min(size, MAX_READ_BYTES)
    const buf = Buffer.alloc(readBytes)
    readSync(fd, buf, 0, readBytes, Math.max(0, size - readBytes))
    let text = buf.toString('utf8')
    if (size > readBytes) {
      const nl = text.indexOf('\n')
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }
    const all = text.split('\n').filter((l) => l.length > 0)
    return all.slice(-Math.max(1, maxLines))
  } catch {
    return []
  } finally {
    if (fd != null) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

function sinceOfLine(line) {
  const m = /^\[([^\]]+)\]/.exec(line)
  if (!m) return null
  const t = Date.parse(m[1])
  return Number.isFinite(t) ? t : null
}

/**
 * @returns {{ok:true,name,path,lines,total,matched}|{ok:false,code,error?}}
 */
export function readLog({ name = 'list', lines = 50, grep = '', since = null, paths = null } = {}) {
  if (name === 'list') {
    const p = pathsWith(paths)
    return {
      ok: true,
      name: 'list',
      path: null,
      lines: LOG_NAMES.map((n) => ({ name: n, path: p[n], exists: existsSync(p[n]) })),
      total: LOG_NAMES.length,
      matched: LOG_NAMES.length,
    }
  }
  if (!LOG_NAMES.includes(name)) return { ok: false, code: 'BAD_NAME' }
  const path = pathsWith(paths)[name]
  if (!existsSync(path)) return { ok: false, code: 'NO_LOG', name, path }
  let sinceMs = null
  if (since != null && String(since).trim() !== '') {
    sinceMs = Date.parse(String(since))
    if (!Number.isFinite(sinceMs)) return { ok: false, code: 'BAD_SINCE', name, path }
  }
  const n = Math.min(200, Math.max(1, Number(lines) || 50))
  const total = countLines(path)
  const tail = readTail(path, Math.min(4000, Math.max(n * 4, 200)))
  const needle = String(grep ?? '').trim()
  const matched = []
  for (const raw of tail) {
    const at = sinceOfLine(raw)
    if (sinceMs != null && at != null && at < sinceMs) continue
    if (needle && !raw.includes(needle)) continue
    matched.push(raw.slice(0, MAX_LINE))
  }
  const out = matched.slice(-n)
  return { ok: true, name, path, lines: out, total, matched: out.length }
}
