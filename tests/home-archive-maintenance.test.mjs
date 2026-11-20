import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../lib/store/db.js'
import { createHomeArchiveMaintenance } from '../lib/run/home-archive-maintenance.js'
import { loadConfig, DEFAULTS } from '../lib/config.js'

function fakeSpawn({ dataDir, archiveRoot, failExportCount = 0, hold = false } = {}) {
  let exports = 0
  const calls = []
  const spawnImpl = (command, args) => {
    calls.push({ command, args })
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    setImmediate(() => {
      if (command === process.execPath) {
        exports++
        if (exports <= failExportCount) { child.stderr.end('temporary export failure'); child.emit('close', 1, null); return }
        const outDir = args[args.indexOf('--out') + 1]
        requireMkdir(outDir)
        writeFileSync(join(outDir, '2026-11-20.md'), 'exported')
      } else if (command === 'tar') {
        const temp = args[1]
        writeFileSync(temp, 'fake-tar-content')
      }
      if (!hold) child.emit('close', 0, null)
    })
    return child
  }
  return { spawnImpl, calls, exports: () => exports }
}
function requireMkdir(path) { mkdirSync(path, { recursive: true }) }
function makeExportScript(dir) {
  const file = join(dir, 'export-home-archive.mjs')
  writeFileSync(file, '// isolated test fixture; child execution is mocked')
  return file
}

test('home archive scheduler defaults disabled and fixes the cadence at 15 days', () => {
  assert.equal(DEFAULTS.homeArchiveMaintenance.enabled, false)
  const cfg = loadConfig({ homeArchiveMaintenance: { enabled: true, intervalDays: 2, retryCount: 8 } })
  assert.equal(cfg.homeArchiveMaintenance.enabled, true)
  assert.equal(cfg.homeArchiveMaintenance.intervalDays, 15)
  assert.equal(cfg.homeArchiveMaintenance.retryCount, 2)
})


test('missing exporter path fails explicitly before spawning or creating backup output', async () => {
  const dir = mkdtempSync(join(process.cwd(), 'tmp-home-archive-missing-exporter-'))
  const { db } = openDb({ dbPath: join(dir, 'autonomy.db') })
  const archiveRoot = join(dir, '永久'), backupDir = join(dir, '备份')
  const fake = fakeSpawn({ archiveRoot })
  const missing = join(dir, 'plugin-src', 'scripts', 'export-home-archive.mjs')
  const service = createHomeArchiveMaintenance({
    cfg: { enabled: true, exportScript: missing, memoryDbPath: join(dir, 'memory.db'), archiveRoot, backupDir, retryCount: 1 },
    db, dataDir: dir, spawnImpl: fake.spawnImpl,
  })
  try {
    const result = await service.runOnce()
    assert.equal(result.ok, false)
    assert.equal(result.code, `E_EXPORT_SCRIPT_NOT_FOUND: ${missing}`)
    assert.equal(fake.calls.length, 0, 'missing exporter must be detected before child process spawn')
    assert.equal(existsSync(backupDir), false, 'missing exporter must not create backup output')
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('manual acceptance runs export then exclusive tar backup, records size/hash and next due time', async () => {
  const dir = mkdtempSync(join(process.cwd(), 'tmp-home-archive-scheduler-'))
  const { db } = openDb({ dbPath: join(dir, 'autonomy.db') })
  const archiveRoot = join(dir, '永久')
  const backupDir = join(dir, '备份')
  const exportScript = makeExportScript(dir)
  const fake = fakeSpawn({ archiveRoot, failExportCount: 1 })
  let now = Date.UTC(2026,10,20,5)
  const service = createHomeArchiveMaintenance({
    cfg: { enabled: true, exportScript, memoryDbPath: '/tmp/memory.db', archiveRoot, backupDir, homeCwd: '/sdcard/DSHA/生活/数据/home', retryCount: 1, retryDelayMs: 1 },
    db, dataDir: dir, spawnImpl: fake.spawnImpl, clock: () => now, sleepImpl: async () => {},
  })
  try {
    const result = await service.runOnce()
    assert.equal(result.ok, true)
    assert.equal(fake.exports(), 2)
    assert.equal(result.attemptsUsed, 2)
    assert.equal(result.exportExitCode, 0)
    assert.equal(result.tarExitCode, 0)
    assert.equal(result.backupBytes, 'fake-tar-content'.length)
    assert.equal(result.sha256.length, 64)
    assert.ok(existsSync(result.backupPath))
    assert.equal(service.status().nextDueAt, now + 15*24*60*60*1000)
    const log = readFileSync(join(dir, 'home-archive-maintenance.log'), 'utf8')
    assert.match(log, /sha256/)
    const again = await service.runOnce()
    assert.equal(again.ok, false)
    assert.equal(again.code, 'E_BACKUP_EXISTS')
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}) }
})

test('schedule waits for manual first acceptance, then runs only after 15 days', async () => {
  const dir = mkdtempSync(join(process.cwd(), 'tmp-home-archive-schedule-due-'))
  const { db } = openDb({ dbPath: join(dir, 'autonomy.db') })
  const archiveRoot = join(dir, '永久'), backupDir = join(dir, '备份')
  const exportScript = makeExportScript(dir)
  const fake = fakeSpawn({ archiveRoot })
  let now = Date.UTC(2026,10,20,5)
  const service = createHomeArchiveMaintenance({ cfg:{enabled:true,exportScript,memoryDbPath:'/tmp/m.db',archiveRoot,backupDir,retryCount:0}, db, dataDir:dir, spawnImpl:fake.spawnImpl, clock:()=>now })
  try {
    assert.equal((await service.tick()).reason,'awaiting-first-manual-acceptance')
    assert.equal((await service.runOnce()).ok,true)
    now += 14*24*60*60*1000
    assert.equal((await service.tick()).reason,'not-due')
    now += 24*60*60*1000
    assert.equal((await service.tick()).ok,true)
    assert.equal(fake.exports(),2)
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}) }
})

test('second instance cannot overlap while the first holds the cross-process lock', async () => {
  const dir = mkdtempSync(join(process.cwd(), 'tmp-home-archive-lock-'))
  const { db } = openDb({ dbPath: join(dir, 'autonomy.db') })
  const archiveRoot = join(dir, '永久'), backupDir = join(dir, '备份')
  let finish
  const heldSpawn = (command,args) => {
    const child = new EventEmitter(); child.stdout=new PassThrough(); child.stderr=new PassThrough()
    if(command===process.execPath){ const out=args[args.indexOf('--out')+1]; requireMkdir(out); writeFileSync(join(out,'x.md'),'x'); finish=()=>child.emit('close',0,null) }
    if(command==='tar'){ writeFileSync(args[1],'tar'); setImmediate(()=>child.emit('close',0,null)) }
    return child
  }
  const exportScript = makeExportScript(dir)
  const cfg={enabled:true,exportScript,memoryDbPath:'/tmp/m.db',archiveRoot,backupDir,retryCount:0}
  const first=createHomeArchiveMaintenance({cfg,db,dataDir:dir,spawnImpl:heldSpawn})
  const second=createHomeArchiveMaintenance({cfg,db,dataDir:dir,spawnImpl:fakeSpawn({archiveRoot}).spawnImpl})
  const pending=first.runOnce()
  await new Promise(r=>setImmediate(r))
  try {
    const blocked=await second.runOnce()
    assert.equal(blocked.ok,false)
    assert.equal(blocked.code,'ELOCKED')
    finish()
    assert.equal((await pending).ok,true)
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}) }
})
