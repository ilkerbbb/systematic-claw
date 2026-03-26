/**
 * plan_mode tool — structured plan-before-execute workflow.
 * Claude Code equivalent: EnterPlanMode / ExitPlanMode + writing-plans + executing-plans
 *
 * Phases: drafting → awaiting_approval → executing → verifying → completed
 * Auto-creates task_tracker entries from plan steps.
 */
import { Type } from "@sinclair/typebox";
import type { SessionStateStore, PlanStep, PlanPhase, SessionSnapshot } from "../store/session-state.js";
import type { AuditLog } from "../store/audit-log.js";
import { jsonResult, generateId, renderPlan, RELATED_FILE_RULES, checkPropagation, type AnyAgentTool } from "./common.js";
import type { GateMode } from "../hooks/hard-gates.js";

const PlanModeSchema = Type.Object({
  action: Type.Union([
    Type.Literal("create"),
    Type.Literal("approve"),
    Type.Literal("advance"),
    Type.Literal("complete_step"),
    Type.Literal("verify"),
    Type.Literal("complete"),
    Type.Literal("status"),
    Type.Literal("cancel"),
  ], {
    description: "Plan lifecycle action",
  }),
  goal: Type.Optional(Type.String({
    description: "Plan goal/objective (required for create)",
  })),
  steps: Type.Optional(Type.Array(Type.String(), {
    description: "Plan steps as strings (required for create)",
  })),
  step_index: Type.Optional(Type.Number({
    description: "Step index to advance to or mark complete",
  })),
  verification: Type.Optional(Type.String({
    description: "Verification evidence for completing the plan",
  })),
  alternatives: Type.Optional(Type.Array(Type.Object({
    approach: Type.String({ description: "Alternative approach that was considered" }),
    tradeoff: Type.String({ description: "Why this approach was NOT chosen — trade-off analysis" }),
  }), {
    description: "Alternative approaches considered BEFORE choosing this plan. ZORUNLU for 4+ step plans (min 2 alternatives). Include 'do nothing' option and at least 1 other rejected approach with trade-off. Will be REJECTED without alternatives for complex plans.",
  })),
  change_summary: Type.Optional(Type.String({
    description: "Summary of all changes made during plan execution (required for verify)",
  })),
});

export function createPlanModeTool(deps: {
  store: SessionStateStore;
  auditLog: AuditLog;
  sessionKey?: string;
  gateMode?: GateMode;
  dependencyMap?: Map<string, string[]>;
}): AnyAgentTool {
  return {
    name: "plan_mode",
    label: "Plan Mode",
    description:
      "Create and manage structured execution plans. " +
      "Use this before starting complex tasks (creating new features, multi-file changes). " +
      "Workflow: create → approve → execute steps → verify → complete. " +
      "Plan steps are automatically linked to task_tracker for progress tracking. " +
      "IMPORTANT: For 'creating' workflows, create a plan BEFORE writing code.",
    parameters: PlanModeSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const action = p.action as string;
      const sessionKey = deps.sessionKey ?? "unknown";

      try {
        deps.store.ensureSession(sessionKey);

        switch (action) {
          case "create": {
            const goal = p.goal as string;
            const stepStrings = p.steps as string[];

            if (!goal || !stepStrings || stepStrings.length === 0) {
              return jsonResult({ error: "goal and steps required for create action" });
            }

            // ── BRAINSTORM GATE: Alternatives required ──
            const alternatives = p.alternatives as Array<{ approach: string; tradeoff: string }> | undefined;

            // Complexity threshold: alternatives required only for plans with 4+ steps
            // Simple plans (1-3 steps) get alternatives as optional recommendation
            const isComplexPlan = stepStrings.length >= 4;

            if (isComplexPlan && (!alternatives || alternatives.length < 2)) {
              return jsonResult({
                error: `Bu plan ${stepStrings.length} adım içeriyor — en az 2 alternatif yaklaşım zorunlu.`,
                hint: "Her karmaşık plan için düşün: (1) 'Hiçbir şey yapmama' seçeneği neden uygun değil? (2) Seçmediğin en az 1 başka yaklaşım ne, neden seçmedin?",
                example: [
                  { approach: "Mevcut sistemi değiştirmemek (do nothing)", tradeoff: "Sorun devam eder, kullanıcı deneyimi kötü kalır" },
                  { approach: "Monolith yaklaşım", tradeoff: "Basit ama ileride ölçeklenmez, test edilmesi zor" },
                ],
                rule: "4+ adımlık planlarda alternatif düşünmek zorunlu. İlk aklına geleni değil, bilinçli bir seçim yap.",
              });
            }

            // Quality check on alternatives (skip if none provided for simple plans)
            const effectiveAlternatives = alternatives ?? [];
            const qualityIssues: string[] = [];
            for (let i = 0; i < effectiveAlternatives.length; i++) {
              const alt = effectiveAlternatives[i];
              if (!alt.approach || alt.approach.trim().length < 10) {
                qualityIssues.push(`Alternatif #${i + 1}: Yaklaşım çok kısa ("${alt.approach || ""}"). En az 10 karakter ile ne yapılacağını tanımla.`);
              }
              if (!alt.tradeoff || alt.tradeoff.trim().length < 15) {
                qualityIssues.push(`Alternatif #${i + 1}: Trade-off analizi çok kısa ("${alt.tradeoff || ""}"). Neden SEÇMEDİĞİNİ en az 15 karakterle açıkla.`);
              }
              // Reject copy-paste / lazy alternatives
              if (alt.approach && alt.tradeoff && alt.approach.trim().toLowerCase() === alt.tradeoff.trim().toLowerCase()) {
                qualityIssues.push(`Alternatif #${i + 1}: approach ve tradeoff aynı olamaz — gerçek bir analiz yap.`);
              }
            }

            // Check for duplicate alternatives
            const approachTexts = effectiveAlternatives.map(a => (a.approach || "").trim().toLowerCase());
            const uniqueApproaches = new Set(approachTexts);
            if (uniqueApproaches.size < effectiveAlternatives.length) {
              qualityIssues.push("Tekrarlanan alternatifler var — her biri farklı bir yaklaşım olmalı.");
            }

            if (qualityIssues.length > 0) {
              return jsonResult({
                error: "Alternatif kalite kontrolünden geçemedi",
                issues: qualityIssues,
                rule: "Her alternatif benzersiz olmalı, yaklaşım ≥10 karakter, trade-off ≥15 karakter.",
              });
            }

            // Check for existing active plan
            const existing = deps.store.getActivePlan(sessionKey);
            if (existing && existing.phase !== "completed" && existing.phase !== "cancelled") {
              return jsonResult({
                error: `Aktif bir plan zaten var: "${existing.goal}" (${existing.phase}). ` +
                  `Önce mevcut planı tamamla veya iptal et.`,
                currentPlan: renderPlan(existing),
              });
            }

            const planId = generateId("plan");
            const steps: PlanStep[] = stepStrings.map((content, index) => ({
              index,
              content,
              completed: false,
            }));

            deps.store.createPlan({ id: planId, sessionKey, goal, steps });

            // Store alternatives (may be empty for simple plans)
            deps.store.updatePlanAlternatives(planId, effectiveAlternatives);

            // Auto-create task_tracker entries for each step
            for (const step of steps) {
              deps.store.createTask({
                id: generateId("pt"),
                sessionKey,
                content: `[Plan] ${step.content}`,
                status: "pending",
              });
            }

            deps.auditLog.record({
              sessionKey,
              eventType: "plan_created",
              severity: "info",
              message: `Plan oluşturuldu: "${goal}" (${steps.length} adım)`,
              details: { planId, goal, stepCount: steps.length, alternativesCount: effectiveAlternatives.length },
            });

            const plan = deps.store.getActivePlan(sessionKey)!;
            return jsonResult({
              success: true,
              planId,
              message: `Plan oluşturuldu (${effectiveAlternatives.length} alternatif değerlendirildi). Şimdi kullanıcıdan onay al (approve action).`,
              plan: renderPlan(plan),
              alternativesConsidered: effectiveAlternatives,
              phase: "drafting",
              nextAction: "approve — kullanıcı onayından sonra",
            });
          }

          case "approve": {
            const plan = deps.store.getActivePlan(sessionKey);
            if (!plan) return jsonResult({ error: "Aktif plan yok" });

            if (plan.phase !== "drafting" && plan.phase !== "awaiting_approval") {
              return jsonResult({
                error: `Plan zaten ${plan.phase} aşamasında`,
                plan: renderPlan(plan),
              });
            }

            deps.store.updatePlanPhase(plan.id, "executing");
            deps.store.updatePlanStep(plan.id, 0);

            const updated = deps.store.getActivePlan(sessionKey)!;
            return jsonResult({
              success: true,
              message: `Plan onaylandı. Adım 1'den başla: "${updated.steps[0]?.content}"`,
              plan: renderPlan(updated),
              phase: "executing",
              currentStep: 0,
            });
          }

          case "advance":
          case "complete_step": {
            const plan = deps.store.getActivePlan(sessionKey);
            if (!plan) return jsonResult({ error: "Aktif plan yok" });

            if (plan.phase !== "executing") {
              return jsonResult({
                error: `Plan executing aşamasında değil (${plan.phase})`,
                plan: renderPlan(plan),
              });
            }

            // Mark current step as completed and persist to DB
            const steps = [...plan.steps];
            if (steps[plan.currentStep]) {
              steps[plan.currentStep] = { ...steps[plan.currentStep], completed: true };
            }
            deps.store.updatePlanSteps(plan.id, steps);

            // Advance to next step or move to verifying
            const nextStep = plan.currentStep + 1;
            if (nextStep >= steps.length) {
              deps.store.updatePlanPhase(plan.id, "verifying");
              const updated = deps.store.getActivePlan(sessionKey)!;
              return jsonResult({
                success: true,
                message: "Tüm adımlar tamamlandı. Şimdi doğrulama yap (verify action).",
                plan: renderPlan(updated),
                phase: "verifying",
                nextAction: "verify — tüm çalışmayı doğrula",
              });
            }

            deps.store.updatePlanStep(plan.id, nextStep);
            const updated = deps.store.getActivePlan(sessionKey)!;
            return jsonResult({
              success: true,
              message: `Adım ${plan.currentStep + 1} tamamlandı. Sıradaki: "${steps[nextStep]?.content}"`,
              plan: renderPlan(updated),
              phase: "executing",
              currentStep: nextStep,
            });
          }

          case "verify": {
            const plan = deps.store.getActivePlan(sessionKey);
            if (!plan) return jsonResult({ error: "Aktif plan yok" });

            // Phase guard: only allow verify from "verifying" or "executing" (if all steps done)
            if (plan.phase !== "verifying") {
              if (plan.phase === "executing") {
                const allDone = plan.steps.every(s => s.completed);
                if (!allDone) {
                  return jsonResult({
                    error: `Plan henüz tamamlanmadı. ${plan.steps.filter(s => !s.completed).length} adım kaldı. Önce tüm adımları tamamla (complete_step).`,
                    plan: renderPlan(plan),
                  });
                }
                // All steps done but phase not auto-advanced — allow verify
              } else {
                return jsonResult({
                  error: `Plan "${plan.phase}" aşamasında — verify sadece "verifying" veya tüm adımlar tamamlanmış "executing" aşamasında kullanılabilir.`,
                  plan: renderPlan(plan),
                });
              }
            }

            const verification = p.verification as string;
            const changeSummary = p.change_summary as string | undefined;

            // ── REVIEW GATE: Change summary required ──
            if (!changeSummary || changeSummary.trim().length < 30) {
              // Build auto-checklist from session state
              const snapshot = deps.store.getSnapshot(sessionKey);
              const reviewChecklist = buildReviewChecklist(snapshot);

              return jsonResult({
                error: "change_summary zorunlu (min 30 karakter) — yaptığın tüm değişikliklerin özetini ver.",
                hint: "Özet formatı: hangi dosyalar değişti, ne eklendi/silindi, hangi alanlar etkilenebilir, regresyon riski var mı.",
                reviewChecklist,
                modifiedFiles: snapshot?.modifiedFiles ?? [],
              });
            }

            if (!verification) {
              return jsonResult({
                error: "verification field zorunlu — çalışmanın doğru olduğuna dair kanıt sağla",
                hint: "Örnek: 'npm test çalıştırıldı, 15/15 test geçti. index.ts ve STATE.md güncellendi.'",
              });
            }

            // ── Gate 5: Evidence quality check ──
            const evidenceIssue = checkEvidenceQuality(verification);
            if (evidenceIssue) {
              deps.auditLog.record({
                sessionKey,
                eventType: "gate_blocked",
                severity: "high",
                message: `Zayıf kanıt reddedildi: ${evidenceIssue}`,
                details: { gate: "evidence_required", verification },
              });
              return jsonResult({
                error: evidenceIssue,
                hint: "Somut kanıt sağla: hangi komutu çalıştırdın, sonuç ne oldu, hangi dosyalar güncellendi.",
              });
            }

            // ── REVIEW CROSS-CHECK: Validate change_summary against actual state ──
            const snapshot = deps.store.getSnapshot(sessionKey);
            const crossCheckWarnings: string[] = [];

            if (snapshot && snapshot.modifiedFiles.length > 0) {
              // Check: are all modified files mentioned in the change summary?
              const summaryLower = changeSummary.toLowerCase();
              const unmentionedFiles: string[] = [];
              for (const modFile of snapshot.modifiedFiles) {
                // Extract just filename for matching (not full path)
                const filename = modFile.split("/").pop() || modFile;
                if (!summaryLower.includes(filename.toLowerCase())) {
                  unmentionedFiles.push(filename);
                }
              }
              if (unmentionedFiles.length > 0) {
                crossCheckWarnings.push(
                  `⚠️ ${unmentionedFiles.length} değiştirilen dosya change_summary'de belirtilmemiş: ${unmentionedFiles.join(", ")}`
                );
              }

              // Check: related files impact analysis
              const checkedRequired = new Set<string>();
              const missingRelated: string[] = [];
              for (const modFile of snapshot.modifiedFiles) {
                for (const rule of RELATED_FILE_RULES) {
                  if (rule.pattern.test(modFile)) {
                    for (const req of rule.requires) {
                      if (checkedRequired.has(req)) continue;
                      checkedRequired.add(req);
                      const wasUpdated = snapshot.modifiedFiles.some(f =>
                        f.endsWith(req) || f.includes(req)
                      );
                      if (!wasUpdated) missingRelated.push(`${req} (${rule.description})`);
                    }
                  }
                }
              }
              if (missingRelated.length > 0) {
                crossCheckWarnings.push(
                  `⚠️ İlişkili dosyalar güncellenmemiş: ${missingRelated.join(", ")}`
                );
              }

              // Check: read-modify ratio (hallucination indicator)
              const readSet = new Set(snapshot.readFiles);
              const blindModifications = snapshot.modifiedFiles.filter(f => !readSet.has(f));
              if (blindModifications.length > 0) {
                crossCheckWarnings.push(
                  `⚠️ ${blindModifications.length} dosya okunmadan değiştirilmiş — hallucination riski: ${blindModifications.map(f => f.split("/").pop()).join(", ")}`
                );
              }

              // Propagation check: modified files → test files / dependency map
              if (deps.dependencyMap) {
                for (const modFile of snapshot.modifiedFiles) {
                  const missingDeps = checkPropagation(modFile, snapshot.modifiedFiles, deps.dependencyMap);
                  // Filter to only existing-like paths (not speculative test file paths)
                  const significantMissing = missingDeps.filter(d =>
                    deps.dependencyMap!.has(modFile.toLowerCase()) // Only flag user-defined deps
                  );
                  if (significantMissing.length > 0) {
                    crossCheckWarnings.push(
                      `🔗 PROPAGATION: ${modFile.split("/").pop()} değişti ama bağımlıları güncellenmedi: ${significantMissing.map(d => d.split("/").pop()).join(", ")}`
                    );
                  }
                }
              }
            }

            // If there are critical cross-check warnings, block completion
            const criticalWarnings = crossCheckWarnings.filter(w => w.includes("PROPAGATION") || w.includes("okunmadan"));
            if (criticalWarnings.length > 0 && deps.gateMode === "block") {
              return jsonResult({
                error: `Plan tamamlanamıyor — kritik sorunlar var`,
                warnings: criticalWarnings,
                allWarnings: crossCheckWarnings,
                hint: "Yukarıdaki sorunları çöz, sonra tekrar verify çağır.",
              });
            }
            // Store the change summary for audit trail
            deps.store.updatePlanChangeSummary(plan.id, changeSummary);
            deps.store.updatePlanPhase(plan.id, "completed");

            deps.auditLog.record({
              sessionKey,
              eventType: "plan_completed",
              severity: "info",
              message: `Plan tamamlandı: "${plan.goal}"`,
              details: { planId: plan.id, verification, changeSummary, crossCheckWarnings },
            });

            const reviewChecklist = buildReviewChecklist(snapshot);

            return jsonResult({
              success: true,
              message: `Plan tamamlandı ve doğrulandı: "${plan.goal}"`,
              verification,
              changeSummary,
              phase: "completed",
              reviewChecklist,
              ...(crossCheckWarnings.length > 0 ? {
                warnings: crossCheckWarnings,
                warningMessage: `⚠️ ${crossCheckWarnings.length} potansiyel sorun tespit edildi — lütfen kontrol et:`,
              } : {}),
            });
          }

          case "status": {
            const plan = deps.store.getActivePlan(sessionKey);
            if (!plan) {
              return jsonResult({ message: "Aktif plan yok. 'create' ile yeni plan oluştur." });
            }
            return jsonResult({
              plan: renderPlan(plan),
              phase: plan.phase,
              currentStep: plan.currentStep,
              totalSteps: plan.steps.length,
              completedSteps: plan.steps.filter(s => s.completed).length,
            });
          }

          case "cancel": {
            const plan = deps.store.getActivePlan(sessionKey);
            if (!plan) return jsonResult({ error: "Aktif plan yok" });

            deps.store.updatePlanPhase(plan.id, "cancelled");

            // Clean up auto-created [Plan] tasks — mark as blocked (not completed) to preserve accurate metrics
            const tasks = deps.store.getTasks(sessionKey);
            let cancelledTasks = 0;
            for (const task of tasks) {
              if (task.content.startsWith("[Plan] ") && task.status !== "completed") {
                deps.store.updateTaskStatus(task.id, "blocked", "Plan iptal edildi");
                cancelledTasks++;
              }
            }

            deps.auditLog.record({
              sessionKey,
              eventType: "plan_incomplete",
              severity: "medium",
              message: `Plan iptal edildi: "${plan.goal}"`,
              details: { planId: plan.id, phase: plan.phase, currentStep: plan.currentStep, cancelledTasks },
            });

            return jsonResult({
              success: true,
              message: `Plan iptal edildi: "${plan.goal}" (${cancelledTasks} ilişkili görev 'blocked' olarak işaretlendi)`,
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
          message: `plan_mode error: ${message}`,
          details: { action, params: p },
        });
        return jsonResult({ error: message });
      }
    },
  };
}

// ── Evidence Quality Validation ──────────────────────

const VAGUE_LANGUAGE_PATTERNS = [
  /\b(should|probably|think|guess|assume|belki|sanırım|muhtemelen|galiba|heralde|olabilir)\b/i,
];

const EMPTY_COMPLETION_PATTERNS = [
  /^(ok|tamam|done|bitti|evet|yes|✅|👍|completed|tamamlandı)$/i,
];

function checkEvidenceQuality(verification: string): string | null {
  const trimmed = verification.trim();

  // Check for empty/minimal completions
  if (EMPTY_COMPLETION_PATTERNS.some(p => p.test(trimmed))) {
    return `"${trimmed}" kanıt değil. Ne yaptığını, nasıl doğruladığını somut olarak açıkla.`;
  }

  // Check minimum length
  if (trimmed.length < 30) {
    return `Kanıt çok kısa (${trimmed.length} karakter). En az 30 karakter ile somut kanıt sağla: komut çıktısı, dosya adları, test sonuçları.`;
  }

  // Check for vague language
  for (const pattern of VAGUE_LANGUAGE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return `Belirsiz ifade tespit edildi: "${match[0]}". Kesin kanıt sağla — "should work" değil, "npm test: 15/15 passed" gibi.`;
    }
  }

  return null; // Evidence passes quality check
}

// ── Review Checklist Builder ──────────────────────────

type ReviewChecklistItem = {
  check: string;
  status: "pass" | "fail" | "unknown";
  detail?: string;
};

function buildReviewChecklist(snapshot: SessionSnapshot | null): ReviewChecklistItem[] {
  const items: ReviewChecklistItem[] = [];

  if (!snapshot) {
    items.push({ check: "Session verisi", status: "unknown", detail: "Session snapshot bulunamadı" });
    return items;
  }

  // 1. Files modified — list them
  if (snapshot.modifiedFiles.length > 0) {
    items.push({
      check: `${snapshot.modifiedFiles.length} dosya değiştirildi`,
      status: "pass",
      detail: snapshot.modifiedFiles.join(", "),
    });
  } else {
    items.push({ check: "Dosya değişikliği", status: "unknown", detail: "Hiç dosya değiştirilmemiş" });
  }

  // 2. Related files check
  if (snapshot.modifiedFiles.length > 0) {
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
              missingUpdates.push(required);
            }
          }
        }
      }
    }

    if (missingUpdates.length > 0) {
      items.push({
        check: "İlişkili dosya güncellemeleri",
        status: "fail",
        detail: `Güncellenmemiş: ${missingUpdates.join(", ")}`,
      });
    } else if (checkedRequired.size > 0) {
      items.push({ check: "İlişkili dosya güncellemeleri", status: "pass" });
    }
  }

  // 3. Memory written
  items.push({
    check: "Memory/öğrenme dosyası",
    status: snapshot.memoryWritten ? "pass" : "fail",
    detail: snapshot.memoryWritten ? "Yazıldı" : "Yazılmadı — MEMORY.md veya öğrenme dosyasına yaz",
  });

  // 4. Incomplete tasks
  const allTasks = flattenAllTasks(snapshot.tasks);
  // "blocked" tasks from cancelled plans are not actionable
  const incomplete = allTasks.filter(t => t.status !== "completed" && t.status !== "blocked");
  if (allTasks.length > 0) {
    items.push({
      check: `Görev tamamlanma: ${allTasks.length - incomplete.length}/${allTasks.length}`,
      status: incomplete.length === 0 ? "pass" : "fail",
      detail: incomplete.length > 0 ? `Tamamlanmamış: ${incomplete.map(t => t.content).join(", ")}` : undefined,
    });
  }

  // 5. Read vs modified ratio (hallucination risk indicator)
  if (snapshot.modifiedFiles.length > 0) {
    const readSet = new Set(snapshot.readFiles);
    const modifiedButNotRead = snapshot.modifiedFiles.filter(f => !readSet.has(f));
    if (modifiedButNotRead.length > 0) {
      items.push({
        check: "Okumadan değiştirilen dosyalar",
        status: "fail",
        detail: `⚠️ ${modifiedButNotRead.length} dosya okunmadan değiştirilmiş: ${modifiedButNotRead.join(", ")}`,
      });
    } else {
      items.push({ check: "Tüm değiştirilen dosyalar okunmuş", status: "pass" });
    }
  }

  return items;
}

function flattenAllTasks(tasks: Array<{ status: string; content: string; children?: unknown[] }>): Array<{ status: string; content: string }> {
  const result: Array<{ status: string; content: string }> = [];
  for (const task of tasks) {
    result.push({ status: task.status, content: task.content });
    if (task.children && Array.isArray(task.children)) {
      result.push(...flattenAllTasks(task.children as typeof tasks));
    }
  }
  return result;
}
