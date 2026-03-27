/**
 * Database schema and migration for systematic-claw.
 * Tables: tasks, plans, session_state, audit_log, file_tracking
 */
import type { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 4;

const MIGRATIONS: string[] = [
  // Version 1: Initial schema
  `
  -- Task tree: hierarchical task tracking
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    parent_id TEXT,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'blocked')),
    verification TEXT,
    files_affected TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_key);
  CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

  -- Plans: structured plan-before-execute workflow
  CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    goal TEXT NOT NULL,
    steps TEXT NOT NULL,
    current_step INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL DEFAULT 'drafting' CHECK(phase IN ('drafting', 'awaiting_approval', 'executing', 'verifying', 'completed', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_plans_session ON plans(session_key);

  -- Session state: per-session tracking for hooks
  CREATE TABLE IF NOT EXISTS session_state (
    session_key TEXT PRIMARY KEY,
    agent_id TEXT,
    workflow_type TEXT,
    read_files TEXT NOT NULL DEFAULT '[]',
    modified_files TEXT NOT NULL DEFAULT '[]',
    memory_written INTEGER NOT NULL DEFAULT 0,
    active_plan_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (active_plan_id) REFERENCES plans(id) ON DELETE SET NULL
  );

  -- File tracking: which files were read/modified per session
  CREATE TABLE IF NOT EXISTS file_tracking (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT NOT NULL,
    file_path TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('read', 'write', 'edit')),
    tool_name TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_file_tracking_session ON file_tracking(session_key);
  CREATE INDEX IF NOT EXISTS idx_file_tracking_path ON file_tracking(file_path);

  -- Audit log: completion checks, blocked calls, errors
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT,
    agent_id TEXT,
    trigger_type TEXT,
    event_type TEXT NOT NULL CHECK(event_type IN (
      'session_start', 'session_end',
      'task_created', 'task_completed', 'task_incomplete',
      'plan_created', 'plan_completed', 'plan_incomplete',
      'gate_warned', 'gate_blocked',
      'completion_check_pass', 'completion_check_fail',
      'tool_error', 'memory_not_written',
      'related_file_not_updated'
    )),
    severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info', 'low', 'medium', 'high', 'critical')),
    message TEXT NOT NULL,
    details TEXT,
    duration_ms INTEGER,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_log_session ON audit_log(session_key);
  CREATE INDEX IF NOT EXISTS idx_audit_log_event ON audit_log(event_type);
  CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_log_severity ON audit_log(severity);

  -- Schema version tracking
  CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '1');
  `,

  // Version 2: Debug sessions + plan alternatives
  // NOTE: ALTER TABLE ADD COLUMN is not idempotent in SQLite — handled via PRAGMA check in migrateDatabase
  `
  -- Debug sessions: systematic debugging protocol
  CREATE TABLE IF NOT EXISTS debug_sessions (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    error_description TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'evidence' CHECK(phase IN ('evidence', 'hypothesize', 'test', 'resolved', 'escalated')),
    reproduced INTEGER NOT NULL DEFAULT 0,
    reproduction_steps TEXT,
    hypotheses TEXT NOT NULL DEFAULT '[]',
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    escalation_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_debug_session ON debug_sessions(session_key);

  INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '2');
  `,

  // Version 3: Checkpoints — session state snapshots for rollback
  `
  CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    label TEXT NOT NULL,
    snapshot_data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_key);

  INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '3');
  `,

  // Version 4: Add 'plan_task_sync' + 'workflow_transition' to audit_log event_type CHECK constraint.
  // SQLite cannot ALTER CHECK constraints, so we recreate the table.
  `
  CREATE TABLE IF NOT EXISTS audit_log_v4 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT,
    agent_id TEXT,
    trigger_type TEXT,
    event_type TEXT NOT NULL CHECK(event_type IN (
      'session_start', 'session_end',
      'task_created', 'task_completed', 'task_incomplete',
      'plan_created', 'plan_completed', 'plan_incomplete',
      'plan_task_sync',
      'gate_warned', 'gate_blocked',
      'completion_check_pass', 'completion_check_fail',
      'tool_error', 'memory_not_written',
      'related_file_not_updated',
      'workflow_transition'
    )),
    severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info', 'low', 'medium', 'high', 'critical')),
    message TEXT NOT NULL,
    details TEXT,
    duration_ms INTEGER,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT INTO audit_log_v4 (id, session_key, agent_id, trigger_type, event_type, severity, message, details, duration_ms, timestamp)
    SELECT id, session_key, agent_id, trigger_type, event_type, severity, message, details, duration_ms, timestamp
    FROM audit_log;

  DROP TABLE audit_log;
  ALTER TABLE audit_log_v4 RENAME TO audit_log;

  CREATE INDEX IF NOT EXISTS idx_audit_log_session ON audit_log(session_key);
  CREATE INDEX IF NOT EXISTS idx_audit_log_event ON audit_log(event_type);
  CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_log_severity ON audit_log(severity);

  INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '4');
  `,
];

/** Safely add a column if it doesn't exist (ALTER TABLE ADD COLUMN is not idempotent in SQLite). */
function safeAddColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const exists = rows.some(r => r.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function migrateDatabase(db: DatabaseSync): void {
  let currentVersion = 0;
  try {
    const row = db.prepare(
      "SELECT value FROM schema_meta WHERE key = 'version'"
    ).get() as { value: string } | undefined;
    if (row) {
      currentVersion = parseInt(row.value, 10) || 0;
    }
  } catch {
    currentVersion = 0;
  }

  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    const migration = MIGRATIONS[i];
    if (migration) {
      // Run entire migration as a single atomic transaction
      db.exec("BEGIN");
      try {
        db.exec(migration);
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* rollback best-effort */ }
        throw error;
      }
    }
  }

  // Post-migration: safe ALTER TABLE operations (always run — idempotent via PRAGMA check)
  // Wrapped in transaction for atomicity — all columns added or none.
  // Individual safeAddColumn calls are idempotent (PRAGMA check), so re-running after
  // a crash will simply skip already-added columns and add missing ones.
  db.exec("BEGIN");
  try {
    safeAddColumn(db, "session_state", "active_debug_id", "TEXT REFERENCES debug_sessions(id) ON DELETE SET NULL");
    safeAddColumn(db, "plans", "alternatives", "TEXT DEFAULT '[]'");
    safeAddColumn(db, "plans", "change_summary", "TEXT");
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* rollback best-effort */ }
    throw err;
  }
}
