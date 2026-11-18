/** 学习与练习：本地主题 + 兴趣 + 好奇心自驱；不调模型、不写记忆库 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getMeta, setMeta } from '../store/db.js'

const dayOf = (now, tz = 'Asia/Shanghai') => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
  } catch {
    return new Date(now).toISOString().slice(0, 10)
  }
}
const hhmm = (now, tz = 'Asia/Shanghai') => {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(now))
  } catch {
    return new Date(now).toISOString().slice(11, 16)
  }
}
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0))

const INTERESTS_DDL = `CREATE TABLE IF NOT EXISTS interests (
  topic TEXT PRIMARY KEY,
  strength REAL NOT NULL DEFAULT 0.5,
  source TEXT NOT NULL DEFAULT 'self',
  created_at INTEGER NOT NULL,
  last_practiced_at INTEGER,
  note TEXT,
  dropped_at INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  weight REAL NOT NULL DEFAULT 1,
  last_suggested_at INTEGER
)`

export function createPractice({ db, cfg, selfId = 'self:practice', now = () => Date.now(), tz = 'Asia/Shanghai', log = null } = {}) {
  const dir = String(cfg?.practiceDir ?? '').trim()
  const pcfg = cfg?.practice ?? {}
  const curiosityThreshold = Math.max(0, Math.min(1, Number(pcfg.curiosityThreshold ?? 0.6)))
  const energyMin = Math.max(0, Math.min(1, Number(pcfg.energyMin ?? 0.3)))
  const selfDailyCap = Math.max(1, Number(pcfg.selfDailyCap ?? 4))

  const ensureTable = () => {
    try { db.exec(INTERESTS_DDL) } catch {}
    for (const [col, def] of [['tags', "TEXT NOT NULL DEFAULT '[]'"], ['weight', 'REAL NOT NULL DEFAULT 1'], ['last_suggested_at', 'INTEGER']]) {
      try { db.exec(`ALTER TABLE interests ADD COLUMN ${col} ${def}`) } catch {}
    }
  }
  ensureTable()

  const topics = () => {
    try {
      if (!dir || !existsSync(dir)) return []
      return readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md')).map((n) => n.slice(0, -3)).sort()
    } catch {
      return []
    }
  }

  const matchTopic = (topic) => {
    const t = String(topic ?? '').trim()
    if (!t) return null
    const all = topics()
    const lower = t.toLowerCase()
    let name = all.find((n) => n.toLowerCase() === lower)
    if (!name) name = all.find((n) => n.toLowerCase().includes(lower) || lower.includes(n.toLowerCase()))
    if (!name) return null
    return { name, path: join(dir, `${name}.md`) }
  }

  const curiosity = () => {
    try {
      const r = db.prepare("SELECT value FROM drives WHERE self_id=? AND name='curiosity'").get(String(selfId))
      return r ? Number(r.value) : Number(cfg?.practice?.baselineCuriosity ?? 0.45)
    } catch {
      return 0.45
    }
  }

  const adjustCuriosity = (delta) => {
    try {
      const r = db.prepare("SELECT value FROM drives WHERE self_id=? AND name='curiosity'").get(String(selfId))
      const at = now()
      if (r) db.prepare("UPDATE drives SET value=?, updated_at=? WHERE self_id=? AND name='curiosity'").run(clamp01(Number(r.value) + delta), at, String(selfId))
      else db.prepare("INSERT INTO drives(self_id,name,value,baseline,growth,updated_at) VALUES(?,?,?,?,?,?)").run(String(selfId), 'curiosity', clamp01(0.45 + delta), 0.45, 0.05, at)
    } catch {}
  }

  const energy = () => {
    try { return clamp01(getMeta(db, 'home.energy', Number(pcfg.defaultEnergy ?? 0.6))) } catch { return 0.6 }
  }

  function run({ topic, note = '', minutes = null, source = 'manual' } = {}) {
    if (!topic || !String(topic).trim()) return { ok: false, code: 'NO_TOPIC', topics: topics() }
    const hit = matchTopic(topic)
    if (!hit) return { ok: false, code: 'NO_TOPIC', topics: topics() }
    let material = ''
    let bytes = 0
    try {
      material = readFileSync(hit.path, 'utf8')
      bytes = statSync(hit.path).size
    } catch (e) {
      return { ok: false, code: 'TOPIC_READ_FAILED', error: String(e?.message ?? e) }
    }
    const at = now()
    const n = String(note ?? '').trim().slice(0, 500)
    const minutesNum = minutes == null || minutes === '' ? null : Math.max(0, Math.min(600, Number(minutes) || 0))
    const day = dayOf(at, tz)
    const recordFile = join(dir, `练习-${day}.md`)
    try {
      mkdirSync(dir, { recursive: true })
      const rec = [
        `## ${hhmm(at, tz)} · ${hit.name}`,
        '',
        `- 时间: ${new Date(at).toISOString()}`,
        `- 材料: ${hit.path} (${bytes} bytes)`,
        `- minutes: ${minutesNum ?? '-'}`,
        `- source: ${source}`,
        `- note: ${n || '（没写）'}`,
        '',
      ].join('\n')
      appendFileSync(recordFile, rec)
    } catch (e) {
      return { ok: false, code: 'RECORD_WRITE_FAILED', error: String(e?.message ?? e) }
    }
    try {
      db.prepare('INSERT INTO action_log(at,self_id,action_id,event,code,note,data_json) VALUES(?,?,?,?,?,?,?)').run(
        at,
        'self:practice',
        null,
        'practice',
        'OK',
        `topic=${hit.name} bytes=${bytes} noteLen=${n.length} source=${source}`,
        JSON.stringify({ topic: hit.name, bytes, noteLen: n.length, source }),
      )
    } catch {}
    try {
      db.prepare('UPDATE interests SET last_practiced_at=?, strength=? WHERE topic=?').run(at, clamp01(Number(db.prepare('SELECT strength FROM interests WHERE topic=?').get(hit.name)?.strength ?? 0.5) + 0.02), hit.name)
    } catch {}
    adjustCuriosity(-0.12)
    return { ok: true, topic: hit.name, file: hit.path, recordFile, bytes, noteLen: n.length, minutes: minutesNum, materialChars: material.length, source }
  }

  const addInterest = ({ topic, note = '', source = 'self', tags = [], weight = 1 } = {}) => {
    const t = String(topic ?? '').trim().slice(0, 80)
    if (!t) return { ok: false, code: 'NO_TOPIC' }
    if (!['self', 'owner', 'seed'].includes(source)) source = 'self'
    const at = now()
    ensureTable()
    try {
      const existing = db.prepare('SELECT * FROM interests WHERE topic=?').get(t) ?? null
      const tagJson = JSON.stringify((Array.isArray(tags) ? tags : []).map(String).filter(Boolean).slice(0, 8))
      const w = Math.max(0.1, Math.min(3, Number(weight) || 1))
      if (existing) {
        db.prepare('UPDATE interests SET note=?, source=?, dropped_at=NULL, tags=?, weight=? WHERE topic=?').run(String(note ?? existing.note ?? '').slice(0, 500), source, tagJson, w, t)
      } else {
        db.prepare('INSERT INTO interests(topic,strength,source,created_at,last_practiced_at,note,dropped_at,tags,weight) VALUES(?,?,?,?,NULL,?,NULL,?,?)').run(t, 0.5, source, at, String(note ?? '').slice(0, 500), tagJson, w)
      }
    } catch (e) {
      return { ok: false, code: 'INTEREST_WRITE_FAILED', error: String(e?.message ?? e) }
    }
    if (source === 'owner') adjustCuriosity(0.03)
    return { ok: true, topic: t, source }
  }

  const listInterests = ({ includeDropped = false } = {}) => {
    ensureTable()
    try {
      const sql = includeDropped
        ? 'SELECT * FROM interests ORDER BY strength DESC, COALESCE(last_practiced_at,0) ASC'
        : 'SELECT * FROM interests WHERE dropped_at IS NULL ORDER BY strength DESC, COALESCE(last_practiced_at,0) ASC'
      return { ok: true, interests: db.prepare(sql).all() }
    } catch (e) {
      return { ok: false, code: 'INTEREST_READ_FAILED', error: String(e?.message ?? e) }
    }
  }

  const dropInterest = ({ topic } = {}) => {
    const t = String(topic ?? '').trim()
    if (!t) return { ok: false, code: 'NO_TOPIC' }
    ensureTable()
    try {
      const r = db.prepare('UPDATE interests SET dropped_at=? WHERE topic=? AND dropped_at IS NULL').run(now(), t)
      if (!r.changes) return { ok: false, code: 'INTEREST_NOT_FOUND' }
      return { ok: true, topic: t, dropped: true }
    } catch (e) {
      return { ok: false, code: 'INTEREST_WRITE_FAILED', error: String(e?.message ?? e) }
    }
  }

  const pickInterest = ({ mood = '', random = Math.random } = {}) => {
    ensureTable()
    try {
      const rows = db.prepare('SELECT * FROM interests WHERE dropped_at IS NULL ORDER BY strength DESC, COALESCE(last_practiced_at,0) ASC').all().filter((r) => matchTopic(r.topic))
      if (!rows.length) return null
      // 10% 探索：随机挑一个，哪怕它很久没碰；否则按 strength×weight（心情差时偏好“放松”标签）
      if (random() < 0.1) return rows[Math.floor(random() * rows.length) % rows.length]
      const scored = rows.map((r) => {
        let tags = []
        try { tags = JSON.parse(r.tags ?? '[]') } catch {}
        let w = Math.max(0.05, Number(r.strength) || 0.5) * Math.max(0.1, Number(r.weight) || 1)
        if (mood && /低落|难过|疲惫|焦虑/.test(String(mood)) && tags.some((t) => /放松|安慰|轻松/.test(String(t)))) w *= 1.8
        return { row: r, w }
      })
      const total = scored.reduce((n, x) => n + x.w, 0)
      let roll = random() * total
      for (const x of scored) { roll -= x.w; if (roll <= 0) return x.row }
      return scored[scored.length - 1].row
    } catch {
      return null
    }
  }

  const suggestInterest = ({ mood = '', random = Math.random } = {}) => {
    const pick = pickInterest({ mood, random })
    if (!pick) return { ok: false, code: 'NO_INTEREST' }
    try { db.prepare('UPDATE interests SET last_suggested_at=? WHERE topic=?').run(now(), pick.topic) } catch {}
    let tags = []
    try { tags = JSON.parse(pick.tags ?? '[]') } catch {}
    return { ok: true, topic: pick.topic, tags, strength: Number(pick.strength), reason: '加权挑选（10% 探索）' }
  }

  const maybeSelfPractice = () => {
    if (curiosity() < curiosityThreshold) return { ok: false, code: 'CURIOSITY_LOW' }
    if (energy() < energyMin) return { ok: false, code: 'ENERGY_LOW' }
    try {
      const day = dayOf(now(), tz)
      const n = Number(db.prepare("SELECT COUNT(1) AS n FROM action_log WHERE event='practice' AND note LIKE '%source=self%' AND at>=?").get(new Date(`${day}T00:00:00+08:00`).getTime()).n ?? 0)
      if (n >= selfDailyCap) return { ok: false, code: 'DAILY_CAP' }
    } catch {}
    const pick = pickInterest()
    if (!pick) return { ok: false, code: 'NO_INTEREST' }
    return run({ topic: pick.topic, note: '自己找的，想看看', source: 'self' })
  }

  return { run, topics, dir, addInterest, listInterests, dropInterest, pickInterest, suggestInterest, maybeSelfPractice, curiosity, energy }
}
