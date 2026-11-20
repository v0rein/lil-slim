import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { decide, resolveSearchPath } from '../hooks/scripts/search-path-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsSrc = path.join(here, '..', 'hooks', 'scripts');

const agentsDir = mkdtempSync(path.join(tmpdir(), 'omcs-guard-agents-'));
writeFileSync(path.join(agentsDir, 'explorer.md'), '---\nname: explorer\n---\n');

const err = (code) => () => {
  throw Object.assign(new Error(code), { code });
};
const ok = () => {};
const WS = '/w/proj';
const base = (over = {}) => ({
  agent_type: 'lil-slim:explorer',
  cwd: WS,
  tool_name: 'Grep',
  tool_input: { pattern: 'x', path: 'src' },
  ...over,
});
const deps = (stat, extra = {}) => ({
  agentsDir,
  pathOps: path.posix,
  stat,
  exists: () => false,
  ...extra,
});
const reason = (out) => out.hookSpecificOutput.permissionDecisionReason;

test('resolveSearchPath: relative, absolute, home, missing cwd', () => {
  assert.equal(resolveSearchPath(WS, 'src', path.posix), '/w/proj/src');
  assert.equal(resolveSearchPath(WS, '/abs/x', path.posix), '/abs/x');
  assert.equal(
    resolveSearchPath(WS, '~/x', path.posix),
    path.posix.resolve(WS, path.posix.join(homedir(), 'x')),
  );
  assert.equal(resolveSearchPath(undefined, 'src', path.posix), null);
});

test('ENOENT denies with a does-not-exist reason', () => {
  const out = decide(base(), deps(err('ENOENT')));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reason(out), /Search path does not exist: \/w\/proj\/src \(from "src"\)/);
  assert.match(reason(out), /Grep search was blocked/);
});

test('ENOTDIR denies with an invalid-path reason', () => {
  const out = decide(base(), deps(err('ENOTDIR')));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reason(out), /ENOTDIR/);
});

test('other stat errors and existing paths pass through', () => {
  assert.equal(decide(base(), deps(err('EACCES'))), null);
  assert.equal(decide(base(), deps(ok)), null);
});

test('only Grep and Glob for plugin agents', () => {
  assert.equal(decide(base({ tool_name: 'Read' }), deps(err('ENOENT'))), null);
  assert.equal(
    decide(base({ agent_type: undefined }), deps(err('ENOENT'))),
    null,
  );
  assert.equal(
    decide(base({ agent_type: 'ghost' }), deps(err('ENOENT'))),
    null,
  );
});

test('missing, empty, or non-string path means no decision', () => {
  for (const p of [undefined, '', 5, null, {}]) {
    assert.equal(
      decide(base({ tool_input: { pattern: 'x', path: p } }), deps(err('ENOENT'))),
      null,
      String(p),
    );
  }
  assert.equal(decide(base({ tool_input: null }), deps(err('ENOENT'))), null);
});

test('Glob treats literal "undefined"/"null" as absent', () => {
  for (const p of ['undefined', 'null']) {
    assert.equal(
      decide(
        base({ tool_name: 'Glob', tool_input: { pattern: '*', path: p } }),
        deps(err('ENOENT')),
      ),
      null,
      p,
    );
  }
});

test('missing cwd never blocks', () => {
  assert.equal(decide(base({ cwd: undefined }), deps(err('ENOENT'))), null);
});

test('defers to rescue when an absolute missing path is rescuable', () => {
  const out = decide(
    base({
      cwd: '/home/u/Work/Parent/Child/Project',
      tool_input: { pattern: 'x', path: '/home/u/Work/Project/src' },
    }),
    deps(err('ENOENT'), {
      exists: (p) => p === '/home/u/Work/Parent/Child/Project/src',
    }),
  );
  assert.equal(out, null);
});

test('e2e: real missing path denies through the CLI', () => {
  const plugin = mkdtempSync(path.join(tmpdir(), 'omcs-plugin-'));
  const scripts = path.join(plugin, 'hooks', 'scripts');
  mkdirSync(path.join(scripts, 'lib'), { recursive: true });
  mkdirSync(path.join(plugin, 'agents'));
  writeFileSync(
    path.join(plugin, 'agents', 'explorer.md'),
    '---\nname: explorer\n---\n',
  );
  for (const f of [
    'search-path-guard.mjs',
    'absolute-path-rescue.mjs',
    'lib/hook-io.mjs',
  ]) {
    copyFileSync(path.join(scriptsSrc, f), path.join(scripts, f));
  }
  const cwd = mkdtempSync(path.join(tmpdir(), 'omcs-ws-'));
  const r = spawnSync(
    process.execPath,
    [path.join(scripts, 'search-path-guard.mjs')],
    {
      input: JSON.stringify({
        agent_type: 'lil-slim:explorer',
        cwd,
        tool_name: 'Grep',
        tool_input: { pattern: 'x', path: 'does-not-exist' },
      }),
      encoding: 'utf8',
    },
  );
  assert.equal(r.status, 0);
  assert.equal(
    JSON.parse(r.stdout).hookSpecificOutput.permissionDecision,
    'deny',
  );
});

test('msys-style /d/... paths map to drive paths on win32 only', () => {
  assert.equal(
    resolveSearchPath('C:\\w', '/d/Projects/x', path.win32, 'win32'),
    'D:\\Projects\\x',
  );
  assert.equal(
    resolveSearchPath('C:\\w', '/D/Projects/x', path.win32, 'win32'),
    'D:\\Projects\\x',
  );
  assert.equal(
    resolveSearchPath('/w', '/d/Projects/x', path.posix, 'linux'),
    '/d/Projects/x',
  );
  // not a single-letter drive segment: left exactly as given
  assert.equal(
    resolveSearchPath('C:\\w', '/dev/null', path.win32, 'win32'),
    '/dev/null',
  );
});

test('real filesystem: a path under a regular file is denied (ENOTDIR on POSIX, ENOENT on Windows)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'omcs-notdir-'));
  writeFileSync(path.join(dir, 'f.txt'), 'x');
  const out = decide(
    {
      agent_type: 'lil-slim:explorer',
      cwd: dir,
      tool_name: 'Grep',
      tool_input: { pattern: 'x', path: 'f.txt/sub' },
    },
    { agentsDir },
  );
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  if (process.platform === 'win32') {
    assert.match(reason, /does not exist/);
  } else {
    assert.match(reason, /ENOTDIR/);
  }
});
