/** 家的实际活动（2026-11-14）：记 home 会话里真正调用过的工具/动作，HUD 不再拿“醒来”冒充。 */
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const SECRET = /(token|key|password|secret|cookie|authorization)/i

function summarizeArgs(raw) {
  let a = null
  try { a = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { a = null }
  if (!a || typeof a !== 'object') return clip(raw, 120)
  const bits = []
  for (const k of ['query', 'text', 'path', 'file', 'name', 'id', 'kind', 'url', 'command', 'prompt']) {
    if (SECRET.test(k)) continue
    if (a[k] !== undefined && a[k] !== null && String(a[k]).trim()) bits.push(clip(a[k], 70))
    if (bits.length >= 2) break
  }
  return bits.join(' · ').slice(0, 140)
}

export function recordActivity(db, selfId, { sessionId = '', kind = 'tool', name = '', args = null, summary = '', status = 'done', at = Date.now(), meta = null } = {}) {
  try {
    const text = summary || summarizeArgs(args)
    const info = db.prepare('INSERT INTO home_activities(self_id,session_id,kind,name,summary,status,at,meta_json) VALUES(?,?,?,?,?,?,?,?)')
      .run(String(selfId), String(sessionId), String(kind), String(name), clip(text, 160), String(status), Number(at), meta ? JSON.stringify(meta).slice(0, 1000) : null)
    try { db.prepare('DELETE FROM home_activities WHERE id < ?').run(Number(info.lastInsertRowid) - 800) } catch {}
    return Number(info.lastInsertRowid)
  } catch { return 0 }
}

export function recentActivities(db, selfId, limit = 8) {
  try {
    return db.prepare('SELECT id,kind,name,summary,status,at,session_id FROM home_activities WHERE self_id=? ORDER BY at DESC LIMIT ?')
      .all(String(selfId), Math.max(1, Number(limit) || 8))
  } catch { return [] }
}
