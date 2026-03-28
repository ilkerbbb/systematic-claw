/**
 * Scaffold — First-run workspace file creation + onboarding.
 *
 * When systematic-claw is installed on a fresh workspace, the gate system
 * depends on certain files (STATE.md, MEMORY.md, SYSTEM/SSOT_REGISTRY.md).
 * Without them, gates either block meaninglessly or silently skip.
 *
 * This module:
 * 1. Detects missing workspace files
 * 2. Creates minimal templates (scaffold)
 * 3. Generates an onboarding message for the first session
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

// ─── Scaffold File Templates ─────────────────────────────────

export interface ScaffoldFile {
  /** Relative path from workspace root */
  relativePath: string;
  /** Purpose — shown to user during onboarding */
  purpose: string;
  /** Which gate(s) depend on this file */
  gates: string[];
  /** Template content */
  template: string;
}

const SCAFFOLD_FILES: ScaffoldFile[] = [
  {
    relativePath: "STATE.md",
    purpose: "Track active tasks, completed work, and blockers. The plugin checks this file to ensure you update task status after code changes.",
    gates: ["Gate 3c (related-file verification)"],
    template: `# STATE.md — Task & Progress Tracker

> Track what you're working on, what's done, and what's blocked.
> The Systematic Engine plugin checks this file when you modify code —
> it reminds you to update task status alongside code changes.

## Active Tasks

| Task | Status | Updated |
|------|--------|---------|
| — | — | — |

## Recently Completed

| Task | Completed |
|------|-----------|
| — | — |

## Blocked / Waiting

| Task | Blocker | Since |
|------|---------|-------|
| — | — | — |
`,
  },
  {
    relativePath: "MEMORY.md",
    purpose: "Record important decisions, learnings, and architectural choices. The plugin ensures this file is updated when you change core system files.",
    gates: ["Gate 3c (related-file verification)"],
    template: `# MEMORY.md — Decisions & Learnings

> Record important decisions with context and rationale.
> When you modify core files (SOUL.md, AGENTS.md, config), the plugin
> reminds you to log the decision here so future sessions have context.

## Decisions

<!-- Format: ## Decision Title [YYYY-MM-DD] #tag
     What was decided, why, and what alternatives were considered. -->

## Learnings

<!-- Format: ## Learning [YYYY-MM-DD] #learn
     What went wrong/right and what to do differently next time. -->
`,
  },
  {
    relativePath: "SYSTEM/SSOT_REGISTRY.md",
    purpose: "Map which file is the single source of truth for each type of information. The plugin checks this before creating complex plans to prevent scattered/duplicate information.",
    gates: ["Gate 9 (SSoT propagation)"],
    template: `# SSOT_REGISTRY.md — Single Source of Truth Map

> Map each type of information to its ONE canonical source.
> The Systematic Engine checks this file before creating plans with 4+ steps,
> ensuring you consider which files will be affected by changes.

## Information Sources

| Information | Source File | Notes |
|-------------|------------|-------|
| Task status | STATE.md | Update after completing work |
| Decisions & learnings | MEMORY.md | Log why, not just what |
| Configuration | openclaw.json | Never duplicate config values |

## Rules

1. **One source per fact.** If the same info exists in two places, one will drift.
2. **Reference, don't copy.** Point to the source file instead of duplicating data.
3. **Before changing:** Ask "what else references this?" — check this registry.
`,
  },
];

// ─── Scaffold Logic ──────────────────────────────────────────

export interface ScaffoldResult {
  /** Files that were created during this scaffold run */
  created: string[];
  /** Files that already existed (skipped) */
  skipped: string[];
  /** Whether this is the first run (at least one file was created) */
  isFirstRun: boolean;
}

/**
 * Check workspace for missing scaffold files and create them.
 * Idempotent: only creates files that don't exist.
 */
export function runScaffold(workspaceRoot: string): ScaffoldResult {
  const created: string[] = [];
  const skipped: string[] = [];

  // Pre-check: if workspace already has ANY of the scaffold files (or common
  // variants like CORE/STATE.md), this is an existing workspace — don't scaffold
  // partial files into it. Only scaffold into truly empty workspaces.
  const existingCount = SCAFFOLD_FILES.filter(f => {
    const fullPath = join(workspaceRoot, f.relativePath);
    if (existsSync(fullPath)) return true;
    // Check common alternative locations (e.g., CORE/STATE.md instead of STATE.md)
    if (f.relativePath === "STATE.md" && existsSync(join(workspaceRoot, "CORE/STATE.md"))) return true;
    return false;
  }).length;

  // If any scaffold file (or variant) already exists, skip all scaffolding.
  // This prevents creating orphan files in an established workspace.
  if (existingCount > 0) {
    for (const file of SCAFFOLD_FILES) {
      skipped.push(file.relativePath);
    }
    return { created, skipped, isFirstRun: false };
  }

  // Truly fresh workspace — create all scaffold files
  for (const file of SCAFFOLD_FILES) {
    const fullPath = join(workspaceRoot, file.relativePath);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(fullPath, file.template, "utf-8");
    created.push(file.relativePath);
  }

  return {
    created,
    skipped,
    isFirstRun: created.length > 0,
  };
}

// ─── Onboarding Message ──────────────────────────────────────

/**
 * Build the onboarding message that introduces scaffold files to the user.
 * Only called when isFirstRun is true.
 */
export function buildOnboardingMessage(result: ScaffoldResult): string {
  if (!result.isFirstRun) return "";

  const lines: string[] = [
    "## 🚀 Systematic Engine — First Run Setup",
    "",
    "Welcome! I've set up your workspace with essential tracking files:",
    "",
  ];

  for (const file of SCAFFOLD_FILES) {
    if (result.created.includes(file.relativePath)) {
      lines.push(`### 📄 \`${file.relativePath}\``);
      lines.push(file.purpose);
      lines.push(`*Used by: ${file.gates.join(", ")}*`);
      lines.push("");
    }
  }

  lines.push("### How it works");
  lines.push("");
  lines.push("The Systematic Engine enforces good habits through **gates** — checks that run before your tool calls:");
  lines.push("");
  lines.push("- **Read before edit** — Can't edit a file you haven't read first");
  lines.push("- **Plan before create** — Complex tasks need a plan before coding");
  lines.push("- **Verify before complete** — Must run tests before marking tasks done");
  lines.push("- **Update tracking files** — Code changes should be reflected in STATE.md");
  lines.push("");
  lines.push("These files are yours to customize. The templates are starting points — adapt them to your workflow.");
  lines.push("");
  lines.push("> 💡 Tip: Run `/systematic` anytime to see gate activity and session stats.");

  return lines.join("\n");
}

/**
 * Get the list of scaffold files for external reference.
 */
export function getScaffoldFiles(): readonly ScaffoldFile[] {
  return SCAFFOLD_FILES;
}
