import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sourceHash } from '../hooks/rust/source-hash.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const posix = (p) => p.split(path.sep).join('/');
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'windows-x64'];
const binName = (p) => (p.startsWith('windows') ? 'lil-hook.exe' : 'lil-hook');
const binPath = (p) => path.join(root, 'hooks', 'bin', p, binName(p));

function findBash() {
  const candidates =
    process.platform === 'win32'
      ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']
      : ['/bin/bash', '/usr/bin/bash'];
  return candidates.find((c) => existsSync(c));
}

test('every platform ships a prebuilt binary of plausible size', () => {
  for (const p of PLATFORMS) {
    assert.ok(existsSync(binPath(p)), `missing ${p}`);
    const size = statSync(binPath(p)).size;
    assert.ok(size > 200_000 && size < 5_000_000, `${p} size ${size}`);
  }
});

test('SHA256SUMS matches the committed binaries exactly', () => {
  const lines = read('hooks/bin/SHA256SUMS').trim().split('\n');
  assert.equal(lines.length, PLATFORMS.length);
  const seen = new Set();
  for (const line of lines) {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    assert.ok(m, `bad line: ${line}`);
    const file = path.join(root, 'hooks', 'bin', ...m[2].split('/'));
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), m[1], m[2]);
    seen.add(m[2].split('/')[0]);
  }
  assert.deepEqual([...seen].sort(), [...PLATFORMS].sort());
});

test('BUILD.json pins the exact Rust sources the binaries were built from', () => {
  const b = JSON.parse(read('hooks/bin/BUILD.json'));
  assert.equal(b.sourceHash, sourceHash(path.join(root, 'hooks', 'rust')), 'binaries are stale: rebuild after editing hooks/rust');
  assert.deepEqual(Object.keys(b.platforms).sort(), [...PLATFORMS].sort());
  for (const p of PLATFORMS) {
    assert.equal(b.platforms[p].file, `${p}/${binName(p)}`);
    assert.equal(b.platforms[p].bytes, statSync(binPath(p)).size, p);
  }
});

test('unix binaries are committed with the executable bit', (t) => {
  const r = spawnSync('git', ['ls-files', '-s', 'hooks/bin'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.trim()) return t.skip('not a git checkout');
  for (const p of PLATFORMS.filter((x) => !x.startsWith('windows'))) {
    const line = r.stdout.split('\n').find((l) => l.endsWith(`hooks/bin/${p}/lil-hook`));
    assert.ok(line, `${p} not tracked`);
    assert.match(line, /^100755 /, `${p} lacks +x`);
  }
});

test('binaries are marked binary for git (no EOL rewriting)', () => {
  assert.match(read('.gitattributes'), /hooks\/bin\/\*\*\s+binary/);
  assert.doesNotMatch(read('.gitignore'), /hooks\/bin/);
});

// ---- run.sh behaviour, in a throwaway plugin tree ------------------------

function tree({ fake, plat = 'linux-x64', nodeScript = true } = {}) {
  const d = mkdtempSync(path.join(tmpdir(), 'lil-run-'));
  mkdirSync(path.join(d, 'hooks', 'scripts'), { recursive: true });
  copyFileSync(path.join(root, 'hooks', 'scripts', 'run.sh'), path.join(d, 'hooks', 'scripts', 'run.sh'));
  if (nodeScript) writeFileSync(path.join(d, 'hooks', 'scripts', 'phase-reminder.mjs'), "process.stdout.write('NODE');\n");
  if (fake !== undefined) {
    const dir = path.join(d, 'hooks', 'bin', plat);
    mkdirSync(dir, { recursive: true });
    const f = path.join(dir, binName(plat));
    writeFileSync(f, fake);
    chmodSync(f, 0o755);
  }
  return d;
}
function run(d, env, stdin = '{}') {
  const bash = findBash();
  const sh = posix(path.join(d, 'hooks', 'scripts', 'run.sh'));
  return spawnSync(bash, ['-c', `sh "${sh}" phase-reminder`], {
    input: stdin,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
}

test('run.sh runs the platform binary when present (and needs no Node)', (t) => {
  if (!findBash()) return t.skip('no bash');
  const d = tree({ fake: '#!/bin/sh\nprintf "RUST"\n' });
  const r = run(d, { LIL_HOOK_PLATFORM: 'linux-x64', PATH: '/usr/bin:/bin' });
  assert.equal(r.stdout, 'RUST');
  assert.equal(r.status, 0);
});

test('run.sh picks the binary by platform and uses .exe on windows', (t) => {
  if (!findBash()) return t.skip('no bash');
  const d = tree({ fake: '#!/bin/sh\nprintf "WIN"\n', plat: 'windows-x64' });
  assert.equal(run(d, { LIL_HOOK_PLATFORM: 'windows-x64' }).stdout, 'WIN');
  assert.equal(run(d, { LIL_HOOK_PLATFORM: 'linux-x64' }).stdout, 'NODE');
});

test('run.sh falls back to Node for an unknown platform or a missing binary', (t) => {
  if (!findBash()) return t.skip('no bash');
  const d = tree({ fake: '#!/bin/sh\nprintf "RUST"\n' });
  assert.equal(run(d, { LIL_HOOK_PLATFORM: 'plan9-mips' }).stdout, 'NODE');
  assert.equal(run(tree(), { LIL_HOOK_PLATFORM: 'linux-x64' }).stdout, 'NODE');
});

test('run.sh falls back to Node when the binary cannot be executed', (t) => {
  if (!findBash()) return t.skip('no bash');
  const d = tree({ fake: Buffer.from([0, 1, 2, 3, 255, 254, 0, 0]) });
  assert.equal(run(d, { LIL_HOOK_PLATFORM: 'linux-x64' }).stdout, 'NODE');
});

test('run.sh never propagates a crashing binary (exit 0, no output)', (t) => {
  if (!findBash()) return t.skip('no bash');
  const d = tree({ fake: '#!/bin/sh\nexit 134\n' });
  const r = run(d, { LIL_HOOK_PLATFORM: 'linux-x64' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('run.sh passes stdin through to the binary', (t) => {
  if (!findBash()) return t.skip('no bash');
  const d = tree({ fake: '#!/bin/sh\ncat\n' });
  assert.equal(run(d, { LIL_HOOK_PLATFORM: 'linux-x64' }, '{"x":1}').stdout, '{"x":1}');
});

test('run.sh with neither binary nor node stays silent and notifies once at SessionStart', (t) => {
  if (!findBash()) return t.skip('no bash');
  const d = tree();
  const bash = findBash();
  const sh = posix(path.join(d, 'hooks', 'scripts', 'run.sh'));
  const r = spawnSync(bash, ['-c', `sh "${sh}" tool-loop-guard`], { input: '{}', encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LIL_HOOK_PLATFORM: 'linux-x64' } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const n = spawnSync(bash, ['-c', `sh "${sh}" phase-reminder --notice`], { input: '{}', encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LIL_HOOK_PLATFORM: 'linux-x64' } });
  assert.match(n.stdout, /no prebuilt hook binary|Node\.js .*not found/i);
  assert.match(n.stdout, /guard hooks are inactive/);
});

// ---- CI wiring -----------------------------------------------------------

test('binaries workflow builds all five targets with locked deps', () => {
  const y = read('.github/workflows/binaries.yml');
  for (const t of ['x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl', 'aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc']) {
    assert.ok(y.includes(t), t);
  }
  assert.match(y, /--locked/);
  assert.match(y, /crt-static/);
  assert.match(y, /upload-artifact/);
});

test('test workflow verifies every committed binary natively against the Node hooks', () => {
  const y = read('.github/workflows/test.yml');
  for (const p of PLATFORMS) assert.ok(y.includes(p), p);
  for (const os of ['ubuntu-24.04-arm', 'macos-15-intel', 'windows-latest']) assert.ok(y.includes(os), os);
  assert.match(y, /committed-binaries/);
  assert.match(y, /parity\.mjs/);
});

test('update-binaries script exists and refuses to run without artifacts', () => {
  const f = path.join(root, 'hooks', 'rust', 'update-binaries.mjs');
  assert.ok(existsSync(f));
  const r = spawnSync(process.execPath, [f], { cwd: root, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage/i);
});

// ---- the real committed binary for THIS machine ---------------------------

function hostPlatform() {
  const a = process.arch;
  if (process.platform === 'win32' && a === 'x64') return 'windows-x64';
  if (process.platform === 'linux' && a === 'x64') return 'linux-x64';
  if (process.platform === 'linux' && a === 'arm64') return 'linux-arm64';
  if (process.platform === 'darwin' && a === 'arm64') return 'darwin-arm64';
  if (process.platform === 'darwin' && a === 'x64') return 'darwin-x64';
  return null;
}

test('the committed binary for this machine serves hooks through run.sh with no node on PATH', (t) => {
  const plat = hostPlatform();
  const bash = findBash();
  if (!plat || !bash) return t.skip('no supported host or bash');
  const sh = posix(path.join(root, 'hooks', 'scripts', 'run.sh'));
  const input = JSON.stringify({ hook_event_name: 'SessionStart', agent_type: 'lil-slim:orchestrator' });
  const r = spawnSync(bash, ['-c', `sh "${sh}" phase-reminder`], {
    input,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', CLAUDE_PLUGIN_ROOT: posix(root) },
  });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /Scheduler workflow/);
  // and it is byte-identical to what the Node implementation prints
  const n = spawnSync(process.execPath, [path.join(root, 'hooks', 'scripts', 'phase-reminder.mjs')], { input, encoding: 'utf8' });
  assert.equal(r.stdout, n.stdout);
});

test('parity: the committed binary for this machine matches the Node hooks', (t) => {
  const plat = hostPlatform();
  if (!plat) return t.skip('no supported host');
  const r = spawnSync(process.execPath, [path.join(root, 'hooks', 'rust', 'parity.mjs'), root, binPath(plat)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout.slice(-600));
  assert.match(r.stdout, /parity: (\d+)\/\1 identical/);
});

test('README describes the prebuilt-binary default and the Node fallback', () => {
  const r = read('README.md');
  assert.match(r, /## Hooks: prebuilt Rust, Node as fallback/);
  assert.match(r, /Node\.js is not needed/);
  assert.match(r, /SHA256SUMS/);
  assert.match(r, /update-binaries\.mjs/);
  assert.doesNotMatch(r, /Optional: Rust hooks/);
});

test('CI proves the binary path with a node shim, not by hiding node', () => {
  const y = read('.github/workflows/test.yml');
  assert.match(y, /NODE-RAN/);
  assert.match(y, /Prove run\.sh uses the binary and not node/);
});

test('workflow files keep every line inside its block (no stray column-0 text)', () => {
  for (const f of ['test.yml', 'binaries.yml']) {
    const lines = read(`.github/workflows/${f}`).replace(/\r/g, '').split('\n');
    lines.forEach((l, i) => {
      if (l === '' ) return;
      assert.match(l, /^(\s|#|[A-Za-z_-]+:|---)/, `${f}:${i + 1} stray column-0 text: ${l.slice(0, 40)}`);
    });
  }
});

test('CI runs the sdd parity against the committed binary on every platform', () => {
  const y = read('.github/workflows/test.yml');
  assert.match(y, /sdd-parity\.mjs/);
  assert.match(y, /rust\/tests\/oracle/);
});

test('sdd parity: the committed binary for this machine matches the original bash scripts', (t) => {
  const plat = hostPlatform();
  if (!plat || !findBash()) return t.skip('no supported host or bash');
  const r = spawnSync(process.execPath, [path.join(root, 'hooks', 'rust', 'sdd-parity.mjs'), path.join(root, 'hooks', 'rust', 'tests', 'oracle'), binPath(plat)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout.slice(-900));
  assert.match(r.stdout, /sdd parity: (\d+)\/\1 identical/);
});
