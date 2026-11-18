/** Purpose 目标假设持久化（2026-11-14）：去重、重复提置信、过期。 */
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0))

export function hypothesisKey(seed = {}) {
  const owner = String(seed.owner ?? 'self')
  const need = String(seed.need ?? 'share')
  const topic = String(seed.topic ?? '').replace(/\s+/g, '').slice(0, 32)
  return `${owner}:${need}:${topic}`
}

export function loadPurposeSeeds(db, selfId, limit = 5, now = Date.now(), ttlDays = 14) {
  try {
    const cutoff = now - Math.max(1, ttlDays) * 86400000
    db.prepare("UPDATE purpose_hypotheses SET status='expired' WHERE self_id=? AND last_seen_at < ? AND status IN ('hypothesis','active')").run(String(selfId), cutoff)
    return db.prepare(`SELECT * FROM purpose_hypotheses WHERE self_id=? AND status IN ('hypothesis','active') ORDER BY confidence DESC, last_seen_at DESC LIMIT ?`)
      .all(String(selfId), Math.max(1, limit))
      .map((r) => ({
        owner: r.owner, need: r.need, emotion: r.emotion, topic: r.topic,
        evidence: r.evidence, confidence: Number(r.confidence), risk: Number(r.risk),
        nextStep: r.next_step, status: r.status, seenCount: Number(r.seen_count), at: Number(r.last_seen_at),
      }))
  } catch { return [] }
}

export function savePurposeSeeds(db, selfId, seeds = [], { now = Date.now(), ttlDays = 14 } = {}) {
  let changed = 0
  try {
    for (const seed of seeds.slice(0, 20)) {
      const key = hypothesisKey(seed)
      const old = db.prepare('SELECT confidence,seen_count,status FROM purpose_hypotheses WHERE key=?').get(key)
      const seen = old ? Number(old.seen_count) + 1 : 1
      const conf = old ? clamp01(Math.max(Number(old.confidence), Number(seed.confidence)) + 0.04) : clamp01(seed.confidence ?? 0.3)
      const status = conf >= 0.45 ? 'active' : 'hypothesis'
      db.prepare(`INSERT INTO purpose_hypotheses(key,self_id,owner,need,emotion,topic,evidence,confidence,risk,next_step,status,seen_count,last_seen_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET confidence=excluded.confidence, risk=excluded.risk, next_step=excluded.next_step,
          status=excluded.status, seen_count=excluded.seen_count, last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at`)
        .run(key, String(selfId), String(seed.owner ?? 'self'), String(seed.need ?? 'share'), String(seed.emotion ?? ''), String(seed.topic ?? ''), String(seed.evidence ?? ''), conf, clamp01(seed.risk ?? 0.05), String(seed.nextStep ?? ''), status, seen, now, old ? now : now, now)
      changed++
    }
    const cutoff = now - Math.max(1, ttlDays) * 86400000
    db.prepare("UPDATE purpose_hypotheses SET status='expired' WHERE self_id=? AND last_seen_at < ? AND status IN ('hypothesis','active')").run(String(selfId), cutoff)
  } catch {}
  return changed
}
