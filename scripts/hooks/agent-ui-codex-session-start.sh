#!/usr/bin/env bash
# Codex SessionStart hook: attach resumable session metadata to the current
# Telemachus task, then load Telemachus's agent instructions into context.

set -u

# A Codex process launched by Claude is a delegate of the primary Telemachus
# agent. Do not let it replace Claude's resumable session or receive instructions
# that tell it to write to Claude's task screen.
if [ -n "${CLAUDECODE:-}" ] || [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  exit 0
fi

[ -n "${AGENT_UI_TASK_ID:-}" ] || exit 0

agent_ui_cli="${AGENT_UI_CLI:-}"
if [ -z "$agent_ui_cli" ] || [ ! -x "$agent_ui_cli" ]; then
  agent_ui_cli="$(command -v agent-ui 2>/dev/null || true)"
fi
[ -n "$agent_ui_cli" ] || exit 0

# SessionStart JSON arrives on stdin. Registration is best-effort so an older
# Telemachus backend cannot prevent the instructions from loading.
"$agent_ui_cli" session attach \
  --provider codex \
  --stdin \
  --output quiet >/dev/null 2>&1 || true

"$agent_ui_cli" doctor --output quiet >/dev/null 2>&1 || exit 0
instructions=$("$agent_ui_cli" instructions 2>/dev/null) || exit 0
[ -n "$instructions" ] || exit 0

jq -n --arg c "$instructions" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $c
  }
}'
