#!/bin/sh
# Runs a plugin hook script with Node. When Node is missing, stay silent
# (exit 0) so tools never see hook errors; SessionStart gets one notice.
# usage: run.sh <script-name-without-ext> [--notice]
script="$1"
if command -v node >/dev/null 2>&1; then
  exec node "$(dirname "$0")/${script}.mjs"
fi
if [ "${2:-}" = "--notice" ]; then
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"lil-slim: Node.js 18+ was not found on PATH, so the guard hooks are inactive for this session. Agents and skills still work. Install Node.js to enable them."}}'
fi
exit 0
