import { spawn } from 'node:child_process'
import {
  appendFileSync, closeSync, copyFileSync, createReadStream, constants as fsConstants,
  fstatSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { getMeta, setMeta } from '../store/db.js'

const DAY_MS = 15 * 24 * 60 * 60 * 1000
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const stamp = (at) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at)).replaceAll('-', '')

function appendLog(dataDir, entry) {
  try { appendFileSync(join(dataDir, 'home-archive-maintenance.log'), JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 }) } catch {}
}

function acquireLock(lockPath, now = Date.now()) {
  mkdirSync(dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd
    try {
      fd = openSync(lockPath, 'wx', 0o600)
      const body = JSON.stringify({ pid: process.pid, startedAt: now, token: randomUUID() })
      writeSync(fd, body)
      const stat = fstatSync(fd)
      return () => {
        try {
          const current = lstatSync(lockPath)
          if (current.isFile() && !current.isSymbolicLink() && current.dev === stat.dev && current.ino === stat.ino) unlinkSync(lockPath)
        } catch {}
        try { closeSync(fd) } catch {}
      }
    } catch (error) {
      try { if (fd != null) closeSync(fd) } catch {}
      if (error?.code !== 'EEXIST') throw error
      let stat, owner = {}
      try {
        stat = lstatSync(lockPath)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('ELOCKED')
        const readFd = openSync(lockPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
        try {
          const opened = fstatSync(readFd)
          if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('ELOCKED')
          owner = JSON.parse(readFileSync(readFd, 'utf8'))
        } finally { closeSync(readFd) }
      } catch { throw new Error('ELOCKED') }
      let alive = false
      const pid = Number(owner.pid)
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); alive = true } catch (e) { alive = e?.code === 'EPERM' }
      }
      if (alive || now - Number(stat.mtimeMs ?? now) < 10 * 60 * 1000 || attempt > 0) throw new Error('ELOCKED')
      try {
        const again = lstatSync(lockPath)
        if (again.dev !== stat.dev || again.ino !== stat.ino) throw new Error('ELOCKED')
        unlinkSync(lockPath)
      } catch { throw new Error('ELOCKED') }
    }
  }
  throw new Error('ELOCKED')
}

function runChild(spawnImpl, command, args) {
  return new Promise((resolveRun, rejectRun) => {
    let child
    let stdout = ''
    let stderr = ''
    try { child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (error) { rejectRun(error); return }
    const collect = (target, chunk) => {
      const next = target + String(chunk ?? '')
      return next.length > 32_000 ? next.slice(-32_000) : next
    }
    child.stdout?.on?.('data', (chunk) => { stdout = collect(stdout, chunk) })
    child.stderr?.on?.('data', (chunk) => { stderr = collect(stderr, chunk) })
    child.once('error', rejectRun)
    child.once('close', (code, signal) => resolveRun({ code: Number.isInteger(code) ? code : 1, signal: signal ?? null, stdout, stderr }))
  })
}

async function sha256File(file) {
  const hash = createHash('sha256')
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', rejectHash)
    stream.once('end', resolveHash)
  })
  return hash.digest('hex')
}

export function createHomeArchiveMaintenance({
  cfg = {}, db, dataDir = process.cwd(), log = null,
  spawnImpl = spawn, clock = () => Date.now(), sleepImpl = sleep,
} = {}) {
  let running = false
  const config = {
    enabled: cfg.enabled === true,
    intervalDays: 15,
    retryCount: Math.max(0, Math.min(2, Number(cfg.retryCount ?? 1))),
    retryDelayMs: Math.max(1000, Number(cfg.retryDelayMs ?? 5000)),
    pollMinutes: Math.max(5, Number(cfg.pollMinutes ?? 60)),
    exportScript: String(cfg.exportScript ?? ''),
    memoryDbPath: String(cfg.memoryDbPath ?? ''),
    homeCwd: String(cfg.homeCwd ?? '/sdcard/DSHA/生活/数据/home'),
    archiveRoot: String(cfg.archiveRoot ?? '/sdcard/DSHA/记忆/档案/永久'),
    backupDir: String(cfg.backupDir ?? '/sdcard/DSHA/备份'),
  }
  const lockPath = join(dataDir, '.home-archive-maintenance.lock')
  const lastSuccess = () => Number(getMeta(db, 'homeArchiveMaintenance.lastSuccessAt', 0)) || 0

  async function runOnce({ trigger = 'manual' } = {}) {
    if (!config.enabled) return { ok: false, code: 'E_DISABLED' }
    if (running) return { ok: false, code: 'E_BUSY' }
    running = true
    let release = null
    const startedAt = Number(clock())
    const attempts = config.retryCount + 1
    const record = { trigger: String(trigger), startedAt, attempts, ok: false }
    try {
      release = acquireLock(lockPath, startedAt)
      mkdirSync(config.backupDir, { recursive: true })
      const outDir = join(config.archiveRoot, 'home')
      const finalBackup = join(config.backupDir, `永久档案-home-${stamp(startedAt)}.tar.gz`)
      let exportResult = null
      let tarResult = null
      let tempBackup = null
      let finalSize = 0
      let finalHash = ''
      let lastError = null
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          exportResult = await runChild(spawnImpl, process.execPath, [
            config.exportScript, '--db', config.memoryDbPath, '--out', outDir, '--home-cwd', config.homeCwd,
          ])
          if (exportResult.code !== 0) throw new Error(`E_EXPORT_EXIT_${exportResult.code}`)
          tempBackup = join(config.backupDir, `.永久档案-home-${stamp(startedAt)}-${process.pid}-${randomUUID()}.tar.gz.tmp`)
          tarResult = await runChild(spawnImpl, 'tar', [
            '-czf', tempBackup, '-C', dirname(resolve(config.archiveRoot)), basename(resolve(config.archiveRoot)),
          ])
          if (tarResult.code !== 0) throw new Error(`E_TAR_EXIT_${tarResult.code}`)
          const tempStat = statSync(tempBackup)
          if (!tempStat.isFile() || tempStat.size <= 0) throw new Error('E_EMPTY_BACKUP')
          // Exclusive copy: a second manual run on the same day must never overwrite a prior backup.
          copyFileSync(tempBackup, finalBackup, fsConstants.COPYFILE_EXCL)
          unlinkSync(tempBackup)
          tempBackup = null
          finalSize = statSync(finalBackup).size
          finalHash = await sha256File(finalBackup)
          lastError = null
          break
        } catch (error) {
          lastError = error
          try { if (tempBackup) unlinkSync(tempBackup) } catch {}
          tempBackup = null
          if (String(error?.code ?? error?.message ?? '').includes('EEXIST')) throw new Error('E_BACKUP_EXISTS')
          if (attempt + 1 < attempts) await sleepImpl(config.retryDelayMs * (attempt + 1))
        }
      }
      if (lastError) throw lastError
      const completedAt = Number(clock())
      const result = {
        ok: true, trigger, startedAt, completedAt, attemptsUsed: record.attempts - Math.max(0, attempts - (exportResult ? 1 : attempts)),
        exportExitCode: exportResult?.code ?? null, tarExitCode: tarResult?.code ?? null,
        backupPath: finalBackup, backupBytes: finalSize, sha256: finalHash,
        exportStdout: String(exportResult?.stdout ?? '').slice(-4000),
        tarStdout: String(tarResult?.stdout ?? '').slice(-2000),
      }
      setMeta(db, 'homeArchiveMaintenance.lastSuccessAt', completedAt, completedAt)
      setMeta(db, 'homeArchiveMaintenance.lastRun', result, completedAt)
      appendLog(dataDir, result)
      log?.info?.(`[autonomy] home 永久档案导出备份成功：bytes=${finalSize} sha256=${finalHash} path=${finalBackup}`)
      return result
    } catch (error) {
      const completedAt = Number(clock())
      const result = { ...record, ok: false, completedAt, code: String(error?.message ?? error), error: String(error?.stack ?? error).slice(0, 4000) }
      try { setMeta(db, 'homeArchiveMaintenance.lastRun', result, completedAt) } catch {}
      appendLog(dataDir, result)
      log?.warn?.(`[autonomy] home 永久档案导出备份失败：${result.code}`)
      return result
    } finally {
      try { release?.() } catch {}
      running = false
    }
  }

  async function tick() {
    if (!config.enabled) return { ok: true, skipped: true, reason: 'disabled' }
    const last = lastSuccess()
    if (!last) return { ok: true, skipped: true, reason: 'awaiting-first-manual-acceptance' }
    const now = Number(clock())
    if (now - last < DAY_MS) return { ok: true, skipped: true, reason: 'not-due', nextDueAt: last + DAY_MS }
    return runOnce({ trigger: 'schedule' })
  }

  function status() {
    const last = lastSuccess()
    return {
      enabled: config.enabled, intervalDays: 15, running,
      lastSuccessAt: last || null, nextDueAt: last ? last + DAY_MS : null,
      exportScript: config.exportScript, archiveRoot: config.archiveRoot, backupDir: config.backupDir,
    }
  }

  return { runOnce, tick, status }
}
