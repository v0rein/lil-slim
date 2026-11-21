# lil-slim

Lightweight orchestrator + specialist workflow for Claude Code, ported from
[oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim).
Plain markdown, JSON and dependency-free Node scripts: no build, no
`node_modules`.

## What you get

| Piece | Where |
|---|---|
| Agents (17): `orchestrator`; specialists `explorer`, `oracle`, `designer`, `fixer`, `observer`; read-only audits `arbiter`, `hunter`, `janitor`, `paladin`, `proctor`; `validator`, `debugger`; docs `documenter`, `chronicler`; council seats `council`, `councillor` | `agents/*.md` |
| Skills (20): `ai-estimates`, `council`, `deanchor`, `deepwork`, `simplify`, `step-back`, `verification-planning`, `worktrees`; plus the plan-and-execute workflow `brainstorming`, `writing-plans`, `executing-plans`, `subagent-driven-development`, `dispatching-parallel-agents`, `systematic-debugging`, `test-driven-development`, `verification-before-completion`, `requesting-code-review`, `receiving-code-review`, `finishing-a-development-branch`; the session starter `using-lil-slim` | `skills/*/SKILL.md` |
| Hooks: `skill-bootstrap`, `phase-reminder`, `search-path-guard`, `tool-loop-guard`, `absolute-path-rescue`, `readonly-shell-guard` | `hooks/hooks.json`, `hooks/scripts/*.mjs` (launched via `run.sh`) |
| MCP: `context7`, `gh_grep` (no API key) | `.mcp.json` |

Skipped (OpenCode-only): `reflect`, `codemap`, `clonedeps`, the config skill,
`apply_patch`, cache hooks, TUI, multiplexer. See `docs/design.md`.

## Install

Requires Claude Code 2.1.275+. Hooks use a prebuilt binary on Linux, macOS and Windows (x64; arm64 on Linux and macOS), so no Node.js is required there. On other platforms the hooks fall back to Node.js 18+ on `PATH`; with neither, agents and skills still work, the hooks stay silent, and SessionStart tells you once.

From GitHub (marketplace):

```bash
claude plugin marketplace add v0rein/lil-slim
claude plugin install lil-slim@lil-slim-marketplace
```

Try it from a local checkout without installing:

```bash
claude --plugin-dir /path/to/lil-slim
```

## Council

Ask the orchestrator to "convene the council" on a decision. The `council` skill dispatches three `councillor` seats in parallel (opus, sonnet, haiku), then one `council` synthesizer, and returns a report with consensus level and dissent. It costs one call per seat plus one for synthesis (about $0.3 in our test, more with real code); use it for decisions that deserve it. `debugger` needs a debugger MCP or CLI that this plugin does not ship.

## Run the orchestrator

```bash
claude --agent lil-slim:orchestrator
```

or make it the project default in `.claude/settings.json`:

```json
{ "agent": "lil-slim:orchestrator" }
```

Plain `claude` still works: the specialists are available through Claude
Code's own routing (their `description` fields), without the orchestrator and
without the phase reminder.

## Add an agent

Create `agents/<name>.md`. That is all: no registry, no code.

```markdown
---
name: reviewer
description: When Claude should pick this agent, in one or two sentences.
model: sonnet
disallowedTools: Edit, Write, NotebookEdit
skills: [lil-slim:simplify]
---

Prompt body. Do not dispatch other agents.
```

- `name` must equal the filename and contain no `:`.
- `skills:` preloads the full skill text into that agent (max 32). Use the
  prefixed form `lil-slim:<skill>`; a bare name does not resolve to
  this plugin's skill.
- Guard hooks automatically cover any agent that has a file in `agents/`.
- To let the orchestrator route to it, add one line to the `<Agents>` block in
  `agents/orchestrator.md`.

## Add or disable a hook

Hooks are one entry each in `hooks/hooks.json` (command:
`sh "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/run.sh" <script-name>`) plus one script
in `hooks/scripts/`. Remove the entry to disable a hook. Scripts export a pure
`decide(input, deps)` and run it through `runHook` in
`hooks/scripts/lib/hook-io.mjs`, which exits 0 silently on any error, so a hook
bug never blocks your work.

The three guards only act for agents defined in this plugin; plain `claude`
sessions and other plugins' agents are untouched. Loop-guard state lives in
`${CLAUDE_PLUGIN_DATA}` and is capped at 64 small files.

## Safety notes

- **Read-only is enforced, not just requested.** `arbiter`, `hunter` and `proctor` keep `Bash` so they can inspect the repo and run tests; a `PreToolUse` hook (`readonly-shell-guard`) denies shell commands that write: `rm`, `mv`, redirects to files, `git commit/checkout/reset/stash/push`, `sed -i`, package installs, and inline `node -e`/`python -c` that write files. Writes under the OS temp directory are allowed. It is a seatbelt against accidents, not a sandbox: a script file you ask it to run, or a command it cannot parse, is not inspected. `validator` is deliberately not restricted because its job is to run builds and tests, which write artifacts.
- **Permissions:** most testing used `--dangerously-skip-permissions`. One headless run in the default permission mode showed the same hook decisions. Interactive approval prompts, and how the path-rescue hook interacts with your `ask` rules, have not been exercised.
- **Cost:** one large ticket that fans out to many agents cost roughly $12-17 in testing. Use `--max-budget-usd` to cap a session.

## Hooks: prebuilt Rust, Node as fallback

The five guard hooks ship as one small Rust binary per platform in `hooks/bin/` (`linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`, `windows-x64`; about 1-1.5 MB each). `hooks/scripts/run.sh` picks the one for your OS and CPU. **Node.js is not needed** on those platforms.

- **Fallback:** on any other platform, or if the binary cannot start, `run.sh` runs the equivalent Node scripts (Node 18+). If neither is available the hooks stay silent and SessionStart tells you once.
- **Never blocks:** a crashing or missing hook never produces an error exit.
- **Same behavior:** `hooks/rust/parity.mjs` feeds 80 events to both implementations and requires identical output. CI runs it against the committed binaries natively on all five platforms.
- **Integrity:** `hooks/bin/SHA256SUMS` lists every binary, and `hooks/bin/BUILD.json` records a hash of the exact Rust sources they were built from. A test fails if `hooks/rust` changes without the binaries being rebuilt.
- **Built in CI, not on a laptop:** the `binaries` workflow builds all five from the locked sources (static where the platform allows; macOS binaries link only the system libSystem). Rebuild with the workflow, download the artifacts, then `node hooks/rust/update-binaries.mjs <artifacts-dir>` and review the change as a normal pull request.
- **Trust:** the binaries are opaque. To audit one, build `hooks/rust` yourself (`cargo build --release --locked`) and compare its behavior with `parity.mjs`; byte-identical rebuilds are not guaranteed across toolchains. Remove `hooks/bin` to force the Node scripts.

Measured on one Windows machine (30 runs each): about 59 ms per hook call through `run.sh` with the binary versus about 148 ms with Node. Claude Code's own per-hook timing in a real session includes its process launch, so expect a smaller absolute gain.

## Skills load automatically

At session start a hook injects the `lil-slim:using-lil-slim` skill, the same way the original superpowers plugin does: it tells the model to check for a matching skill before any response, and it maps each skill to the lil-slim agent that does the work (brainstorming to `oracle` and `designer`, plan execution to `fixer`, `arbiter` and `validator`, debugging to `explorer` and `debugger`, and so on). It applies to the orchestrator and to a plain session; subagents are left alone. The text comes from `skills/using-lil-slim/SKILL.md`, so editing that file changes it.

- **Turn it off:** set `LIL_SLIM_SKILLS=off`. Skills stay available to call by name.
- **With superpowers installed:** both plugins would inject a mandatory skill-first rule, so use one. Disable superpowers (`/plugin disable superpowers@claude-plugins-official`) or turn this off. The workflow skills here are adapted copies and do not need superpowers.
- **Cost:** about 1.5 KB of extra context per session, and the mandatory wording makes small tasks slower: the skill itself says to skip its full process for trivial changes.

## State directory

The `deepwork` and `worktrees` skills keep their state under `.lil-slim/` in your
project (`.lil-slim/deepwork/<slug>/progress.md`, `.lil-slim/worktrees/<slug>/`,
`.lil-slim/worktrees.json`). Both skills add the paths to `.gitignore` themselves.

## Overlap with other plugins

The `explorer`/`oracle`/`fixer` agents and the `simplify`/`worktrees`/
`verification-planning` skills overlap with Claude Code built-ins and plugins
such as superpowers and caveman. Names are namespaced, so nothing collides, but
routing by `description` may pick another plugin's agent; the orchestrator
always uses the prefixed names. Hooks from other plugins (for example
superpowers' skill-first SessionStart) still run in orchestrator sessions; if
they fight the orchestrator's "act directly when small" rule, disable them for
that session.

## Privacy

This plugin collects nothing and makes no network calls of its own.

`context7` and `gh_grep` are remote MCP servers (`mcp.context7.com`,
`mcp.grep.app`); queries sent through them leave your machine. Remove
`.mcp.json` entries to opt out.

## License

MIT. Adapted from [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) (MIT). The audit, docs, validator, debugger and council agents and the `council` skill come from [slim-claude](https://github.com/aw4e/slim-claude) (MIT) and its upstream authors; see `LICENSE` and `THIRD_PARTY_NOTICES.md`.

## Develop

```bash
node --test
claude plugin validate .
```
