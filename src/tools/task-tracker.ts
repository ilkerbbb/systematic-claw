/**
 * task_tracker tool — hierarchical task tracking for OpenClaw agents.
 * Claude Code equivalent: TodoWrite
 *
 * Supports: create, update, add_subtask, complete, delete, list
 * Features: parent-child relationships, verification field, file tracking
 */
import { Type } from "@sinclair/typebox";
import type { SessionStateStore, TaskStatus } from "../store/session-state.js";
import type { AuditLog } from "../store/audit-log.js";
import { jsonResult, generateId, renderTaskTree, RELATED_FILE_RULES, PROPAGATION_RULES, isExcludedFromRelatedFileRules, type AnyAgentTool } from "./common.js";
import type { GateMode } from "../hooks/hard-gates.js";

const TaskTrackerSchema = Type.Object({
  action: Type.Union([
    Type.Literal("create"),
    Type.Literal("update"),
    Type.Literal("add_subtask"),
    Type.Literal("complete"),
    Type.Literal("delete"),
    Type.Literal("list"),
    Type.Literal("checkpoint"),
    Type.Literal("rollback"),
  ], {
    description: "Action to perform on the task tree. checkpoint: save current state. rollback: restore to a checkpoint.",
  }),
  tasks: Type.Optional(Type.Array(Type.Object({
    id: Type.Optional(Type.String({ description: "Task ID (auto-generated if omitted on create)" })),
    content: Type.Optional(Type.String({ description: "Task description" })),
    status: Type.Optional(Type.Union([
      Type.Literal("pending"),
      Type.Literal("in_progress"),
      Type.Literal("completed"),
      Type.Literal("blocked"),
    ], { description: "Task status" })),
    parent_id: Type.Optional(Type.String({ description: "Parent task ID for subtasks" })),
    verification: Type.Optional(Type.String({ description: "How you verified this task is complete" })),
    files_affected: Type.Optional(Type.Array(Type.String(), { description: "Files affected by this task" })),
  }), {
    description: "Tasks to create or update",
  })),
  task_id: Type.Optional(Type.String({
    description: "Task ID for single-task operations (complete, delete)",
  })),
  verification: Type.Optional(Type.String({
    description: "Verification evidence when completing a task",
  })),
  label: Type.Optional(Type.String({
    description: "Label for checkpoint (used with checkpoint action)",
  })),
  checkpoint_id: Type.Optional(Type.String({
    description: "Checkpoint ID to rollback to (used with rollback action)",
  })),
});

export function createTaskTrackerTool(deps: {
  store: SessionStateStore;
  auditLog: AuditLog;
  sessionKey?: string;
  gateMode?: GateMode;
}): AnyAgentTool {
  return {
    name: "task_tracker",
    label: "Task Tracker",
    description:
      "Manage a hierarchical task list for the current session. " +
      "Use this to track progress on multi-step tasks. " +
      "Supports parent-child relationships (subtasks), verification evidence, " +
      "and file tracking. Actions: create, update, add_subtask, complete, delete, list. " +
      "IMPORTANT: Use this for any task with 3+ steps. Update regularly.",
    parameters: TaskTrackerSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const action = p.action as string;
      const sessionKey = deps.sessionKey ?? "unknown";

      try {
        deps.store.ensureSession(sessionKey);

        switch (action) {
          case "create": {
            const tasks = p.tasks as Array<Record<string, unknown>> | undefined;
            if (!tasks || tasks.length === 0) {
              return jsonResult({ error: "tasks array required for create action" });
            }

            const created: string[] = [];
            for (const task of tasks) {
              const id = (task.id as string) || generateId("t");
              // Prevent bypass: tasks cannot be created as "completed" — must go through complete action
              const requestedStatus = (task.status as TaskStatus) || "pending";
              const safeStatus: TaskStatus = requestedStatus === "completed" ? "pending" : requestedStatus;

              deps.store.createTask({
                id,
                sessionKey,
                parentId: task.parent_id as string | undefined,
                content: (task.content as string) || "Untitled task",
                status: safeStatus,
                filesAffected: task.files_affected as string[] | undefined,
              });
              created.push(id);

              deps.auditLog.record({
                sessionKey,
                eventType: "task_created",
                severity: "info",
                message: `Task created: ${task.content}`,
                details: {
                  taskId: id,
                  parentId: task.parent_id,
                  ...(requestedStatus === "completed" ? { overridden: "completed→pending (use complete action)" } : {}),
                },
              });
            }

            const tree = deps.store.getTaskTree(sessionKey);
            return jsonResult({
              success: true,
              created,
              message: `${created.length} görev oluşturuldu`,
              taskTree: renderTaskTree(tree),
              summary: getTaskSummary(deps.store, sessionKey),
            });
          }

          case "update": {
            const tasks = p.tasks as Array<Record<string, unknown>> | undefined;
            if (!tasks || tasks.length === 0) {
              return jsonResult({ error: "tasks array required for update action" });
            }

            const gateMode = deps.gateMode ?? "block";

            // ── WORKFLOW CHAIN GATE (update path) ────────
            // If any task is being set to "completed" via update, apply the same
            // chain checks as the dedicated complete action — agent can't bypass
            // by using update(status: "completed") instead of complete().
            const completingTasks = tasks.filter(t => t.status === "completed");
            const updateChainWarnings: string[] = [];
            const updateCritical: string[] = [];
            const updateAdvisory: string[] = [];

            if (completingTasks.length > 0) {
              const snapshot = deps.store.getSnapshot(sessionKey);
              if (snapshot && snapshot.modifiedFiles.length > 0) {
                if (!deps.store.hasRecentVerification(sessionKey)) {
                  const msg = "❌ DOĞRULAMA EKSİK — Dosya değişikliği yapıldı ama test/build/lint çalıştırılmadı.";
                  updateChainWarnings.push(msg);
                  updateCritical.push(msg);
                }
                const missingRelated = new Set<string>();
                for (const modFile of snapshot.modifiedFiles) {
                  if (isExcludedFromRelatedFileRules(modFile)) continue;
                  for (const rule of RELATED_FILE_RULES) {
                    if (rule.pattern.test(modFile)) {
                      for (const required of rule.requires) {
                        const wasUpdated = snapshot.modifiedFiles.some(f =>
                          f.endsWith(required.toLowerCase()) || f.includes(required.toLowerCase())
                        );
                        if (!wasUpdated) {
                          missingRelated.add(required);
                        }
                      }
                    }
                  }
                }
                if (missingRelated.size > 0) {
                  const msg = `⚠️ İLİŞKİLİ DOSYA EKSİK — Güncellenmedi: ${[...missingRelated].join(", ")}`;
                  updateChainWarnings.push(msg);
                  updateAdvisory.push(msg);
                }
              }

              if (updateChainWarnings.length > 0) {
                const hasCritical = updateCritical.length > 0;
                const shouldBlock = hasCritical || gateMode === "block";

                deps.auditLog.record({
                  sessionKey,
                  eventType: shouldBlock ? "gate_blocked" : "gate_warned",
                  severity: shouldBlock ? "high" : "medium",
                  message: `Workflow chain gate: update-to-complete ${shouldBlock ? "blocked" : "warned"}`,
                  details: {
                    gate: "workflow_chain",
                    taskIds: completingTasks.map(t => t.id),
                    critical: updateCritical,
                    advisory: updateAdvisory,
                    gateMode,
                    overriddenByCritical: hasCritical && gateMode === "warn",
                  },
                });

                if (shouldBlock) {
                  return jsonResult({
                    error: "Görev(ler) tamamlanamıyor — workflow chain eksik",
                    warnings: updateChainWarnings,
                    ...(hasCritical && gateMode === "warn" ? {
                      note: "⛔ Doğrulama eksikliği kritik — gateMode: warn olsa bile engellendi.",
                    } : {}),
                    hint: "Önce doğrulama komutu çalıştır ve ilişkili dosyaları güncelle.",
                  });
                }
              }
            }

            const updated: string[] = [];
            for (const task of tasks) {
              const id = task.id as string;
              if (!id) continue;

              if (task.status) {
                deps.store.updateTaskStatus(
                  id,
                  task.status as TaskStatus,
                  task.verification as string | undefined,
                );
                updated.push(id);

                if (task.status === "completed") {
                  deps.auditLog.record({
                    sessionKey,
                    eventType: "task_completed",
                    severity: "info",
                    message: `Task completed: ${id}`,
                    details: { taskId: id, verification: task.verification },
                  });
                }
              }
            }

            const tree = deps.store.getTaskTree(sessionKey);
            return jsonResult({
              success: true,
              updated,
              ...(updateChainWarnings.length > 0 ? { warnings: updateChainWarnings } : {}),
              taskTree: renderTaskTree(tree),
              summary: getTaskSummary(deps.store, sessionKey),
            });
          }

          case "add_subtask": {
            const tasks = p.tasks as Array<Record<string, unknown>> | undefined;
            if (!tasks || tasks.length === 0) {
              return jsonResult({ error: "tasks array with parent_id required" });
            }

            const created: string[] = [];
            for (const task of tasks) {
              if (!task.parent_id) {
                return jsonResult({ error: "parent_id required for add_subtask" });
              }
              const id = (task.id as string) || generateId("t");
              // Prevent bypass: subtasks cannot be created as "completed"
              const reqStatus = (task.status as TaskStatus) || "pending";
              const safeStatus: TaskStatus = reqStatus === "completed" ? "pending" : reqStatus;

              deps.store.createTask({
                id,
                sessionKey,
                parentId: task.parent_id as string,
                content: (task.content as string) || "Untitled subtask",
                status: safeStatus,
                filesAffected: task.files_affected as string[] | undefined,
              });
              created.push(id);
            }

            const tree = deps.store.getTaskTree(sessionKey);
            return jsonResult({
              success: true,
              created,
              message: `${created.length} alt görev eklendi`,
              taskTree: renderTaskTree(tree),
              summary: getTaskSummary(deps.store, sessionKey),
            });
          }

          case "complete": {
            const taskId = p.task_id as string;
            if (!taskId) {
              return jsonResult({ error: "task_id required for complete action" });
            }

            const verification = p.verification as string | undefined;
            const gateMode = deps.gateMode ?? "block";

            // ── WORKFLOW CHAIN GATE ──────────────────────
            // Before completing a task, check:
            // 1. Were files modified? If so, was verification (test/build) run?
            // 2. Were source files modified but STATE.md not updated?
            // These checks enforce the edit→verify→mark chain.
            //
            // Two severity levels:
            // - chainCritical: ALWAYS block (verification missing) — cannot be bypassed even in warn mode
            // - chainAdvisory: follow gateMode (related files, propagation)
            const chainWarnings: string[] = [];
            const chainCritical: string[] = [];
            const chainAdvisory: string[] = [];
            const snapshot = deps.store.getSnapshot(sessionKey);

            if (snapshot && snapshot.modifiedFiles.length > 0) {
              // Check 1: Verification after file modifications — CRITICAL (always blocks)
              if (!deps.store.hasRecentVerification(sessionKey)) {
                const msg = "❌ DOĞRULAMA EKSİK — Dosya değişikliği yapıldı ama test/build/lint komutu çalıştırılmadı. " +
                  "Önce doğrulama komutu çalıştır, sonra görevi tamamla.";
                chainWarnings.push(msg);
                chainCritical.push(msg);
              }

              // Check 2: Related file updates (STATE.md etc.)
              const missingRelated = new Set<string>();
              for (const modFile of snapshot.modifiedFiles) {
                if (isExcludedFromRelatedFileRules(modFile)) continue;
                for (const rule of RELATED_FILE_RULES) {
                  if (rule.pattern.test(modFile)) {
                    for (const required of rule.requires) {
                      const wasUpdated = snapshot.modifiedFiles.some(f =>
                        f.endsWith(required.toLowerCase()) || f.includes(required.toLowerCase())
                      );
                      if (!wasUpdated) {
                        missingRelated.add(required);
                      }
                    }
                  }
                }
              }
              if (missingRelated.size > 0) {
                const msg = `⚠️ İLİŞKİLİ DOSYA EKSİK — Kaynak kodu değişti ama şunlar güncellenmedi: ${[...missingRelated].join(", ")}. ` +
                  `Bu dosyaları güncellemeden görevi tamamlama.`;
                chainWarnings.push(msg);
                chainAdvisory.push(msg);
              }

              // Check 3: Propagation — source file changed but test file not updated
              // Exempt: /tmp/, /var/, scratch/test directories — these are throwaway files
              const EXEMPT_PATHS = /^\/(tmp|var|private\/tmp)\//i;
              for (const modFile of snapshot.modifiedFiles) {
                if (EXEMPT_PATHS.test(modFile)) continue; // Skip temp/scratch files
                for (const rule of PROPAGATION_RULES) {
                  if (rule.sourcePattern.test(modFile)) {
                    const candidates = rule.dependentPattern(modFile);
                    for (const candidate of candidates) {
                      if (!candidate.includes("*")) {
                        const normCandidate = candidate.toLowerCase();
                        const wasUpdated = snapshot.modifiedFiles.some(f => f.toLowerCase().includes(normCandidate));
                        if (!wasUpdated) {
                          // Only warn for concrete test files (not all candidates)
                          if (/\.(test|spec|_test)\./i.test(candidate)) {
                            const msg = `⚠️ TEST DOSYASI GÜNCELLENMEDİ — "${modFile}" değişti ama ilişkili test dosyası "${candidate}" güncellenmedi.`;
                            chainWarnings.push(msg);
                            chainAdvisory.push(msg);
                            break; // One propagation warning per source file is enough
                          }
                        }
                      }
                    }
                  }
                }
              }
            }

            // If there are chain warnings, enforce based on severity:
            // - Critical warnings (verification missing) ALWAYS block, regardless of gateMode
            // - Advisory warnings (related files, propagation) follow gateMode
            if (chainWarnings.length > 0) {
              const hasCritical = chainCritical.length > 0;
              const shouldBlock = hasCritical || gateMode === "block";

              deps.auditLog.record({
                sessionKey,
                eventType: shouldBlock ? "gate_blocked" : "gate_warned",
                severity: shouldBlock ? "high" : "medium",
                message: `Workflow chain gate: task ${taskId} completion ${shouldBlock ? "blocked" : "warned"}`,
                details: {
                  gate: "workflow_chain",
                  taskId,
                  critical: chainCritical,
                  advisory: chainAdvisory,
                  gateMode,
                  overriddenByCritical: hasCritical && gateMode === "warn",
                },
              });

              if (shouldBlock) {
                return jsonResult({
                  error: "Görev tamamlanamıyor — workflow chain eksik",
                  warnings: chainWarnings,
                  ...(hasCritical && gateMode === "warn" ? {
                    note: "⛔ Doğrulama eksikliği kritik — gateMode: warn olsa bile engellendi. Test/build/lint çalıştır.",
                  } : {}),
                  hint: "Önce doğrulama komutu çalıştır ve ilişkili dosyaları güncelle, sonra tekrar dene.",
                });
              }
              // In warn mode with no critical issues: allow completion but include warnings
            }

            deps.store.updateTaskStatus(taskId, "completed", verification);

            deps.auditLog.record({
              sessionKey,
              eventType: "task_completed",
              severity: "info",
              message: `Task completed: ${taskId}`,
              details: { taskId, verification },
            });

            const tree = deps.store.getTaskTree(sessionKey);
            return jsonResult({
              success: true,
              completed: taskId,
              ...(chainWarnings.length > 0 ? { warnings: chainWarnings } : {}),
              taskTree: renderTaskTree(tree),
              summary: getTaskSummary(deps.store, sessionKey),
            });
          }

          case "delete": {
            const taskId = p.task_id as string;
            if (!taskId) {
              return jsonResult({ error: "task_id required for delete action" });
            }
            deps.store.deleteTask(taskId);

            const tree = deps.store.getTaskTree(sessionKey);
            return jsonResult({
              success: true,
              deleted: taskId,
              taskTree: renderTaskTree(tree),
              summary: getTaskSummary(deps.store, sessionKey),
            });
          }

          case "list": {
            const tree = deps.store.getTaskTree(sessionKey);
            if (tree.length === 0) {
              return jsonResult({
                message: "Henüz görev yok. 'create' action ile görev oluştur.",
                taskTree: "",
                summary: { total: 0, completed: 0, inProgress: 0, pending: 0, blocked: 0 },
              });
            }

            return jsonResult({
              taskTree: renderTaskTree(tree),
              summary: getTaskSummary(deps.store, sessionKey),
            });
          }

          case "checkpoint": {
            const label = (p.label as string) || `Checkpoint @ ${new Date().toISOString()}`;
            const cpId = deps.store.createCheckpoint(sessionKey, label);

            if (!cpId) {
              return jsonResult({ error: "Checkpoint oluşturulamadı — session bulunamadı" });
            }

            deps.auditLog.record({
              sessionKey,
              eventType: "task_created",
              severity: "info",
              message: `Checkpoint created: ${label}`,
              details: { checkpointId: cpId, label },
            });

            const allCps = deps.store.getCheckpoints(sessionKey);
            return jsonResult({
              success: true,
              checkpointId: cpId,
              label,
              message: `✅ Checkpoint kaydedildi: "${label}"`,
              totalCheckpoints: allCps.length,
              checkpoints: allCps.map(cp => `${cp.id}: ${cp.label} (${cp.createdAt})`),
            });
          }

          case "rollback": {
            const checkpointId = p.checkpoint_id as string;
            if (!checkpointId) {
              // No ID given — list available checkpoints
              const allCps = deps.store.getCheckpoints(sessionKey);
              if (allCps.length === 0) {
                return jsonResult({
                  error: "Hiç checkpoint yok. Önce checkpoint oluştur.",
                });
              }
              return jsonResult({
                error: "checkpoint_id gerekli. Mevcut checkpoint'ler:",
                checkpoints: allCps.map(cp => `${cp.id}: ${cp.label} (${cp.createdAt})`),
              });
            }

            const result = deps.store.rollbackToCheckpoint(sessionKey, checkpointId);

            if (!result.success) {
              return jsonResult({ error: result.error });
            }

            deps.auditLog.record({
              sessionKey,
              eventType: "gate_warned", // closest semantic match — state was forcibly changed
              severity: "medium",
              message: `Rollback to checkpoint: ${checkpointId}`,
              details: {
                gate: "checkpoint_rollback",
                checkpointId,
                restoredTasks: result.restoredTasks,
                removedTasks: result.removedTasks,
                planRestored: result.planRestored,
                filesChangedSince: result.filesChangedSinceCheckpoint,
              },
            });

            const tree = deps.store.getTaskTree(sessionKey);
            return jsonResult({
              success: true,
              message: `🔄 Checkpoint'e geri sarıldı`,
              restoredTasks: result.restoredTasks,
              removedTasks: result.removedTasks,
              planRestored: result.planRestored,
              filesChangedSinceCheckpoint: result.filesChangedSinceCheckpoint,
              warning: result.filesChangedSinceCheckpoint.length > 0
                ? `⚠️ Bu dosyalar checkpoint'ten sonra değiştirildi — dosya sistemi geri sarılmadı, manuel kontrol gerekli: ${result.filesChangedSinceCheckpoint.join(", ")}`
                : undefined,
              taskTree: renderTaskTree(tree),
              summary: getTaskSummary(deps.store, sessionKey),
            });
          }

          default:
            return jsonResult({ error: `Unknown action: ${action}` });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.auditLog.record({
          sessionKey,
          eventType: "tool_error",
          severity: "high",
          message: `task_tracker error: ${message}`,
          details: { action, params: p },
        });
        return jsonResult({ error: message });
      }
    },
  };
}

function getTaskSummary(store: SessionStateStore, sessionKey: string) {
  const tasks = store.getTasks(sessionKey);
  return {
    total: tasks.length,
    completed: tasks.filter(t => t.status === "completed").length,
    inProgress: tasks.filter(t => t.status === "in_progress").length,
    pending: tasks.filter(t => t.status === "pending").length,
    blocked: tasks.filter(t => t.status === "blocked").length,
  };
}
