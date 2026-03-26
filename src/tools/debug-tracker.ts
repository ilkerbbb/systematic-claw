/**
 * debug_tracker tool — systematic debugging enforcement.
 * Claude Code equivalent: systematic-debugging skill
 *
 * 4 Phases: evidence → hypothesize → test → resolved | escalate
 *
 * Hard rules enforced structurally (not via prompts):
 * - No fix without a hypothesis
 * - Max 3 failed attempts → forced escalation to user
 * - Each phase transition requires specific evidence
 * - Error patterns tracked in SQLite for cross-session learning
 */
import { Type } from "@sinclair/typebox";
import type { SessionStateStore, DebugPhase, DebugHypothesis, DebugSession } from "../store/session-state.js";
import type { AuditLog } from "../store/audit-log.js";
import { jsonResult, generateId, type AnyAgentTool } from "./common.js";

// ─── Schema ─────────────────────────────────────────────

const DebugTrackerSchema = Type.Object({
  action: Type.Union([
    Type.Literal("start"),          // Start debugging: describe the error
    Type.Literal("reproduce"),      // Confirm the error is reproducible
    Type.Literal("hypothesize"),    // Propose a hypothesis with evidence
    Type.Literal("test"),           // Record test result for current hypothesis
    Type.Literal("resolve"),        // Mark bug as resolved with evidence
    Type.Literal("escalate"),       // Escalate to user (voluntary or forced)
    Type.Literal("status"),         // View current debug session state
    Type.Literal("cancel"),         // Cancel debug session
  ], {
    description: "Debug session lifecycle action",
  }),
  error_description: Type.Optional(Type.String({
    description: "What error/bug is being debugged (required for start)",
  })),
  reproduction_steps: Type.Optional(Type.String({
    description: "Steps taken to reproduce the error (required for reproduce)",
  })),
  hypothesis: Type.Optional(Type.String({
    description: "What you think the root cause is (required for hypothesize)",
  })),
  evidence: Type.Optional(Type.String({
    description: "Evidence supporting your hypothesis (required for hypothesize)",
  })),
  test_plan: Type.Optional(Type.String({
    description: "How you will test this hypothesis (required for hypothesize)",
  })),
  test_result: Type.Optional(Type.String({
    description: "What happened when you tested the hypothesis (required for test)",
  })),
  fix_succeeded: Type.Optional(Type.Boolean({
    description: "Did the fix resolve the issue? (required for test)",
  })),
  resolution: Type.Optional(Type.String({
    description: "How the bug was resolved — final evidence (required for resolve)",
  })),
  escalation_reason: Type.Optional(Type.String({
    description: "Why escalating to user (required for escalate)",
  })),
});

// ─── Tool Factory ───────────────────────────────────────

const MAX_ATTEMPTS = 3;

export function createDebugTrackerTool(deps: {
  store: SessionStateStore;
  auditLog: AuditLog;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "debug_tracker",
    label: "Debug Tracker",
    description:
      "Systematic debugging tool — enforces evidence-based debugging. " +
      "Phases: start → reproduce → hypothesize → test → resolve/escalate. " +
      "RULES: (1) No fix without a hypothesis. (2) Max 3 failed attempts → must escalate to user. " +
      "(3) Each hypothesis needs evidence and a test plan. " +
      "USE THIS when encountering any bug, error, or unexpected behavior.",
    parameters: DebugTrackerSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const action = p.action as string;
      const sessionKey = deps.sessionKey ?? "unknown";

      try {
        deps.store.ensureSession(sessionKey);

        switch (action) {
          // ── START: Begin a debug session ──────────────
          case "start": {
            const errorDesc = p.error_description as string;
            if (!errorDesc || errorDesc.trim().length < 10) {
              return jsonResult({
                error: "error_description zorunlu (min 10 karakter). Hatayı detaylı açıkla: ne olması gerekiyordu, ne oldu, hata mesajı ne.",
              });
            }

            // Check for existing active debug session
            const existing = deps.store.getActiveDebugSession(sessionKey);
            if (existing && existing.phase !== "resolved" && existing.phase !== "escalated") {
              return jsonResult({
                error: `Aktif debug session zaten var: "${existing.errorDescription}" (${existing.phase}). Önce mevcut oturumu çöz, iptal et veya escalate et.`,
                currentSession: renderDebugSession(existing),
              });
            }

            const debugId = generateId("dbg");
            deps.store.createDebugSession({
              id: debugId,
              sessionKey,
              errorDescription: errorDesc,
              maxAttempts: MAX_ATTEMPTS,
            });

            // Reset doom loop history — agent acknowledged the loop by starting debug
            deps.store.resetDoomLoop(sessionKey);

            deps.auditLog.record({
              sessionKey,
              eventType: "task_created",
              severity: "info",
              message: `Debug session başlatıldı: "${errorDesc}"`,
              details: { debugId },
            });

            const session = deps.store.getActiveDebugSession(sessionKey)!;
            return jsonResult({
              success: true,
              debugId,
              message: `Debug session başlatıldı. Doom loop sıfırlandı. Şimdi hatayı REPRODUCE et (reproduce action). Hatayı önce tekrar üret, sonra hipotez oluştur.`,
              session: renderDebugSession(session),
              phase: "evidence",
              nextAction: "reproduce — hatayı yeniden üret ve adımları kaydet",
            });
          }

          // ── REPRODUCE: Confirm the error ─────────────
          case "reproduce": {
            const session = deps.store.getActiveDebugSession(sessionKey);
            if (!session) return jsonResult({ error: "Aktif debug session yok. 'start' ile başla." });

            if (session.phase !== "evidence") {
              return jsonResult({
                error: `Debug session "${session.phase}" aşamasında. reproduce sadece "evidence" aşamasında kullanılabilir.`,
                session: renderDebugSession(session),
              });
            }

            const reproSteps = p.reproduction_steps as string;
            if (!reproSteps || reproSteps.trim().length < 20) {
              return jsonResult({
                error: "reproduction_steps zorunlu (min 20 karakter). Tam adımları yaz: hangi komutu çalıştırdın, ne oldu, hata mesajı ne.",
              });
            }

            deps.store.updateDebugSession(session.id, {
              phase: "hypothesize",
              reproduced: true,
              reproductionSteps: reproSteps,
            });

            const updated = deps.store.getActiveDebugSession(sessionKey)!;
            return jsonResult({
              success: true,
              message: `Hata reproduce edildi. Şimdi HİPOTEZ oluştur (hypothesize action). Kök neden ne olabilir? Hangi kanıt bunu destekliyor?`,
              session: renderDebugSession(updated),
              phase: "hypothesize",
              nextAction: "hypothesize — kök neden hipotezi + kanıt + test planı",
              rule: `⚠️ Hipotez olmadan FIX DENEME. Maksimum ${MAX_ATTEMPTS} deneme hakkın var.`,
            });
          }

          // ── HYPOTHESIZE: Propose a root cause ────────
          case "hypothesize": {
            const session = deps.store.getActiveDebugSession(sessionKey);
            if (!session) return jsonResult({ error: "Aktif debug session yok." });

            if (session.phase !== "hypothesize" && session.phase !== "test") {
              return jsonResult({
                error: `Hipotez sadece "hypothesize" veya "test" (başarısız denemeden sonra) aşamasında oluşturulabilir. Şu an: "${session.phase}"`,
                session: renderDebugSession(session),
              });
            }

            // ── HARD GATE: 3-attempt limit ──
            if (session.failedAttempts >= session.maxAttempts) {
              return jsonResult({
                error: `🚫 ${session.maxAttempts} başarısız deneme sınırına ulaşıldı! Bu muhtemelen bir MİMARÎ SORUN.`,
                action: "ZORUNLU: 'escalate' action ile kullanıcıya danış. Artık yeni hipotez oluşturamazsın.",
                failedAttempts: session.failedAttempts,
                hypotheses: session.hypotheses.map(h => ({
                  hypothesis: h.description,
                  result: h.result,
                  succeeded: h.succeeded,
                })),
              });
            }

            const hypothesis = p.hypothesis as string;
            const evidence = p.evidence as string;
            const testPlan = p.test_plan as string;

            if (!hypothesis || hypothesis.trim().length < 15) {
              return jsonResult({
                error: "hypothesis zorunlu (min 15 karakter). 'Bunu deneyelim' değil, 'Kök neden X çünkü Y' formatında yaz.",
              });
            }
            if (!evidence || evidence.trim().length < 15) {
              return jsonResult({
                error: "evidence zorunlu (min 15 karakter). Bu hipotezi destekleyen kanıtı belirt: hata mesajı, log çıktısı, kod analizi.",
              });
            }
            if (!testPlan || testPlan.trim().length < 10) {
              return jsonResult({
                error: "test_plan zorunlu (min 10 karakter). Bu hipotezi nasıl test edeceksin? Minimal, izole bir test tanımla.",
              });
            }

            // Check for vague hypotheses
            const vaguePatterns = [
              /\b(belki|maybe|possibly|muhtemelen|galiba|heralde|sanırım|probably|might|could be)\b/i,
              /\b(bir şey|something|whatever|somehow|bir şekilde)\b/i,
            ];
            for (const pattern of vaguePatterns) {
              const match = hypothesis.match(pattern);
              if (match) {
                return jsonResult({
                  error: `Belirsiz hipotez: "${match[0]}". Kesin bir kök neden belirt. "Belki X" değil, "X çünkü Y kanıtı bunu gösteriyor" formatında yaz.`,
                });
              }
            }

            const newHypothesis: DebugHypothesis = {
              index: session.hypotheses.length,
              description: hypothesis,
              evidence,
              testPlan,
              result: null,
              succeeded: null,
            };

            const hypotheses = [...session.hypotheses, newHypothesis];
            deps.store.updateDebugSession(session.id, {
              phase: "test",
              hypotheses,
            });

            const updated = deps.store.getActiveDebugSession(sessionKey)!;
            return jsonResult({
              success: true,
              message: `Hipotez #${newHypothesis.index + 1} kaydedildi. Şimdi TEST ET (test action). Test planını uygula ve sonucu kaydet.`,
              session: renderDebugSession(updated),
              phase: "test",
              currentHypothesis: newHypothesis,
              remainingAttempts: session.maxAttempts - session.failedAttempts,
              nextAction: "test — hipotezi test et ve sonucu kaydet",
            });
          }

          // ── TEST: Record test result ─────────────────
          case "test": {
            const session = deps.store.getActiveDebugSession(sessionKey);
            if (!session) return jsonResult({ error: "Aktif debug session yok." });

            if (session.phase !== "test") {
              return jsonResult({
                error: `test sadece "test" aşamasında kullanılabilir. Şu an: "${session.phase}"`,
                session: renderDebugSession(session),
              });
            }

            const testResult = p.test_result as string;
            const fixSucceeded = p.fix_succeeded as boolean | undefined;

            if (!testResult || testResult.trim().length < 15) {
              return jsonResult({
                error: "test_result zorunlu (min 15 karakter). Ne yaptın, ne oldu, çıktı ne? Somut sonuç yaz.",
              });
            }
            if (fixSucceeded === undefined || fixSucceeded === null) {
              return jsonResult({
                error: "fix_succeeded zorunlu (true/false). Fix çalıştı mı, çalışmadı mı?",
              });
            }

            // Update current hypothesis with result
            const hypotheses = [...session.hypotheses];
            const currentIdx = hypotheses.length - 1;
            if (currentIdx >= 0) {
              hypotheses[currentIdx] = {
                ...hypotheses[currentIdx],
                result: testResult,
                succeeded: fixSucceeded,
              };
            }

            if (fixSucceeded) {
              // Success! Move to resolved phase — agent should call resolve for final evidence
              deps.store.updateDebugSession(session.id, {
                phase: "resolved",
                hypotheses,
              });

              deps.auditLog.record({
                sessionKey,
                eventType: "task_completed",
                severity: "info",
                message: `Debug fix başarılı: hipotez #${currentIdx + 1}`,
                details: { debugId: session.id, hypothesis: hypotheses[currentIdx]?.description, testResult },
              });

              const updated = deps.store.getActiveDebugSession(sessionKey)!;
              return jsonResult({
                success: true,
                message: `✅ Fix BAŞARILI! Hipotez #${currentIdx + 1} doğrulandı. Şimdi 'resolve' action ile final doğrulamayı kaydet.`,
                session: renderDebugSession(updated),
                phase: "resolved",
                nextAction: "resolve — final doğrulama kanıtı kaydet",
              });
            } else {
              // Failed — increment counter
              const newFailedAttempts = session.failedAttempts + 1;
              deps.store.updateDebugSession(session.id, {
                phase: "hypothesize",
                hypotheses,
                failedAttempts: newFailedAttempts,
              });

              deps.auditLog.record({
                sessionKey,
                eventType: "gate_warned",
                severity: "medium",
                message: `Debug fix başarısız: hipotez #${currentIdx + 1} (${newFailedAttempts}/${session.maxAttempts})`,
                details: { debugId: session.id, hypothesis: hypotheses[currentIdx]?.description, testResult },
              });

              // Check if max attempts reached
              if (newFailedAttempts >= session.maxAttempts) {
                deps.store.updateDebugSession(session.id, { phase: "hypothesize" });

                deps.auditLog.record({
                  sessionKey,
                  eventType: "gate_blocked",
                  severity: "high",
                  message: `Debug: ${session.maxAttempts} deneme sınırı aşıldı — escalation zorunlu`,
                  details: { debugId: session.id, failedAttempts: newFailedAttempts },
                });

                return jsonResult({
                  success: false,
                  message: `🚫 ${newFailedAttempts}/${session.maxAttempts} deneme BAŞARISIZ. Bu muhtemelen MİMARÎ BİR SORUN.`,
                  action: "ZORUNLU: 'escalate' action ile kullanıcıya danış. Yeni hipotez oluşturamazsın.",
                  session: renderDebugSession(deps.store.getActiveDebugSession(sessionKey)!),
                  failedHypotheses: hypotheses.filter(h => h.succeeded === false).map(h => ({
                    hypothesis: h.description,
                    result: h.result,
                  })),
                });
              }

              const updated = deps.store.getActiveDebugSession(sessionKey)!;
              return jsonResult({
                success: false,
                message: `❌ Fix başarısız (${newFailedAttempts}/${session.maxAttempts}). Farklı bir HİPOTEZ oluştur — aynı yaklaşımı tekrarlama!`,
                session: renderDebugSession(updated),
                phase: "hypothesize",
                remainingAttempts: session.maxAttempts - newFailedAttempts,
                failedHypotheses: hypotheses.filter(h => h.succeeded === false).map(h => h.description),
                nextAction: "hypothesize — FARKLI bir kök neden hipotezi oluştur",
              });
            }
          }

          // ── RESOLVE: Final verification ──────────────
          case "resolve": {
            const session = deps.store.getActiveDebugSession(sessionKey);
            if (!session) return jsonResult({ error: "Aktif debug session yok." });

            // Phase guard: resolve only from "resolved" (set by successful test)
            if (session.phase !== "resolved") {
              return jsonResult({
                error: `resolve sadece başarılı bir test'ten sonra kullanılabilir. Şu an: "${session.phase}". Önce hypothesize → test → fix başarılı olmalı.`,
                session: renderDebugSession(session),
              });
            }

            const resolution = p.resolution as string;
            if (!resolution || resolution.trim().length < 30) {
              return jsonResult({
                error: "resolution zorunlu (min 30 karakter). Final kanıt: hangi komutu çalıştırdın, sonuç ne, regresyon testi yaptın mı?",
              });
            }

            deps.store.updateDebugSession(session.id, { phase: "resolved" });

            deps.auditLog.record({
              sessionKey,
              eventType: "task_completed",
              severity: "info",
              message: `Debug çözüldü: "${session.errorDescription}"`,
              details: {
                debugId: session.id,
                resolution,
                totalAttempts: session.hypotheses.length,
                failedAttempts: session.failedAttempts,
              },
            });

            return jsonResult({
              success: true,
              message: `✅ Bug çözüldü: "${session.errorDescription}"`,
              resolution,
              stats: {
                totalHypotheses: session.hypotheses.length,
                failedAttempts: session.failedAttempts,
                successfulHypothesis: session.hypotheses.find(h => h.succeeded)?.description,
              },
            });
          }

          // ── ESCALATE: Ask user for help ──────────────
          case "escalate": {
            const session = deps.store.getActiveDebugSession(sessionKey);
            if (!session) return jsonResult({ error: "Aktif debug session yok." });

            // Phase guard: don't escalate already terminal sessions
            if (session.phase === "resolved" || session.phase === "escalated") {
              return jsonResult({
                error: `Debug session zaten "${session.phase}" aşamasında — tekrar escalate edilemez.`,
                session: renderDebugSession(session),
              });
            }

            const reason = p.escalation_reason as string;
            if (!reason || reason.trim().length < 20) {
              return jsonResult({
                error: "escalation_reason zorunlu (min 20 karakter). Neden escalate ediyorsun? Ne denedin, neden başarısız oldu?",
              });
            }

            deps.store.updateDebugSession(session.id, {
              phase: "escalated",
              escalationReason: reason,
            });

            deps.auditLog.record({
              sessionKey,
              eventType: "task_incomplete",
              severity: "high",
              message: `Debug escalate edildi: "${session.errorDescription}"`,
              details: {
                debugId: session.id,
                reason,
                failedAttempts: session.failedAttempts,
                hypotheses: session.hypotheses.map(h => ({
                  description: h.description,
                  result: h.result,
                  succeeded: h.succeeded,
                })),
              },
            });

            return jsonResult({
              success: true,
              message: `⚠️ Debug kullanıcıya escalate edildi. Kullanıcıya şunları bildir:`,
              briefing: {
                error: session.errorDescription,
                triedApproaches: session.hypotheses.map(h => ({
                  hypothesis: h.description,
                  result: h.result,
                })),
                escalationReason: reason,
                recommendation: "Bu muhtemelen bir mimarî sorun veya eksik bilgi. Kullanıcıdan ek context veya yönlendirme iste.",
              },
            });
          }

          // ── STATUS: View current session ─────────────
          case "status": {
            const session = deps.store.getActiveDebugSession(sessionKey);
            if (!session) {
              return jsonResult({ message: "Aktif debug session yok. 'start' ile başla." });
            }
            return jsonResult({
              session: renderDebugSession(session),
              phase: session.phase,
              failedAttempts: session.failedAttempts,
              remainingAttempts: session.maxAttempts - session.failedAttempts,
              hypotheses: session.hypotheses.length,
            });
          }

          // ── CANCEL: End without resolution ───────────
          case "cancel": {
            const session = deps.store.getActiveDebugSession(sessionKey);
            if (!session) return jsonResult({ error: "Aktif debug session yok." });

            deps.store.updateDebugSession(session.id, { phase: "escalated" });

            deps.auditLog.record({
              sessionKey,
              eventType: "task_incomplete",
              severity: "medium",
              message: `Debug session iptal edildi: "${session.errorDescription}"`,
              details: { debugId: session.id },
            });

            return jsonResult({
              success: true,
              message: `Debug session iptal edildi: "${session.errorDescription}"`,
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
          message: `debug_tracker error: ${message}`,
          details: { action, params: p },
        });
        return jsonResult({ error: message });
      }
    },
  };
}

// ─── Render Helper ──────────────────────────────────────

function renderDebugSession(session: DebugSession): string {
  const phaseIcons: Record<string, string> = {
    evidence: "🔍",
    hypothesize: "🧠",
    test: "🧪",
    resolved: "✅",
    escalated: "⚠️",
  };

  const lines = [
    `${phaseIcons[session.phase] || "❓"} Debug: ${session.errorDescription}`,
    `   Aşama: ${session.phase}`,
    `   Reproduce: ${session.reproduced ? "✅" : "⏳"}`,
    ...(session.reproductionSteps ? [`   Repro adımları: ${session.reproductionSteps}`] : []),
    `   Denemeler: ${session.failedAttempts}/${session.maxAttempts}`,
  ];

  if (session.hypotheses.length > 0) {
    lines.push(`   Hipotezler:`);
    for (const h of session.hypotheses) {
      const icon = h.succeeded === true ? "✅" : h.succeeded === false ? "❌" : "🧪";
      lines.push(`   ${icon} #${h.index + 1}: ${h.description}`);
      if (h.result) {
        lines.push(`      Sonuç: ${h.result}`);
      }
    }
  }

  if (session.escalationReason) {
    lines.push(`   Escalation: ${session.escalationReason}`);
  }

  return lines.join("\n");
}
