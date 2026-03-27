/**
 * quality_checklist tool — Enforces self-review before work completion.
 *
 * Agent MUST call this tool before saying "done" or ending a session.
 * Requires answering quality questions about verification, edge cases,
 * regression risk, and gap analysis.
 *
 * The tool validates answers aren't empty/superficial and records
 * the quality review in the audit log for cross-session tracking.
 */
import { Type } from "@sinclair/typebox";
import type { SessionStateStore } from "../store/session-state.js";
import type { AuditLog } from "../store/audit-log.js";
import { jsonResult, type AnyAgentTool } from "./common.js";

const QualityChecklistSchema = Type.Object({
  action: Type.Union([
    Type.Literal("review"),
    Type.Literal("status"),
  ], {
    description: "review: submit quality self-review. status: check if review is required.",
  }),
  // Review fields — required for "review" action
  verification_done: Type.Optional(Type.String({
    description: "What verification commands did you run? (test, build, lint, type-check). List actual commands and their results.",
  })),
  edge_cases_considered: Type.Optional(Type.String({
    description: "What edge cases did you consider? Empty inputs, error states, concurrent access, large data, missing dependencies, etc.",
  })),
  regression_risk: Type.Optional(Type.String({
    description: "What existing functionality could be affected by your changes? How did you verify it still works?",
  })),
  gap_analysis: Type.Optional(Type.String({
    description: "What gaps remain? Known limitations, TODOs, things you couldn't verify, follow-up items?",
  })),
  stress_tested: Type.Optional(Type.String({
    description: "Did you stress-test your changes? How? What did you find?",
  })),
});

/** Minimum answer length to count as a real response (not just "yes" or "n/a") */
const MIN_ANSWER_LENGTH = 15;

/** Quality review fields and their labels */
const REVIEW_FIELDS = [
  { key: "verification_done", label: "Doğrulama", emoji: "✅", required: true },
  { key: "edge_cases_considered", label: "Edge Case'ler", emoji: "🔍", required: true },
  { key: "regression_risk", label: "Regresyon Riski", emoji: "⚠️", required: true },
  { key: "gap_analysis", label: "Gap Analizi", emoji: "📋", required: true },
  { key: "stress_tested", label: "Stres Testi", emoji: "💪", required: false },
] as const;

export function createQualityChecklistTool(deps: {
  store: SessionStateStore;
  auditLog: AuditLog;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "quality_checklist",
    label: "Quality Self-Review",
    description:
      "Self-review checklist — İşi tamamlamadan ÖNCE çağır. " +
      "Doğrulama, edge case, regresyon riski, gap analizi sorularını yanıtla. " +
      "BU TOOL ÇAĞRILMADAN session tamamlanamaz. " +
      "ZORUNLU: Dosya değişikliği yapılan her session'da çağrılmalı. " +
      "Yanıtlar yüzeysel olamaz — en az 15 karakter, somut bilgi gerekli.",
    parameters: QualityChecklistSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const action = p.action as string;
      const sessionKey = deps.sessionKey ?? "unknown";

      try {
        deps.store.ensureSession(sessionKey);

        if (action === "status") {
          const snapshot = deps.store.getSnapshot(sessionKey);
          const hasModifications = snapshot && snapshot.modifiedFiles.length > 0;
          const alreadyReviewed = deps.store.hasQualityReview(sessionKey);

          return jsonResult({
            required: hasModifications && !alreadyReviewed,
            alreadyReviewed,
            modifiedFiles: snapshot?.modifiedFiles.length ?? 0,
            message: alreadyReviewed
              ? "✅ Quality review zaten tamamlandı."
              : hasModifications
                ? "❌ Quality review gerekli — dosya değişikliği yapıldı ama henüz self-review yapılmadı."
                : "ℹ️ Quality review gerekli değil — dosya değişikliği yok.",
          });
        }

        if (action === "review") {
          // Validate that required fields are present and substantive
          const issues: string[] = [];
          const answers: Record<string, string> = {};
          let score = 0;

          for (const field of REVIEW_FIELDS) {
            const value = (p[field.key] as string | undefined)?.trim() ?? "";
            answers[field.key] = value;

            if (field.required && !value) {
              issues.push(`${field.emoji} ${field.label}: Yanıt eksik — bu alan zorunlu.`);
            } else if (field.required && value.length < MIN_ANSWER_LENGTH) {
              issues.push(
                `${field.emoji} ${field.label}: Yanıt çok kısa (${value.length} karakter). ` +
                `En az ${MIN_ANSWER_LENGTH} karakter, somut bilgi gerekli. "Evet", "N/A", "Yapıldı" gibi yanıtlar kabul edilmez.`
              );
            } else if (value.length >= MIN_ANSWER_LENGTH) {
              score += field.required ? 2 : 1;
            } else if (value) {
              score += 0.5; // Partial credit for optional fields with short answers
            }
          }

          // Max score = only required fields. Optional fields are bonus.
          const maxScore = REVIEW_FIELDS.filter(f => f.required).length * 2;

          if (issues.length > 0) {
            deps.auditLog.record({
              sessionKey,
              eventType: "gate_warned",
              severity: "medium",
              message: `Quality review incomplete: ${issues.length} sorun`,
              details: { gate: "quality_checklist", issues, answers },
            });

            return jsonResult({
              success: false,
              error: "Quality review eksik — aşağıdaki sorunları düzelt ve tekrar dene:",
              issues,
              score: `${score}/${maxScore}`,
              hint: "Her soruya somut, detaylı yanıt ver. Genel ifadeler yerine spesifik bilgi yaz.",
            });
          }

          // Review passed — record it. Also marks impact analysis as done
          // (quality review implicitly includes cross-reference consideration).
          deps.store.recordQualityReview(sessionKey);
          deps.store.markImpactAnalysisDone(sessionKey);

          deps.auditLog.record({
            sessionKey,
            eventType: "completion_check_pass",
            severity: "info",
            message: `Quality review completed (score: ${score}/${maxScore})`,
            details: { gate: "quality_checklist", score, maxScore, answers },
          });

          // ── SUBAGENT REVIEW SUGGESTION ──────────────
          // For high-complexity sessions, suggest dispatching a review subagent.
          // This is prompt-based (Layer 1) — the agent decides whether to dispatch.
          // Future: native runtime.subagent.run() integration (Layer 2).
          const snapshot = deps.store.getSnapshot(sessionKey);
          const modifiedFiles = snapshot?.modifiedFiles ?? [];
          const directories = new Set(modifiedFiles.map(f => f.split("/").slice(0, -1).join("/")));
          const isHighComplexity = modifiedFiles.length >= 6 || directories.size >= 3;

          const subagentSuggestion = isHighComplexity ? {
            subagentReview: {
              suggested: true,
              reason: `${modifiedFiles.length} dosya, ${directories.size} dizin — bağımsız review önerilir`,
              readyPrompt: `Aşağıdaki dosyaları incele ve olası sorunları listele:\n${modifiedFiles.map(f => `- ${f}`).join("\n")}\n\nKontrol et:\n1. Değişiklikler birbiriyle tutarlı mı?\n2. Kırılma riski var mı? (API uyumluluğu, type safety)\n3. Eksik test/doğrulama var mı?\n4. Edge case'ler düşünülmüş mü?`,
              hint: "Bu prompt'u sessions_spawn() ile bağımsız bir review agentına gönderebilirsin.",
            },
          } : {};

          return jsonResult({
            success: true,
            score: `${score}/${maxScore}`,
            message: `✅ Quality review tamamlandı.${isHighComplexity ? " 📋 Yüksek karmaşıklık — bağımsız review subagent önerisi eklendi." : " Session tamamlanmaya hazır."}`,
            summary: REVIEW_FIELDS.map(f => {
              const val = answers[f.key];
              return `${f.emoji} ${f.label}: ${val ? val.slice(0, 80) + (val.length > 80 ? "..." : "") : "—"}`;
            }),
            ...subagentSuggestion,
          });
        }

        return jsonResult({ error: `Bilinmeyen action: ${action}` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonResult({ error: message });
      }
    },
  };
}
