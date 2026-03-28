/**
 * Layer 2 (partial) + Layer 3: after_tool_call hook.
 *
 * Responsibilities:
 * 1. Track which files were read (for read-before-edit gate)
 * 2. Track which files were modified (for completion check)
 * 3. Detect memory file writes (for memory enforcement)
 * 4. Track verification commands — test/build/lint (for verify-before-complete gate)
 * 5. Log tool errors
 */
import type { SessionStateStore } from "../store/session-state.js";
import type { AuditLog } from "../store/audit-log.js";
import { extractFilePath } from "../tools/common.js";

// Tool name patterns for file operations across different agents/providers
const FILE_READ_TOOLS = new Set([
  "file_read", "read_file", "Read", "cat", "read",
  "file_view", "view_file",
]);

const FILE_WRITE_TOOLS = new Set([
  "file_write", "write_file", "Write", "write",
  "file_edit", "edit_file", "Edit", "edit",
  "file_create", "create_file",
  "replace_in_file", "insert_code", "apply_diff",
]);

// Shell/bash execution tools across different agents
const SHELL_TOOLS = new Set([
  "Bash", "bash", "execute_command", "run_command",
  "shell", "terminal", "exec", "run_terminal_command",
]);

// Patterns that indicate a verification command (test, build, lint, typecheck)
const VERIFICATION_PATTERNS = [
  /\b(npm|npx|yarn|pnpm)\s+(test|run\s+test|run\s+lint|run\s+build|run\s+check|run\s+typecheck)\b/i,
  /\b(pytest|py\.test|python\s+-m\s+(pytest|unittest))\b/i,
  /\bgo\s+(test|vet|build)\b/i,
  /\bcargo\s+(test|check|clippy|build)\b/i,
  /\bmake\s+(test|check|build|lint|verify)\b/i,
  /\b(jest|vitest|mocha|tap|ava)\b/i,
  /\b(eslint|tsc|mypy|flake8|ruff|pylint|rubocop|biome|oxlint)\b/i,
  /\btsc\s+--noEmit\b/i,
  /\b(swift\s+test|dotnet\s+(test|build)|mvn\s+(test|verify)|gradle\s+(test|build|check))\b/i,
  // Node.js syntax check
  /\bnode\s+--check\b/i,
  // Explicit npx/yarn typecheck/build commands
  /\b(npx|yarn|pnpm)\s+tsc\b/i,
  // Python type checkers not already covered
  /\bpyright\b/i,
];

const MEMORY_FILE_PATTERNS = [
  /MEMORY\.md$/i,
  /REGRESSIONS\.md$/i,
  /STATE\.md$/i,
  /SHARED_INSIGHTS/i,
  /\/memory\//i,
  /\/temp\//i,
];

// Search/grep tools — when agent uses these, impact analysis is likely happening
const SEARCH_TOOLS = new Set([
  "Grep", "grep", "search", "ripgrep", "Glob", "glob",
  "find_files", "list_files", "file_search",
]);

// Skill file patterns — detect when agent reads/uses a skill file
const SKILL_FILE_PATTERNS = [
  /\/skills\//i,
  /\.skill\.md$/i,
  /skill[-_]?[\w]+\.md$/i,
];

export function isFileReadTool(toolName: string): boolean {
  return FILE_READ_TOOLS.has(toolName);
}

export function isFileWriteTool(toolName: string): boolean {
  return FILE_WRITE_TOOLS.has(toolName);
}

function isMemoryFile(filePath: string): boolean {
  return MEMORY_FILE_PATTERNS.some(pattern => pattern.test(filePath));
}

function isSkillFile(filePath: string): boolean {
  return SKILL_FILE_PATTERNS.some(pattern => pattern.test(filePath));
}

/** Classify a tool call into a high-level operation type for pattern detection. */
function classifyOperation(toolName: string, params: Record<string, unknown>): string {
  if (isFileReadTool(toolName)) return "read";
  if (isFileWriteTool(toolName)) return "edit";
  if (isShellTool(toolName)) {
    const cmd = extractCommand(params);
    if (cmd && isVerificationCommand(cmd)) return "verify";
    return "shell";
  }
  // Plugin tools
  if (toolName === "task_tracker") return "task";
  if (toolName === "plan_mode") return "plan";
  if (toolName === "debug_tracker") return "debug";
  if (toolName === "quality_checklist") return "quality";
  return "other";
}

function extractCommand(params: Record<string, unknown>): string | null {
  const candidates = ["command", "cmd", "input", "script", "code"];
  for (const key of candidates) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

export function isVerificationCommand(command: string): boolean {
  return VERIFICATION_PATTERNS.some(pattern => pattern.test(command));
}

export function isShellTool(toolName: string): boolean {
  return SHELL_TOOLS.has(toolName);
}

// ── Shell File Write Detection ──────────────────────────
// Detects file writes through shell commands (redirect, cp, sed -i, tee, cat >, heredoc)
// Returns list of detected file paths (best-effort — shell is too flexible for perfect detection)

const SHELL_WRITE_PATTERNS: Array<{ pattern: RegExp; fileGroup: number }> = [
  // Redirect: command > file, command >> file
  { pattern: /[12]?\s*>{1,2}\s*["']?([^\s"'|;&]+)["']?/g, fileGroup: 1 },
  // tee: command | tee file, command | tee -a file
  { pattern: /\btee\s+(?:-a\s+)?["']?([^\s"'|;&]+)["']?/g, fileGroup: 1 },
  // cp: cp source dest (capture dest = last arg)
  { pattern: /\bcp\s+(?:-[a-zA-Z]+\s+)*["']?[^\s"']+["']?\s+["']?([^\s"'|;&]+)["']?/g, fileGroup: 1 },
  // mv: mv source dest
  { pattern: /\bmv\s+(?:-[a-zA-Z]+\s+)*["']?[^\s"']+["']?\s+["']?([^\s"'|;&]+)["']?/g, fileGroup: 1 },
  // sed -i: sed -i 's/old/new/' file
  { pattern: /\bsed\s+-i(?:\s*['"][^'"]*['"])?\s+(?:-e\s+)?['"]?[^\s]*['"]?\s+["']?([^\s"'|;&]+)["']?/g, fileGroup: 1 },
  // cat > file << EOF (heredoc)
  { pattern: /\bcat\s*>\s*["']?([^\s"'|;&<]+)["']?/g, fileGroup: 1 },
];

function detectShellFileWrites(command: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();

  for (const { pattern, fileGroup } of SHELL_WRITE_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(command)) !== null) {
      const filePath = match[fileGroup];
      if (filePath && !seen.has(filePath) && looksLikeFilePath(filePath)) {
        seen.add(filePath);
        files.push(filePath);
      }
    }
  }

  return files;
}

function looksLikeFilePath(s: string): boolean {
  // Filter out obvious non-file things: flags, /dev/null, env vars
  if (s.startsWith("-") || s === "/dev/null" || s === "/dev/stderr" || s === "/dev/stdout") return false;
  if (s.startsWith("$") || s.startsWith("`")) return false;
  // Must have at least one path separator or file extension
  return s.includes("/") || s.includes(".");
}

export function handleAfterToolCall(deps: {
  store: SessionStateStore;
  auditLog: AuditLog;
  sessionKey?: string;
  agentId?: string;
}) {
  return (event: {
    toolName: string;
    params: Record<string, unknown>;
    result?: unknown;
    error?: string;
    durationMs?: number;
  }) => {
    const sessionKey = deps.sessionKey ?? "unknown";

    try {
      deps.store.ensureSession(sessionKey, deps.agentId);

      // If this tool call was blocked by before_tool_call (gate), skip all file tracking.
      // OpenClaw may fire after_tool_call for blocked calls without setting event.error,
      // which would cause addModifiedFile → invalidateVerification → counter inflation.
      if (deps.store.consumeGateBlock(sessionKey)) {
        // Only record the tool call for doom loop detection (as errored/blocked)
        deps.store.recordToolCall(sessionKey, event.toolName, event.params, true);
        return;
      }

      const filePath = extractFilePath(event.params);

      // Track file reads
      if (isFileReadTool(event.toolName) && filePath && !event.error) {
        deps.store.addReadFile(sessionKey, filePath, event.toolName);

        // Detect skill file access
        if (isSkillFile(filePath)) {
          deps.store.recordSkillAccess(sessionKey, filePath);
        }

        // Gate 9: Detect SSOT_REGISTRY.md read
        if (/SSOT_REGISTRY\.md$/i.test(filePath)) {
          deps.store.recordSsotRegistryRead(sessionKey);
        }
      }

      // Gate 10: Track memory_search calls
      if (event.toolName === "memory_search" && !event.error) {
        deps.store.recordMemorySearch(sessionKey);
      }

      // Gate 10: Also track lcm_grep / lcm_expand_query as memory recall
      if ((event.toolName === "lcm_grep" || event.toolName === "lcm_expand_query" || event.toolName === "lcm_expand") && !event.error) {
        deps.store.recordMemorySearch(sessionKey);
      }

      // Track operation type for repetitive pattern detection
      deps.store.recordOperationType(sessionKey, classifyOperation(event.toolName, event.params));

      // Track file writes/edits
      if (isFileWriteTool(event.toolName) && filePath && !event.error) {
        deps.store.addModifiedFile(sessionKey, filePath, event.toolName);
        // Note: addModifiedFile() already calls invalidateVerification() internally —
        // no need to call it again here (was causing double-increment of writesSinceVerification)

        // Implicit read: When a file is CREATED (Write/write_file/create_file — NOT Edit),
        // the agent defined the content itself, so it implicitly "knows" the file.
        // Record as read to prevent false Gate 1 blocks on subsequent edits to agent-created files.
        const FILE_CREATE_TOOLS = new Set([
          "file_write", "write_file", "Write", "write",
          "file_create", "create_file",
        ]);
        if (FILE_CREATE_TOOLS.has(event.toolName)) {
          deps.store.addReadFile(sessionKey, filePath, `${event.toolName}:implicit`);
        }

        // Detect memory file writes
        if (isMemoryFile(filePath)) {
          deps.store.setMemoryWritten(sessionKey);
        }
      }

      // Track search/grep tools for impact analysis detection
      if (SEARCH_TOOLS.has(event.toolName) && !event.error) {
        deps.store.recordSearch(sessionKey);
      }

      // Track verification commands (test/build/lint via shell tools)
      // Records timestamp in-memory for Gate 3 (verify-before-complete)
      if (isShellTool(event.toolName) && !event.error) {
        const command = extractCommand(event.params);
        if (command) {
          if (isVerificationCommand(command)) {
            deps.store.recordVerification(sessionKey);
          }

          // Detect search commands in shell (grep, rg, find, ag, ack) for impact analysis
          if (/\b(grep|rg|find|ag|ack|ripgrep)\b/.test(command)) {
            deps.store.recordSearch(sessionKey);
          }

          // Detect git commands for git hygiene tracking
          if (/\bgit\s+(status|add|commit|diff|log|stash|push)\b/.test(command)) {
            deps.store.recordGitCommand(sessionKey);
          }

          // Shell write detection: detect file writes via redirects, cp, sed -i, etc.
          const shellWrittenFiles = detectShellFileWrites(command);
          for (const writtenFile of shellWrittenFiles) {
            deps.store.addModifiedFile(sessionKey, writtenFile, `${event.toolName}:shell_write`);
            // addModifiedFile() calls invalidateVerification() internally — no redundant call needed

            if (isMemoryFile(writtenFile)) {
              deps.store.setMemoryWritten(sessionKey);
            }
          }

          if (shellWrittenFiles.length > 0) {
            deps.auditLog.record({
              sessionKey,
              agentId: deps.agentId,
              eventType: "gate_warned",
              severity: "high",
              message: `Shell üzerinden dosya yazımı tespit edildi: ${shellWrittenFiles.join(", ")}`,
              details: {
                gate: "shell_write",
                tool: event.toolName,
                command,
                detectedFiles: shellWrittenFiles,
                warning: "Edit/Write tool yerine shell kullanıldı — gate bypass riski",
              },
            });
          }
        }
      }

      // Track ALL tool calls for doom loop detection (including errors — error-aware detection)
      deps.store.recordToolCall(sessionKey, event.toolName, event.params, !!event.error);

      // Log errors
      if (event.error) {
        deps.auditLog.record({
          sessionKey,
          agentId: deps.agentId,
          eventType: "tool_error",
          severity: "medium",
          message: `Tool error: ${event.toolName} — ${event.error}`,
          details: {
            tool: event.toolName,
            params: event.params,
            error: event.error,
            durationMs: event.durationMs,
          },
        });
      }
    } catch (err) {
      // Non-critical — don't fail the hook, but log for debugging
      console.warn("[systematic-claw] tool-verify error:", err instanceof Error ? err.message : err);
    }
  };
}
