/**
 * Shared utilities for systematic-claw tools.
 * Follows lossless-claw's common.ts pattern.
 */
import type { AnyAgentTool as OpenClawAnyAgentTool } from "openclaw/plugin-sdk";

export type AnyAgentTool = OpenClawAnyAgentTool;

/** Render structured payloads as deterministic text tool results. */
export function jsonResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}

/** Generate a short unique ID for tasks and plans. */
export function generateId(prefix: string = "t"): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  return `${prefix}_${timestamp}_${random}`;
}

/** Status icons for task tree rendering. */
export const STATUS_ICONS: Record<string, string> = {
  pending: "⏳",
  in_progress: "🔄",
  completed: "✅",
  blocked: "🚫",
};

/** Render a task tree as a human-readable string. */
export function renderTaskTree(
  tasks: Array<{ id: string; content: string; status: string; children?: unknown[] }>,
  indent: number = 0,
): string {
  const lines: string[] = [];
  const prefix = indent === 0 ? "" : "│   ".repeat(indent - 1) + "├── ";

  for (const task of tasks) {
    const icon = STATUS_ICONS[task.status] || "❓";
    lines.push(`${prefix}[${icon}] ${task.id}: ${task.content}`);
    if (task.children && Array.isArray(task.children) && task.children.length > 0) {
      lines.push(renderTaskTree(task.children as typeof tasks, indent + 1));
    }
  }

  return lines.join("\n");
}

// ─── Related File Rules (shared across hooks) ───────────────

export type RelatedFileRule = {
  pattern: RegExp;
  requires: string[];
  description: string;
};

/** Paths excluded from related-file rules.
 *  Files under these directories are temporary/test artifacts — requiring
 *  STATE.md updates for them creates false positives. */
const RELATED_FILE_EXCLUDE_PATTERNS = [
  /^\/tmp\//i,
  /^\/var\/folders\//i,       // macOS temp
  /\/node_modules\//i,
  /^\/private\/tmp\//i,       // macOS /tmp symlink target
  /\/\.cache\//i,
  /\/dist\//i,
  /\/build\//i,
  /\/\.openclaw\/extensions\//i,  // Plugin source code — not workspace files
  /\/\.openclaw\/plugins\//i,     // Installed plugins
];

/** Check if a file path is in a temporary/excluded location. */
export function isExcludedFromRelatedFileRules(filePath: string): boolean {
  return RELATED_FILE_EXCLUDE_PATTERNS.some(p => p.test(filePath));
}

/** Rules: when a source file type is modified, certain metadata files should also be updated. */
export const RELATED_FILE_RULES: RelatedFileRule[] = [
  {
    pattern: /\.(py|ts|js|sh|go|rs|java|rb|tsx|jsx)$/i,
    requires: ["STATE.md"],
    description: "Kaynak kodu değiştiğinde STATE.md güncellenmeli",
  },
  {
    pattern: /openclaw\.json$/i,
    requires: ["TOOLS.md"],
    description: "Config değiştiğinde TOOLS.md güncellenmeli",
  },
  {
    pattern: /cron/i,
    requires: ["OPERATIONS.md"],
    description: "Cron değiştiğinde OPERATIONS.md güncellenmeli",
  },
  // Gate 9: Expanded SSoT propagation rules
  {
    pattern: /\/skills\/[^/]+\/SKILL\.md$/i,
    requires: ["TOOLS.md"],
    description: "Skill SKILL.md değiştiğinde TOOLS.md güncellenmeli",
  },
  {
    pattern: /SOUL\.md$/i,
    requires: ["MEMORY.md"],
    description: "SOUL.md değiştiğinde MEMORY.md'ye karar kaydı yazılmalı",
  },
  {
    pattern: /AGENTS\.md$/i,
    requires: ["MEMORY.md"],
    description: "AGENTS.md değiştiğinde MEMORY.md'ye karar kaydı yazılmalı",
  },
  {
    pattern: /CRON_INVENTORY\.md$/i,
    requires: ["OPERATIONS.md"],
    description: "CRON_INVENTORY değiştiğinde OPERATIONS.md kontrol edilmeli",
  },
  {
    pattern: /MEMORY\.md$/i,
    requires: ["STATE.md"],
    description: "MEMORY.md değiştiğinde STATE.md güncellenmeli",
  },
];

// ─── Propagation Rules (Phase 4B) ───────────────────────────

/** Auto-detected file dependency patterns. When sourcePattern is modified, dependents should be checked. */
export const PROPAGATION_RULES: Array<{
  sourcePattern: RegExp;
  dependentPattern: (sourcePath: string) => string[];
  description: string;
}> = [
  {
    // Source file → its test file
    sourcePattern: /^(.+)\.(ts|js|tsx|jsx|py|go|rs|java|rb)$/i,
    dependentPattern: (src) => {
      const base = src.replace(/\.[^.]+$/, "");
      const ext = src.match(/\.([^.]+)$/)?.[1] ?? "ts";
      return [
        `${base}.test.${ext}`,
        `${base}.spec.${ext}`,
        `${base}_test.${ext}`,
        `tests/${src.split("/").pop()?.replace(/\.[^.]+$/, "")}.test.${ext}`,
      ];
    },
    description: "Kaynak dosya değiştiğinde ilgili test dosyası da güncellenebilir",
  },
  {
    // Type/interface files → files that import them
    sourcePattern: /types?\.(ts|js|d\.ts)$/i,
    dependentPattern: () => ["**/*.ts", "**/*.tsx"], // Generic hint — actual check via dependency map
    description: "Tip tanımı değiştiğinde tüketiciler etkilenebilir",
  },
];

/** Load user-defined dependency map from a JSON file.
 *  Format: { "src/api.ts": ["src/types.ts", "tests/api.test.ts"], ... } */
export function loadDependencyMap(filePath: string | null): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!filePath) return map;
  try {
    const { readFileSync } = require("node:fs");
    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content) as Record<string, string[]>;
    for (const [source, deps] of Object.entries(parsed)) {
      if (Array.isArray(deps)) {
        map.set(source.toLowerCase(), deps.map(d => d.toLowerCase()));
      }
    }
  } catch (err) {
    // Distinguish file-not-found (acceptable) from parse errors (user config bug)
    const isNotFound = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
    if (!isNotFound) {
      console.warn(
        `[systematic-claw] Failed to load dependency map from "${filePath}": ${err instanceof Error ? err.message : err}. ` +
        `Propagation checks will use auto-detection only.`
      );
    }
  }
  return map;
}

/** Check which dependencies of a modified file have NOT been updated in this session. */
export function checkPropagation(
  modifiedFile: string,
  allModifiedFiles: string[],
  dependencyMap: Map<string, string[]>,
): string[] {
  const missing: string[] = [];
  const normalizedModified = new Set(allModifiedFiles.map(f => f.toLowerCase()));
  const normalizedFile = modifiedFile.toLowerCase();

  // Check user-defined dependency map first
  const deps = dependencyMap.get(normalizedFile);
  if (deps) {
    for (const dep of deps) {
      if (!normalizedModified.has(dep)) {
        missing.push(dep);
      }
    }
  }

  // Check auto-detected patterns (source → test file)
  for (const rule of PROPAGATION_RULES) {
    if (rule.sourcePattern.test(modifiedFile)) {
      const candidates = rule.dependentPattern(modifiedFile);
      for (const candidate of candidates) {
        // Only flag if the candidate file is a concrete path (not a glob)
        if (!candidate.includes("*")) {
          const normCandidate = candidate.toLowerCase();
          if (!normalizedModified.has(normCandidate)) {
            // Only add if not already in missing list
            if (!missing.includes(normCandidate)) {
              missing.push(normCandidate);
            }
          }
        }
      }
    }
  }

  return missing;
}

/** Extract file path from tool parameters — shared across hooks. */
export function extractFilePath(params: Record<string, unknown>): string | null {
  const candidates = ["file_path", "filePath", "path", "file", "target_file", "target", "filename"];
  for (const key of candidates) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

/** Render plan with current step highlighted. */
export function renderPlan(plan: {
  goal: string;
  steps: Array<{ index: number; content: string; completed: boolean }>;
  currentStep: number;
  phase: string;
}): string {
  const lines: string[] = [
    `📋 Plan: ${plan.goal}`,
    `   Durum: ${plan.phase}`,
    `   Adımlar:`,
  ];

  for (const step of plan.steps) {
    const isCurrent = step.index === plan.currentStep;
    const icon = step.completed ? "✅" : isCurrent ? "👉" : "⏳";
    lines.push(`   ${icon} ${step.index + 1}. ${step.content}`);
  }

  const completed = plan.steps.filter(s => s.completed).length;
  lines.push(`   İlerleme: ${completed}/${plan.steps.length}`);

  return lines.join("\n");
}
