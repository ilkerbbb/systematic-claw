# Tools Reference

## task_tracker

Hierarchical task management with checkpoint/rollback support.

### Actions

#### `create` — Create a new top-level task

```json
{
  "action": "create",
  "title": "Implement user authentication",
  "priority": "high",
  "status": "pending"
}
```

> **Bypass protection:** If `status: "completed"` is passed, it's overridden to `"pending"`.
> Tasks must go through `complete` or `update` (which triggers chain gate verification).

#### `add_subtask` — Add a child task

```json
{
  "action": "add_subtask",
  "parent_id": "task-abc123",
  "title": "Add password hashing",
  "priority": "medium"
}
```

#### `update` — Update task status or title

```json
{
  "action": "update",
  "task_id": "task-abc123",
  "status": "in_progress"
}
```

When updating to `status: "completed"`, the **workflow chain gate** activates:
1. Were verification commands run?
2. Were related files (STATE.md) updated?
3. Were dependent files updated?

#### `complete` — Mark task as completed

```json
{
  "action": "complete",
  "task_id": "task-abc123"
}
```

Same chain gate as `update(completed)`.

#### `delete` — Remove a task

```json
{
  "action": "delete",
  "task_id": "task-abc123"
}
```

#### `list` — Show all tasks

```json
{
  "action": "list"
}
```

Returns a tree view with status icons and completion counts.

#### `checkpoint` — Save a state snapshot

```json
{
  "action": "checkpoint",
  "label": "before database migration"
}
```

Maximum 10 checkpoints per session. Oldest are auto-pruned.

#### `rollback` — Restore a previous state

```json
{
  "action": "rollback",
  "checkpoint_id": "chk-abc123"
}
```

Restores:
- Task statuses (reverts completed → pending, etc.)
- Deleted tasks (re-creates them)
- New tasks created after checkpoint (removes them)
- Active plan state (phase, current step, step completion)

---

## plan_mode

Structured plan → approve → execute → verify workflow.

### Actions

#### `create` — Create a new plan

```json
{
  "action": "create",
  "goal": "Refactor authentication system",
  "steps": [
    "Analyze current auth flow",
    "Design new token-based system",
    "Implement token generation",
    "Update middleware",
    "Write tests",
    "Update documentation"
  ]
}
```

Plan starts in `draft` phase. Agent must get approval before executing.

#### `approve` — Approve the plan for execution

```json
{
  "action": "approve"
}
```

Transitions from `draft` → `executing`.

#### `advance` — Mark current step as done, move to next

```json
{
  "action": "advance"
}
```

#### `complete` — Mark entire plan as completed

```json
{
  "action": "complete"
}
```

#### `status` — Show current plan state

```json
{
  "action": "status"
}
```

#### `cancel` — Cancel the active plan

```json
{
  "action": "cancel"
}
```

---

## debug_tracker

4-phase systematic debugging protocol.

### Phases

```
START → REPRODUCE → HYPOTHESIZE → TEST → RESOLVE
         ↑                         │
         └─────── (loop) ──────────┘
```

### Actions

#### `start` — Begin a debug session

```json
{
  "action": "start",
  "error_description": "API returns 500 on POST /users with valid payload"
}
```

#### `add_evidence` — Record observed evidence

```json
{
  "action": "add_evidence",
  "evidence": "Stack trace shows NullPointerException at UserService.java:42"
}
```

#### `hypothesize` — Propose a hypothesis

```json
{
  "action": "hypothesize",
  "hypothesis": "user.address is null when address field is optional"
}
```

#### `test_result` — Record hypothesis test result

```json
{
  "action": "test_result",
  "hypothesis_id": "hyp-1",
  "result": "confirmed",
  "details": "Sending request without address field reproduces the error"
}
```

#### `resolve` — Close the debug session with resolution

```json
{
  "action": "resolve",
  "resolution": "Added null check for optional address field"
}
```

#### `escalate` — Flag as needing human help

```json
{
  "action": "escalate",
  "reason": "3 hypotheses tested, none confirmed. Need domain knowledge."
}
```

Auto-triggers after 3 failed hypotheses.

---

## quality_checklist

Self-review enforcement before session completion.

### Actions

#### `status` — Check if review is required

```json
{
  "action": "status"
}
```

Returns:
```json
{
  "required": true,
  "alreadyReviewed": false,
  "modifiedFiles": 3,
  "message": "Quality review gerekli — dosya değişikliği yapıldı ama henüz self-review yapılmadı."
}
```

#### `review` — Submit the quality self-review

```json
{
  "action": "review",
  "verification_done": "Ran npm test (45 passing), npm run build (success), npm run lint (0 errors)",
  "edge_cases_considered": "Tested empty input, unicode characters, concurrent requests, missing env vars",
  "regression_risk": "Changed auth middleware — verified login, logout, token refresh still work",
  "gap_analysis": "Load testing not done, need to verify with >1000 concurrent users",
  "stress_tested": "Ran 500 concurrent requests with k6, p99 latency stayed under 200ms"
}
```

**Required fields** (must be 15+ characters):
- `verification_done`
- `edge_cases_considered`
- `regression_risk`
- `gap_analysis`

**Optional fields** (bonus score):
- `stress_tested`

**Scoring:** Required fields = 2 points each (max 8). Optional = 1 point bonus.

### Invalidation

The review is automatically invalidated when:
- A new file is modified after the review
- A new session starts (reset)

This means the agent can't review early and then make more changes unchecked.
