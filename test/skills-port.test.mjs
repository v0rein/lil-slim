import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const posix = (p) => p.split(path.sep).join('/');
const CORE = [
  'brainstorming', 'dispatching-parallel-agents', 'executing-plans', 'finishing-a-development-branch',
  'receiving-code-review', 'requesting-code-review', 'subagent-driven-development', 'systematic-debugging',
  'test-driven-development', 'verification-before-completion', 'writing-plans',
];

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const coreFiles = () => CORE.flatMap((n) => files(path.join(root, 'skills', n)));
const text = (f) => readFileSync(f, 'utf8');

function findBash() {
  const c = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'] : ['/bin/bash', '/usr/bin/bash'];
  return c.find((x) => existsSync(x));
}

test('the eleven workflow skills ship with a SKILL.md each', () => {
  for (const n of CORE) assert.ok(existsSync(path.join(root, 'skills', n, 'SKILL.md')), n);
});

test('no trace of the original plugin name, its state dir, or generic agents remains', () => {
  for (const f of coreFiles()) {
    const t = text(f);
    const rel = path.relative(root, f);
    assert.doesNotMatch(t, /superpowers/i, `${rel}: mentions superpowers`);
    assert.doesNotMatch(t, /general-purpose/, `${rel}: generic agent`);
    assert.doesNotMatch(t, /visual.companion/i, `${rel}: visual companion`);
  }
});

test('every lil-slim:<name> reference resolves to a shipped skill or agent', () => {
  const skills = new Set(readdirSync(path.join(root, 'skills')));
  const agents = new Set(readdirSync(path.join(root, 'agents')).map((f) => f.replace(/\.md$/, '')));
  for (const f of coreFiles()) {
    for (const m of text(f).matchAll(/lil-slim:([a-z][a-z0-9-]*)/g)) {
      assert.ok(skills.has(m[1]) || agents.has(m[1]), `${path.relative(root, f)}: unknown lil-slim:${m[1]}`);
    }
  }
});

test('helper scripts run through run.sh sdd, never as bare bash scripts', () => {
  for (const f of coreFiles().filter((x) => x.endsWith('.md'))) {
    const t = text(f);
    const rel = path.relative(root, f);
    assert.doesNotMatch(t, /bash scripts\//, `${rel}: bash scripts/`);
    assert.doesNotMatch(t, /`scripts\/(task-start|task-done|task-brief|review-package|sdd-workspace|sdd-repo)/, `${rel}: bare script path`);
    assert.doesNotMatch(t, /\.\.\/subagent-driven-development\/scripts/, `${rel}: relative script path`);
  }
  for (const n of ['executing-plans', 'subagent-driven-development']) {
    const t = text(path.join(root, 'skills', n, 'SKILL.md'));
    assert.match(t, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/scripts\/run\.sh" sdd/, `${n}: no resolved sdd command`);
  }
  assert.ok(!existsSync(path.join(root, 'skills', 'subagent-driven-development', 'scripts')), 'bash scripts must not ship');
  assert.ok(!existsSync(path.join(root, 'skills', 'executing-plans', 'scripts')), 'bash scripts must not ship');
});

test('delegation targets are lil-slim agents', () => {
  const need = {
    'subagent-driven-development/implementer-prompt.md': 'lil-slim:fixer',
    'subagent-driven-development/task-reviewer-prompt.md': 'lil-slim:arbiter',
    'subagent-driven-development/re-review-prompt.md': 'lil-slim:arbiter',
    'requesting-code-review/code-reviewer.md': 'lil-slim:arbiter',
    'brainstorming/builder-check-prompt.md': 'lil-slim:oracle',
  };
  for (const [f, agent] of Object.entries(need)) {
    assert.match(text(path.join(root, 'skills', f)), new RegExp(agent), f);
  }
});

test('plan and spec output locations use the lil-slim docs folder', () => {
  assert.match(text(path.join(root, 'skills', 'writing-plans', 'SKILL.md')), /docs\/lil-slim\/plans\//);
  assert.match(text(path.join(root, 'skills', 'brainstorming', 'SKILL.md')), /docs\/lil-slim\/specs\//);
});

// ---- run.sh sdd mode -------------------------------------------------------
function tree(fake) {
  const d = mkdtempSync(path.join(tmpdir(), 'lil-sdd-'));
  mkdirSync(path.join(d, 'hooks', 'scripts'), { recursive: true });
  copyFileSync(path.join(root, 'hooks', 'scripts', 'run.sh'), path.join(d, 'hooks', 'scripts', 'run.sh'));
  if (fake !== undefined) {
    const dir = path.join(d, 'hooks', 'bin', 'linux-x64');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'lil-hook'), fake);
    chmodSync(path.join(dir, 'lil-hook'), 0o755);
  }
  return d;
}
const runSdd = (d, args) =>
  spawnSync(findBash(), ['-c', `sh "${posix(path.join(d, 'hooks', 'scripts', 'run.sh'))}" sdd ${args}`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, LIL_HOOK_PLATFORM: 'linux-x64' },
  });

test('run.sh sdd passes every argument to the binary and propagates its exit status', (t) => {
  if (!findBash()) return t.skip('no bash');
  const d = tree('#!/bin/sh\nprintf "ARGS:%s|" "$@"\nexit 3\n');
  const r = runSdd(d, 'task-brief plan.md 7');
  assert.equal(r.status, 3);
  assert.equal(r.stdout, 'ARGS:sdd|ARGS:task-brief|ARGS:plan.md|ARGS:7|');
});

test('run.sh sdd without a platform binary fails loudly instead of staying silent', (t) => {
  if (!findBash()) return t.skip('no bash');
  const r = runSdd(tree(), 'task-brief plan.md 1');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no prebuilt binary/i);
  assert.equal(r.stdout, '');
});

test('run.sh sdd never falls back to Node (there is no Node implementation)', () => {
  assert.equal(existsSync(path.join(root, 'hooks', 'scripts', 'sdd.mjs')), false);
});

test('adapted wording reads naturally: no stray commas, no nested parentheses, no dangling references', () => {
  for (const f of coreFiles().filter((x) => x.endsWith('.md'))) {
    const t = text(f);
    const rel = path.relative(root, f);
    assert.doesNotMatch(t, /working tree, you're executing in/, `${rel}: stray comma`);
    assert.doesNotMatch(t, /there is none to rely on/, `${rel}: placeholder wording`);
    assert.doesNotMatch(t, /using-superpowers/, `${rel}: dangling reference`);
    assert.doesNotMatch(t, /command from SKILL\.md \(arguments/, `${rel}: nested parentheses`);
  }
});

test('companion files never carry an unresolved CLAUDE_PLUGIN_ROOT placeholder', () => {
  for (const f of coreFiles().filter((x) => x.endsWith('.md') && !x.endsWith('SKILL.md'))) {
    assert.doesNotMatch(text(f), /CLAUDE_PLUGIN_ROOT/, path.relative(root, f));
  }
});
