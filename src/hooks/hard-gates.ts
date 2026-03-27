/**
 * Layer 2: ENFORCE — before_tool_call hook (Hard Gates).
 *
 * Gates:
 * 1. Read-before-edit: Block file edits if file wasn't read first
 * 2. Plan-before-create: Warn/block file creation without active plan (for "creating" workflow)
 * 3. Verify-before-complete: Block task/plan completion without running verification commands
 * 4. Doom-loop: Block repeated tool calls on same file (3+ in last 8) → redirect to debug_tracker
 *
 * Gate mode: "warn" (log only) or "block" (actively prevent)
 */
import type { SessionStateStore } from "../store/session-state.js";
import type { AuditLog } from "../store/audit-log.js";
import { isFileWriteTool } from "./tool-verify.js";
import { extractFilePath } from "../tools/common.js";

export type GateMode = "warn" | "block";

// Tools that edit existing files (not create new ones)
const FILE_EDIT_TOOLS = new Set([
  "file_edit", "edit_file", "Edit", "edit",
  "replace_in_file", "apply_diff", "insert_code",
]);

// Tools that can OVERWRITE existing files — gated only when file is already known
const FILE_OVERWRITE_TOOLS = new Set([
  "file_write", "write_file", "Write", "write",
  "file_create", "create_file",
]);

export function handleBeforeToolCall(deps: {
  store: SessionStateStore;
  auditLog: AuditLog;
  gateMode: GateMode;
  planModeEnabled: boolean;
  sessionKey?: string;
  agentId?: string;
  // Phase 4
  dangerousCommands?: string[];
  bootstrapSizeWarnKB?: number;
  bootstrapSizeBlockKB?: number;
}) {
  return (event: {
    toolName: string;
    params: Record<string, unknown>;
  }): { block?: boolean; blockReason?: string } | void => {
    const sessionKey = deps.sessionKey ?? "unknown";
    const SHELL_TOOL_NAMES = new Set([
      "Bash", "bash", "execute_command", "run_command",
      "shell", "terminal", "exec", "run_terminal_command",
    ]);

    // Helper: mark gate block in store so after_tool_call skips tracking for this call.
    // Without this, OpenClaw may fire after_tool_call for blocked calls without setting
    // event.error, causing addModifiedFile to inflate writesSinceVerification counter.
    const blockAndMark = (reason: string): { block: true; blockReason: string } => {
      deps.store.markGateBlocked(sessionKey);
      return { block: true, blockReason: reason };
    };

    try {
      // ── GATE 1: Read before edit ────────────────────────

      const isEditTool = FILE_EDIT_TOOLS.has(event.toolName);
      const isOverwriteTool = FILE_OVERWRITE_TOOLS.has(event.toolName);

      if (isEditTool || isOverwriteTool) {
        const filePath = extractFilePath(event.params);

        if (filePath && !deps.store.hasReadFile(sessionKey, filePath)) {
          // For overwrite tools (Write, write_file): only gate if the file is
          // already known (previously modified in this session). This allows
          // creating truly new files while preventing blind overwrites of
          // existing files the agent never read.
          const shouldGate = isEditTool || deps.store.hasModifiedFile(sessionKey, filePath);

          if (shouldGate) {
            const message = `Dosya düzenleme engeli: "${filePath}" henüz okunmadı. ` +
              `Önce dosyayı oku, sonra düzenle. Okumadan düzenleme hallüsinasyona yol açar.`;

            deps.auditLog.record({
              sessionKey,
              agentId: deps.agentId,
              eventType: deps.gateMode === "block" ? "gate_blocked" : "gate_warned",
              severity: "high",
              message,
              details: {
                gate: "read_before_edit",
                tool: event.toolName,
                file: filePath,
                mode: deps.gateMode,
              },
            });

            if (deps.gateMode === "block") {
              return blockAndMark(`⚠️ ${message}`);
            }
          }
        }
      }

      // ── GATE 2: Plan before create (creating workflow) ──

      if (deps.planModeEnabled && isFileWriteTool(event.toolName)) {
        deps.store.ensureSession(sessionKey);
        const snapshot = deps.store.getSnapshot(sessionKey);

        if (
          snapshot?.workflowType === "creating" &&
          !snapshot.activePlan &&
          event.toolName !== "task_tracker" &&
          event.toolName !== "plan_mode"
        ) {
          const filePath = extractFilePath(event.params);
          // Only gate on source files, not on config/docs/state files
          const isSourceFile = filePath && /\.(ts|js|py|tsx|jsx|go|rs|java|rb|sh)$/i.test(filePath);

          if (isSourceFile) {
            const message = `Plan olmadan kaynak dosya oluşturma: "${filePath}". ` +
              `Oluşturma görevlerinde önce plan_mode ile plan oluştur, onay al, sonra uygula.`;

            deps.auditLog.record({
              sessionKey,
              agentId: deps.agentId,
              eventType: deps.gateMode === "block" ? "gate_blocked" : "gate_warned",
              severity: "medium",
              message,
              details: {
                gate: "plan_before_create",
                tool: event.toolName,
                file: filePath,
                mode: deps.gateMode,
              },
            });

            if (deps.gateMode === "block") {
              return blockAndMark(`⚠️ ${message}`);
            }
          }
        }
      }
      // ── GATE 3: Verify before complete ─────────────
      // Only enforced on plan_mode verify/complete — NOT on individual task completion.
      // Reason: Individual tasks may be read-only or simple; plan completion always requires verification.

      if (event.toolName === "plan_mode") {
        const action = event.params.action as string | undefined;
        const requiresVerification = action === "verify" || action === "complete";

        if (requiresVerification) {
          deps.store.ensureSession(sessionKey);
          const snapshot = deps.store.getSnapshot(sessionKey);
          const hasModifications = snapshot && snapshot.modifiedFiles.length > 0;

          if (hasModifications && !deps.store.hasRecentVerification(sessionKey)) {
            const message =
              `Doğrulama olmadan tamamlama engeli. ` +
              `${snapshot!.modifiedFiles.length} dosya değiştirildi ama test/build/lint komutu çalıştırılmadı. ` +
              `Önce doğrulama komutu çalıştır (npm test, pytest, go test, tsc --noEmit vb.), sonra tamamla.`;

            deps.auditLog.record({
              sessionKey,
              agentId: deps.agentId,
              eventType: deps.gateMode === "block" ? "gate_blocked" : "gate_warned",
              severity: "high",
              message,
              details: {
                gate: "verify_before_complete",
                tool: event.toolName,
                action,
                modifiedFiles: snapshot!.modifiedFiles,
                mode: deps.gateMode,
              },
            });

            if (deps.gateMode === "block") {
              return blockAndMark(`⚠️ ${message}`);
            }
          }
        }
      }
      // ── GATE 4: Doom loop detection ─────────────────
      // If the same tool + same file has been called 3+ times in recent history,
      // block and redirect to debug_tracker for systematic debugging.

      const isFileTool = FILE_EDIT_TOOLS.has(event.toolName) ||
        FILE_OVERWRITE_TOOLS.has(event.toolName) ||
        isFileWriteTool(event.toolName);

      if (isFileTool) {
        const doomCheck = deps.store.checkDoomLoop(sessionKey, event.toolName, event.params);

        if (doomCheck.detected) {
          const fileInfo = doomCheck.fileTarget ? ` (${doomCheck.fileTarget})` : "";
          const message =
            `⚠️ DOOM LOOP TESPİT EDİLDİ: ${event.toolName}${fileInfo} son 8 call'da ${doomCheck.count}x tekrarlandı. ` +
            `Aynı düzeltmeyi tekrar denemek yerine debug_tracker(action: "start") ile sistematik debug başlat. ` +
            `Adımlar: (1) Hatayı tanımla, (2) Reproduce et, (3) Hipotez oluştur, (4) Minimal test yap.`;

          deps.auditLog.record({
            sessionKey,
            agentId: deps.agentId,
            eventType: deps.gateMode === "block" ? "gate_blocked" : "gate_warned",
            severity: "high",
            message,
            details: {
              gate: "doom_loop",
              tool: event.toolName,
              fileTarget: doomCheck.fileTarget,
              repeatCount: doomCheck.count,
              mode: deps.gateMode,
            },
          });

          if (deps.gateMode === "block") {
            return blockAndMark(message);
          }
        }
      }
      // ── GATE 5: Dangerous command block ──────────────
      // Hard-block irreversible commands (social media posts, destructive ops, email sends).
      // Applies to shell/exec tools only. Always blocks regardless of gateMode.

      if (SHELL_TOOL_NAMES.has(event.toolName) && deps.dangerousCommands && deps.dangerousCommands.length > 0) {
        const command = (event.params.command ?? event.params.input ?? event.params.cmd ?? "") as string;
        if (command) {
          for (const pattern of deps.dangerousCommands) {
            try {
              const regex = new RegExp(pattern, "i");
              if (regex.test(command)) {
                const message =
                  `🛑 TEHLİKELİ KOMUT ENGELLENDİ: "${command.slice(0, 100)}" komutu geri alınamaz bir işlem içeriyor. ` +
                  `Eşleşen pattern: ${pattern}. Bu komut kullanıcı onayı olmadan çalıştırılamaz.`;

                deps.auditLog.record({
                  sessionKey,
                  agentId: deps.agentId,
                  eventType: "gate_blocked",
                  severity: "critical",
                  message,
                  details: {
                    gate: "dangerous_command",
                    command: command.slice(0, 200),
                    matchedPattern: pattern,
                  },
                });

                // ALWAYS block dangerous commands — ignores gateMode
                return blockAndMark(message);
              }
            } catch (regexErr) {
              // Invalid regex pattern — log warning (security-critical: user should know their pattern is broken)
              console.warn(`[systematic-claw] Invalid dangerous command regex: "${pattern}" — ${regexErr instanceof Error ? regexErr.message : regexErr}`);
              try {
                deps.auditLog.record({
                  sessionKey,
                  agentId: deps.agentId,
                  eventType: "tool_error",
                  severity: "high",
                  message: `Invalid dangerous command regex pattern: "${pattern}"`,
                  details: { gate: "dangerous_command", pattern, error: String(regexErr) },
                });
              } catch { /* audit log failure — best effort */ }
            }
          }
        }
      }

      // ── GATE 6: Bootstrap file size check ─────────────
      // Prevent writing oversized files that will be silently truncated by the bootstrap system.
      // Applies to Write tools targeting known bootstrap files.

      if (FILE_OVERWRITE_TOOLS.has(event.toolName) || FILE_EDIT_TOOLS.has(event.toolName)) {
        const filePath = extractFilePath(event.params);
        if (filePath) {
          const bootstrapPatterns = [
            /SOUL\.md$/i, /AGENTS\.md$/i, /PERSONA\.md$/i,
            /MEMORY\.md$/i, /CLAUDE\.md$/i, /TOOLS\.md$/i,
            /STATE\.md$/i, /OPERATIONS\.md$/i,
          ];
          const isBootstrapFile = bootstrapPatterns.some(p => p.test(filePath));

          if (isBootstrapFile) {
            // Estimate content size from params
            const content = (event.params.content ?? event.params.new_string ?? event.params.text ?? "") as string;
            const existingContent = (event.params.old_string ?? "") as string;
            // For Edit: net change = new - old. For Write: total = content length.
            const estimatedSizeKB = FILE_OVERWRITE_TOOLS.has(event.toolName)
              ? content.length / 1024
              : (content.length - existingContent.length) / 1024; // Rough estimate for edits

            const warnKB = deps.bootstrapSizeWarnKB ?? 28;
            const blockKB = deps.bootstrapSizeBlockKB ?? 35;

            // We need the actual file size for Edit operations — check if we can get it
            // For now, just check the content being written for Write operations
            if (FILE_OVERWRITE_TOOLS.has(event.toolName) && estimatedSizeKB > blockKB) {
              const message =
                `🛑 BOOTSTRAP DOSYASI ÇOK BÜYÜK: ${filePath} (${estimatedSizeKB.toFixed(1)}KB) bootstrap limiti olan ${blockKB}KB'ı aşıyor. ` +
                `Bu dosya sessizce kesilerek agent'a eksik kurallar gösterilecek. Dosyayı küçült.`;

              deps.auditLog.record({
                sessionKey,
                agentId: deps.agentId,
                eventType: "gate_blocked",
                severity: "critical",
                message,
                details: { gate: "bootstrap_size", file: filePath, sizeKB: estimatedSizeKB, limitKB: blockKB },
              });

              return blockAndMark(message);
            }

            if (FILE_OVERWRITE_TOOLS.has(event.toolName) && estimatedSizeKB > warnKB) {
              const message =
                `⚠️ BOOTSTRAP UYARISI: ${filePath} (${estimatedSizeKB.toFixed(1)}KB) ${warnKB}KB uyarı eşiğini aşıyor. ` +
                `${blockKB}KB'a ulaşırsa yazım engellenecek. Dosyayı küçültmeyi düşün.`;

              deps.auditLog.record({
                sessionKey,
                agentId: deps.agentId,
                eventType: "gate_warned",
                severity: "high",
                message,
                details: { gate: "bootstrap_size", file: filePath, sizeKB: estimatedSizeKB, warnKB, blockKB },
              });
            }
          }
        }
      }
      // ── GATE 7: Verify-First enforcement (P5) ──────────
      // Escalating response to unverified writes:
      //   - 4+ writes: audit log warning (agent may not see, but recorded)
      //   - 8+ writes: HARD BLOCK — forces agent to run test/build/lint before more writes
      // This gate fires on every file write, even during autonomous tool call turns,
      // solving the before_prompt_build timing gap where periodic warnings never appeared.

      if (isFileWriteTool(event.toolName)) {
        const writes = deps.store.getWritesSinceVerification(sessionKey);

        if (writes >= 8) {
          const message =
            `🛑 DOĞRULAMA ZORUNLU: ${writes} dosya yazımı doğrulama olmadan yapıldı. ` +
            `Daha fazla dosya yazmadan önce Bash tool ile doğrulama komutu çalıştır. ` +
            `Kabul edilen komutlar: tsc, tsc --noEmit, npm test, npx tsc, pytest, ` +
            `go test, cargo check, eslint, jest, vitest, make test, dotnet test. ` +
            `ÖNEMLİ: echo veya basit shell komutu doğrulama sayılmaz — gerçek bir compiler/test/lint komutu gerekli. ` +
            `Doğrulama sonrası yazıma devam edebilirsin.`;

          deps.auditLog.record({
            sessionKey,
            agentId: deps.agentId,
            eventType: "gate_blocked",
            severity: "high",
            message,
            details: {
              gate: "verify_first",
              tool: event.toolName,
              writesSinceVerification: writes,
              threshold: 8,
            },
          });

          return blockAndMark(message);

        } else if (writes >= 4) {
          // Audit-only nudge — recorded for observability, may not be visible to agent
          deps.auditLog.record({
            sessionKey,
            agentId: deps.agentId,
            eventType: "gate_warned",
            severity: "medium",
            message: `⚠️ Verify-First uyarı: ${writes} dosya yazımı doğrulama olmadan. 8'e ulaşırsa yazım engellenecek.`,
            details: {
              gate: "verify_first",
              tool: event.toolName,
              writesSinceVerification: writes,
              threshold: 4,
              blockThreshold: 8,
            },
          });
        }
      }

      // ── GATE 8: Complexity Review enforcement (P6) ─────
      // When the session has accumulated significant complexity (6+ modified files
      // spanning 3+ directories) AND no quality_checklist review has been done,
      // block further writes. Forces the agent to pause and run quality_checklist
      // before continuing — prevents "write everything then realize it's broken" pattern.
      // Only triggers once per review cycle (hasQualityReview resets on new writes).

      if (isFileWriteTool(event.toolName)) {
        const snapshot = deps.store.getSnapshot(sessionKey);
        if (snapshot && !deps.store.hasQualityReview(sessionKey)) {
          const modifiedFiles = snapshot.modifiedFiles;
          const dirSet = new Set<string>();
          for (const f of modifiedFiles) {
            const lastSlash = f.lastIndexOf("/");
            if (lastSlash > 0) {
              dirSet.add(f.substring(0, lastSlash));
            }
          }

          const fileCount = modifiedFiles.length;
          const dirCount = dirSet.size;

          if (fileCount >= 6 && dirCount >= 3) {
            const message =
              `🛑 KALİTE İNCELEMESİ ZORUNLU: ${fileCount} dosya ${dirCount} dizinde değiştirildi — karmaşıklık eşiği aşıldı. ` +
              `Daha fazla dosya yazmadan önce quality_checklist(action: "review") çalıştır. ` +
              `Bu, cross-cutting hataları erken yakalamak ve tutarlılığı sağlamak için gerekli.`;

            deps.auditLog.record({
              sessionKey,
              agentId: deps.agentId,
              eventType: "gate_blocked",
              severity: "high",
              message,
              details: {
                gate: "complexity_review",
                tool: event.toolName,
                fileCount,
                dirCount,
                directories: [...dirSet],
              },
            });

            return blockAndMark(message);
          }
        }
      }

    } catch (err) {
      // Log error to console AND attempt audit log
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn("[systematic-claw] hard-gates error:", errMsg);
      try {
        deps.auditLog.record({
          sessionKey,
          agentId: deps.agentId,
          eventType: "tool_error",
          severity: "critical",
          message: `Hard gates error — gates bypassed: ${errMsg}`,
          details: { gate: "infrastructure_error", toolName: event.toolName, error: errMsg },
        });
      } catch { /* audit log itself failed — nothing more we can do */ }

      // SAFETY: For shell tools, fail-closed (block) rather than fail-open
      // A gate infrastructure error should NOT allow potentially dangerous commands through
      if (SHELL_TOOL_NAMES.has(event.toolName)) {
        return blockAndMark(`🛑 Systematic Engine iç hatası — güvenlik gate'leri çalışamadı. Shell komutu güvenlik nedeniyle engellendi. Hata: ${errMsg}`);
      }
      // For non-shell tools: fail-open (don't block agent on plugin errors)
    }
  };
}
