#!/bin/sh
# Runs a plugin hook. Order: the prebuilt Rust binary for this OS/arch
# (hooks/bin/<platform>/lil-hook[.exe], needs no Node), then the Node script,
# then silence. Hooks must never block the user's work, so a binary that is
# missing, unrunnable or crashing never produces an error exit.
# usage: run.sh <script-name-without-ext> [--notice]
script="$1"
case "$0" in */*) here="${0%/*}" ;; *) here="." ;; esac

# Platform: LIL_HOOK_PLATFORM overrides (tests). Windows is detected from the
# environment to avoid spawning uname there, where process starts are costly.
plat="${LIL_HOOK_PLATFORM:-}"
if [ -z "$plat" ]; then
  if [ "${OS:-}" = "Windows_NT" ]; then
    case "${PROCESSOR_ARCHITECTURE:-}" in AMD64 | x86_64) plat=windows-x64 ;; esac
  else
    case "$(uname -sm 2>/dev/null)" in
      "Linux x86_64") plat=linux-x64 ;;
      "Linux aarch64" | "Linux arm64") plat=linux-arm64 ;;
      "Darwin arm64") plat=darwin-arm64 ;;
      "Darwin x86_64") plat=darwin-x64 ;;
      MINGW*" x86_64" | MSYS*" x86_64" | CYGWIN*" x86_64") plat=windows-x64 ;;
    esac
  fi
fi

bin="${LIL_HOOK_BIN:-}"
if [ -z "$bin" ] && [ -n "$plat" ]; then
  case "$plat" in windows-*) exe=lil-hook.exe ;; *) exe=lil-hook ;; esac
  bin="$here/../bin/$plat/$exe"
fi

if [ -n "$bin" ] && [ -x "$bin" ]; then
  "$bin" "$script"
  st=$?
  # 126/127: the binary could not be started at all (stdin untouched), so
  # fall through to Node. Anything else means it ran: never surface its status.
  case "$st" in 126 | 127) ;; *) exit 0 ;; esac
fi

if command -v node >/dev/null 2>&1; then
  exec node "$here/${script}.mjs"
fi
if [ "${2:-}" = "--notice" ]; then
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"lil-slim: no prebuilt hook binary matches this platform and Node.js 18+ was not found on PATH, so the guard hooks are inactive for this session. Agents and skills still work. Install Node.js to enable them."}}'
fi
exit 0
