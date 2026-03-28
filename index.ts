/**
 * systematic-claw — Systematic thinking enforcement plugin for OpenClaw.
 *
 * Brings Claude Code's structured methodology (TodoWrite, Plan Mode,
 * verification-before-completion, hard gates) to any OpenClaw agent.
 *
 * Architecture: 3-layer enforcement
 *   Layer 1 (GUIDE):   before_prompt_build — workflow detection + state injection
 *   Layer 2 (ENFORCE): before_tool_call — hard gates (read-before-edit, plan-before-create)
 *                       task_tracker + plan_mode tools
 *   Layer 3 (AUDIT):   after_tool_call — file tracking
 *                       agent_end — completion checklist
 *                       /systematic command — dashboard
 */
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getConnection, closeConnection } from "./src/store/connection.js";
import { migrateDatabase } from "./src/store/schema.js";
import { SessionStateStore } from "./src/store/session-state.js";
import { AuditLog } from "./src/store/audit-log.js";
import { buildPromptContext, type GateVerbosity } from "./src/hooks/prompt-inject.js";
import { handleAfterToolCall } from "./src/hooks/tool-verify.js";
import { handleBeforeToolCall, type GateMode } from "./src/hooks/hard-gates.js";
import { handleAgentEnd } from "./src/hooks/completion-check.js";
import { createTaskTrackerTool } from "./src/tools/task-tracker.js";
import { createPlanModeTool } from "./src/tools/plan-mode.js";
import { createDebugTrackerTool } from "./src/tools/debug-tracker.js";
import { createQualityChecklistTool } from "./src/tools/quality-checklist.js";
import { loadDependencyMap } from "./src/tools/common.js";

// ─── Default Dangerous Commands ──────────────────────────────
// Patterns for irreversible commands that should be hard-blocked.
// Users can override via config. These are regex pattern strings.
const DEFAULT_DANGEROUS_COMMANDS: string[] = [
  // Social media — irreversible public posts
  "\\bbird\\s+tweet\\b",
  "\\btoot\\s+(post|send)\\b",
  // Email — irreversible sends
  "\\bgog\\s+gmail\\s+send\\b",
  "\\bhimalaya\\s+.*send\\b",
  "\\bmutt\\s+-s\\b",
  "\\bmail\\s+-s\\b",
  "\\bsendmail\\b",
  // Destructive filesystem operations
  "\\brm\\s+(-[rRf]+\\s+)*(/|~|\\.\\./)",  // rm -rf on root, home, or parent
  "\\brm\\s+(-[rRf]+\\s+)*.*\\.openclaw/workspace",  // rm on workspace files — use trash instead
  "\\brm\\s+(-[rRf]+\\s+)*.*workspace-",  // rm on agent workspace files
  "\\bmkfs\\b",
  "\\bdd\\s+of=/dev/",
  // Git destructive operations
  "\\bgit\\s+push\\s+.*--force\\b",
  "\\bgit\\s+reset\\s+--hard\\s+origin/",
  // Cloud/infra — irreversible deployments
  "\\bkubectl\\s+delete\\b",
  "\\bterraform\\s+destroy\\b",
  "\\baws\\s+.*delete\\b",
  // Payment/financial
  "\\bcurl\\s+.*-X\\s+(POST|PUT|DELETE)\\s+.*pay",
];

// ─── Config Resolution ───────────────────────────────────────

type SystematicConfig = {
  enabled: boolean;
  gateMode: GateMode;
  taskTrackerEnabled: boolean;
  planModeEnabled: boolean;
  completionCheckEnabled: boolean;
  memoryEnforcementEnabled: boolean;
  debugTrackerEnabled: boolean;
  workflowDetectionEnabled: boolean;
  dbPath: string;
  // Phase 4: New features
  dangerousCommands: string[];          // Regex patterns for irreversible commands (hard block)
  bootstrapSizeWarnKB: number;          // Warn when bootstrap file exceeds this size (KB)
  bootstrapSizeBlockKB: number;         // Block when bootstrap file exceeds this size (KB)
  propagationEnabled: boolean;          // Enable dependency propagation checking
  dependencyMapPath: string | null;     // Path to dependency map JSON (null = use RELATED_FILE_RULES only)
  gateVerbosity: GateVerbosity;         // Gate annotation visibility: silent (off), summary (1-line), verbose (per-gate)
};

function resolveConfig(
  raw: Record<string, unknown> | undefined,
  fallbackDir: string,
): SystematicConfig {
  const r = raw ?? {};
  return {
    enabled: r.enabled !== false, // enabled by default
    gateMode: (r.gateMode === "warn" || r.gateMode === "block") ? r.gateMode : "block",
    taskTrackerEnabled: r.taskTrackerEnabled !== false,
    planModeEnabled: r.planModeEnabled !== false,
    completionCheckEnabled: r.completionCheckEnabled !== false,
    memoryEnforcementEnabled: r.memoryEnforcementEnabled !== false, // on by default
    debugTrackerEnabled: r.debugTrackerEnabled !== false, // on by default
    workflowDetectionEnabled: r.workflowDetectionEnabled !== false,
    dbPath: (r.dbPath as string) || join(fallbackDir, "systematic-claw.db"),
    // Phase 4 defaults
    dangerousCommands: Array.isArray(r.dangerousCommands)
      ? (r.dangerousCommands as string[])
      : DEFAULT_DANGEROUS_COMMANDS,
    bootstrapSizeWarnKB: typeof r.bootstrapSizeWarnKB === "number" ? r.bootstrapSizeWarnKB : 28,
    bootstrapSizeBlockKB: typeof r.bootstrapSizeBlockKB === "number" ? r.bootstrapSizeBlockKB : 35,
    propagationEnabled: r.propagationEnabled !== false,
    dependencyMapPath: typeof r.dependencyMapPath === "string" ? r.dependencyMapPath : null,
    gateVerbosity: (r.gateVerbosity === "silent" || r.gateVerbosity === "summary" || r.gateVerbosity === "verbose")
      ? r.gateVerbosity : "summary",
  };
}

// ─── Tool Policy Check ───────────────────────────────────────

function checkToolPolicy(api: OpenClawPluginApi): void {
  try {
    const config = api.config;
    // Check all agents for tool policy coverage
    const agents = (config as Record<string, unknown>)?.agents as { list?: Array<{ tools?: { allow?: string[]; alsoAllow?: string[] } }> } | undefined;
    if (!agents?.list) return;

    const pluginToolNames = ["task_tracker", "plan_mode", "debug_tracker", "quality_checklist"];
    let anyMissing = false;

    for (const agent of agents.list) {
      const policy = agent?.tools;
      if (!policy) continue;

      const allowed = [...(policy.allow ?? []), ...(policy.alsoAllow ?? [])];
      const normalizedAllowed = allowed.map(t => t.toLowerCase().trim());

      // Check if group:plugins or individual tool names are present
      const hasGroupPlugins = normalizedAllowed.includes("group:plugins");
      const hasPluginId = normalizedAllowed.includes("systematic-claw");

      if (hasGroupPlugins || hasPluginId) continue;

      // Check individual tools
      const missing = pluginToolNames.filter(t => !normalizedAllowed.includes(t));
      if (missing.length > 0) {
        anyMissing = true;
      }
    }

    if (anyMissing) {
      api.logger.warn(
        `[systematic-claw] ⚠️ Plugin tool'ları (task_tracker, plan_mode, debug_tracker) agent'ların tool policy'sinde bulunamadı. ` +
        `Hook'lar (gate'ler, file tracking) çalışır ama tool'lar agent'a görünmez. ` +
        `Düzeltme: Agent config'da tools.alsoAllow'a "group:plugins" ekleyin veya /systematic setup komutunu çalıştırın.`
      );
    }
  } catch (err) {
    // Non-critical — don't block plugin load, but log for debugging
    api.logger.warn(`[systematic-claw] Tool policy check error: ${err instanceof Error ? err.message : err}`);
  }
}

// ─── Plugin Definition ───────────────────────────────────────

const systematicPlugin = {
  id: "systematic-claw",
  name: "Systematic Engine",
  description:
    "Brings Claude Code's structured methodology to OpenClaw agents — " +
    "task tracking, plan mode, hard gates, completion verification, and audit logging",

  configSchema: {
    parse(value: unknown) {
      const raw =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      // Use home dir as fallback for DB path
      const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
      return resolveConfig(raw, join(home, ".openclaw"));
    },
  },

  register(api: OpenClawPluginApi) {
    // Always resolve config through our defaults — api.pluginConfig may not include all fields
    const rawConfig = api.pluginConfig && typeof api.pluginConfig === "object"
      ? api.pluginConfig as Record<string, unknown>
      : undefined;
    const resolved = resolveConfig(rawConfig, join(
      process.env.HOME || "/tmp",
      ".openclaw",
    ));

    if (!resolved.enabled) {
      api.logger.info("[systematic-claw] Plugin disabled via config");
      return;
    }

    // ── Tool Policy Check ────────────────────────
    // Plugin tools (task_tracker, plan_mode, debug_tracker) need to be in agent's
    // tool allowlist. The easiest way is adding "group:plugins" to alsoAllow.
    checkToolPolicy(api);

    // ── Initialize database ────────────────────────

    let db: ReturnType<typeof getConnection>;
    try {
      db = getConnection(resolved.dbPath);
      migrateDatabase(db);
      api.logger.info(`[systematic-claw] Database initialized at ${resolved.dbPath}`);
    } catch (error) {
      api.logger.error(
        `[systematic-claw] Failed to initialize database: ${error instanceof Error ? error.message : error}`
      );
      return;
    }

    const store = new SessionStateStore(db);
    const auditLog = new AuditLog(db);

    // Load user-defined dependency map (if configured)
    const dependencyMap = resolved.propagationEnabled
      ? loadDependencyMap(resolved.dependencyMapPath)
      : new Map<string, string[]>();

    // ── Layer 1: GUIDE — before_prompt_build ───────

    api.on("before_prompt_build", async (event, ctx) => {
      try {
        const result = buildPromptContext({
          prompt: event.prompt,
          sessionStore: store,
          auditLog,
          sessionKey: ctx.sessionKey,
          workflowDetectionEnabled: resolved.workflowDetectionEnabled,
          gateVerbosity: resolved.gateVerbosity,
        });
        return result;
      } catch (error) {
        api.logger.warn(
          `[systematic-claw] before_prompt_build error: ${error instanceof Error ? error.message : error}`
        );
        return undefined;
      }
    }, { priority: 50 });

    // ── Layer 2: ENFORCE — Tools ───────────────────

    if (resolved.taskTrackerEnabled) {
      api.registerTool((ctx) =>
        createTaskTrackerTool({
          store,
          auditLog,
          sessionKey: ctx.sessionKey,
          gateMode: resolved.gateMode,
        }),
      );
      api.logger.info("[systematic-claw] task_tracker tool registered");
    }

    if (resolved.planModeEnabled) {
      api.registerTool((ctx) =>
        createPlanModeTool({
          store,
          auditLog,
          sessionKey: ctx.sessionKey,
          gateMode: resolved.gateMode,
          dependencyMap,
        }),
      );
      api.logger.info("[systematic-claw] plan_mode tool registered");
    }

    // Debug tracker — 4-phase systematic debugging protocol
    if (resolved.debugTrackerEnabled) {
      api.registerTool((ctx) =>
        createDebugTrackerTool({
          store,
          auditLog,
          sessionKey: ctx.sessionKey,
        }),
      );
      api.logger.info("[systematic-claw] debug_tracker tool registered");
    }

    // Quality checklist — self-review before completion
    api.registerTool((ctx) =>
      createQualityChecklistTool({
        store,
        auditLog,
        sessionKey: ctx.sessionKey,
      }),
    );
    api.logger.info("[systematic-claw] quality_checklist tool registered");

    // ── Layer 2: ENFORCE — Hard Gates ──────────────

    api.on("before_tool_call", async (event, ctx) => {
      try {
        const handler = handleBeforeToolCall({
          store,
          auditLog,
          gateMode: resolved.gateMode,
          planModeEnabled: resolved.planModeEnabled,
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
          // Phase 4
          dangerousCommands: resolved.dangerousCommands,
          bootstrapSizeWarnKB: resolved.bootstrapSizeWarnKB,
          bootstrapSizeBlockKB: resolved.bootstrapSizeBlockKB,
        });
        return handler(event);
      } catch (error) {
        api.logger.warn(
          `[systematic-claw] before_tool_call error: ${error instanceof Error ? error.message : error}`
        );
        return undefined;
      }
    }, { priority: 50 });

    // ── Layer 3: AUDIT — File Tracking ─────────────

    api.on("after_tool_call", async (event, ctx) => {
      try {
        const handler = handleAfterToolCall({
          store,
          auditLog,
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
        });
        handler(event);
      } catch (error) {
        api.logger.warn(
          `[systematic-claw] after_tool_call error: ${error instanceof Error ? error.message : error}`
        );
      }
    }, { priority: 50 });

    // ── Layer 3: AUDIT — Completion Check ──────────

    api.on("agent_end", async (event, ctx) => {
      try {
        const handler = handleAgentEnd({
          store,
          auditLog,
          completionCheckEnabled: resolved.completionCheckEnabled,
          memoryEnforcementEnabled: resolved.memoryEnforcementEnabled,
        });
        handler(event, ctx);
      } catch (error) {
        api.logger.warn(
          `[systematic-claw] agent_end error: ${error instanceof Error ? error.message : error}`
        );
      }
    }, { priority: 50 });

    // ── Session tracking ───────────────────────────

    api.on("session_start", async (_event, ctx) => {
      try {
        const sessionKey = ctx.sessionKey ?? "unknown";
        store.ensureSession(sessionKey, ctx.agentId);
        // Reset session-scoped tracking for fresh start
        store.resetSessionTracking(sessionKey);
        auditLog.record({
          sessionKey,
          agentId: ctx.agentId,
          eventType: "session_start",
          severity: "info",
          message: "Session started",
        });
      } catch (err) {
        api.logger.warn(`[systematic-claw] session_start error: ${err instanceof Error ? err.message : err}`);
      }
    }, { priority: 50 });

    // ── /systematic command ────────────────────────

    api.registerCommand({
      name: "systematic",
      description: "Systematic Engine durumu ve istatistikleri",
      acceptsArgs: true,
      handler: async () => {
        try {
          const stats = auditLog.getStats();

          const lines = [
            `📊 **Systematic Engine v0.1.0**`,
            ``,
            `**Config:**`,
            `  Gate mode: ${resolved.gateMode}`,
            `  Task tracker: ${resolved.taskTrackerEnabled ? "✅" : "❌"}`,
            `  Plan mode: ${resolved.planModeEnabled ? "✅" : "❌"}`,
            `  Completion check: ${resolved.completionCheckEnabled ? "✅" : "❌"}`,
            `  Memory enforcement: ${resolved.memoryEnforcementEnabled ? "✅" : "❌"}`,
            `  Workflow detection: ${resolved.workflowDetectionEnabled ? "✅" : "❌"}`,
            ``,
            `**Son 24 saat:**`,
            `  Tamamlanan session: ${stats.last24h.completed}`,
            `  Sorunlu tamamlanma: ${stats.last24h.withIssues}`,
            `  Engellenen tool çağrısı: ${stats.last24h.blockedCalls}`,
            `  Uyarılar: ${stats.last24h.warnedCalls}`,
            `  Hatalar: ${stats.last24h.errors}`,
            ``,
            `**Son 7 gün:**`,
            `  Toplam session: ${stats.last7d.totalSessions}`,
            `  Tamamlanma oranı: %${stats.last7d.completionRate}`,
            `  En sık sorun: ${stats.last7d.topIssue}`,
          ];

          return { text: lines.join("\n") };
        } catch (error) {
          return {
            text: `❌ Systematic Engine hatası: ${error instanceof Error ? error.message : error}`,
          };
        }
      },
    });

    // ── Service: cleanup on gateway stop ───────────

    api.registerService({
      id: "systematic-audit",
      async start(ctx) {
        ctx.logger.info("[systematic-claw] Audit service started");
      },
      async stop() {
        closeConnection(resolved.dbPath);
      },
    });

    api.logger.info(
      `[systematic-claw] Plugin loaded (gate=${resolved.gateMode}, tasks=${resolved.taskTrackerEnabled}, plan=${resolved.planModeEnabled}, completion=${resolved.completionCheckEnabled})`
    );
  },
};

export default systematicPlugin;
