/**
 * Audit log — records gate warnings/blocks, completion checks, errors.
 * Provides stats for /systematic command dashboard.
 */
import type { DatabaseSync } from "node:sqlite";

export type AuditEventType =
  | "session_start" | "session_end"
  | "task_created" | "task_completed" | "task_incomplete"
  | "plan_created" | "plan_completed" | "plan_incomplete"
  | "gate_warned" | "gate_blocked"
  | "completion_check_pass" | "completion_check_fail"
  | "tool_error" | "memory_not_written"
  | "related_file_not_updated";

export type AuditSeverity = "info" | "low" | "medium" | "high" | "critical";

export type AuditEntry = {
  sessionKey?: string;
  agentId?: string;
  triggerType?: string;
  eventType: AuditEventType;
  severity: AuditSeverity;
  message: string;
  details?: Record<string, unknown>;
  durationMs?: number;
};

export type AuditStats = {
  last24h: {
    completed: number;
    withIssues: number;
    blockedCalls: number;
    warnedCalls: number;
    errors: number;
  };
  last7d: {
    completionRate: number;
    topIssue: string;
    totalSessions: number;
  };
};

export class AuditLog {
  constructor(private db: DatabaseSync) {}

  record(entry: AuditEntry): void {
    this.db.prepare(`
      INSERT INTO audit_log (session_key, agent_id, trigger_type, event_type, severity, message, details, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.sessionKey ?? null,
      entry.agentId ?? null,
      entry.triggerType ?? null,
      entry.eventType,
      entry.severity,
      entry.message,
      entry.details ? JSON.stringify(entry.details) : null,
      entry.durationMs ?? null,
    );
  }

  getStats(): AuditStats {
    // Last 24 hours
    const completedRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM audit_log
      WHERE event_type = 'session_end'
      AND timestamp >= datetime('now', '-1 day')
    `).get() as { count: number };

    const issuesRow = this.db.prepare(`
      SELECT COUNT(DISTINCT session_key) as count FROM audit_log
      WHERE event_type = 'completion_check_fail'
      AND timestamp >= datetime('now', '-1 day')
    `).get() as { count: number };

    const blockedRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM audit_log
      WHERE event_type = 'gate_blocked'
      AND timestamp >= datetime('now', '-1 day')
    `).get() as { count: number };

    const warnedRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM audit_log
      WHERE event_type = 'gate_warned'
      AND timestamp >= datetime('now', '-1 day')
    `).get() as { count: number };

    const errorsRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM audit_log
      WHERE event_type = 'tool_error'
      AND timestamp >= datetime('now', '-1 day')
    `).get() as { count: number };

    // Last 7 days
    const weekTotalRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM audit_log
      WHERE event_type = 'session_end'
      AND timestamp >= datetime('now', '-7 days')
    `).get() as { count: number };

    const weekPassRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM audit_log
      WHERE event_type = 'completion_check_pass'
      AND timestamp >= datetime('now', '-7 days')
    `).get() as { count: number };

    const topIssueRow = this.db.prepare(`
      SELECT event_type, COUNT(*) as count FROM audit_log
      WHERE severity IN ('medium', 'high', 'critical')
      AND timestamp >= datetime('now', '-7 days')
      GROUP BY event_type
      ORDER BY count DESC
      LIMIT 1
    `).get() as { event_type: string; count: number } | undefined;

    const weekTotal = weekTotalRow.count || 0;
    const weekPass = weekPassRow.count || 0;
    const completionRate = weekTotal > 0 ? Math.round((weekPass / weekTotal) * 100) : 0;

    return {
      last24h: {
        completed: completedRow.count,
        withIssues: issuesRow.count,
        blockedCalls: blockedRow.count,
        warnedCalls: warnedRow.count,
        errors: errorsRow.count,
      },
      last7d: {
        completionRate,
        topIssue: topIssueRow?.event_type ?? "yok",
        totalSessions: weekTotal,
      },
    };
  }

  /** Get a brief summary of the last session's audit for cross-session context injection. */
  getLastSessionSummary(): string | null {
    // Find the most recent session that ended
    const lastSession = this.db.prepare(`
      SELECT session_key FROM audit_log
      WHERE event_type = 'session_end'
      ORDER BY timestamp DESC LIMIT 1
    `).get() as { session_key: string } | undefined;

    if (!lastSession?.session_key) return null;

    const sk = lastSession.session_key;

    // Get counts for that session
    const blocks = this.db.prepare(
      "SELECT COUNT(*) as c FROM audit_log WHERE session_key = ? AND event_type = 'gate_blocked'"
    ).get(sk) as { c: number };

    const warnings = this.db.prepare(
      "SELECT COUNT(*) as c FROM audit_log WHERE session_key = ? AND event_type = 'gate_warned'"
    ).get(sk) as { c: number };

    const incomplete = this.db.prepare(
      "SELECT COUNT(*) as c FROM audit_log WHERE session_key = ? AND event_type = 'task_incomplete'"
    ).get(sk) as { c: number };

    const errors = this.db.prepare(
      "SELECT COUNT(*) as c FROM audit_log WHERE session_key = ? AND event_type = 'tool_error'"
    ).get(sk) as { c: number };

    const shellWrites = this.db.prepare(
      "SELECT COUNT(*) as c FROM audit_log WHERE session_key = ? AND event_type = 'gate_warned' AND details LIKE '%shell_write%'"
    ).get(sk) as { c: number };

    const parts: string[] = [];
    if (blocks.c > 0) parts.push(`${blocks.c} gate bloğu`);
    if (warnings.c > 0) parts.push(`${warnings.c} uyarı`);
    if (incomplete.c > 0) parts.push(`${incomplete.c} tamamlanmamış görev`);
    if (errors.c > 0) parts.push(`${errors.c} tool hatası`);
    if (shellWrites.c > 0) parts.push(`${shellWrites.c} shell dosya yazımı`);

    if (parts.length === 0) return null;

    return `ÖNCEKİ SESSION: ${parts.join(", ")}. Bu session'da aynı hataları tekrarlama.`;
  }

  getRecentEntries(limit: number = 20): Array<AuditEntry & { timestamp: string }> {
    const rows = this.db.prepare(`
      SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?
    `).all(limit) as Array<{
      session_key: string | null; agent_id: string | null;
      trigger_type: string | null; event_type: AuditEventType;
      severity: AuditSeverity; message: string;
      details: string | null; duration_ms: number | null;
      timestamp: string;
    }>;

    return rows.map(row => ({
      sessionKey: row.session_key ?? undefined,
      agentId: row.agent_id ?? undefined,
      triggerType: row.trigger_type ?? undefined,
      eventType: row.event_type,
      severity: row.severity,
      message: row.message,
      details: row.details ? JSON.parse(row.details) : undefined,
      durationMs: row.duration_ms ?? undefined,
      timestamp: row.timestamp,
    }));
  }
}
