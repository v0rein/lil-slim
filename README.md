# lil-slim

Lightweight orchestrator + specialist workflow for Claude Code, ported from
[oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim).
Plain markdown, JSON and dependency-free Node scripts: no build, no
`node_modules`.

## What you get

| Piece | Where |
|---|---|
| Agents (17): `orchestrator`; specialists `explorer`, `oracle`, `designer`, `fixer`, `observer`; read-only audits `arbiter`, `hunter`, `janitor`, `paladin`, `proctor`; `validator`, `debugger`; docs `documenter`, `chronicler`; council seats `council`, `councillor` | `agents/*.md` |
| Skills: `ai-estimates`, `council`, `deanchor`, `deepwork`, `simplify`, `step-back`, `verification-planning`, `worktrees` | `skills/*/SKILL.md` |
| Guard hooks: `phase-reminder`, `search-path-guard`, `tool-loop-guard`, `absolute-path-rescue` | `hooks/hooks.json`, `hooks/scripts/*.mjs` (launched via `run.sh`) |
| MCP: `context7`, `gh_grep` (no API key) | `.mcp.json` |

Skipped (OpenCode-only): `reflect`, `codemap`, `clonedeps`, the config skill,
`apply_patch`, cache hooks, TUI, multiplexer. See `docs/design.md`.

## Install

Requires Claude Code 2.1.275+. The guard hooks also need
[Node.js 18+](https://nodejs.org) on `PATH`; without it the agents and skills
still work, the hooks stay silent, and SessionStart tells you once that they
are inactive.

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
