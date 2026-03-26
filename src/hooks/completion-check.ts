/**
 * Layer 3: AUDIT — agent_end hook (Completion Checklist).
 *
 * Runs when any agent session ends. Checks:
 * 1. All tasks completed?
 * 2. Active plan finished?
 * 3. Related files updated after modifications?
 * 4. Memory written (if enforced)?
 */
import type { SessionStateStore } from "../store/session-state.js";
import type { AuditLog } from "../store/audit-log.js";
import { RELATED_FILE_RULES } from "../tools/common.js";

export type CompletionIssue = {
  type: string;
  message: string;
  severity: "low" | "medium" | "high";
  details?: string[];
};

export function handleAgentEnd(deps: {
  store: SessionStateStore;
  auditLog: AuditLog;
  completionCheckEnabled: boolean;
  memoryEnforcementEnabled: boolean;
}) {
  return (event: {
    messages: unknown[];
    success: boolean;
    error?: string;
    durationMs?: number;
  }, ctx: {
    agentId?: string;
    sessionKey?: string;
    trigger?: string;
  }) => {
    const sessionKey = ctx.sessionKey ?? "unknown";

    try {
      deps.auditLog.record({
        sessionKey,
        agentId: ctx.agentId,
        triggerType: ctx.trigger,
        eventType: "session_end",
        severity: "info",
        message: `Session ended (${event.success ? "success" : "error"})`,
        durationMs: event.durationMs,
      });

      if (!deps.completionCheckEnabled) return;

      const snapshot = deps.store.getSnapshot(sessionKey);
      if (!snapshot) return;

      const issues: CompletionIssue[] = [];

      // ── CHECK 1: Incomplete tasks ──────────────────

      const allTasks = flattenTasks(snapshot.tasks);
      // "blocked" tasks from cancelled plans are not actionable — exclude them
      const incompleteTasks = allTasks.filter(t => t.status !== "completed" && t.status !== "blocked");
      if (incompleteTasks.length > 0 && allTasks.length > 0) {
        issues.push({
          type: "incomplete_tasks",
          message: `${incompleteTasks.length}/${allTasks.length} görev tamamlanmadı`,
          severity: "high",
          details: incompleteTasks.map(t => `${t.id}: ${t.content} (${t.status})`),
        });
      }

      // ── CHECK 2: Incomplete plan ───────────────────

      if (snapshot.activePlan && snapshot.activePlan.phase !== "completed" && snapshot.activePlan.phase !== "cancelled") {
        issues.push({
          type: "incomplete_plan",
          message: `Plan "${snapshot.activePlan.goal}" tamamlanmadı (${snapshot.activePlan.phase}, adım ${snapshot.activePlan.currentStep + 1}/${snapshot.activePlan.steps.length})`,
          severity: "high",
        });
      }

      // ── CHECK 3: Related file updates ──────────────

      if (snapshot.modifiedFiles.length > 0) {
        // Deduplicate: check each required file only once, not per modified file
        const checkedRequired = new Set<string>();
        const missingUpdates: string[] = [];

        for (const modifiedFile of snapshot.modifiedFiles) {
          for (const rule of RELATED_FILE_RULES) {
            if (rule.pattern.test(modifiedFile)) {
              for (const required of rule.requires) {
                if (checkedRequired.has(required)) continue;
                checkedRequired.add(required);

                const wasUpdated = snapshot.modifiedFiles.some(f =>
                  f.endsWith(required) || f.includes(required)
                );
                if (!wasUpdated) {
                  missingUpdates.push(`${required} güncellenmedi (${rule.description})`);
                }
              }
            }
          }
        }

        if (missingUpdates.length > 0) {
          issues.push({
            type: "missing_related_updates",
            message: `${missingUpdates.length} ilişkili dosya güncellenmedi`,
            severity: "medium",
            details: missingUpdates,
          });
        }
      }

      // ── CHECK 4: Memory enforcement ────────────────

      if (deps.memoryEnforcementEnabled && !snapshot.memoryWritten) {
        // Only warn if there were actual modifications (don't warn for read-only sessions)
        if (snapshot.modifiedFiles.length > 0) {
          issues.push({
            type: "no_memory_written",
            message: "Dosya değişikliği yapıldı ama memory/öğrenme dosyasına yazılmadı",
            severity: "low",
          });
        }
      }

      // ── CHECK 5: Quality review ──────────────────

      if (snapshot.modifiedFiles.length > 0 && !deps.store.hasQualityReview(sessionKey)) {
        issues.push({
          type: "no_quality_review",
          message: "quality_checklist çağrılmadı — dosya değişikliği yapıldı ama self-review yapılmadı. " +
            "İş tamamlanmadan önce quality_checklist(action: 'review') çağır.",
          severity: "high",
        });
      }

      // ── CHECK 6: Skill awareness ──────────────────

      const toolCalls = deps.store.getRecentToolCalls(sessionKey);
      const callCount = toolCalls?.length ?? 0;

      // 6a: No skill used in a substantial session with a detected workflow
      if (callCount >= 10 && !deps.store.hasSkillAccess(sessionKey) && snapshot.workflowType && snapshot.workflowType !== "general") {
        issues.push({
          type: "no_skill_used",
          message: `"${snapshot.workflowType}" tipinde ${callCount} tool call yapıldı ama hiç skill kullanılmadı. ` +
            `Bu iş tipi için uygun bir skill olup olmadığını kontrol et.`,
          severity: "low",
        });
      }

      // 6b: Repetitive pattern → skill creation suggestion
      const repetitivePatterns = deps.store.detectRepetitivePatterns(sessionKey);
      if (repetitivePatterns.length > 0) {
        const suggestions = repetitivePatterns
          .map(p => `"${p.pattern}" (${p.count}x)`)
          .join(", ");
        issues.push({
          type: "skill_opportunity",
          message: `Tekrarlayan iş akışı tespit edildi: ${suggestions}. ` +
            `Bu pattern için bir skill oluşturulması önerilir — tutarlılığı artırır ve zaman kazandırır.`,
          severity: "low",
        });
      }

      // ── Record result ──────────────────────────────

      if (issues.length === 0) {
        deps.auditLog.record({
          sessionKey,
          agentId: ctx.agentId,
          triggerType: ctx.trigger,
          eventType: "completion_check_pass",
          severity: "info",
          message: "Completion check passed — tüm kontroller geçti",
          durationMs: event.durationMs,
        });
      } else {
        for (const issue of issues) {
          deps.auditLog.record({
            sessionKey,
            agentId: ctx.agentId,
            triggerType: ctx.trigger,
            eventType: "completion_check_fail",
            severity: issue.severity,
            message: issue.message,
            details: {
              type: issue.type,
              items: issue.details,
            },
          });
        }
      }
    } catch (err) {
      // Non-critical — don't fail on audit errors, but log for debugging
      console.warn("[systematic-claw] completion-check error:", err instanceof Error ? err.message : err);
    }
  };
}

// Flatten nested task tree into flat array
function flattenTasks(tasks: Array<{ status: string; id: string; content: string; children?: unknown[] }>): Array<{ status: string; id: string; content: string }> {
  const result: Array<{ status: string; id: string; content: string }> = [];
  for (const task of tasks) {
    result.push({ status: task.status, id: task.id, content: task.content });
    if (task.children && Array.isArray(task.children)) {
      result.push(...flattenTasks(task.children as typeof tasks));
    }
  }
  return result;
}
