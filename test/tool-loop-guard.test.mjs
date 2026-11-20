import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BLOCK_AT,
  MAX_STATE_FILES,
  WARN_AT,
  decide,
  fingerprint,
} from '../hooks/scripts/tool-loop-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsSrc = path.join(here, '..', 'hooks', 'scripts');

const agentsDir = mkdtempSync(path.join(tmpdir(), 'omcs-loop-agents-'));
writeFileSync(path.join(agentsDir, 'explorer.md'), '---\nname: explorer\n---\n');

const fresh = () => ({
  agentsDir,
  dir: mkdtempSync(path.join(tmpdir(), 'omcs-loop-state-')),
});
const ev = (event, over = {}) => ({
  hook_event_name: event,
  session_id: 's1',
  agent_type: 'lil-slim:explorer',
  tool_name: 'Read',
  tool_input: { file_path: '/a' },
  tool_response: { content: 'same' },
  ...over,
});
const post = (deps, over) => decide(ev('PostToolUse', over), deps);
const pre = (deps, over) => decide(ev('PreToolUse', over), deps);

test('constants match the source repo', () => {
  assert.equal(WARN_AT, 3);
  assert.equal(BLOCK_AT, 5);
  assert.equal(MAX_STATE_FILES, 64);
});

test('fingerprint ignores key order, differs on args and tool', () => {
  assert.equal(
    fingerprint('Read', { a: 1, b: { c: 2, d: 3 } }),
    fingerprint('Read', { b: { d: 3, c: 2 }, a: 1 }),
  );
  assert.notEqual(fingerprint('Read', { a: 1 }), fingerprint('Read', { a: 2 }));
  assert.notEqual(fingerprint('Read', { a: 1 }), fingerprint('Grep', { a: 1 }));
});

test('warns on the 3rd identical call, not before', () => {
  const d = fresh();
  assert.equal(post(d), null);
  assert.equal(post(d), null);
  const out = post(d);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /3 times/);
});

test('blocks the next identical read-only call after 5 confirmed repeats', () => {
  const d = fresh();
  for (let i = 0; i < 4; i += 1) {
    post(d);
    assert.equal(pre(d), null, `pre after ${i + 1}`);
  }
  post(d);
  const out = pre(d);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /5 times/);
});

test('PreToolUse never advances the counter', () => {
  const d = fresh();
  for (let i = 0; i < 10; i += 1) pre(d);
  assert.equal(post(d), null);
  assert.equal(post(d), null);
  assert.notEqual(post(d), null);
});

test('non-read tools only warn, never block', () => {
  const d = fresh();
  const bash = { tool_name: 'Bash', tool_input: { command: 'ls' } };
  for (let i = 0; i < 6; i += 1) post(d, bash);
  assert.equal(pre(d, bash), null);
});

test('changed output or args resets the run', () => {
  const d = fresh();
  post(d);
  post(d);
  post(d, { tool_response: { content: 'new' } });
  assert.equal(post(d, { tool_response: { content: 'new' } }), null);
  post(d, { tool_input: { file_path: '/b' } });
  assert.equal(post(d, { tool_input: { file_path: '/b' } }), null);
});

test('state is keyed by session and agent_id', () => {
  const d = fresh();
  for (let i = 0; i < 3; i += 1) post(d, { session_id: 'A' });
  assert.equal(post(d, { session_id: 'B' }), null);
  for (let i = 0; i < 2; i += 1) post(d, { agent_id: 'x1' });
  assert.equal(post(d, { agent_id: 'x2' }), null);
});

test('Task, Agent, non-plugin and agent-less sessions are ignored', () => {
  const d = fresh();
  for (const over of [
    { tool_name: 'Task' },
    { tool_name: 'Agent' },
    { agent_type: 'ghost' },
    { agent_type: undefined },
  ]) {
    for (let i = 0; i < 6; i += 1) assert.equal(post(d, over), null);
    assert.equal(pre(d, over), null);
  }
});

test('corrupt state file is treated as empty', () => {
  const d = fresh();
  post(d);
  for (const f of readdirSync(d.dir)) {
    writeFileSync(path.join(d.dir, f), '{{{');
  }
  assert.equal(post(d), null);
  assert.equal(post(d), null);
  assert.notEqual(post(d), null);
});

test('state files are capped at MAX_STATE_FILES, oldest evicted', () => {
  const d = fresh();
  for (let i = 0; i < MAX_STATE_FILES + 6; i += 1) {
    post(d, { session_id: `sess-${i}` });
    const files = readdirSync(d.dir).filter((f) => f.startsWith('loop-'));
    for (const [n, f] of files.entries()) {
      const t = new Date(Date.now() - (files.length - n) * 1000);
      utimesSync(path.join(d.dir, f), t, t);
    }
  }
  const files = readdirSync(d.dir).filter((f) => f.startsWith('loop-'));
  assert.ok(files.length <= MAX_STATE_FILES, `got ${files.length}`);
});

test('malformed events never throw', () => {
  const d = fresh();
  assert.equal(decide({}, d), null);
  assert.equal(decide(ev('PostToolUse', { tool_input: undefined }), d), null);
  assert.equal(decide(ev('Stop'), d), null);
});

test('e2e: 3rd identical PostToolUse through the CLI warns', () => {
  const plugin = mkdtempSync(path.join(tmpdir(), 'omcs-plugin-'));
  const scripts = path.join(plugin, 'hooks', 'scripts');
  mkdirSync(path.join(scripts, 'lib'), { recursive: true });
  mkdirSync(path.join(plugin, 'agents'));
  writeFileSync(
    path.join(plugin, 'agents', 'explorer.md'),
    '---\nname: explorer\n---\n',
  );
  for (const f of ['tool-loop-guard.mjs', 'lib/hook-io.mjs']) {
    copyFileSync(path.join(scriptsSrc, f), path.join(scripts, f));
  }
  const data = mkdtempSync(path.join(tmpdir(), 'omcs-data-'));
  let last;
  for (let i = 0; i < 3; i += 1) {
    last = spawnSync(
      process.execPath,
      [path.join(scripts, 'tool-loop-guard.mjs')],
      {
        input: JSON.stringify(ev('PostToolUse')),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PLUGIN_DATA: data },
      },
    );
    assert.equal(last.status, 0);
  }
  assert.match(
    JSON.parse(last.stdout).hookSpecificOutput.additionalContext,
    /3 times/,
  );
});

test('timing fields in Glob responses do not defeat repeat detection', () => {
  const d = fresh();
  const glob = { tool_name: 'Glob', tool_input: { pattern: '*.ts' } };
  let out = null;
  for (let i = 0; i < 5; i += 1) {
    out = post(d, {
      ...glob,
      tool_response: { filenames: ['a.ts'], durationMs: 40 + i, numFiles: 1 },
    });
  }
  assert.notEqual(out, null);
  assert.equal(
    pre(d, glob).hookSpecificOutput.permissionDecision,
    'deny',
  );
});

test('polling tools are exempt from the loop warning', () => {
  const d = fresh();
  for (const tool_name of ['TaskOutput', 'BashOutput', 'Monitor', 'TaskStop']) {
    for (let i = 0; i < 6; i += 1) {
      assert.equal(post(d, { tool_name }), null, tool_name);
    }
  }
});

test('concurrent writers leave no temp files and never throw', async () => {
  const d = fresh();
  const { fork } = await import('node:child_process');
  const worker = path.join(d.dir, 'w.mjs');
  writeFileSync(
    worker,
    `import { decide } from ${JSON.stringify(
      new URL('../hooks/scripts/tool-loop-guard.mjs', import.meta.url).href,
    )};
const [dir, agentsDir] = process.argv.slice(2);
for (let i = 0; i < 25; i += 1) {
  decide({ hook_event_name: 'PostToolUse', session_id: 's', agent_type: 'lil-slim:explorer', tool_name: 'Read', tool_input: { file_path: '/a' }, tool_response: { c: 1 } }, { dir, agentsDir });
}`,
  );
  await Promise.all(
    Array.from(
      { length: 6 },
      () =>
        new Promise((resolve, reject) => {
          const c = fork(worker, [d.dir, d.agentsDir]);
          c.on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`exit ${code}`)),
          );
        }),
    ),
  );
  assert.deepEqual(
    readdirSync(d.dir).filter((f) => f.endsWith('.tmp')),
    [],
  );
});
