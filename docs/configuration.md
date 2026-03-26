# Configuration Guide

## Quick Start

systematic-claw works with zero configuration. Install it and add `"group:plugins"` to your agent's tool allowlist.

## All Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the entire plugin |
| `gateMode` | `"block"` \| `"warn"` | `"block"` | How gates respond to violations |
| `taskTrackerEnabled` | boolean | `true` | Enable `task_tracker` tool |
| `planModeEnabled` | boolean | `true` | Enable `plan_mode` tool |
| `completionCheckEnabled` | boolean | `true` | Enable end-of-session completion audit |
| `memoryEnforcementEnabled` | boolean | `true` | Warn when no memory file written |
| `debugTrackerEnabled` | boolean | `true` | Enable `debug_tracker` tool |
| `workflowDetectionEnabled` | boolean | `true` | Auto-detect workflow type from prompt |
| `propagationEnabled` | boolean | `true` | Check dependent file updates |
| `dbPath` | string | `~/.openclaw/systematic-claw.db` | SQLite database location |
| `dangerousCommands` | string[] | (see below) | Regex patterns for blocked commands |
| `bootstrapSizeWarnKB` | number | `28` | Warn threshold for bootstrap files |
| `bootstrapSizeBlockKB` | number | `35` | Block threshold for bootstrap files |
| `dependencyMapPath` | string \| null | `null` | Path to custom dependency map |

## Gate Mode

### Block Mode (Default)

The agent receives an error and must fix the issue before proceeding:

```
🛑 GATE: Read-before-Edit
Bu dosya henüz okunmadı. Düzenleme yapılmadan önce dosya okunmalı.
Çözüm: Önce dosyayı okuyun, sonra düzenleme yapın.
```

### Warn Mode

The agent sees a warning but the action proceeds:

```
⚠️ UYARI: Bu dosya henüz okunmadı. Düzenleme öncesi okuma önerilir.
```

Use warn mode when:
- Testing the plugin for the first time
- Working with agents that get confused by blocking
- You want visibility without enforcement

## Dangerous Commands

The default list blocks common irreversible operations:

| Category | Examples |
|----------|----------|
| Social media | `bird tweet`, `toot post` |
| Email | `gmail send`, `sendmail`, `mutt -s` |
| Destructive filesystem | `rm -rf /`, `mkfs`, `dd of=/dev/` |
| Git destructive | `git push --force`, `git reset --hard origin/` |
| Cloud/infra | `kubectl delete`, `terraform destroy`, `aws ... delete` |
| Financial | `curl -X POST ...pay` |

### Custom Patterns

Override entirely:
```json
{
  "dangerousCommands": [
    "\\bmy-deploy\\s+production\\b",
    "\\bdrop\\s+database\\b"
  ]
}
```

Or disable:
```json
{
  "dangerousCommands": []
}
```

## Dependency Map

By default, the plugin uses built-in rules:

| File Pattern | Requires Update |
|-------------|----------------|
| `src/**/*.ts` | `STATE.md` |
| `src/**/*.js` | `STATE.md` |
| `*.config.*` | `STATE.md` |

For project-specific dependencies, create a JSON file:

```json
{
  "src/api/routes.ts": [
    "src/api/routes.test.ts",
    "docs/api-reference.md"
  ],
  "src/models/user.ts": [
    "src/models/user.test.ts",
    "src/migrations/"
  ]
}
```

Then point to it:
```json
{
  "dependencyMapPath": "./dependency-map.json"
}
```

## Disabling Features

To run with only hard gates (no tools):
```json
{
  "taskTrackerEnabled": false,
  "planModeEnabled": false,
  "debugTrackerEnabled": false
}
```

To run with only tools (no gates):
```json
{
  "gateMode": "warn"
}
```

To disable everything except audit logging:
```json
{
  "taskTrackerEnabled": false,
  "planModeEnabled": false,
  "debugTrackerEnabled": false,
  "completionCheckEnabled": false,
  "workflowDetectionEnabled": false,
  "gateMode": "warn"
}
```

## Tool Policy

OpenClaw agents need explicit permission to use plugin tools. The simplest approach:

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

This allows ALL plugin tools automatically. Alternatively, list individual tools:

```json
{
  "tools": {
    "alsoAllow": ["task_tracker", "plan_mode", "debug_tracker", "quality_checklist"]
  }
}
```

> **Note:** Hooks (gates, file tracking, completion check) work regardless of tool policy.
> Only the interactive tools require allowlist inclusion.
