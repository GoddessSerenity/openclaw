# Fork Patches Registry

This file tracks all custom patches applied to the OpenClaw fork that are NOT in upstream.
After every upstream merge, run `./scripts/verify-fork-patches.sh` to ensure nothing was lost.

## How to use

1. **After merging upstream:** Run `./scripts/verify-fork-patches.sh`
2. **When adding a new fork patch:** Add an entry below with a unique grep signature
3. **When upstream absorbs a patch:** Remove the entry and note it in the commit message

---

## Patches

### 1. Telegram per-chat send queue

**Commits:** 9a31148f1
**Description:** Wraps all outbound Telegram API calls in `queueTelegramSend(chatId, ...)` to serialize messages per chat, fixing race conditions where tool-sent messages arrive out of order.
**Files:**

- `src/telegram/send-queue.ts` (new file)
- `src/telegram/send.ts` (5 call sites wrapped)
- `src/telegram/bot/delivery.ts` (9 call sites wrapped)
  **Signatures:**
- `src/telegram/send-queue.ts` EXISTS
- `src/telegram/send.ts` CONTAINS `queueTelegramSend`
- `src/telegram/bot/delivery.ts` CONTAINS `queueTelegramSend`

### 2. user_message hook emission

**Commits:** a5d879b6c, e86958f9f
**Description:** Emits `activity.user_message` internal hook events when inbound messages are received, enabling event hooks to capture user messages for logging/analytics.
**Files:**

- `src/auto-reply/reply/dispatch-from-config.ts`
  **Signatures:**
- `src/auto-reply/reply/dispatch-from-config.ts` CONTAINS `user_message`

### 3. Session lifecycle hooks

**Commits:** a9b079592, 74f5d665d, ed8dca8d1
**Description:** Fires session:start and session:end internal hook events + plugin hooks during session lifecycle. Includes effective model resolution and spawnedBy tracking.
**Files:**

- `src/auto-reply/reply/session.ts` (lifecycle hooks + resolveDefaultModel)
- `src/gateway/server-methods/sessions.ts` (session:end on delete)
  **Signatures:**
- `src/auto-reply/reply/session.ts` CONTAINS `triggerInternalHook`
- `src/auto-reply/reply/session.ts` CONTAINS `resolveDefaultModel`
- `src/auto-reply/reply/session.ts` CONTAINS `spawnedBy`
- `src/gateway/server-methods/sessions.ts` CONTAINS `triggerInternalHook`

### 4. Subagent session:start hook

**Commits:** 057261b39
**Description:** Fires session:start hook when subagent/embedded sessions are created.
**Files:**

- `src/agents/pi-embedded-runner/run/attempt.ts`
  **Signatures:**
- `src/agents/pi-embedded-runner/run/attempt.ts` MATCHES `createInternalHookEvent.*session.*start`

### 5. Extended InternalHookEventType union

**Commits:** 02961a458
**Description:** Adds activity, lifecycle, compaction, and cron event types to the internal hook system.
**Files:**

- `src/hooks/internal-hooks.ts`
  **Signatures:**
- `src/hooks/internal-hooks.ts` CONTAINS `"activity"`
- `src/hooks/internal-hooks.ts` CONTAINS `"lifecycle"`
- `src/hooks/internal-hooks.ts` CONTAINS `"compaction"`
- `src/hooks/internal-hooks.ts` CONTAINS `"cron"`

### 6. Cron event bridge to internal hooks

**Commits:** 02961a458
**Description:** Bridges cron started/finished/removed events to the internal hook system.
**Files:**

- `src/cron/service/timer.ts`
  **Signatures:**
- `src/cron/service/timer.ts` CONTAINS `triggerInternalHook`

### 7. spawnedBy propagation

**Commits:** 0ef10f6f2, 9e5320183
**Description:** Adds spawnedBy field to AgentBootstrapHookContext and propagates parent session key through bootstrap files and hooks.
**Files:**

- `src/hooks/internal-hooks.ts`
- `src/agents/bootstrap-hooks.ts`
- `src/agents/bootstrap-files.ts`
  **Signatures:**
- `src/hooks/internal-hooks.ts` CONTAINS `spawnedBy`
- `src/agents/bootstrap-hooks.ts` CONTAINS `spawnedBy`
- `src/agents/bootstrap-files.ts` CONTAINS `spawnedBy`

### 8. /clean command (raw LLM sessions)

**Commits:** ef9879621, 34ccbee2e, 998940757
**Description:** Adds /clean command for raw LLM sessions without workspace files, skills, memory, or persona. Includes cleanSession persistence, chat.send RPC flags, and embedded runner support.
**Files:**

- `src/auto-reply/reply/session.ts` (trigger detection + persistence)
- `src/auto-reply/reply/get-reply-run.ts` (isBareClean handling)
- `src/config/sessions/types.ts` (cleanSession field)
- `src/agents/system-prompt.ts` (clean prompt mode)
- `src/agents/pi-embedded-runner/run/attempt.ts` (cleanSession check)
- `src/agents/pi-embedded-runner/system-prompt.ts` (clean mode)
- `src/agents/workspace.ts` (CLEAN-PROMPT.md support)
- `src/gateway/server-methods/chat.ts` (cleanSession RPC flag)
  **Signatures:**
- `src/auto-reply/reply/session.ts` CONTAINS `cleanRequested`
- `src/auto-reply/reply/session.ts` CONTAINS `cleanSession`
- `src/auto-reply/reply/get-reply-run.ts` CONTAINS `isBareClean`
- `src/config/sessions/types.ts` CONTAINS `cleanSession`
- `src/agents/pi-embedded-runner/run/attempt.ts` CONTAINS `cleanSession`
- `src/gateway/server-methods/chat.ts` CONTAINS `cleanSession`

### 9. Image persistence (chat images as files)

**Commits:** 2b382996b, fbdac9a9d, 8ee2066e9, 8ab98ab55
**Description:** Persists chat images as files referenced in session JSONL, with externalization during agent runs and path preservation through chat.history sanitization.
**Files:**

- `src/media/session-image-store.ts` (new file)
- `src/agents/pi-embedded-runner/run/attempt.ts` (externalization)
- `src/gateway/server-methods/chat.ts` (path preservation)
  **Signatures:**
- `src/media/session-image-store.ts` EXISTS
- `src/agents/pi-embedded-runner/run/attempt.ts` CONTAINS `externalizeSessionImages`
- `src/gateway/server-methods/chat.ts` CONTAINS `_resolvedFromFile`

### 10. configuredOnly filter for models.list

**Commits:** ed2e4c3fb, 270923d6a
**Description:** Adds configuredOnly and providers filters to the models.list RPC.
**Files:**

- `src/gateway/server-methods/models.ts`
  **Signatures:**
- `src/gateway/server-methods/models.ts` CONTAINS `configuredOnly`

### 11. session:end endKind tagging

**Commits:** 35e0f0453
**Description:** Emits session:end with endKind field for embedded runs, and tags deletions with endKind='deleted'.
**Files:**

- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/gateway/server-methods/sessions.ts`
  **Signatures:**
- `src/agents/pi-embedded-runner/run/attempt.ts` CONTAINS `endKind`
- `src/gateway/server-methods/sessions.ts` CONTAINS `endKind`

### 12. task-runner enhancements

**Commits:** ae12217bf
**Description:** Auto-replace terminal tasks on task_start, new task_restart action, fix prune race condition with olderThanMs=0.
**Files:**

- `src/task-runner/service.ts`
- `src/agents/tools/task-runner-tool.ts`
  **Signatures:**
- `src/task-runner/service.ts` CONTAINS `isTerminalStatus`
- `src/task-runner/service.ts` CONTAINS `async restart`
- `src/task-runner/service.ts` CONTAINS `POSITIVE_INFINITY`
- `src/agents/tools/task-runner-tool.ts` CONTAINS `task_restart`

### 13. Discord: honor explicit thread type

**Commits:** 89397a3e1
**Description:** Passes explicit thread type when creating standalone Discord threads.
**Files:**

- `src/discord/send.messages.ts`
  **Signatures:**
- `src/discord/send.messages.ts` CONTAINS `payload.type`

### 14. Activity/lifecycle/compaction bridge (server-startup)

**Commits:** b11b1cd00, 3e0946838
**Description:** Bridges agent activity events (message, tool_call, tool_result), lifecycle events (start, end, error), and compaction events to internal hooks.
**Files:**

- `src/gateway/server-startup.ts`
  **Signatures:**
- `src/gateway/server-startup.ts` MATCHES `activity.*message`
- `src/gateway/server-startup.ts` MATCHES `activity.*tool_call`
- `src/gateway/server-startup.ts` MATCHES `lifecycle.*start`
- `src/gateway/server-startup.ts` MATCHES `compaction.*start`

### 15. task_runner as native tool (+ projectId extension)

**Commits:** 58b6adae5, cf80e8b68
**Description:** Adds task_runner as a native OpenClaw coding tool with full start/stop/logs/etc functionality.
**Files:**

- `src/agents/tools/task-runner-tool.ts` (new file)
- `src/agents/openclaw-tools.ts` (tool registration)
  **Signatures:**
- `src/agents/tools/task-runner-tool.ts` EXISTS
- `src/agents/openclaw-tools.ts` CONTAINS `task-runner`

### 16. Project management runtime tool

**Commits:** c8b1f74e2, da86bffa7
**Description:** Full project management tool (`project`) backed by MariaDB. 38 actions covering project CRUD, links, stored commands, task state machine with git worktree support, task dependencies, status history, and per-project memory. Database: `openclaw_projects` with 8 tables.
**Files:**

- `src/project/db.ts` (new file — MariaDB connection pool)
- `src/project/types.ts` (new file — all enums, row types, state machines)
- `src/project/migrations.ts` (new file — idempotent SQL migrations)
- `src/project/git.ts` (new file — worktree/branch helpers)
- `src/project/service.ts` (new file — ProjectService with all 38 actions)
- `src/agents/tools/project-tool.ts` (new file — tool definition + schema)
- `src/agents/openclaw-tools.ts` (tool registration)
- `src/task-runner/types.ts` (added projectId field)
- `src/task-runner/service.ts` (persist/filter projectId)
- `package.json` (added mysql2 dependency)
  **Signatures:**
- `src/project/service.ts` EXISTS
- `src/project/db.ts` EXISTS
- `src/agents/tools/project-tool.ts` EXISTS
- `src/agents/openclaw-tools.ts` CONTAINS `project-tool`
- `package.json` CONTAINS `mysql2`
- `src/task-runner/types.ts` CONTAINS `projectId`
