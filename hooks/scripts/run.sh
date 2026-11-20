#!/bin/sh
# Runs a plugin hook. Prefers the optional Rust binary (no Node needed, about
# 2.5x faster per call when measured on Windows); falls back to the Node script.
# When neither is available, stay silent (exit 0) so tools never see hook
# errors; SessionStart gets one notice.
# usage: run.sh <script-name-without-ext> [--notice]
script="$1"
# parameter expansion, not $(dirname): avoids a process spawn per hook call
case "$0" in */*) here="${0%/*}" ;; *) here="." ;; esac

# The binary is found via $LIL_HOOK_BIN or <plugin>/hooks/bin/lil-hook[.exe].
bin="${LIL_HOOK_BIN:-}"
if [ -z "$bin" ]; then
  for c in "$here/../bin/lil-hook" "$here/../bin/lil-hook.exe"; do
    if [ -x "$c" ]; then bin="$c"; break; fi
  done
fi
if [ -n "$bin" ] && [ -x "$bin" ]; then
  exec "$bin" "$script"
fi

if command -v node >/dev/null 2>&1; then
  exec node "$here/${script}.mjs"
fi
if [ "${2:-}" = "--notice" ]; then
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"lil-slim: Node.js 18+ was not found on PATH, so the guard hooks are inactive for this session. Agents and skills still work. Install Node.js to enable them."}}'
fi
exit 0
