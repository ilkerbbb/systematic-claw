# Changelog

All notable changes to systematic-claw are documented here.

## [0.3.0] — 2026-03-29

### Added
- **Gate 9 — SSoT Propagation:** plan_mode create with 4+ steps requires reading SSOT_REGISTRY.md first
- **Gate 9c — SSoT Awareness:** Every workspace file write requires SSOT_REGISTRY.md read; flag resets after each write for continuous enforcement
- **Gate 10 — Memory before Dispatch:** sessions_send to agent sessions requires prior memory_search / lcm_grep / lcm_expand_query
- **Gate 11 — Skill File Read:** Writing to skills/X/ requires reading both X/SKILL.md and skill-creator/SKILL.md; also enforced on shell writes (11b)
- **Gate 12 — Spawn Thinking:** sessions_spawn requires a thinking parameter
- **Gate 13 — Workspace Root Hygiene:** Only .md files allowed in workspace root; also enforced on shell writes (13b)
- **Gate 3c — Related Files on Completion:** Plan completion blocked if related files (per RELATED_FILE_RULES) were not updated
- **Gate 5 expansion:** rm + workspace directory patterns added to dangerous commands
- **Iron Rule prompts:** Demir Kural #1 (verify sources) and #3 (stop and check) injected into prompt context
- **Bilingual workflow detection:** ~189 keywords across Turkish and English (debugging, creating, analyzing, fixing)
- **Scaffold system:** First-run creates STATE.md, MEMORY.md, SYSTEM/SSOT_REGISTRY.md templates with onboarding guide
- **Portability:** All hardcoded paths replaced with HOME resolution; works on any machine
- **Architecture diagram:** Visual hook flow diagram added to README
- **CHANGELOG.md:** This file

### Fixed
- Shell write bypass prevention (Gates 11b, 13b) — file writes via >, >>, tee, cat > now caught
- Tilde expansion in path normalization
- RELATED_FILE_RULES false positives on plugin source code (extensions/, plugins/ excluded)
- USERPROFILE fallback for Windows compatibility in register()
- Word boundary fix for hang/reject in workflow detection (prevented change matching hang)

## [0.2.0] — 2026-03-28

### Added
- **Gate visibility annotations:** gateVerbosity config (silent/summary/verbose); summary mode shows Gates: N checks, N blocks, N warnings
- **Gate 3b — Quality Review on Plan Completion:** plan_mode verify/complete requires quality_checklist when files were changed
- **Gate 8 enforcement tightened:** Threshold lowered to 2+ files (was 6+ files + 3 dirs)

### Fixed
- Gate 8 cooldown: allows 4 new files after quality review before re-triggering

## [0.1.0] — 2026-03-27

### Added
- **Gate 1 — Read before Edit:** Cannot edit a file you have not read
- **Gate 2 — Plan before Create:** Creating files in a creating workflow requires an active plan
- **Gate 3 — Verify before Complete:** Cannot mark tasks/plans complete without running test/build/lint
- **Gate 4 — Doom Loop:** 3+ identical tool calls redirects to debug_tracker
- **Gate 5 — Dangerous Commands:** Blocks destructive shell commands and social media posts
- **Gate 6 — Bootstrap File Size:** Warns at 28KB, blocks at 35KB
- **Gate 7 — Verify-First Cadence:** Every 3-4 file writes requires a verification command
- **Gate 8 — Complexity Review:** Multi-file changes require quality_checklist
- **Workflow tools:** task_tracker, plan_mode, debug_tracker, quality_checklist
- **Workflow detection:** Automatic prompt analysis (debugging/creating/analyzing/fixing)
- **Skill awareness:** Usage nudges, gap detection, development suggestions
- **Audit logging:** Persistent SQLite trail of gate blocks, warnings, and session history
- **Impact analysis enforcement** and git hygiene reminders
