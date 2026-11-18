/**
 * autonomy.db schema
 *
 * v1（阶段 2）：meta / drives / goals / actions / action_log / tick_runs
 * v2（阶段 3）：reflections（触发器记账，仍**不调模型**；正文由阶段 4 生成）
 *
 * 迁移：PRAGMA user_version（0 = 空库 / 未标记）。
 * 规矩：
 * - 只向上加，不删列、不改语义；每加一版 SCHEMA_VERSION +1，并在 MIGRATIONS 里留 SQL
 * - 所有时间戳是 Unix 毫秒整数（与 DSH 一致）
 * - DDL 全部 IF NOT EXISTS，允许重复执行（版本号是唯一闸门）
 */

export const SCHEMA_VERSION = 3

export const DDL = [
  `CREATE TABLE IF NOT EXISTS meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS drives (
    self_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    value      REAL NOT NULL DEFAULT 0.5 CHECK (value >= 0 AND value <= 1),
    baseline   REAL NOT NULL DEFAULT 0.5,
    growth     REAL NOT NULL DEFAULT 0.05,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (self_id, name)
  )`,

  `CREATE TABLE IF NOT EXISTS goals (
    id              TEXT PRIMARY KEY,
    self_id         TEXT NOT NULL,
    title           TEXT NOT NULL,
    note            TEXT,
    source          TEXT NOT NULL DEFAULT 'self',
    priority        REAL NOT NULL DEFAULT 0.5,
    status          TEXT NOT NULL DEFAULT 'open',
    kind_hint       TEXT,
    due_at          INTEGER,
    last_touched_at INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_goals_open ON goals(self_id, status, priority DESC)`,

  `CREATE TABLE IF NOT EXISTS actions (
    id                 TEXT PRIMARY KEY,
    self_id            TEXT NOT NULL,
    kind               TEXT NOT NULL,
    goal_id            TEXT REFERENCES goals(id) ON DELETE SET NULL,
    status             TEXT NOT NULL DEFAULT 'planned',
    risk               TEXT NOT NULL DEFAULT 'low',
    reason             TEXT,
    decision_json      TEXT,
    evidence_json      TEXT,
    cost_estimate      REAL DEFAULT 0,
    importance         INTEGER NOT NULL DEFAULT 1,
    expect_reply_until INTEGER,
    attempt            INTEGER NOT NULL DEFAULT 1,
    lease_until        INTEGER,
    started_at         INTEGER,
    ended_at           INTEGER,
    result_json        TEXT,
    error              TEXT,
    episode_ref        TEXT,
    created_at         INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_actions_recent  ON actions(self_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_actions_kind    ON actions(self_id, kind, status, ended_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_actions_running ON actions(status, lease_until)`,

  `CREATE TABLE IF NOT EXISTS action_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        INTEGER NOT NULL,
    self_id   TEXT NOT NULL,
    action_id TEXT,
    event     TEXT NOT NULL,
    code      TEXT,
    note      TEXT,
    data_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_log_at    ON action_log(self_id, at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_log_event ON action_log(event, at DESC)`,

  `CREATE TABLE IF NOT EXISTS tick_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          INTEGER NOT NULL,
    self_id     TEXT NOT NULL,
    trigger     TEXT NOT NULL,
    outcome     TEXT NOT NULL,
    code        TEXT,
    top_kind    TEXT,
    top_score   REAL,
    model_calls INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    note        TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tick_at ON tick_runs(self_id, at DESC)`,

  // v2：反思触发器记账（pending = 该反思了，但还没生成正文；阶段 3 不调模型）
  `CREATE TABLE IF NOT EXISTS reflections (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    self_id      TEXT NOT NULL,
    at           INTEGER NOT NULL,
    period       TEXT NOT NULL DEFAULT 'threshold',
    status       TEXT NOT NULL DEFAULT 'pending',
    trigger      TEXT,
    importance   INTEGER NOT NULL DEFAULT 0,
    window_start INTEGER,
    window_end   INTEGER,
    evidence_json TEXT,
    text         TEXT,
    applied_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reflections_pending ON reflections(self_id, status, at DESC)`,

  // v3：Purpose 目标假设（2026-11-14）
  `CREATE TABLE IF NOT EXISTS purpose_hypotheses (
    key         TEXT PRIMARY KEY,
    self_id     TEXT NOT NULL,
    owner       TEXT NOT NULL DEFAULT 'self',
    need        TEXT NOT NULL,
    emotion     TEXT NOT NULL DEFAULT '',
    topic       TEXT NOT NULL DEFAULT '',
    evidence    TEXT NOT NULL DEFAULT '',
    confidence  REAL NOT NULL DEFAULT 0.3,
    risk        REAL NOT NULL DEFAULT 0.05,
    next_step   TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'hypothesis',
    seen_count  INTEGER NOT NULL DEFAULT 1,
    last_seen_at INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_purpose_recent ON purpose_hypotheses(self_id, status, last_seen_at DESC)`,
]

/** 版本迁移：{ n: [sql...] }；只在 user_version 落后时按序执行 */
export const MIGRATIONS = {
  2: [
    `CREATE TABLE IF NOT EXISTS reflections (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      self_id      TEXT NOT NULL,
      at           INTEGER NOT NULL,
      period       TEXT NOT NULL DEFAULT 'threshold',
      status       TEXT NOT NULL DEFAULT 'pending',
      trigger      TEXT,
      importance   INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER,
      window_end   INTEGER,
      evidence_json TEXT,
      text         TEXT,
      applied_json TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_reflections_pending ON reflections(self_id, status, at DESC)`,
  ],
}

export function currentVersion(db) {
  try {
    const row = db.prepare('PRAGMA user_version').get()
    return Number(row?.user_version ?? 0)
  } catch {
    return 0
  }
}

/**
 * 幂等迁移：空库建全表并打版本；已有版本只跑缺失的那几步。
 * @returns {{from:number,to:number,applied:boolean,steps:number[]}}
 */
export function migrate(db) {
  const from = currentVersion(db)
  if (from >= SCHEMA_VERSION) return { from, to: from, applied: false, steps: [] }

  const steps = []
  if (from === 0) {
    for (const sql of DDL) db.exec(sql)
    steps.push(1)
  } else {
    for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
      for (const sql of MIGRATIONS[v] ?? []) db.exec(sql)
      steps.push(v)
    }
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  return { from, to: SCHEMA_VERSION, applied: true, steps }
}
