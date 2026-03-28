/**
 * Layer 1: GUIDE — before_prompt_build hook.
 *
 * Responsibilities:
 * 1. Detect workflow type from prompt (debugging, creating, analyzing, fixing)
 * 2. Inject active plan and task state into agent context
 * 3. Provide SHORT, actionable tool guidance (not long protocols agents ignore)
 * 4. PERIODIC WARNINGS: missing updates, stale tasks, no memory written
 *    (Gate 4: Update-Before-End — delivered via prompt injection)
 */
import type { SessionStateStore } from "../store/session-state.js";
import type { AuditLog } from "../store/audit-log.js";
import { renderTaskTree, renderPlan, RELATED_FILE_RULES, isExcludedFromRelatedFileRules } from "../tools/common.js";

// Cache cross-session summary per session (never changes during a session, avoid 6 SQL queries per prompt)
const lastSessionSummaryCache = new Map<string, string | null>();

// Process boot timestamp — used to distinguish "new session" vs "gateway restart mid-session"
const PROCESS_BOOT_TIME = new Date().toISOString().replace("T", " ").replace("Z", "").slice(0, 19);

// Track which sessions have been initialized this process lifetime.
// On first buildPromptContext call for a session, we reset tracking
// ONLY IF the session data is stale (updated_at < process boot time).
// If session data is fresh (gateway restarted mid-session), preserve it.
const initializedSessions = new Set<string>();

// ─── Workflow Detection ──────────────────────────────────────

export type WorkflowType = "debugging" | "creating" | "analyzing" | "fixing" | "general";

const WORKFLOW_SIGNALS: Partial<Record<WorkflowType, RegExp[]>> = {
  debugging: [
    /hata|error|bug|crash|fail|broken|çalışmıyor|bozuk|sorun|problem|issue|exception|trace/i,
    /debug|diagnose|investigate|neden|why|root.?cause|kök.?neden/i,
  ],
  creating: [
    /oluştur|create|build|yaz|write|implement|geliştir|develop|ekle|add|kur|setup|scaffold/i,
    /yeni|new|feature|özellik|modül|module|component|plugin/i,
  ],
  analyzing: [
    /analiz|analyze|incele|examine|audit|review|değerlendir|evaluate|karşılaştır|compare/i,
    /rapor|report|summary|özet|istatistik|stats|metrik|metric/i,
  ],
  fixing: [
    /düzelt|fix|repair|patch|güncelle|update|değiştir|modify|refactor|iyileştir|improve/i,
    /migration|upgrade|optimize|temizle|clean/i,
  ],
};

export function detectWorkflow(prompt: string): WorkflowType {
  const scores: Record<WorkflowType, number> = {
    debugging: 0,
    creating: 0,
    analyzing: 0,
    fixing: 0,
    general: 0,
  };

  for (const [workflow, patterns] of Object.entries(WORKFLOW_SIGNALS)) {
    if (!patterns) continue;
    for (const pattern of patterns) {
      if (pattern.test(prompt)) {
        scores[workflow as WorkflowType] += 1;
      }
    }
  }

  let best: WorkflowType = "general";
  let bestScore = 0;
  for (const [workflow, score] of Object.entries(scores)) {
    if (score > bestScore) {
      best = workflow as WorkflowType;
      bestScore = score;
    }
  }

  return best;
}

// ─── Workflow Guidance (SHORT — agents ignore long protocols) ─

const WORKFLOW_GUIDANCE: Record<WorkflowType, string> = {
  debugging: `🔍 **DEBUGGING MODU**
1. debug_tracker KULLAN — start → reproduce → hypothesize → test → resolve
2. FIX ÖNCE KÖK NEDENİ BUL — hata mesajını oku, reproduce et
3. TEK hipotez, TEK minimal test. Hipotez olmadan fix DENEME
4. 3 başarısız deneme = debug_tracker escalate → kullanıcıya danış
💡 Bu hata tipi için workspace'inde bir debugging skill'i olabilir — kontrol et`,

  creating: `🏗️ **OLUŞTURMA MODU**
1. ÖNCE plan_mode ile plan oluştur — plan olmadan kod yazma
   → 4+ adım: 4-Lens Brainstorm zorunlu (constraints, impact, reversibility, success_criteria)
   → Alternatifler: en az 2 farklı yaklaşım + trade-off analizi
2. Kullanıcı onayı al, sonra adım adım uygula
3. Her adımda task_tracker güncelle
4. Bitirirken: test çalıştır, ilişkili dosyaları güncelle
💡 Verify-First: her 3-4 dosya yazımından sonra test/build çalıştır — hataları erken yakala
💡 Bu oluşturma görevi için hazır bir skill/şablon olabilir — workspace skill'lerini kontrol et`,

  analyzing: `📊 **ANALİZ MODU**
1. Veri topla — ilgili dosyaları oku, mevcut durumu anla
2. Bulguları sentezle, pattern'leri tespit et
3. Varsayımlarını sorgula
4. Yapılandırılmış çıktı oluştur
💡 Analiz tipi için özelleşmiş bir skill olabilir — kontrol et`,

  fixing: `🔧 **DÜZELTME MODU**
1. ÖNCE dosyayı oku — okumadan düzenleme yapma
2. Neyi neden değiştirdiğini planla (karmaşıksa plan_mode + 4-Lens Brainstorm kullan)
3. Değişikliği uygula
4. İlişkili dosyaları güncelle (STATE.md, MEMORY.md)
💡 Bu düzeltme tipi için bir skill/checklist olabilir — kontrol et`,

  general: "",  // No guidance for general — keep it clean
};

// ─── Static System Context (cached by provider) ──────────────

const STATIC_SYSTEMATIC_CONTEXT = `## Systematic Engine
Araçlar: **task_tracker** (görev takibi), **plan_mode** (plan→onayla→uygula→doğrula), **quality_checklist** (self-review)

ZORUNLU KURALLAR:
- 3+ adımlık işlerde task_tracker KULLAN
- Yeni şey oluştururken plan_mode KULLAN
- Dosya düzenlemeden ÖNCE dosyayı OKU
- İş bittiğinde test/build ÇALIŞTIR, sonra tamamla
- Dosya değişikliği yaptıysan STATE.md/MEMORY.md GÜNCELLE
- "Tamamlandı" demeden ÖNCE doğrulama komutu çalıştır
- İŞ BİTMEDEN ÖNCE quality_checklist(action: "review") ÇAĞIR — doğrulama, edge case, regresyon, gap analizi yanıtla

SKILL FARKINDALIK:
- Bir iş tipine başlarken workspace'teki mevcut skill'leri kontrol et
- Tekrarlayan iş akışları tespit edersen → kullanıcıya skill oluşturulmasını öner
- Skill önerisinde somut ol: hangi adımlar otomatikleşir, hangi tutarlılık sağlanır
`;

// ─── Build Context Function ──────────────────────────────────

export type GateVerbosity = "silent" | "summary" | "verbose";

export function buildPromptContext(params: {
  prompt: string;
  sessionStore: SessionStateStore;
  auditLog?: AuditLog;
  sessionKey?: string;
  workflowDetectionEnabled: boolean;
  gateVerbosity?: GateVerbosity;
}): { prependSystemContext: string; prependContext?: string } {
  const parts: string[] = [];
  const sessionKey = params.sessionKey ?? "default";

  // ── First-call session reset ──────────────────────────────────
  // session_start event doesn't fire reliably in OpenClaw, so we
  // use the first before_prompt_build call as the session init point.
  //
  // SMART RESET: Only reset if session data is STALE (from a previous session).
  // If session data is FRESH (updated after process boot), this is a gateway
  // restart mid-session — preserve the data to avoid losing tracking state.
  if (!initializedSessions.has(sessionKey)) {
    initializedSessions.add(sessionKey);
    try {
      const sessionUpdatedAt = params.sessionStore.getSessionUpdatedAt(sessionKey);
      const isStaleSession = !sessionUpdatedAt || sessionUpdatedAt < PROCESS_BOOT_TIME;

      if (isStaleSession) {
        params.sessionStore.resetSessionTracking(sessionKey);
        // Also clear the cross-session summary cache so it re-fetches
        lastSessionSummaryCache.delete(sessionKey);
      }
      // If session is fresh (updated after process boot), skip reset —
      // this is a gateway restart mid-session, preserve tracking data.
    } catch (err) {
      console.warn("[systematic-claw] session reset error:", err instanceof Error ? err.message : err);
    }
  }

  // 0. Cross-session context: inject last session's audit summary (cached per session)
  if (params.auditLog) {
    try {
      if (!lastSessionSummaryCache.has(sessionKey)) {
        lastSessionSummaryCache.set(sessionKey, params.auditLog.getLastSessionSummary());
      }
      const lastSessionSummary = lastSessionSummaryCache.get(sessionKey);
      if (lastSessionSummary) {
        parts.push(`⚠️ ${lastSessionSummary}`);
      }
    } catch (err) {
      console.warn("[systematic-claw] cross-session summary error:", err instanceof Error ? err.message : err);
    }
  }

  // 1. Workflow detection and guidance (State Machine)
  //    Re-detect on every user prompt. Track transitions. Warn on incomplete workflow switches.
  if (params.workflowDetectionEnabled) {
    const newWorkflow = detectWorkflow(params.prompt);
    const guidance = WORKFLOW_GUIDANCE[newWorkflow];
    if (guidance) {
      parts.push(guidance);
    }

    if (params.sessionKey) {
      try {
        const snapshot = params.sessionStore.getSnapshot(params.sessionKey);
        const previousWorkflow = snapshot?.workflowType as WorkflowType | undefined;

        // Detect meaningful workflow transition (ignore general → X and X → general)
        const isTransition = previousWorkflow
          && previousWorkflow !== newWorkflow
          && previousWorkflow !== "general"
          && newWorkflow !== "general";

        if (isTransition && snapshot) {
          // Check if previous workflow had incomplete work
          const tasks = snapshot.tasks ?? [];
          const hasIncompleteTasks = tasks.some(
            t => t.status === "in_progress" || (t.status === "pending" && tasks.length > 1)
          );
          const activePlan = snapshot.activePlan;
          const hasIncompletePlan = activePlan
            && activePlan.phase !== "completed"
            && activePlan.phase !== "cancelled";

          if (hasIncompleteTasks || hasIncompletePlan) {
            parts.push(
              `⚠️ **WORKFLOW DEĞİŞİKLİĞİ** — "${previousWorkflow}" → "${newWorkflow}" geçişi tespit edildi.\n` +
              `Önceki iş tamamlanmamış görünüyor:` +
              (hasIncompletePlan && activePlan ? ` Plan "${activePlan.goal}" henüz ${activePlan.phase} aşamasında.` : "") +
              (hasIncompleteTasks ? ` Tamamlanmamış görevler var.` : "") +
              `\nÖnceki işi tamamla veya iptal et, sonra yeni işe geç.`
            );
          }

          // Audit log the transition
          if (params.auditLog) {
            params.auditLog.record({
              sessionKey,
              eventType: "gate_warned",
              severity: hasIncompleteTasks || hasIncompletePlan ? "medium" : "info",
              message: `Workflow transition: ${previousWorkflow} → ${newWorkflow}`,
              details: {
                gate: "workflow_transition",
                from: previousWorkflow,
                to: newWorkflow,
                hasIncompleteTasks,
                hasIncompletePlan: !!hasIncompletePlan,
              },
            });
          }
        }

        // Always update workflow type (re-detect per prompt)
        params.sessionStore.setWorkflowType(params.sessionKey, newWorkflow);
      } catch (err) {
        console.warn("[systematic-claw] prompt-inject error:", err instanceof Error ? err.message : err);
      }
    }
  }

  // 2. Active plan state
  if (params.sessionKey) {
    try {
      const plan = params.sessionStore.getActivePlan(params.sessionKey);
      if (plan && plan.phase !== "completed" && plan.phase !== "cancelled") {
        parts.push(renderPlan(plan));
      }
    } catch (err) {
      console.warn("[systematic-claw] active plan injection error:", err instanceof Error ? err.message : err);
    }
  }

  // 3. Active task tree
  if (params.sessionKey) {
    try {
      const tasks = params.sessionStore.getTaskTree(params.sessionKey);
      if (tasks.length > 0) {
        const total = countAllTasks(tasks);
        const completed = countCompletedTasks(tasks);
        parts.push(`## Görev Durumu (${completed}/${total} tamamlandı)`);
        parts.push(renderTaskTree(tasks));

        if (completed < total) {
          parts.push(`⚠️ ${total - completed} görev henüz tamamlanmadı.`);
        }
      }
    } catch (err) {
      console.warn("[systematic-claw] task tree injection error:", err instanceof Error ? err.message : err);
    }
  }

    // 3b. Gate Activity Status (verbosity-dependent)
    if (params.sessionKey && params.gateVerbosity && params.gateVerbosity !== "silent") {
      try {
        const activity = params.sessionStore.getGateActivity(params.sessionKey);
        if (activity.totalChecks > 0) {
          if (params.gateVerbosity === "verbose") {
            // Verbose: show per-gate breakdown
            const gateLines: string[] = [];
            for (const [gateName, entry] of Object.entries(activity.gates)) {
              const status = entry.blocks > 0 ? "🔴" : entry.warns > 0 ? "🟡" : "✅";
              gateLines.push(`  ${status} ${gateName}: ${entry.checks} check, ${entry.blocks} block, ${entry.warns} warn`);
            }
            parts.push(`## 🛡️ Gate Status\n${gateLines.join("\n")}\nToplam: ${activity.totalChecks} kontrol, ${activity.totalBlocks} engel, ${activity.totalWarns} uyarı`);
          } else {
            // Summary: single line
            const emoji = activity.totalBlocks > 0 ? "🔴" : activity.totalWarns > 0 ? "🟡" : "✅";
            parts.push(`${emoji} Gates: ${activity.totalChecks} kontrol, ${activity.totalBlocks} engel, ${activity.totalWarns} uyarı`);
          }
        }
      } catch (err) {
        console.warn("[systematic-claw] gate activity injection error:", err instanceof Error ? err.message : err);
      }
    }

    // 4. GATE 4: Periodic warnings — missing updates, no memory, stale state
  if (params.sessionKey) {
    try {
      const warnings = buildPeriodicWarnings(params.sessionStore, params.sessionKey);
      if (warnings.length > 0) {
        parts.push("## ⚠️ EKSİK ADIMLAR");
        parts.push(warnings.join("\n"));
      }
    } catch (err) {
      console.warn("[systematic-claw] periodic warnings error:", err instanceof Error ? err.message : err);
    }
  }

  return {
    prependSystemContext: STATIC_SYSTEMATIC_CONTEXT,
    ...(parts.length > 0 ? { prependContext: parts.join("\n\n") } : {}),
  };
}

// ─── Gate 4: Periodic Warning Builder ────────────────────────

function buildPeriodicWarnings(store: SessionStateStore, sessionKey: string): string[] {
  const warnings: string[] = [];
  const snapshot = store.getSnapshot(sessionKey);
  if (!snapshot) return warnings;

  // Warning 1: Files modified but related files not updated
  // Filter out temp/scratch paths — they don't need STATE.md updates
  const relevantModifiedFiles = snapshot.modifiedFiles.filter(f => !isExcludedFromRelatedFileRules(f));
  if (relevantModifiedFiles.length > 0) {
    const checkedRequired = new Set<string>();
    for (const modifiedFile of relevantModifiedFiles) {
      for (const rule of RELATED_FILE_RULES) {
        if (rule.pattern.test(modifiedFile)) {
          for (const required of rule.requires) {
            if (checkedRequired.has(required)) continue;
            checkedRequired.add(required);
            const wasUpdated = snapshot.modifiedFiles.some(f =>
              f.endsWith(required) || f.includes(required)
            );
            if (!wasUpdated) {
              warnings.push(`- ❌ **${required} güncellenmedi** — kaynak kodu değişti ama ${required} güncellenmedi`);
            }
          }
        }
      }
    }
  }

  // Warning 2: Files modified but no memory written
  if (snapshot.modifiedFiles.length > 0 && !snapshot.memoryWritten) {
    warnings.push("- ❌ **Memory yazılmadı** — dosya değişikliği yapıldı ama MEMORY.md/öğrenme dosyasına yazılmadı");
  }

  // Warning 3: Tasks exist but none in progress
  if (snapshot.tasks.length > 0) {
    const flat = flattenTasks(snapshot.tasks);
    const incomplete = flat.filter(t => t.status !== "completed");
    const inProgress = flat.filter(t => t.status === "in_progress");

    if (incomplete.length > 0 && inProgress.length === 0) {
      warnings.push(`- ⚠️ **Aktif görev yok** — ${incomplete.length} tamamlanmamış görev var ama hiçbiri in_progress değil`);
    }
  }

  // Warning 4: Active plan but no progress
  if (snapshot.activePlan && snapshot.activePlan.phase === "executing") {
    const completedSteps = snapshot.activePlan.steps.filter(s => s.completed).length;
    if (completedSteps === 0) {
      warnings.push(`- ⚠️ **Plan ilerlemedi** — "${snapshot.activePlan.goal}" planı executing aşamasında ama hiç adım tamamlanmadı`);
    }
  }

  // Warning 5: Verify-First (TDD Lite) — escalating nudge based on writes since verification
  if (snapshot.modifiedFiles.length > 0 && !store.hasRecentVerification(sessionKey)) {
    const writesSinceVerify = store.getWritesSinceVerification(sessionKey);

    if (writesSinceVerify >= 8) {
      // Critical: too many writes without ANY verification
      warnings.push(
        `- 🛑 **DOĞRULAMA ACİL** — ${writesSinceVerify} dosya yazımı yapıldı, hiç test/build çalıştırılmadı. ` +
        `Hataları erken yakala: şu an test çalıştır. Ne kadar çok değişiklik birikirse, debug o kadar zorlaşır.`
      );
    } else if (writesSinceVerify >= 4) {
      // Moderate: suggest intermediate verification
      warnings.push(
        `- ⚠️ **Ara doğrulama önerilir** — ${writesSinceVerify} dosya yazımı yapıldı, henüz doğrulanmadı. ` +
        `Verify-First: değişiklikleri küçük gruplar halinde doğrula, hataları erken yakala.`
      );
    } else if (writesSinceVerify >= 1) {
      // Gentle: basic reminder
      warnings.push("- ❌ **Doğrulama çalıştırılmadı** — dosya değişikliği yapıldı ama test/build/lint komutu çalıştırılmadı");
    }
  }

  // Warning 6: Smart tool recommendation based on session patterns
  const toolCallHistory = store.getRecentToolCalls(sessionKey);
  if (toolCallHistory) {
    const recentErrors = toolCallHistory.filter(c => c.hadError).length;
    const totalCalls = toolCallHistory.length;

    // High error rate → suggest debug_tracker
    if (totalCalls >= 5 && recentErrors >= 3) {
      warnings.push(
        "- 🔧 **Yüksek hata oranı** — son " + totalCalls + " call'da " + recentErrors +
        " hata var. `debug_tracker(action: \"start\")` ile sistematik debug başlat."
      );
    }

    // Many file edits without verification → nudge
    const fileEdits = toolCallHistory.filter(c => c.fileTarget !== null).length;
    if (fileEdits >= 8 && !store.hasRecentVerification(sessionKey)) {
      warnings.push(
        "- 🔧 **Çok fazla düzenleme, doğrulama yok** — " + fileEdits +
        " dosya düzenlendi ama henüz test/build çalıştırılmadı. Ara doğrulama önerilir."
      );
    }
  }

  // Warning 7: Long session indicator (proxy for context budget)
  // We can't access token count directly, but tool call volume is a proxy
  if (toolCallHistory && toolCallHistory.length >= 40) {
    warnings.push(
      "- ⚠️ **Uzun session** — " + toolCallHistory.length +
      " tool call yapıldı. Context doluluk riski. Mevcut çalışmayı kaydet ve gerekirse yeni session başlat."
    );
  }

  // Warning 8: Skill usage nudge — remind if no skill accessed in a non-trivial session
  if (toolCallHistory && toolCallHistory.length >= 12 && !store.hasSkillAccess(sessionKey)) {
    const workflow = snapshot.workflowType ?? "general";
    if (workflow !== "general") {
      warnings.push(
        `- 💡 **Skill kontrolü** — ${toolCallHistory.length} tool call yapıldı ama bu session'da hiç skill dosyası kullanılmadı. ` +
        `Bu "${workflow}" tipi iş için workspace'inde uygun bir skill olabilir. ` +
        `Mevcut skill'leri kontrol et veya bu iş akışı için bir skill oluşturulmasını öner.`
      );
    }
  }

  // Warning 9: Repetitive pattern detection — suggest skill creation
  if (toolCallHistory && toolCallHistory.length >= 15) {
    const patterns = store.detectRepetitivePatterns(sessionKey);
    if (patterns.length > 0) {
      const topPattern = patterns[0];
      warnings.push(
        `- 🔄 **Tekrarlayan pattern tespit edildi** — "${topPattern.pattern}" dizisi ${topPattern.count}x tekrarlandı. ` +
        `Bu iş akışı için bir skill oluşturulabilir — tekrarlayan adımları otomatikleştirir ve tutarlılık sağlar.`
      );
    }
  }

  // Warning 10: Impact Analysis — cross-reference check for modified files
  if (store.isImpactAnalysisPending(sessionKey)) {
    const fileNames = snapshot.modifiedFiles
      .slice(0, 5)
      .map(f => f.split("/").pop() ?? f)
      .join(", ");
    const moreText = snapshot.modifiedFiles.length > 5 ? ` (+${snapshot.modifiedFiles.length - 5} daha)` : "";
    warnings.push(
      `- ⚠️ **ETKİ ANALİZİ EKSİK** — ${snapshot.modifiedFiles.length} dosya değiştirildi (${fileNames}${moreText}). ` +
      `Bu dosyalara referans veren başka dosyalar olabilir. ` +
      `\`grep\` veya \`search\` ile cross-reference kontrolü yap — etkilenen dosyaları da güncelle.`
    );
  }

  // Warning 11: Git hygiene — remind to commit when many files are modified
  if (store.isGitReminderNeeded(sessionKey)) {
    warnings.push(
      `- 💡 **Git kontrol** — ${snapshot.modifiedFiles.length} dosya değiştirildi, henüz commit yapılmadı. ` +
      `Düzenli commit: \`git status\` → \`git add\` → \`git commit\``
    );
  }

  // Warning 12: Complexity-Based Quality Review Triggers
  // Instead of simple call-count thresholds, use complexity signals:
  // - Cross-directory changes (3+ directories)
  // - Same-file revisions (file edited 3+ times = churn risk)
  // - Config file changes (package.json, tsconfig, etc.)
  // - Session duration (high call count)
  if (snapshot.modifiedFiles.length > 0 && !store.hasQualityReview(sessionKey)) {
    const fileCount = snapshot.modifiedFiles.length;
    const callCount = toolCallHistory?.length ?? 0;

    // Calculate complexity score (0-10 scale)
    let complexityScore = 0;
    const complexityReasons: string[] = [];

    // Signal 1: Cross-directory spread (3+ directories = higher complexity)
    const directories = new Set(snapshot.modifiedFiles.map(f => {
      const parts = f.split("/");
      return parts.slice(0, -1).join("/");
    }));
    if (directories.size >= 4) {
      complexityScore += 3;
      complexityReasons.push(`${directories.size} farklı dizin`);
    } else if (directories.size >= 3) {
      complexityScore += 2;
      complexityReasons.push(`${directories.size} farklı dizin`);
    }

    // Signal 2: Same-file revisions (churn — file edited multiple times)
    if (toolCallHistory) {
      const fileEditCounts = new Map<string, number>();
      for (const call of toolCallHistory) {
        if (call.fileTarget) {
          fileEditCounts.set(call.fileTarget, (fileEditCounts.get(call.fileTarget) ?? 0) + 1);
        }
      }
      const churningFiles = [...fileEditCounts.entries()].filter(([, count]) => count >= 3);
      if (churningFiles.length > 0) {
        complexityScore += 2;
        complexityReasons.push(`${churningFiles.length} dosya 3+ kez düzenlendi`);
      }
    }

    // Signal 3: Config file changes (higher risk of breaking things)
    const CONFIG_PATTERNS = /\/(package\.json|tsconfig|\.eslintrc|\.env|Dockerfile|docker-compose|Makefile|\.github)/i;
    const configChanges = snapshot.modifiedFiles.filter(f => CONFIG_PATTERNS.test(f));
    if (configChanges.length > 0) {
      complexityScore += 2;
      complexityReasons.push(`${configChanges.length} config dosyası`);
    }

    // Signal 4: Session duration (tool call count as proxy)
    if (callCount >= 30) {
      complexityScore += 3;
      complexityReasons.push(`${callCount} tool call`);
    } else if (callCount >= 15) {
      complexityScore += 1;
    }

    // Signal 5: Raw file count
    if (fileCount >= 8) {
      complexityScore += 2;
      complexityReasons.push(`${fileCount} dosya değiştirildi`);
    } else if (fileCount >= 4) {
      complexityScore += 1;
    }

    // Emit warning aligned with hard block thresholds
    // Hard block: ≥2 files → new writes blocked until quality_checklist
    // Hard block: plan verify/complete → blocked if files modified without quality_checklist
    const reasonText = complexityReasons.length > 0 ? ` (${complexityReasons.join(", ")})` : "";

    if (fileCount >= 2) {
      warnings.push(
        `- 🛑 **QUALITY REVIEW ZORUNLU** — ${fileCount} dosya değiştirildi${reasonText}. ` +
        `Yeni dosya yazımı ve plan tamamlama **ENGELLENİYOR**. ` +
        `\`quality_checklist(action: "review")\` çağır: doğrulama, edge case, regresyon riski ve gap analizi yanıtla.`
      );
    } else if (fileCount === 1) {
      warnings.push(
        `- ⚠️ **Quality review önerilir** — 1 dosya değiştirildi. ` +
        `İşi bitirmeden önce \`quality_checklist(action: "review")\` çağırmayı unutma. ` +
        `2. dosya yazımında engelleme başlayacak.`
      );
    }
  }

  return warnings;
}

// ─── Helpers ─────────────────────────────────────────────────

function countAllTasks(tasks: Array<{ children?: unknown[] }>): number {
  let count = 0;
  for (const task of tasks) {
    count += 1;
    if (task.children && Array.isArray(task.children)) {
      count += countAllTasks(task.children as typeof tasks);
    }
  }
  return count;
}

function countCompletedTasks(tasks: Array<{ status?: string; children?: unknown[] }>): number {
  let count = 0;
  for (const task of tasks) {
    if (task.status === "completed") count += 1;
    if (task.children && Array.isArray(task.children)) {
      count += countCompletedTasks(task.children as typeof tasks);
    }
  }
  return count;
}

function flattenTasks(tasks: Array<{ status: string; children?: unknown[] }>): Array<{ status: string }> {
  const result: Array<{ status: string }> = [];
  for (const task of tasks) {
    result.push({ status: task.status });
    if (task.children && Array.isArray(task.children)) {
      result.push(...flattenTasks(task.children as typeof tasks));
    }
  }
  return result;
}
