/**
 * Session state management — tracks tasks, plans, file access per session.
 * All data persists in SQLite and survives compaction.
 */
import type { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

// ─── Types ───────────────────────────────────────────────────

export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked";

export type Task = {
  id: string;
  sessionKey: string;
  parentId: string | null;
  content: string;
  status: TaskStatus;
  verification: string | null;
  filesAffected: string[];
  createdAt: string;
  updatedAt: string;
  children?: Task[];
};

export type PlanPhase = "drafting" | "awaiting_approval" | "executing" | "verifying" | "completed" | "cancelled";

export type PlanStep = {
  index: number;
  content: string;
  completed: boolean;
};

export type PlanAlternative = {
  approach: string;
  tradeoff: string;
};

export type Plan = {
  id: string;
  sessionKey: string;
  goal: string;
  steps: PlanStep[];
  currentStep: number;
  phase: PlanPhase;
  alternatives: PlanAlternative[];
  changeSummary: string | null;
  createdAt: string;
  updatedAt: string;
};

// ─── Debug Session Types ─────────────────────────

export type DebugPhase = "evidence" | "hypothesize" | "test" | "resolved" | "escalated";

export type DebugHypothesis = {
  index: number;
  description: string;
  evidence: string;
  testPlan: string;
  result: string | null;
  succeeded: boolean | null;
};

export type DebugSession = {
  id: string;
  sessionKey: string;
  errorDescription: string;
  phase: DebugPhase;
  reproduced: boolean;
  reproductionSteps: string | null;
  hypotheses: DebugHypothesis[];
  failedAttempts: number;
  maxAttempts: number;
  escalationReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionSnapshot = {
  sessionKey: string;
  agentId: string | null;
  workflowType: string | null;
  readFiles: string[];
  modifiedFiles: string[];
  memoryWritten: boolean;
  activePlan: Plan | null;
  tasks: Task[];
};

// ─── Session State Store ─────────────────────────────────────

export type ToolCallRecord = {
  toolName: string;
  fileTarget: string | null; // extracted file path, if any
  contentSig: string | null; // first 80 chars of edit content — distinguishes different edits to same file
  hadError: boolean; // whether the tool call resulted in an error
  timestamp: number;
};

export type DoomLoopResult = {
  detected: boolean;
  toolName?: string;
  fileTarget?: string;
  count?: number;
};

export class SessionStateStore {
  // In-memory verification tracking — doesn't need to persist across gateway restarts
  private _verifications = new Map<string, number>();
  // In-memory tool call history for doom loop detection
  private _recentCalls = new Map<string, ToolCallRecord[]>();
  private static readonly MAX_CALL_HISTORY = 20;

  constructor(private db: DatabaseSync) {}

  // ── Quality Review Tracking (in-memory) ─────
  // Timestamp-based: review is valid until ANY file modification happens after it.
  // addModifiedFile() invalidates by setting _lastModificationTs > _qualityReviewTs.
  private _qualityReviewTs = new Map<string, number>();
  private _lastModificationTs = new Map<string, number>();

  recordQualityReview(sessionKey: string): void {
    this._qualityReviewTs.set(sessionKey, Date.now());
  }

  /** Invalidate quality review — called from addModifiedFile on every file change. */
  invalidateQualityReview(sessionKey: string): void {
    this._lastModificationTs.set(sessionKey, Date.now());
  }

  hasQualityReview(sessionKey: string): boolean {
    const reviewTs = this._qualityReviewTs.get(sessionKey);
    if (!reviewTs) return false;
    const lastModTs = this._lastModificationTs.get(sessionKey) ?? 0;
    // Review is valid only if no file was modified AFTER the review
    return lastModTs <= reviewTs;
  }

  // ── Verification Tracking (in-memory) ─────

  recordVerification(sessionKey: string): void {
    this._verifications.set(sessionKey, Date.now());
  }

  /** Invalidate verification when new files are modified after last verification. */
  invalidateVerification(sessionKey: string): void {
    this._verifications.delete(sessionKey);
  }

  hasRecentVerification(sessionKey: string, withinMs: number = 300_000): boolean {
    const ts = this._verifications.get(sessionKey);
    if (!ts) return false;
    return (Date.now() - ts) < withinMs;
  }

  // ── Tool Call Tracking (doom loop detection) ─────

  recordToolCall(sessionKey: string, toolName: string, params: Record<string, unknown>, hadError: boolean = false): void {
    if (!this._recentCalls.has(sessionKey)) {
      this._recentCalls.set(sessionKey, []);
    }
    const history = this._recentCalls.get(sessionKey)!;

    // Extract file target from params for file-operation tools
    const fileTarget = extractFileTarget(params);
    // Extract content signature to distinguish different edits to the same file
    const contentSig = extractContentSignature(params);

    history.push({ toolName, fileTarget, contentSig, hadError, timestamp: Date.now() });

    // Keep only the last N calls
    if (history.length > SessionStateStore.MAX_CALL_HISTORY) {
      history.shift();
    }
  }

  /** Check if a doom loop is happening: same tool + same file + same content signature
   *  repeated 3+ times in recent calls. Different edits to the same file (different old_string,
   *  different content) are NOT doom loops — they're legitimate multi-section updates.
   *  Called from before_tool_call — adds +1 for the current (not yet recorded) call. */
  checkDoomLoop(sessionKey: string, toolName: string, params: Record<string, unknown>): DoomLoopResult {
    const history = this._recentCalls.get(sessionKey);
    if (!history || history.length < 2) return { detected: false };

    const fileTarget = extractFileTarget(params);

    // Doom loop detection requires a concrete file target.
    if (fileTarget === null) return { detected: false };

    const contentSig = extractContentSignature(params);

    // Count matching calls in last 10 recorded calls
    const recentWindow = history.slice(-10);
    let exactRepeatCount = 0;
    let sameFileCount = 0;
    let sameFileErrorCount = 0;
    for (const call of recentWindow) {
      if (call.toolName === toolName && call.fileTarget === fileTarget) {
        sameFileCount++;
        if (call.hadError) sameFileErrorCount++;
        // If content signatures match (or both null for non-edit tools), it's an exact repeat
        if (call.contentSig === contentSig) {
          exactRepeatCount++;
        }
      }
    }

    // +1 for the current call
    exactRepeatCount += 1;
    sameFileCount += 1;

    // TIER 1: 3+ exact repeats (same tool + same file + same content) = definite doom loop
    if (exactRepeatCount >= 3) {
      return { detected: true, toolName, fileTarget, count: exactRepeatCount };
    }

    // TIER 2: 4+ different edits to same file WITH errors in the mix = fix-retry loop
    // (agent is trying different fixes but they keep failing — classic doom loop)
    if (sameFileCount >= 4 && sameFileErrorCount >= 1) {
      return { detected: true, toolName, fileTarget, count: sameFileCount };
    }

    // TIER 3: 6+ edits to same file regardless = too many attempts, even if all succeed
    if (sameFileCount >= 6) {
      return { detected: true, toolName, fileTarget, count: sameFileCount };
    }

    return { detected: false };
  }

  /** Reset doom loop history — called when agent starts debug_tracker (acknowledges the loop). */
  resetDoomLoop(sessionKey: string): void {
    this._recentCalls.delete(sessionKey);
  }

  /** Get recent tool call history for a session (for smart recommendations). */
  getRecentToolCalls(sessionKey: string): ToolCallRecord[] | null {
    return this._recentCalls.get(sessionKey) ?? null;
  }

  // ── Session ──────────────────────────────────

  ensureSession(sessionKey: string, agentId?: string): void {
    const existing = this.db.prepare(
      "SELECT session_key FROM session_state WHERE session_key = ?"
    ).get(sessionKey);
    if (!existing) {
      this.db.prepare(
        "INSERT INTO session_state (session_key, agent_id) VALUES (?, ?)"
      ).run(sessionKey, agentId ?? null);
    }
  }

  /** Reset session-scoped tracking (file lists, workflow type) for a fresh session start.
   *  Preserves tasks and plans (cross-session), but clears per-session accumulation. */
  resetSessionTracking(sessionKey: string): void {
    this.db.prepare(`
      UPDATE session_state
      SET read_files = '[]', modified_files = '[]', memory_written = 0,
          workflow_type = NULL, updated_at = datetime('now')
      WHERE session_key = ?
    `).run(sessionKey);
    // Also clear all in-memory state
    this._verifications.delete(sessionKey);
    this._recentCalls.delete(sessionKey);
    this._qualityReviewTs.delete(sessionKey);
    this._lastModificationTs.delete(sessionKey);
  }

  setWorkflowType(sessionKey: string, workflowType: string): void {
    this.ensureSession(sessionKey);
    this.db.prepare(
      "UPDATE session_state SET workflow_type = ?, updated_at = datetime('now') WHERE session_key = ?"
    ).run(workflowType, sessionKey);
  }

  setMemoryWritten(sessionKey: string): void {
    this.db.prepare(
      "UPDATE session_state SET memory_written = 1, updated_at = datetime('now') WHERE session_key = ?"
    ).run(sessionKey);
  }

  // ── File Tracking ────────────────────────────

  addReadFile(sessionKey: string, filePath: string, toolName?: string): void {
    this.ensureSession(sessionKey);
    const normalizedPath = normalizePath(filePath);
    // Update session_state JSON array
    const row = this.db.prepare(
      "SELECT read_files FROM session_state WHERE session_key = ?"
    ).get(sessionKey) as { read_files: string } | undefined;
    const files: string[] = row ? JSON.parse(row.read_files) : [];
    if (!files.includes(normalizedPath)) {
      files.push(normalizedPath);
      this.db.prepare(
        "UPDATE session_state SET read_files = ?, updated_at = datetime('now') WHERE session_key = ?"
      ).run(JSON.stringify(files), sessionKey);
    }
    // Record in file_tracking
    this.db.prepare(
      "INSERT INTO file_tracking (session_key, file_path, action, tool_name) VALUES (?, ?, 'read', ?)"
    ).run(sessionKey, filePath, toolName ?? null);
  }

  addModifiedFile(sessionKey: string, filePath: string, toolName?: string): void {
    this.ensureSession(sessionKey);
    const normalizedPath = normalizePath(filePath);
    const row = this.db.prepare(
      "SELECT modified_files FROM session_state WHERE session_key = ?"
    ).get(sessionKey) as { modified_files: string } | undefined;
    const files: string[] = row ? JSON.parse(row.modified_files) : [];
    if (!files.includes(normalizedPath)) {
      files.push(normalizedPath);
      this.db.prepare(
        "UPDATE session_state SET modified_files = ?, updated_at = datetime('now') WHERE session_key = ?"
      ).run(JSON.stringify(files), sessionKey);
    }
    this.db.prepare(
      "INSERT INTO file_tracking (session_key, file_path, action, tool_name) VALUES (?, ?, 'write', ?)"
    ).run(sessionKey, filePath, toolName ?? null);

    // Invalidate quality review and verification — file was modified after last check
    this.invalidateQualityReview(sessionKey);
    this.invalidateVerification(sessionKey);
  }

  hasReadFile(sessionKey: string, filePath: string): boolean {
    const row = this.db.prepare(
      "SELECT read_files FROM session_state WHERE session_key = ?"
    ).get(sessionKey) as { read_files: string } | undefined;
    if (!row) return false;
    const files: string[] = JSON.parse(row.read_files);
    const normalizedPath = normalizePath(filePath);
    return files.includes(normalizedPath);
  }

  hasModifiedFile(sessionKey: string, filePath: string): boolean {
    const row = this.db.prepare(
      "SELECT modified_files FROM session_state WHERE session_key = ?"
    ).get(sessionKey) as { modified_files: string } | undefined;
    if (!row) return false;
    const files: string[] = JSON.parse(row.modified_files);
    const normalizedPath = normalizePath(filePath);
    return files.includes(normalizedPath);
  }

  // ── Tasks ────────────────────────────────────

  createTask(task: {
    id: string;
    sessionKey: string;
    parentId?: string;
    content: string;
    status?: TaskStatus;
    filesAffected?: string[];
  }): void {
    this.db.prepare(`
      INSERT INTO tasks (id, session_key, parent_id, content, status, files_affected)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.sessionKey,
      task.parentId ?? null,
      task.content,
      task.status ?? "pending",
      task.filesAffected ? JSON.stringify(task.filesAffected) : null,
    );
  }

  updateTaskStatus(taskId: string, status: TaskStatus, verification?: string): void {
    this.db.prepare(`
      UPDATE tasks SET status = ?, verification = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(status, verification ?? null, taskId);
  }

  getTasks(sessionKey: string): Task[] {
    const rows = this.db.prepare(
      "SELECT * FROM tasks WHERE session_key = ? ORDER BY created_at"
    ).all(sessionKey) as Array<{
      id: string; session_key: string; parent_id: string | null;
      content: string; status: TaskStatus; verification: string | null;
      files_affected: string | null; created_at: string; updated_at: string;
    }>;

    return rows.map(row => ({
      id: row.id,
      sessionKey: row.session_key,
      parentId: row.parent_id,
      content: row.content,
      status: row.status,
      verification: row.verification,
      filesAffected: row.files_affected ? JSON.parse(row.files_affected) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getTaskTree(sessionKey: string): Task[] {
    const flatTasks = this.getTasks(sessionKey);
    const taskMap = new Map<string, Task>();
    const roots: Task[] = [];

    // First pass: index all tasks
    for (const task of flatTasks) {
      task.children = [];
      taskMap.set(task.id, task);
    }

    // Second pass: build tree
    for (const task of flatTasks) {
      if (task.parentId && taskMap.has(task.parentId)) {
        taskMap.get(task.parentId)!.children!.push(task);
      } else {
        roots.push(task);
      }
    }

    return roots;
  }

  deleteTask(taskId: string): void {
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
  }

  // ── Plans ────────────────────────────────────

  createPlan(plan: {
    id: string;
    sessionKey: string;
    goal: string;
    steps: PlanStep[];
  }): void {
    this.db.prepare(`
      INSERT INTO plans (id, session_key, goal, steps, phase)
      VALUES (?, ?, ?, ?, 'drafting')
    `).run(plan.id, plan.sessionKey, plan.goal, JSON.stringify(plan.steps));

    // Set as active plan
    this.db.prepare(
      "UPDATE session_state SET active_plan_id = ?, updated_at = datetime('now') WHERE session_key = ?"
    ).run(plan.id, plan.sessionKey);
  }

  updatePlanPhase(planId: string, phase: PlanPhase): void {
    this.db.prepare(
      "UPDATE plans SET phase = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(phase, planId);
  }

  updatePlanStep(planId: string, stepIndex: number): void {
    this.db.prepare(
      "UPDATE plans SET current_step = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(stepIndex, planId);
  }

  updatePlanSteps(planId: string, steps: PlanStep[]): void {
    this.db.prepare(
      "UPDATE plans SET steps = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(JSON.stringify(steps), planId);
  }

  getActivePlan(sessionKey: string): Plan | null {
    const stateRow = this.db.prepare(
      "SELECT active_plan_id FROM session_state WHERE session_key = ?"
    ).get(sessionKey) as { active_plan_id: string | null } | undefined;

    if (!stateRow?.active_plan_id) return null;

    const row = this.db.prepare(
      "SELECT * FROM plans WHERE id = ?"
    ).get(stateRow.active_plan_id) as {
      id: string; session_key: string; goal: string; steps: string;
      current_step: number; phase: PlanPhase;
      alternatives?: string; change_summary?: string | null;
      created_at: string; updated_at: string;
    } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      sessionKey: row.session_key,
      goal: row.goal,
      steps: JSON.parse(row.steps),
      currentStep: row.current_step,
      phase: row.phase,
      alternatives: row.alternatives ? JSON.parse(row.alternatives) : [],
      changeSummary: row.change_summary ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  updatePlanAlternatives(planId: string, alternatives: PlanAlternative[]): void {
    this.db.prepare(
      "UPDATE plans SET alternatives = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(JSON.stringify(alternatives), planId);
  }

  updatePlanChangeSummary(planId: string, summary: string): void {
    this.db.prepare(
      "UPDATE plans SET change_summary = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(summary, planId);
  }

  // ── Debug Sessions ─────────────────────────────

  createDebugSession(session: {
    id: string;
    sessionKey: string;
    errorDescription: string;
    maxAttempts?: number;
  }): void {
    this.db.prepare(`
      INSERT INTO debug_sessions (id, session_key, error_description, max_attempts)
      VALUES (?, ?, ?, ?)
    `).run(session.id, session.sessionKey, session.errorDescription, session.maxAttempts ?? 3);

    // Set as active debug session
    this.db.prepare(
      "UPDATE session_state SET active_debug_id = ?, updated_at = datetime('now') WHERE session_key = ?"
    ).run(session.id, session.sessionKey);
  }

  updateDebugSession(debugId: string, updates: {
    phase?: DebugPhase;
    reproduced?: boolean;
    reproductionSteps?: string;
    hypotheses?: DebugHypothesis[];
    failedAttempts?: number;
    escalationReason?: string;
  }): void {
    const setClauses: string[] = ["updated_at = datetime('now')"];
    const values: Array<string | number | null> = [];

    if (updates.phase !== undefined) {
      setClauses.push("phase = ?");
      values.push(updates.phase);
    }
    if (updates.reproduced !== undefined) {
      setClauses.push("reproduced = ?");
      values.push(updates.reproduced ? 1 : 0);
    }
    if (updates.reproductionSteps !== undefined) {
      setClauses.push("reproduction_steps = ?");
      values.push(updates.reproductionSteps);
    }
    if (updates.hypotheses !== undefined) {
      setClauses.push("hypotheses = ?");
      values.push(JSON.stringify(updates.hypotheses));
    }
    if (updates.failedAttempts !== undefined) {
      setClauses.push("failed_attempts = ?");
      values.push(updates.failedAttempts);
    }
    if (updates.escalationReason !== undefined) {
      setClauses.push("escalation_reason = ?");
      values.push(updates.escalationReason);
    }

    // Skip if no real updates (only updated_at)
    if (values.length === 0) return;

    values.push(debugId);
    this.db.prepare(
      `UPDATE debug_sessions SET ${setClauses.join(", ")} WHERE id = ?`
    ).run(...values);
  }

  getActiveDebugSession(sessionKey: string): DebugSession | null {
    const stateRow = this.db.prepare(
      "SELECT active_debug_id FROM session_state WHERE session_key = ?"
    ).get(sessionKey) as { active_debug_id: string | null } | undefined;

    if (!stateRow?.active_debug_id) return null;

    const row = this.db.prepare(
      "SELECT * FROM debug_sessions WHERE id = ?"
    ).get(stateRow.active_debug_id) as {
      id: string; session_key: string; error_description: string;
      phase: DebugPhase; reproduced: number; reproduction_steps: string | null;
      hypotheses: string;
      failed_attempts: number; max_attempts: number;
      escalation_reason: string | null;
      created_at: string; updated_at: string;
    } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      sessionKey: row.session_key,
      errorDescription: row.error_description,
      phase: row.phase,
      reproduced: row.reproduced === 1,
      reproductionSteps: row.reproduction_steps,
      hypotheses: JSON.parse(row.hypotheses),
      failedAttempts: row.failed_attempts,
      maxAttempts: row.max_attempts,
      escalationReason: row.escalation_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ── Checkpoints ─────────────────────────────────

  private static readonly MAX_CHECKPOINTS_PER_SESSION = 10;

  /** Save a checkpoint of current session state (tasks, plan, files). */
  createCheckpoint(sessionKey: string, label: string): string {
    this.ensureSession(sessionKey);
    const snapshot = this.getSnapshot(sessionKey);
    if (!snapshot) return "";

    const id = `cp_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 5)}`;
    const data = JSON.stringify({
      tasks: snapshot.tasks,
      activePlan: snapshot.activePlan,
      modifiedFiles: snapshot.modifiedFiles,
      readFiles: snapshot.readFiles,
      memoryWritten: snapshot.memoryWritten,
    });

    this.db.prepare(`
      INSERT INTO checkpoints (id, session_key, label, snapshot_data)
      VALUES (?, ?, ?, ?)
    `).run(id, sessionKey, label, data);

    // Prune oldest checkpoints if over limit
    const count = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM checkpoints WHERE session_key = ?"
    ).get(sessionKey) as { cnt: number })?.cnt ?? 0;

    if (count > SessionStateStore.MAX_CHECKPOINTS_PER_SESSION) {
      this.db.prepare(`
        DELETE FROM checkpoints WHERE id IN (
          SELECT id FROM checkpoints WHERE session_key = ?
          ORDER BY created_at ASC
          LIMIT ?
        )
      `).run(sessionKey, count - SessionStateStore.MAX_CHECKPOINTS_PER_SESSION);
    }

    return id;
  }

  /** List all checkpoints for a session. */
  getCheckpoints(sessionKey: string): Array<{ id: string; label: string; createdAt: string }> {
    const rows = this.db.prepare(
      "SELECT id, label, created_at FROM checkpoints WHERE session_key = ? ORDER BY created_at DESC"
    ).all(sessionKey) as Array<{ id: string; label: string; created_at: string }>;
    return rows.map(r => ({ id: r.id, label: r.label, createdAt: r.created_at }));
  }

  /** Rollback to a checkpoint — restores task states, plan state, and returns diff of files changed since checkpoint. */
  rollbackToCheckpoint(sessionKey: string, checkpointId: string): {
    success: boolean;
    restoredTasks: number;
    removedTasks: number;
    planRestored: boolean;
    filesChangedSinceCheckpoint: string[];
    error?: string;
  } {
    const row = this.db.prepare(
      "SELECT snapshot_data FROM checkpoints WHERE id = ? AND session_key = ?"
    ).get(checkpointId, sessionKey) as { snapshot_data: string } | undefined;

    if (!row) {
      return { success: false, restoredTasks: 0, removedTasks: 0, planRestored: false, filesChangedSinceCheckpoint: [], error: "Checkpoint bulunamadı" };
    }

    const saved = JSON.parse(row.snapshot_data) as {
      tasks: Task[];
      activePlan: Plan | null;
      modifiedFiles: string[];
      readFiles: string[];
      memoryWritten: boolean;
    };

    // 1. Remove tasks created AFTER the checkpoint
    const savedTaskIds = new Set(flattenTasksForRestore(saved.tasks).map(t => t.id));
    const currentTasks = this.getTasks(sessionKey);
    let removedCount = 0;
    for (const task of currentTasks) {
      if (!savedTaskIds.has(task.id)) {
        this.db.prepare("DELETE FROM tasks WHERE id = ? AND session_key = ?").run(task.id, sessionKey);
        removedCount++;
      }
    }

    // 2. Restore task states (update existing, re-create deleted)
    let restoredCount = 0;
    const failedTaskIds: string[] = [];
    const flatSaved = flattenTasksForRestore(saved.tasks);
    for (const task of flatSaved) {
      try {
        const exists = this.db.prepare(
          "SELECT id FROM tasks WHERE id = ? AND session_key = ?"
        ).get(task.id, sessionKey);

        if (exists) {
          this.db.prepare(
            "UPDATE tasks SET status = ?, verification = NULL, updated_at = datetime('now') WHERE id = ? AND session_key = ?"
          ).run(task.status, task.id, sessionKey);
        } else {
          // Re-create deleted task from snapshot
          this.db.prepare(
            "INSERT INTO tasks (id, session_key, parent_id, content, status, files_affected) VALUES (?, ?, ?, ?, ?, ?)"
          ).run(task.id, sessionKey, task.parentId ?? null, task.content, task.status, null);
        }
        restoredCount++;
      } catch (err) {
        failedTaskIds.push(task.id);
        console.warn(`[systematic-claw] Rollback failed for task ${task.id}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // 3. Restore plan state
    let planRestored = false;
    if (saved.activePlan) {
      try {
        this.updatePlanPhase(saved.activePlan.id, saved.activePlan.phase);
        this.updatePlanStep(saved.activePlan.id, saved.activePlan.currentStep);
        this.updatePlanSteps(saved.activePlan.id, saved.activePlan.steps);
        planRestored = true;
      } catch (err) {
        console.warn(`[systematic-claw] Rollback failed for plan ${saved.activePlan.id}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // 4. Calculate files changed since checkpoint
    const currentSnapshot = this.getSnapshot(sessionKey);
    const savedModifiedSet = new Set(saved.modifiedFiles);
    const filesChangedSince = (currentSnapshot?.modifiedFiles ?? []).filter(
      f => !savedModifiedSet.has(f)
    );

    // 5. Invalidate verification (state has changed)
    this.invalidateVerification(sessionKey);

    // 6. Delete checkpoints AFTER this one (they're now invalid)
    this.db.prepare(
      "DELETE FROM checkpoints WHERE session_key = ? AND created_at > (SELECT created_at FROM checkpoints WHERE id = ?)"
    ).run(sessionKey, checkpointId);

    return {
      success: true,
      restoredTasks: restoredCount,
      removedTasks: removedCount,
      planRestored,
      filesChangedSinceCheckpoint: filesChangedSince,
    };
  }

  // ── Snapshot ─────────────────────────────────

  getSnapshot(sessionKey: string): SessionSnapshot | null {
    const row = this.db.prepare(
      "SELECT * FROM session_state WHERE session_key = ?"
    ).get(sessionKey) as {
      session_key: string; agent_id: string | null;
      workflow_type: string | null; read_files: string;
      modified_files: string; memory_written: number;
      active_plan_id: string | null;
    } | undefined;

    if (!row) return null;

    return {
      sessionKey: row.session_key,
      agentId: row.agent_id,
      workflowType: row.workflow_type,
      readFiles: JSON.parse(row.read_files),
      modifiedFiles: JSON.parse(row.modified_files),
      memoryWritten: row.memory_written === 1,
      activePlan: this.getActivePlan(sessionKey),
      tasks: this.getTaskTree(sessionKey),
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────

/** Extract file target from tool params (for doom loop detection — same file = same target). */
function extractFileTarget(params: Record<string, unknown>): string | null {
  const candidates = ["file_path", "filePath", "path", "file", "target_file", "filename"];
  for (const key of candidates) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      return normalizePath(value.trim());
    }
  }
  return null;
}

/** Extract a short content signature from edit params to distinguish different edits to the same file.
 *  Same old_string/content = same signature → potential doom loop.
 *  Different old_string/content = different signature → legitimate multi-edit. */
function extractContentSignature(params: Record<string, unknown>): string | null {
  // For Edit-like tools: use first 80 chars of old_string as signature
  const editContent = params["old_string"] ?? params["oldStr"] ?? params["search"] ?? params["old_text"];
  if (typeof editContent === "string" && editContent.trim()) {
    return editContent.trim().slice(0, 80);
  }
  // For Write-like tools: use first 80 chars of content
  const writeContent = params["content"] ?? params["new_content"] ?? params["code"];
  if (typeof writeContent === "string" && writeContent.trim()) {
    return writeContent.trim().slice(0, 80);
  }
  return null;
}

/** Flatten tasks with their full info for checkpoint restore. */
function flattenTasksForRestore(tasks: Task[]): Array<{ id: string; status: TaskStatus; content: string; parentId: string | null }> {
  const result: Array<{ id: string; status: TaskStatus; content: string; parentId: string | null }> = [];
  for (const task of tasks) {
    result.push({ id: task.id, status: task.status, content: task.content, parentId: task.parentId });
    if (task.children && Array.isArray(task.children)) {
      result.push(...flattenTasksForRestore(task.children));
    }
  }
  return result;
}

/** Normalize file path for consistent comparison (resolve + lowercase on macOS). */
function normalizePath(filePath: string): string {
  const resolved = resolve(filePath);
  // macOS has case-insensitive filesystem by default
  if (process.platform === "darwin") {
    return resolved.toLowerCase();
  }
  return resolved;
}
