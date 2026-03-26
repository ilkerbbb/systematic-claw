# Architecture

## 3-Layer Enforcement Model

systematic-claw uses a 3-layer approach to enforce disciplined agent behavior:

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: GUIDE (before_prompt_build)                   │
│  ─ Workflow detection (debugging/creating/fixing/...)    │
│  ─ Active plan + task state injection                   │
│  ─ Periodic warnings (missing updates, no verification) │
│  ─ Cross-session context from audit log                 │
│  ─ Quality review escalating reminders                  │
└─────────────────────────────────────────────────────────┘
          ↓ Agent sees enriched context
┌─────────────────────────────────────────────────────────┐
│  Layer 2: ENFORCE (before_tool_call + tools)            │
│  ─ Hard gates: read-before-edit, plan-before-create     │
│  ─ Dangerous command blocking                           │
│  ─ Bootstrap size limits                                │
│  ─ task_tracker, plan_mode, debug_tracker tools         │
│  ─ quality_checklist tool                               │
│  ─ Workflow chain gate (verify + propagate + complete)  │
└─────────────────────────────────────────────────────────┘
          ↓ Tool executes (or is blocked)
┌─────────────────────────────────────────────────────────┐
│  Layer 3: AUDIT (after_tool_call + agent_end)           │
│  ─ File read/write tracking                             │
│  ─ Verification command detection                       │
│  ─ Completion checklist (open tasks, missing memory)    │
│  ─ SQLite audit log for cross-session learning          │
└─────────────────────────────────────────────────────────┘
```

## State Management

### In-Memory State (per session)

| State | Purpose | Reset |
|-------|---------|-------|
| `readFiles` | Files the agent has read | On session start |
| `modifiedFiles` | Files the agent has written/edited | On session start |
| `memoryWritten` | Whether MEMORY.md was updated | On session start |
| `workflowType` | Detected workflow (debugging/creating/...) | On session start |
| `_verifications` | Recent verification commands (test/build/lint) | On session start |
| `_qualityReviewTs` | Timestamp of last quality review | On session start |
| `_lastModificationTs` | Timestamp of last file modification | On session start |
| `_recentCalls` | Recent tool call history (for pattern detection) | On session start |

### Persistent State (SQLite)

| Table | Purpose |
|-------|---------|
| `session_state` | Session metadata, read/modified file lists |
| `tasks` | Hierarchical task tree (parent_id, status, priority) |
| `plans` | Plan phases, steps, approval state |
| `debug_sessions` | Debug protocol state (evidence, hypotheses, tests) |
| `audit_log` | All events with severity and details |
| `checkpoints` | Task/plan state snapshots for rollback |

### Session Reset Problem & Solution

OpenClaw's `session_start` event doesn't fire reliably. The plugin detects "first call"
by tracking which session keys have been seen in a module-level `Set<string>`:

```typescript
const initializedSessions = new Set<string>();

// In buildPromptContext (before_prompt_build):
if (!initializedSessions.has(sessionKey)) {
  initializedSessions.add(sessionKey);
  store.resetSessionTracking(sessionKey);
}
```

This ensures stale state from previous sessions doesn't leak into new ones.

## Hard Gate Behavior

### Fail-Safe Matrix

| Error Type | Shell Tools | Non-Shell Tools |
|-----------|-------------|-----------------|
| Gate logic error | **BLOCK** (fail-closed) | Allow (fail-open) |
| Invalid regex | Skip pattern, log warning | Skip pattern, log warning |
| Database error | Plugin disables itself | Plugin disables itself |

### Gate Evaluation Order

1. Dangerous command check (shell tools only)
2. Bootstrap size check (shell tools only)
3. Read-before-edit check (edit/write tools)
4. Plan-before-create check (file creation tools)

If any gate blocks, the tool call is prevented and the agent receives a clear error message
explaining what's missing and how to fix it.

## Quality Review Invalidation

The quality review uses timestamp-based tracking to handle re-edits:

```
File edit → addModifiedFile() → _lastModificationTs = Date.now()
Review   → recordQualityReview() → _qualityReviewTs = Date.now()
Check    → hasQualityReview() → _lastModificationTs <= _qualityReviewTs?
```

This means:
- Review passes → agent edits another file → review is invalidated → must review again
- Review passes → no more edits → review stays valid
- Previous session's review doesn't carry over (reset on session start)

## Workflow Chain Gate

When completing a task (`task_tracker complete` or `update status=completed`), the chain gate
verifies:

1. **Verification**: Has a test/build/lint command been run since last file edit?
2. **Related Files**: Were STATE.md / related docs updated?
3. **Propagation**: Were dependent files (tests, docs) updated?

Paths under `/tmp/`, `/var/`, `/private/tmp/` are exempt from propagation checks.

## Bypass Protection

To prevent agents from circumventing the chain gate:

- `task_tracker(action: "create", status: "completed")` → status overridden to `"pending"`
- `task_tracker(action: "add_subtask", status: "completed")` → status overridden to `"pending"`
- Only `complete` and `update(status: "completed")` go through the chain gate
