import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = path.join(root, 'skills');
const FORBIDDEN =
  /task_status|task_cancel|task_reply|apply_patch|wait_for_user|OpenCode|oh-my-opencode|@explorer|@fixer|@oracle|@designer|@observer/;

const names = readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

test('exactly the fourteen shipped skills', () => {
  assert.deepEqual(names, [
    'ai-estimates',
    'brainstorming',
    'council',
    'deanchor',
    'finishing-a-development-branch',
    'receiving-code-review',
    'requesting-code-review',
    'subagent-driven-development',
    'systematic-debugging',
    'test-driven-development',
    'using-lil-slim',
    'verification-before-completion',
    'worktrees',
    'writing-plans',
  ]);
});

test('each SKILL.md has name = dir, description, and no OpenCode vocabulary', () => {
  for (const n of names) {
    const text = readFileSync(path.join(skillsDir, n, 'SKILL.md'), 'utf8');
    const m = text.match(/^---\nname: (.+)\ndescription: (.+)\n---\n/);
    assert.ok(m, `${n}: frontmatter`);
    assert.equal(m[1].trim(), n);
    assert.ok(m[2].trim().length > 10, n);
    assert.doesNotMatch(text, FORBIDDEN, n);
  }
});

test('no OpenCode-era branch prefix or activation-prompt wording', () => {
  const wt = readFileSync(path.join(skillsDir, 'worktrees', 'SKILL.md'), 'utf8');
  const dw = readFileSync(path.join(skillsDir, 'subagent-driven-development', 'references', 'multi-phase.md'), 'utf8');
  assert.doesNotMatch(wt, /omos\//);
  assert.doesNotMatch(dw, /activation\s+prompt/);
  assert.doesNotMatch(dw, /<session-id>/);
});

test('skills carry no repo-specific leftovers from the OpenCode source', () => {
  const read = (n) => readFileSync(path.join(skillsDir, n, 'SKILL.md'), 'utf8');
  for (const n of names) {
    assert.doesNotMatch(read(n), /\.slim\b/, `${n}: .slim/ path`);
  }
});

test('multi-phase work and worktrees use the plugin-owned .lil-slim/ state directory', () => {
  const dw = readFileSync(path.join(skillsDir, 'subagent-driven-development', 'references', 'multi-phase.md'), 'utf8');
  const wt = readFileSync(path.join(skillsDir, 'worktrees', 'SKILL.md'), 'utf8');
  assert.match(dw, /\.lil-slim\/phases\//);
  assert.match(wt, /\.lil-slim\/worktrees\//);
  assert.match(wt, /\.lil-slim\/worktrees\.json/);
  assert.doesNotMatch(wt, /\.claude\/worktrees/);
});

test('worktrees skill speaks to Claude Code, not an OpenCode "Orchestrator" role name', () => {
  const wt = readFileSync(path.join(skillsDir, 'worktrees', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(wt, /OMO|omos/);
  assert.match(wt, /lil-slim:orchestrator/);
});

test('council skill dispatches councillor seats then the council synthesizer by prefixed name', () => {
  const c = readFileSync(path.join(skillsDir, 'council', 'SKILL.md'), 'utf8');
  assert.match(c, /lil-slim:councillor/);
  assert.match(c, /lil-slim:council\b/);
  assert.doesNotMatch(c, /slim-claude/);
  assert.match(c, /parallel/i);
  assert.match(c, /## Council Response/);
});
