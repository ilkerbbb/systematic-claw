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
import { isFileWriteTool, isShellTool, extractCommand, detectShellFileWrites } from "./tool-verify.js";
import { extractFilePath, RELATED_FILE_RULES, isExcludedFromRelatedFileRules } from "../tools/common.js";

/** Resolved HOME directory — avoids hardcoded user paths. */
const HOME = process.env.HOME || process.env.USERPROFILE || "/tmp";
const WORKSPACE_PREFIX = `${HOME}/.openclaw/workspace`;

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
              deps.store.recordGateBlock(sessionKey, "read_before_edit");
              return blockAndMark(`⚠️ ${message}`);
            }
            deps.store.recordGateWarn(sessionKey, "read_before_edit");
          } else {
            deps.store.recordGatePass(sessionKey, "read_before_edit");
          }
        } else if (filePath) {
          deps.store.recordGatePass(sessionKey, "read_before_edit");
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
              deps.store.recordGateBlock(sessionKey, "plan_before_create");
              return blockAndMark(`⚠️ ${message}`);
            }
            deps.store.recordGateWarn(sessionKey, "plan_before_create");
          } else {
            deps.store.recordGatePass(sessionKey, "plan_before_create");
          }
        } else {
          deps.store.recordGatePass(sessionKey, "plan_before_create");
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
              deps.store.recordGateBlock(sessionKey, "verify_before_complete");
              return blockAndMark(`⚠️ ${message}`);
            }
            deps.store.recordGateWarn(sessionKey, "verify_before_complete");
          } else {
            deps.store.recordGatePass(sessionKey, "verify_before_complete");
          }

          // Gate 3b: Quality review before plan completion
          // If files were modified and quality_checklist hasn't been called, block.
          if (hasModifications && !deps.store.hasQualityReview(sessionKey)) {
            const message =
              `Quality review olmadan plan tamamlanamaz. ` +
              `${snapshot!.modifiedFiles.length} dosya değiştirildi ama quality_checklist çağrılmadı. ` +
              `Önce quality_checklist(action: "review") çalıştır, sonra tamamla.`;

            deps.auditLog.record({
              sessionKey,
              agentId: deps.agentId,
              eventType: deps.gateMode === "block" ? "gate_blocked" : "gate_warned",
              severity: "high",
              message,
              details: {
                gate: "quality_before_complete",
                tool: event.toolName,
                action,
                modifiedFiles: snapshot!.modifiedFiles,
                mode: deps.gateMode,
              },
            });

            if (deps.gateMode === "block") {
              deps.store.recordGateBlock(sessionKey, "quality_before_complete");
              return blockAndMark(`🛑 ${message}`);
            }
            deps.store.recordGateWarn(sessionKey, "quality_before_complete");
          } else {
            deps.store.recordGatePass(sessionKey, "quality_before_complete");
          }

          // Gate 3c: Related file propagation enforcement
          // When completing a plan, check if RELATED_FILE_RULES targets were updated.
          // This makes the prompt-level warning into a hard block.
          if (hasModifications && snapshot) {
            const relevantFiles = snapshot.modifiedFiles.filter(f => !isExcludedFromRelatedFileRules(f));
            const missingUpdates: string[] = [];
            const checkedRequired = new Set<string>();

            for (const modifiedFile of relevantFiles) {
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
              const message =
                `İlişkili dosyalar güncellenmeden plan tamamlanamaz. ` +
                `Eksik güncelleme: ${missingUpdates.join(", ")}. ` +
                `Demir Kural #2: "Etki listesindeki HER dosya güncellenip commit edilmeden tamamlandı deme."`;

              deps.auditLog.record({
                sessionKey,
                agentId: deps.agentId,
                eventType: deps.gateMode === "block" ? "gate_blocked" : "gate_warned",
                severity: "high",
                message,
                details: {
                  gate: "related_file_propagation",
                  tool: event.toolName,
                  action,
                  missingUpdates,
                  modifiedFiles: relevantFiles,
                  mode: deps.gateMode,
                },
              });

              if (deps.gateMode === "block") {
                deps.store.recordGateBlock(sessionKey, "related_file_propagation");
                return blockAndMark(`🛑 ${message}`);
              }
              deps.store.recordGateWarn(sessionKey, "related_file_propagation");
            } else {
              deps.store.recordGatePass(sessionKey, "related_file_propagation");
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
            deps.store.recordGateBlock(sessionKey, "doom_loop");
            return blockAndMark(message);
          }
          deps.store.recordGateWarn(sessionKey, "doom_loop");
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
                deps.store.recordGateBlock(sessionKey, "dangerous_command");
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

              deps.store.recordGateBlock(sessionKey, "bootstrap_size");
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
              deps.store.recordGateWarn(sessionKey, "bootstrap_size");
            } else {
              deps.store.recordGatePass(sessionKey, "bootstrap_size");
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

          deps.store.recordGateBlock(sessionKey, "verify_first");
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
          deps.store.recordGateWarn(sessionKey, "verify_first");
        } else {
          deps.store.recordGatePass(sessionKey, "verify_first");
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

          if (fileCount >= 2) {
            const message =
              `🛑 KALİTE İNCELEMESİ ZORUNLU: ${fileCount} dosya değiştirildi — quality review olmadan daha fazla dosya yazılamaz. ` +
              `quality_checklist(action: "review") çağır, sonra devam et.`;

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

            deps.store.recordGateBlock(sessionKey, "complexity_review");
            return blockAndMark(message);
          }
        }
      }

      // ── GATE 9: SSoT Propagation Enforcement ──────
      // Two-layer enforcement:
      // 9a: plan_mode create → SSOT_REGISTRY.md must have been read
      // 9b: plan_mode verify/complete → related files from RELATED_FILE_RULES must be updated
      // 9b is already handled by Gate 3 (verify_before_complete) + prompt warnings.
      // Gate 9a adds the SSoT awareness requirement.

      if (event.toolName === "plan_mode") {
        const action = event.params.action as string | undefined;

        if (action === "create") {
          deps.store.ensureSession(sessionKey);
          const snapshot = deps.store.getSnapshot(sessionKey);
          const hasModifications = snapshot && snapshot.modifiedFiles.length > 0;

          // Only enforce SSOT read when there are already modifications (mid-session plans)
          // or when the plan involves file changes (detected by step count > 3)
          const steps = event.params.steps as string[] | undefined;
          const isComplexPlan = steps && steps.length >= 4;

          if ((hasModifications || isComplexPlan) && !deps.store.hasSsotRegistryRead(sessionKey)) {
            const message =
              `SSoT haritası okunmadan plan oluşturulamaz. ` +
              `SYSTEM/SSOT_REGISTRY.md'yi oku → hangi dosyaların etkileneceğini belirle → sonra plan oluştur. ` +
              `Demir Kural #2: "Değişiklik → Önce Etki Listesi"`;

            deps.auditLog.record({
              sessionKey,
              agentId: deps.agentId,
              eventType: deps.gateMode === "block" ? "gate_blocked" : "gate_warned",
              severity: "high",
              message,
              details: {
                gate: "ssot_propagation",
                tool: event.toolName,
                action,
                stepCount: steps?.length ?? 0,
                mode: deps.gateMode,
              },
            });

            if (deps.gateMode === "block") {
              deps.store.recordGateBlock(sessionKey, "ssot_propagation");
              return blockAndMark(`⚠️ ${message}`);
            }
            deps.store.recordGateWarn(sessionKey, "ssot_propagation");
          } else {
            deps.store.recordGatePass(sessionKey, "ssot_propagation");
          }
        }
      }

      // ── GATE 10: memory_search before agent dispatch ──
      // When sending tasks to agent sessions (sessions_send with agent:* sessionKey),
      // memory_search (or lcm_grep/lcm_expand_query) must have been called first.
      // This prevents dispatching tasks without checking prior decisions/context.

      if (event.toolName === "sessions_send") {
        const targetSession = (event.params.sessionKey ?? event.params.session_key ?? "") as string;
        const isAgentDispatch = /^agent:[^:]+:main$/.test(targetSession);

        if (isAgentDispatch && !deps.store.hasMemorySearch(sessionKey)) {
          const message =
            `Agent dispatch'ten önce bağlam kontrolü zorunlu. ` +
            `"${targetSession}" session'ına görev göndermeden önce memory_search, lcm_grep veya lcm_expand_query çağır. ` +
            `Bu, geçmiş kararların ve bağlamın kontrol edilmesini sağlar (REG-026, REG-041).`;

          deps.auditLog.record({
            sessionKey,
            agentId: deps.agentId,
            eventType: deps.gateMode === "block" ? "gate_blocked" : "gate_warned",
            severity: "high",
            message,
            details: {
              gate: "memory_before_dispatch",
              tool: event.toolName,
              targetSession,
              mode: deps.gateMode,
            },
          });

          if (deps.gateMode === "block") {
            deps.store.recordGateBlock(sessionKey, "memory_before_dispatch");
            return blockAndMark(`⚠️ ${message}`);
          }
          deps.store.recordGateWarn(sessionKey, "memory_before_dispatch");
        } else if (isAgentDispatch) {
          deps.store.recordGatePass(sessionKey, "memory_before_dispatch");
        }
      }

      // ── GATE 11: Skill SKILL.md + skill-creator read before skill write ──
      // When writing to /skills/X/ directory, two conditions must be met:
      // 1. skills/X/SKILL.md must have been read (understand the skill's rules)
      // 2. skills/skill-creator/SKILL.md must have been read (skill writing procedure)
      // Exception: If SKILL.md doesn't exist yet (new skill creation), only skill-creator is required.

      if (isFileWriteTool(event.toolName)) {
        const filePath = extractFilePath(event.params);
        if (filePath) {
          const skillDirMatch = filePath.match(/\/skills\/([^/]+)\//i);
          if (skillDirMatch) {
            const skillName = skillDirMatch[1];
            const missingReads: string[] = [];

            // Check 1: skill-creator/SKILL.md (always required for any skill write)
            if (skillName !== "skill-creator") {
              const skillCreatorPath = "skills/skill-creator/SKILL.md";
              const hasCreatorRead = deps.store.hasReadFile(sessionKey, skillCreatorPath) ||
                deps.store.hasReadFile(sessionKey, `~/.openclaw/workspace/${skillCreatorPath}`) ||
                deps.store.hasReadFile(sessionKey, `${WORKSPACE_PREFIX}/${skillCreatorPath}`);
              if (!hasCreatorRead) {
                missingReads.push("skills/skill-creator/SKILL.md (skill yazma prosedürü)");
              }
            }

            // Check 2: The skill's own SKILL.md (required unless it's a new skill being created)
            const skillMdPath = `skills/${skillName}/SKILL.md`;
            const hasSkillRead = deps.store.hasReadFile(sessionKey, skillMdPath) ||
              deps.store.hasReadFile(sessionKey, `~/.openclaw/workspace/${skillMdPath}`) ||
              deps.store.hasReadFile(sessionKey, `${WORKSPACE_PREFIX}/${skillMdPath}`);

            // Only require skill's own SKILL.md if it's not the SKILL.md itself being written
            const isWritingSkillMd = /SKILL\.md$/i.test(filePath);
            if (!hasSkillRead && !isWritingSkillMd) {
              missingReads.push(`skills/${skillName}/SKILL.md (skill kuralları)`);
            }

            if (missingReads.length > 0) {
              const message =
                `Skill dosyaları okunmadan skill dizinine yazılamaz. ` +
                `Eksik: ${missingReads.join(" + ")}. ` +
                `AGENTS.md kuralı: "Skill oluşturan/düzenleyen herkes → ÖNCE skill-creator/SKILL.md okur."`;

              deps.auditLog.record({
                sessionKey,
                agentId: deps.agentId,
                eventType: deps.gateMode === "block" ? "gate_blocked" : "gate_warned",
                severity: "medium",
                message,
                details: {
                  gate: "skill_read_before_write",
                  tool: event.toolName,
                  file: filePath,
                  skillName,
                  missingReads,
                  mode: deps.gateMode,
                },
              });

              if (deps.gateMode === "block") {
                deps.store.recordGateBlock(sessionKey, "skill_read_before_write");
                return blockAndMark(`⚠️ ${message}`);
              }
              deps.store.recordGateWarn(sessionKey, "skill_read_before_write");
            } else {
              deps.store.recordGatePass(sessionKey, "skill_read_before_write");
            }
          }
        }
      }

      // ── GATE 11b/13b: Shell write bypass prevention ──────
      // Gate 11 and 13 only check isFileWriteTool (Edit/Write tools).
      // Shell commands (echo > file, cat > file, cp, sed -i) bypass those gates.
      // This gate applies Gate 11 (skill) and Gate 13 (workspace root) rules to shell writes.

      if (isShellTool(event.toolName)) {
        const shellCmd = extractCommand(event.params);
        if (shellCmd) {
          const shellWrittenFiles = detectShellFileWrites(shellCmd);
          for (const writtenFile of shellWrittenFiles) {

            // Gate 11 check: shell writing to skills/ directory
            const skillMatch = writtenFile.match(/\/skills\/([^/]+)\//i);
            if (skillMatch) {
              const skillName = skillMatch[1];
              const missingReads: string[] = [];

              if (skillName !== "skill-creator") {
                const paths = [
                  "skills/skill-creator/SKILL.md",
                  `~/.openclaw/workspace/skills/skill-creator/SKILL.md`,
                  `${WORKSPACE_PREFIX}/skills/skill-creator/SKILL.md`,
                ];
                if (!paths.some(p => deps.store.hasReadFile(sessionKey, p))) {
                  missingReads.push("skills/skill-creator/SKILL.md");
                }
              }

              const skillPaths = [
                `skills/${skillName}/SKILL.md`,
                `~/.openclaw/workspace/skills/${skillName}/SKILL.md`,
                `${WORKSPACE_PREFIX}/skills/${skillName}/SKILL.md`,
              ];
              const isWritingSkillMd = /SKILL\.md$/i.test(writtenFile);
              if (!skillPaths.some(p => deps.store.hasReadFile(sessionKey, p)) && !isWritingSkillMd) {
                missingReads.push(`skills/${skillName}/SKILL.md`);
              }

              if (missingReads.length > 0) {
                const message =
                  `Shell üzerinden skill dizinine yazma tespit edildi: ${writtenFile}. ` +
                  `Eksik: ${missingReads.join(" + ")}. Gate 11 shell bypass engellendi.`;

                deps.auditLog.record({
                  sessionKey, agentId: deps.agentId,
                  eventType: deps.gateMode === "block" ? "gate_blocked" : "gate_warned",
                  severity: "high", message,
                  details: { gate: "skill_read_shell_bypass", tool: event.toolName, file: writtenFile, missingReads, mode: deps.gateMode },
                });

                if (deps.gateMode === "block") {
                  deps.store.recordGateBlock(sessionKey, "skill_read_shell_bypass");
                  return blockAndMark(`⚠️ ${message}`);
                }
                deps.store.recordGateWarn(sessionKey, "skill_read_shell_bypass");
              }
            }

            // Gate 13 check: shell writing to workspace root
            const rootPatterns = [
              /^~\/\.openclaw\/workspace\/([^/]+)$/,
              /\/\.openclaw\/workspace\/([^/]+)$/,
            ];
            for (const pattern of rootPatterns) {
              const rootMatch = writtenFile.match(pattern);
              if (rootMatch) {
                const fileName = rootMatch[1];
                if (!/\.md$/i.test(fileName)) {
                  const message =
                    `Shell üzerinden workspace root'a non-MD dosya yazımı tespit edildi: ${fileName}. ` +
                    `Gate 13 shell bypass engellendi. Doğru yer: scripts/, temp/`;

                  deps.auditLog.record({
                    sessionKey, agentId: deps.agentId,
                    eventType: deps.gateMode === "block" ? "gate_blocked" : "gate_warned",
                    severity: "medium", message,
                    details: { gate: "root_hygiene_shell_bypass", tool: event.toolName, file: writtenFile, mode: deps.gateMode },
                  });

                  if (deps.gateMode === "block") {
                    deps.store.recordGateBlock(sessionKey, "root_hygiene_shell_bypass");
                    return blockAndMark(`⚠️ ${message}`);
                  }
                  deps.store.recordGateWarn(sessionKey, "root_hygiene_shell_bypass");
                }
                break;
              }
            }
          }
        }
      }

      // ── GATE 12: sessions_spawn thinking enforcement ──
      // AGENTS.md: "Her sessions_spawn'da thinking parametresi ZORUNLU."
      // Block sessions_spawn calls that don't include a thinking parameter.

      if (event.toolName === "sessions_spawn") {
        const thinking = event.params.thinking as string | undefined;
        if (!thinking || thinking.trim() === "") {
          const message =
            `sessions_spawn'da thinking parametresi zorunlu. ` +
            `Spawn çağrısına thinking: "low" | "medium" | "high" ekle. ` +
            `AGENTS.md kuralı: "Her sessions_spawn'da thinking parametresi ZORUNLU."`;

          deps.auditLog.record({
            sessionKey,
            agentId: deps.agentId,
            eventType: deps.gateMode === "block" ? "gate_blocked" : "gate_warned",
            severity: "medium",
            message,
            details: {
              gate: "spawn_thinking",
              tool: event.toolName,
              mode: deps.gateMode,
            },
          });

          if (deps.gateMode === "block") {
            deps.store.recordGateBlock(sessionKey, "spawn_thinking");
            return blockAndMark(`⚠️ ${message}`);
          }
          deps.store.recordGateWarn(sessionKey, "spawn_thinking");
        } else {
          deps.store.recordGatePass(sessionKey, "spawn_thinking");
        }
      }

      // ── GATE 13: Workspace root file hygiene ──────────
      // AGENTS.md: "Root'a MD dışı dosya yazılmaz. Geçici → temp/, script → scripts/, görsel → temp/."
      // Block writing non-.md files directly to workspace root.

      if (isFileWriteTool(event.toolName)) {
        const filePath = extractFilePath(event.params);
        if (filePath) {
          // Normalize: detect workspace root writes
          // Workspace root patterns: ~/.openclaw/workspace/ or /Users/.../workspace/
          const workspaceRootPatterns = [
            /^~\/\.openclaw\/workspace\/([^/]+)$/,
            /\/\.openclaw\/workspace\/([^/]+)$/,
          ];

          for (const pattern of workspaceRootPatterns) {
            const match = filePath.match(pattern);
            if (match) {
              const fileName = match[1];
              const isMdFile = /\.md$/i.test(fileName);

              if (!isMdFile) {
                const message =
                  `Workspace root'a sadece .md dosya yazılabilir. ` +
                  `"${fileName}" dosyası workspace root'ta oluşturulamaz. ` +
                  `Doğru yer: script → scripts/, geçici → temp/, görsel → temp/. ` +
                  `AGENTS.md kuralı: "Root'a MD dışı dosya yazılmaz."`;

                deps.auditLog.record({
                  sessionKey,
                  agentId: deps.agentId,
                  eventType: deps.gateMode === "block" ? "gate_blocked" : "gate_warned",
                  severity: "medium",
                  message,
                  details: {
                    gate: "workspace_root_hygiene",
                    tool: event.toolName,
                    file: filePath,
                    fileName,
                    mode: deps.gateMode,
                  },
                });

                if (deps.gateMode === "block") {
                  deps.store.recordGateBlock(sessionKey, "workspace_root_hygiene");
                  return blockAndMark(`⚠️ ${message}`);
                }
                deps.store.recordGateWarn(sessionKey, "workspace_root_hygiene");
              } else {
                deps.store.recordGatePass(sessionKey, "workspace_root_hygiene");
              }
              break; // Only check first matching pattern
            }
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
