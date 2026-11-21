import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { decide } from '../hooks/scripts/skill-bootstrap.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const SKILL = 'skills/using-lil-slim/SKILL.md';
const WORKFLOW = [
  'brainstorming', 'writing-plans', 'executing-plans', 'subagent-driven-development',
  'dispatching-parallel-agents', 'systematic-debugging', 'test-driven-development',
  'verification-before-completion', 'requesting-code-review', 'receiving-code-review',
  'finishing-a-development-branch',
];
const ctx = (out) => out?.hookSpecificOutput?.additionalContext;
const start = (over = {}) => ({ hook_event_name: 'SessionStart', ...over });

// ---- the skill ------------------------------------------------------------
test('using-lil-slim is a real skill with the right name and trigger', () => {
  const t = read(SKILL);
  assert.match(t, /^---\nname: using-lil-slim\ndescription: Use when starting any conversation/);
});

test('it routes every workflow skill and names the agent that does the work', () => {
  const t = read(SKILL);
  for (const s of [...WORKFLOW, 'deepwork', 'council', 'worktrees']) assert.match(t, new RegExp(`lil-slim:${s}`), s);
  for (const a of ['oracle', 'designer', 'explorer', 'fixer', 'arbiter', 'validator', 'debugger', 'hunter', 'paladin', 'proctor', 'janitor']) {
    assert.match(t, new RegExp(`\`${a}\``), `agent ${a} not mentioned`);
  }
});

test('it keeps the superpowers rule strength: mandatory, with red flags and user precedence', () => {
  const t = read(SKILL);
  assert.match(t, /1% chance/);
  assert.match(t, /ABSOLUTELY MUST invoke/);
  assert.match(t, /SUBAGENT-STOP/);
  assert.match(t, /Red Flags/);
  assert.match(t, /User instructions .* take precedence/);
});

test('every lil-slim:<name> in it resolves, and nothing mentions the original plugin', () => {
  const t = read(SKILL);
  assert.doesNotMatch(t, /superpowers/i);
  const skills = new Set(readdirSync(path.join(root, 'skills')));
  const agents = new Set(readdirSync(path.join(root, 'agents')).map((f) => f.replace(/\.md$/, '')));
  for (const m of t.matchAll(/lil-slim:([a-z][a-z0-9-]*)/g)) assert.ok(skills.has(m[1]) || agents.has(m[1]), m[1]);
});

test('it stays small, because it is injected at the start of every session', () => {
  assert.ok(Buffer.byteLength(read(SKILL)) < 6000);
});

// ---- the hook -------------------------------------------------------------
test('SessionStart for the orchestrator injects the skill, wrapped like the original', () => {
  const out = decide(start({ agent_type: 'lil-slim:orchestrator' }));
  const c = ctx(out);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(c, /^<EXTREMELY_IMPORTANT>\nYou have lil-slim skills\./);
  assert.match(c, /lil-slim:using-lil-slim/);
  assert.match(c, /ABSOLUTELY MUST invoke/);
  assert.match(c, /<\/EXTREMELY_IMPORTANT>$/);
});

test('the injected text has no frontmatter and no carriage returns', () => {
  const c = ctx(decide(start({ agent_type: 'lil-slim:orchestrator' })));
  assert.doesNotMatch(c, /name: using-lil-slim/);
  assert.doesNotMatch(c, /\r/);
});

test('a plain session (no agent_type) gets it too, like the original', () => {
  assert.ok(ctx(decide(start())));
});

test('other agents, other plugins, and other events get nothing', () => {
  assert.equal(decide(start({ agent_type: 'lil-slim:explorer' })), null);
  assert.equal(decide(start({ agent_type: 'other:orchestrator' })), null);
  assert.equal(decide(start({ agent_type: 'orchestrator' })), null);
  assert.equal(decide({ hook_event_name: 'PreToolUse' }), null);
  assert.equal(decide({}), null);
});

test('LIL_SLIM_SKILLS=off (or 0/false/no) switches it off', () => {
  for (const v of ['off', 'OFF', '0', 'false', 'no']) {
    assert.equal(decide(start(), { env: { LIL_SLIM_SKILLS: v } }), null, v);
  }
  assert.ok(ctx(decide(start(), { env: { LIL_SLIM_SKILLS: 'on' } })));
});

test('a missing or empty skill file never breaks the session', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'lil-boot-'));
  assert.equal(decide(start(), { root: d, env: {} }), null);
  mkdirSync(path.join(d, 'skills', 'using-lil-slim'), { recursive: true });
  writeFileSync(path.join(d, 'skills', 'using-lil-slim', 'SKILL.md'), '---\nname: x\n---\n');
  assert.equal(decide(start(), { root: d, env: {} }), null);
});

// ---- wiring ---------------------------------------------------------------
test('hooks.json runs skill-bootstrap on SessionStart through run.sh', () => {
  const hooks = JSON.parse(read('hooks/hooks.json')).hooks;
  const g = hooks.SessionStart.find((x) => x.hooks.some((h) => /skill-bootstrap/.test(h.command)));
  assert.ok(g, 'no skill-bootstrap group');
  assert.equal(g.matcher, 'startup|resume|clear|compact');
  assert.match(g.hooks[0].command, /run\.sh" skill-bootstrap/);
});

test('the orchestrator no longer carries its own copy of the routing', () => {
  const o = read('agents/orchestrator.md');
  assert.doesNotMatch(o, /<Skills>/);
  assert.doesNotMatch(o, /prefer a working result now over a perfect plan later/);
});

test('README explains the automatic skill loading and how to avoid doubling it', () => {
  const r = read('README.md');
  assert.match(r, /using-lil-slim/);
  assert.match(r, /LIL_SLIM_SKILLS/);
  assert.match(r, /disable superpowers|superpowers.*disable/i);
});
