---
name: using-lil-slim
description: Use when starting any conversation - establishes how to find and use skills and which lil-slim agent does the work for each, requiring skill invocation before ANY response including clarifying questions
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, ignore this skill.
</SUBAGENT-STOP>

<EXTREMELY-IMPORTANT>
If a skill plausibly applies to what you are doing, you ABSOLUTELY MUST invoke the skill.

IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.

The one exception: a small, clear change you already hold the context for (a rename, a one-file fix with an obvious cause). Do it and verify it. Anything vague, new, multi-step, or failing for an unknown reason is not small.
</EXTREMELY-IMPORTANT>

## The Rule

**Invoke relevant or requested skills BEFORE any response or action**, including clarifying questions, exploring the codebase, or checking files. If it turns out wrong for the situation, you don't have to follow it. A skill's own text may say a task is too small for its full process; follow that.

Then announce "Using [skill] to [purpose]" and follow the skill exactly.

## Skills decide WHEN, lil-slim agents decide WHO

Skills set the process. The agents do the work: dispatch them with the Agent tool as `lil-slim:<name>`, as the skill says.

| Situation | Skill | Agents it uses |
|---|---|---|
| New feature, vague or undecided request | `lil-slim:brainstorming` | `oracle` (builder check), `designer` (UI mockups) |
| Settled spec, multi-step work | `lil-slim:writing-plans` | `explorer` (recon) |
| A plan file exists, or a large multi-phase effort | `lil-slim:subagent-driven-development` | `fixer` implements, `arbiter` reviews, `validator` runs tests |
| Bug, failing test, odd behavior, patches piling up | `lil-slim:systematic-debugging` | `explorer`, `debugger` (runtime), `validator` |
| Writing code | `lil-slim:test-driven-development` | `fixer` |
| About to claim done or passing | `lil-slim:verification-before-completion` | `validator` |
| Work needs review, or feedback arrives | `lil-slim:requesting-code-review`, `lil-slim:receiving-code-review` | `arbiter`, plus `hunter`, `paladin`, `proctor`, `janitor` |
| Tests pass, decide how to integrate | `lil-slim:finishing-a-development-branch` | none |
| High-stakes decision | `lil-slim:council` | `councillor`, `council` |
| Parallel or risky work needs isolation | `lil-slim:worktrees` | none |

## Cost discipline

Skills and their ledgers cost context on every later call. Spend it where it pays. You still run the tests, review, and verify; this only avoids doing the same thing twice.

- **A plan that already says to write the failing test first**, run it, then implement, already contains the TDD loop. Follow the plan and do not load `lil-slim:test-driven-development`.
- **Small plans, up to 3 tasks:** skip the `sdd workspace` and its ledger. Work the tasks in order, commit each, run the tests yourself, and review once at the end.
- **4 or more tasks, or any plan that may be interrupted** (long running, risky, spans compaction): keep the full process with the ledger so work can resume.

## Commits

When you or an agent makes a commit, write the message and nothing else: do not add a `Co-Authored-By: Claude Code` trailer or any other attribution line. The repository's own contributor list stays the author's.

## Skill Priority

When several skills apply, process skills come first (brainstorming, systematic-debugging), then implementation skills.

- "Let's build X" means brainstorming first, then the planning and implementation skills.
- "Fix this bug" means systematic-debugging first, then the domain skills.

## Red Flags

These thoughts mean STOP, you're rationalizing:

| Thought | Reality |
|---|---|
| "This is just a simple question" | Questions are tasks. Check for skills. |
| "I need more context first" | Skill check comes BEFORE clarifying questions. |
| "Let me explore the codebase first" | Skills tell you HOW to explore. Check first. |
| "I can check git/files quickly" | Files lack conversation context. Check for skills. |
| "I remember this skill" | Skills evolve. Read the current version. |
| "The skill is overkill" | Only a small, clear change skips it. Vague or multi-step is not small. |
| "I'll just do this one thing first" | Check BEFORE doing anything. |
| "I'll do it all myself, no agents" | The skill names the agent for each step. Dispatch it. |

## User Instructions

User instructions (CLAUDE.md, direct requests) take precedence over skills, which in turn override default behavior. Only skip a skill's workflow when the user has explicitly told you to.
