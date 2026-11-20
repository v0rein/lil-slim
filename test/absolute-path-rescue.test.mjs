import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  decide,
  findRescuedSuffix,
} from '../hooks/scripts/absolute-path-rescue.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'hooks', 'scripts', 'absolute-path-rescue.mjs');

const agentsDir = mkdtempSync(path.join(tmpdir(), 'omcs-rescue-agents-'));
writeFileSync(path.join(agentsDir, 'explorer.md'), '---\nname: explorer\n---\n');

const WS = '/home/u/Work/Parent/Child/Project';
const CAND = `${WS}/src/a.ts`;
const posix = path.posix;

test('findRescuedSuffix re-anchors a guess with dropped parents', () => {
  const r = findRescuedSuffix(
    '/home/u/Work/Project/src/a.ts',
    WS,
    posix,
    (p) => p === CAND,
  );
  assert.equal(r, CAND);
});

test('findRescuedSuffix returns null for paths already under the workspace', () => {
  assert.equal(findRescuedSuffix(`${WS}/nope.ts`, WS, posix, () => true), null);
});

test('findRescuedSuffix returns null when the tail does not exist', () => {
  assert.equal(
    findRescuedSuffix('/home/u/Work/Project/src/a.ts', WS, posix, () => false),
    null,
  );
});

test('findRescuedSuffix returns null on ambiguous anchor', () => {
  assert.equal(
    findRescuedSuffix('/x/Project/y/Project/src/a.ts', WS, posix, () => true),
    null,
  );
});

test('findRescuedSuffix returns null when guess contains ..', () => {
  assert.equal(
    findRescuedSuffix('/home/u/Work/Project/../src/a.ts', WS, posix, () => true),
    null,
  );
});

test('findRescuedSuffix handles win32 forward-slash guesses', () => {
  const win = path.win32;
  const r = findRescuedSuffix(
    'C:/Users/proj/src/a.ts',
    'C:\\Users\\u\\proj',
    win,
    (p) => p === 'C:\\Users\\u\\proj\\src\\a.ts',
  );
  assert.equal(r, 'C:\\Users\\u\\proj\\src\\a.ts');
});

const base = (over = {}) => ({
  agent_type: 'lil-slim:explorer',
  cwd: WS,
  tool_name: 'Read',
  tool_input: {
    file_path: '/home/u/Work/Project/src/a.ts',
    offset: 5,
    limit: 10,
  },
  ...over,
});
const deps = {
  agentsDir,
  pathOps: posix,
  isMissing: () => true,
  exists: (p) => p === CAND,
};

test('decide rewrites Read file_path and keeps other input keys', () => {
  const out = decide(base(), deps);
  assert.deepEqual(out.hookSpecificOutput.updatedInput, {
    file_path: CAND,
    offset: 5,
    limit: 10,
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
});

test('decide rewrites Grep path', () => {
  const out = decide(
    base({
      tool_name: 'Grep',
      tool_input: { pattern: 'x', path: '/home/u/Work/Project/src/a.ts' },
    }),
    deps,
  );
  assert.deepEqual(out.hookSpecificOutput.updatedInput, {
    pattern: 'x',
    path: CAND,
  });
});

test('decide ignores other tools, relative paths, non-plugin agents', () => {
  assert.equal(decide(base({ tool_name: 'Edit' }), deps), null);
  assert.equal(
    decide(base({ tool_input: { file_path: 'src/a.ts' } }), deps),
    null,
  );
  assert.equal(decide(base({ agent_type: undefined }), deps), null);
  assert.equal(decide(base({ agent_type: 'ghost' }), deps), null);
});

test('decide does nothing when the path is not plainly missing', () => {
  assert.equal(decide(base(), { ...deps, isMissing: () => false }), null);
});

test('decide tolerates malformed tool_input and cwd', () => {
  assert.equal(decide(base({ tool_input: null }), deps), null);
  assert.equal(decide(base({ tool_input: { file_path: 5 } }), deps), null);
  assert.equal(decide(base({ cwd: undefined }), deps), null);
});

test('e2e: rescues a real dropped-parent path through the CLI', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'omcs-rescue-')));
  const ws = path.join(root, 'Parent', 'Child', 'Project');
  mkdirSync(path.join(ws, 'src'), { recursive: true });
  writeFileSync(path.join(ws, 'src', 'a.ts'), 'x');
  const guess = path.join(root, 'Project', 'src', 'a.ts');

  // Self-contained plugin copy so agent lookup is deterministic.
  const plugin = mkdtempSync(path.join(tmpdir(), 'omcs-plugin-'));
  mkdirSync(path.join(plugin, 'agents'));
  writeFileSync(
    path.join(plugin, 'agents', 'explorer.md'),
    '---\nname: explorer\n---\n',
  );
  const scripts = path.join(plugin, 'hooks', 'scripts');
  mkdirSync(path.join(scripts, 'lib'), { recursive: true });
  copyFileSync(script, path.join(scripts, 'absolute-path-rescue.mjs'));
  copyFileSync(
    path.join(path.dirname(script), 'lib', 'hook-io.mjs'),
    path.join(scripts, 'lib', 'hook-io.mjs'),
  );

  const r = spawnSync(
    process.execPath,
    [path.join(scripts, 'absolute-path-rescue.mjs')],
    {
      input: JSON.stringify({
        agent_type: 'lil-slim:explorer',
        cwd: ws,
        tool_name: 'Read',
        tool_input: { file_path: guess },
      }),
      encoding: 'utf8',
    },
  );
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(
    out.hookSpecificOutput.updatedInput.file_path,
    path.join(ws, 'src', 'a.ts'),
  );
});
