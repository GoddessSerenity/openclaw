#!/usr/bin/env bash
# verify-fork-patches.sh - Verify all fork patches are present after upstream merge
# Run from the openclaw repo root: ./scripts/verify-fork-patches.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

PASS=0
FAIL=0
TOTAL=0

check_exists() {
  local file="$1"
  local label="$2"
  TOTAL=$((TOTAL + 1))
  if [ -f "$file" ]; then
    echo "  ✅ $label: $file exists"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label: $file MISSING"
    FAIL=$((FAIL + 1))
  fi
}

check_contains() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  TOTAL=$((TOTAL + 1))
  if [ ! -f "$file" ]; then
    echo "  ❌ $label: $file does not exist"
    FAIL=$((FAIL + 1))
    return
  fi
  if grep -q "$pattern" "$file" 2>/dev/null; then
    echo "  ✅ $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label: pattern '$pattern' not found in $file"
    FAIL=$((FAIL + 1))
  fi
}

check_matches() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  TOTAL=$((TOTAL + 1))
  if [ ! -f "$file" ]; then
    echo "  ❌ $label: $file does not exist"
    FAIL=$((FAIL + 1))
    return
  fi
  if grep -qE "$pattern" "$file" 2>/dev/null; then
    echo "  ✅ $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label: pattern '$pattern' not found in $file"
    FAIL=$((FAIL + 1))
  fi
}

echo "🔍 Verifying fork patches..."
echo ""

echo "=== 1. Telegram per-chat send queue ==="
check_exists "src/telegram/send-queue.ts" "send-queue module"
check_contains "src/telegram/send.ts" "queueTelegramSend" "send.ts uses queue"
check_contains "src/telegram/bot/delivery.ts" "queueTelegramSend" "delivery.ts uses queue"

echo "=== 2. user_message hook emission ==="
check_contains "src/auto-reply/reply/dispatch-from-config.ts" "user_message" "user_message hook"

echo "=== 3. Session lifecycle hooks ==="
check_contains "src/auto-reply/reply/session.ts" "triggerInternalHook" "session.ts hooks"
check_contains "src/auto-reply/reply/session.ts" "resolveDefaultModel" "session.ts model resolution"
check_contains "src/auto-reply/reply/session.ts" "spawnedBy" "session.ts spawnedBy"
check_contains "src/gateway/server-methods/sessions.ts" "triggerInternalHook" "sessions.ts delete hook"

echo "=== 4. Subagent session:start hook ==="
check_matches "src/agents/pi-embedded-runner/run/attempt.ts" "createInternalHookEvent.*session.*start" "subagent session:start"

echo "=== 5. InternalHookEventType union ==="
check_contains "src/hooks/internal-hooks.ts" '"activity"' "activity type"
check_contains "src/hooks/internal-hooks.ts" '"lifecycle"' "lifecycle type"
check_contains "src/hooks/internal-hooks.ts" '"compaction"' "compaction type"
check_contains "src/hooks/internal-hooks.ts" '"cron"' "cron type"

echo "=== 6. Cron event bridge ==="
check_contains "src/cron/service/timer.ts" "triggerInternalHook" "cron hook bridge"

echo "=== 7. spawnedBy propagation ==="
check_contains "src/hooks/internal-hooks.ts" "spawnedBy" "internal-hooks spawnedBy"
check_contains "src/agents/bootstrap-hooks.ts" "spawnedBy" "bootstrap-hooks spawnedBy"
check_contains "src/agents/bootstrap-files.ts" "spawnedBy" "bootstrap-files spawnedBy"

echo "=== 8. /clean command ==="
check_contains "src/auto-reply/reply/session.ts" "cleanRequested" "session.ts trigger"
check_contains "src/auto-reply/reply/session.ts" "cleanSession" "session.ts persistence"
check_contains "src/auto-reply/reply/get-reply-run.ts" "isBareClean" "get-reply-run.ts"
check_contains "src/config/sessions/types.ts" "cleanSession" "types.ts field"
check_contains "src/agents/pi-embedded-runner/run/attempt.ts" "cleanSession" "attempt.ts clean check"
check_contains "src/gateway/server-methods/chat.ts" "cleanSession" "chat.ts RPC flag"

echo "=== 9. Image persistence ==="
check_exists "src/media/session-image-store.ts" "image store module"
check_contains "src/agents/pi-embedded-runner/run/attempt.ts" "externalizeSessionImages" "attempt.ts externalization"
check_contains "src/gateway/server-methods/chat.ts" "_resolvedFromFile" "chat.ts path preservation"

echo "=== 10. configuredOnly filter ==="
check_contains "src/gateway/server-methods/models.ts" "configuredOnly" "models.ts filter"

echo "=== 11. session:end endKind ==="
check_contains "src/agents/pi-embedded-runner/run/attempt.ts" "endKind" "attempt.ts endKind"
check_contains "src/gateway/server-methods/sessions.ts" "endKind" "sessions.ts endKind"

echo "=== 12. task-runner enhancements ==="
check_contains "src/task-runner/service.ts" "isTerminalStatus" "auto-replace"
check_contains "src/task-runner/service.ts" "async restart" "restart method"
check_contains "src/task-runner/service.ts" "POSITIVE_INFINITY" "prune fix"
check_contains "src/agents/tools/task-runner-tool.ts" "task_restart" "tool action"

echo "=== 13. Discord thread type ==="
check_contains "src/discord/send.messages.ts" "payload.type" "thread type"

echo "=== 14. Activity/lifecycle/compaction bridge ==="
check_matches "src/gateway/server-startup.ts" "activity.*message" "activity message"
check_matches "src/gateway/server-startup.ts" "activity.*tool_call" "activity tool_call"
check_matches "src/gateway/server-startup.ts" "lifecycle.*start" "lifecycle start"
check_matches "src/gateway/server-startup.ts" "compaction.*start" "compaction start"

echo "=== 15. task_runner native tool ==="
check_exists "src/agents/tools/task-runner-tool.ts" "task-runner tool"
check_matches "src/agents/openclaw-tools.ts" "task.runner|task-runner" "tool registration"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "⚠️  FORK PATCHES ARE MISSING! Do not deploy until all checks pass."
  exit 1
else
  echo ""
  echo "✅ All fork patches verified."
  exit 0
fi
