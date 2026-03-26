# systematic-claw

**Systematic thinking enforcement plugin for [OpenClaw](https://openclaw.ai).**

Brings Claude Code's structured methodology — task tracking, plan mode, hard gates, quality checklists, and audit logging — to any OpenClaw agent.

> Agents are powerful but undisciplined. They skip verification, forget to update docs, and declare "done" prematurely. This plugin adds structural discipline without requiring strategic thinking.

## What It Does

```
Layer 1 (GUIDE)    → Workflow detection + context injection into every prompt
Layer 2 (ENFORCE)  → Hard gates that block unsafe/incomplete actions
Layer 3 (AUDIT)    → File tracking, completion checks, quality reviews
```

### Tools (4)

| Tool | Purpose |
|------|---------|
| `task_tracker` | Hierarchical task management with checkpoint/rollback |
| `plan_mode` | Plan → approve → execute → verify workflow |
| `debug_tracker` | 4-phase systematic debugging (evidence → hypothesize → test → resolve) |
| `quality_checklist` | Self-review before completion — verification, edge cases, regression, gaps |

### Hard Gates (6)

| Gate | What It Blocks |
|------|---------------|
| Read-before-Edit | Editing a file you haven't read yet |
| Plan-before-Create | Creating new files without an active plan |
| Dangerous Commands | Irreversible operations (social media posts, `rm -rf /`, `terraform destroy`, etc.) |
| Bootstrap Size | Oversized bootstrap/config files that waste context |
| Workflow Chain | Completing tasks without verification + related file updates |
| Quality Review | Ending sessions without self-review when files were modified |

### Hooks (4)

| Event | Action |
|-------|--------|
| `before_prompt_build` | Injects workflow guidance, active plan/task state, periodic warnings |
| `before_tool_call` | Enforces hard gates |
| `after_tool_call` | Tracks file reads/writes, detects verification commands |
| `agent_end` | Completion checklist (open tasks, unverified changes, missing memory) |

## Installation

```bash
# Clone to OpenClaw extensions directory
cd ~/.openclaw/extensions
git clone https://github.com/ilkerbasaran/systematic-claw.git
cd systematic-claw
npm install
```

Then add to your `openclaw.json`:

```json
{
  "extensions": ["~/.openclaw/extensions/systematic-claw"]
}
```

**Important:** Add `"group:plugins"` to your agent's tool allowlist so plugin tools are visible:

```json
{
  "agents": {
    "list": [{
      "tools": {
        "alsoAllow": ["group:plugins"]
      }
    }]
  }
}
```

## Configuration

All settings have sensible defaults — the plugin works out of the box with zero config.

```json
{
  "extensions": {
    "systematic-claw": {
      "enabled": true,
      "gateMode": "block",
      "taskTrackerEnabled": true,
      "planModeEnabled": true,
      "completionCheckEnabled": true,
      "memoryEnforcementEnabled": true,
      "debugTrackerEnabled": true,
      "workflowDetectionEnabled": true,
      "propagationEnabled": true,
      "dangerousCommands": [],
      "bootstrapSizeWarnKB": 28,
      "bootstrapSizeBlockKB": 35,
      "dependencyMapPath": null
    }
  }
}
```

### Gate Mode

- **`block`** (default): Hard gates actively prevent the tool call and return an error message
- **`warn`**: Gates log warnings but allow the action to proceed

### Dangerous Commands

Override the default list of irreversible command patterns:

```json
{
  "dangerousCommands": [
    "\\bkubectl\\s+delete\\b",
    "\\bterraform\\s+destroy\\b",
    "\\bgit\\s+push\\s+.*--force\\b"
  ]
}
```

Patterns are JavaScript regex strings matched against shell command text.

### Dependency Map

For propagation checking (e.g., "you changed `api.ts` — did you update `api.test.ts`?"):

```json
{
  "dependencyMapPath": "./dependency-map.json"
}
```

Format:
```json
{
  "src/api.ts": ["src/api.test.ts", "docs/api.md"],
  "src/schema.ts": ["src/schema.test.ts", "src/migrations/"]
}
```

## How It Works

### Workflow Detection

The plugin analyzes each prompt to detect the workflow type:

| Workflow | Triggers | Guidance |
|----------|----------|----------|
| Debugging | "error", "bug", "broken", "investigate" | Use `debug_tracker`, find root cause first |
| Creating | "create", "build", "new", "implement" | Plan first with `plan_mode`, then execute |
| Analyzing | "analyze", "review", "report", "compare" | Gather data, synthesize, question assumptions |
| Fixing | "fix", "update", "refactor", "improve" | Read before edit, update related files |
| General | (default) | No specific guidance |

### Quality Checklist

Before completing any session with file modifications, agents must answer:

1. **Verification** — What commands did you run? (test, build, lint)
2. **Edge Cases** — What edge cases did you consider?
3. **Regression Risk** — What existing functionality could break?
4. **Gap Analysis** — What remains incomplete or untested?
5. **Stress Test** (optional) — Did you stress-test your changes?

Answers must be substantive (15+ characters). "Yes", "Done", "N/A" are rejected.

The system escalates reminders as the session progresses:
- 10+ tool calls: gentle reminder
- 25+ tool calls: strong "MANDATORY" warning

### Checkpoint & Rollback

Save task state snapshots and rollback if something goes wrong:

```
task_tracker(action: "checkpoint", label: "before refactor")
// ... do risky work ...
task_tracker(action: "rollback", checkpoint_id: "...")
```

- Maximum 10 checkpoints per session (oldest auto-pruned)
- Rollback restores tasks, plan state, and re-creates deleted tasks

### Cross-Session Tracking

- Audit log persists across sessions in SQLite
- Previous session's issues are injected into the next session's context
- Session state (modified files, read files) resets cleanly on new sessions

## Architecture

```
index.ts                          Plugin entry point & registration
src/
├── hooks/
│   ├── prompt-inject.ts          Layer 1: workflow detection, context injection
│   ├── hard-gates.ts             Layer 2: read-before-edit, dangerous commands, etc.
│   ├── tool-verify.ts            Layer 3: file tracking, verification detection
│   └── completion-check.ts       Layer 3: end-of-session quality audit
├── tools/
│   ├── task-tracker.ts           Hierarchical task management + checkpoint/rollback
│   ├── plan-mode.ts              Plan → approve → execute → verify workflow
│   ├── debug-tracker.ts          4-phase systematic debugging protocol
│   ├── quality-checklist.ts      Self-review enforcement
│   └── common.ts                 Shared utilities, dependency map, related file rules
└── store/
    ├── session-state.ts          In-memory + SQLite session state management
    ├── audit-log.ts              Persistent audit trail
    ├── schema.ts                 Database migrations (v1 → v3)
    └── connection.ts             SQLite connection pooling
```

### Fail-Safe Design

- **Shell tools fail-closed**: If the gate system itself errors, shell commands are blocked (safety first)
- **Non-shell tools fail-open**: Other tools are allowed through on gate errors (availability)
- **Invalid regex patterns**: Logged and skipped, not crash the whole gate system
- **Database errors**: Plugin logs the error and disables itself rather than crashing the agent

## Dashboard

Run the `/systematic` command in any OpenClaw session to see plugin stats:

```
/systematic
```

Shows: gate mode, feature toggles, 24h/7d statistics (completed sessions, blocked calls, warnings, errors).

## Development

```bash
# Install dependencies
npm install

# Type check (no build step — OpenClaw runs TypeScript directly)
npx tsc --noEmit

# The plugin uses OpenClaw's plugin SDK types
# See: https://docs.openclaw.ai/plugins
```

## License

MIT
