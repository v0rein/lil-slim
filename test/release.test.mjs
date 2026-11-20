import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const posix = (p) => p.split(path.sep).join('/');
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const json = (f) => JSON.parse(read(f));

function findBash() {
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Git\\bin\\bash.exe',
          'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        ]
      : ['/bin/bash', '/usr/bin/bash'];
  return candidates.find((c) => existsSync(c));
}

test('every hook command degrades gracefully when node is missing', (t) => {
  const bash = findBash();
  if (!bash) return t.skip('no bash available');
  const hooks = json('hooks/hooks.json').hooks;
  const commands = Object.values(hooks)
    .flat()
    .flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(commands.length >= 5);
  for (const raw of commands) {
    const cmd = raw.replaceAll('${CLAUDE_PLUGIN_ROOT}', root.replaceAll('\\', '/'));
    const r = spawnSync(bash, ['-c', cmd], {
      input: '{}',
      encoding: 'utf8',
      env: { PATH: process.platform === 'win32' ? '/usr/bin:/bin' : '/usr/bin:/bin' },
    });
    // skip when this shell cannot even run `command -v` (should not happen)
    assert.equal(r.status, 0, `${raw}\nstderr: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /command not found/, raw);
  }
});

test('SessionStart tells the user when neither a hook binary nor node is available', (t) => {
  const bash = findBash();
  if (!bash) return t.skip('no bash available');
  const group = json('hooks/hooks.json').hooks.SessionStart[0];
  const raw = group.hooks[0].command;
  const cmd = raw.replaceAll('${CLAUDE_PLUGIN_ROOT}', root.replaceAll('\\', '/'));
  const r = spawnSync(bash, ['-c', cmd], {
    input: '{}',
    encoding: 'utf8',
    // an unsupported platform has no prebuilt binary, and PATH has no node
    env: { PATH: '/usr/bin:/bin', LIL_HOOK_PLATFORM: 'plan9-mips' },
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Node\.js .*not found.*guard hooks are inactive/i);
});

test('release metadata: LICENSE, author, marketplace', () => {
  assert.ok(existsSync(path.join(root, 'LICENSE')), 'LICENSE missing');
  const lic = read('LICENSE');
  assert.match(lic, /^MIT License/);
  assert.match(lic, /Copyright \(c\) 2025/); // upstream notice retained
  assert.match(lic, /v0rein/);
  const plugin = json('.claude-plugin/plugin.json');
  assert.equal(plugin.name, 'lil-slim');
  assert.equal(plugin.license, 'MIT');
  assert.equal(plugin.author?.name, 'v0rein');
  const mkt = json('.claude-plugin/marketplace.json');
  assert.equal(mkt.plugins[0].name, plugin.name);
  assert.equal(mkt.plugins[0].source, './');
  assert.ok(mkt.owner?.name);
});

test('README documents install, Node requirement, and a runner that works on Node 22', () => {
  const r = read('README.md');
  assert.match(r, /claude plugin marketplace add/);
  assert.match(r, /claude plugin install lil-slim@/);
  assert.match(r, /Node\.js 18/);
  assert.match(r, /oh-my-opencode-slim/);
  assert.doesNotMatch(r, /node --test test\//);
});

test('CI matrix covers the three OSes and node 18/20/22', () => {
  const y = read('.github/workflows/test.yml');
  for (const s of ['ubuntu-latest', 'windows-latest', 'macos-latest']) {
    assert.ok(y.includes(s), s);
  }
  for (const v of ['18', '20', '22']) assert.ok(y.includes(v), v);
  assert.match(y, /node --test/);
});

test('.gitattributes forces LF so run.sh survives a Windows checkout', () => {
  const g = read('.gitattributes');
  assert.match(g, /^\*\s+text=auto\s+eol=lf/m);
  assert.match(g, /\*\.sh\s+text\s+eol=lf/);
  assert.doesNotMatch(read('hooks/scripts/run.sh'), /\r/);
});

test('third-party notices cover every adapted agent author and upstream license', () => {
  const n = read('THIRD_PARTY_NOTICES.md');
  assert.match(n, /oh-my-opencode-slim/);
  assert.match(n, /Copyright \(c\) 2025\b/);
  assert.match(n, /slim-claude/);
  for (const a of ['capyBearista', 'hbollon', 'stevio2d', 'Alvin', 'Cole Medin']) {
    assert.ok(n.includes(a), a);
  }
  for (const a of ['arbiter', 'chronicler', 'debugger', 'documenter', 'hunter', 'janitor', 'paladin', 'proctor', 'validator']) {
    assert.match(n, new RegExp(`\\b${a}\\b`), a);
  }
});

test('README lists every shipped agent and skill', () => {
  const r = read('README.md');
  for (const f of readdirSync(path.join(root, 'agents'))) {
    assert.ok(r.includes(`\`${f.replace(/\.md$/, '')}\``), `README missing agent ${f}`);
  }
  for (const d of readdirSync(path.join(root, 'skills'))) {
    assert.ok(r.includes(`\`${d}\``), `README missing skill ${d}`);
  }
});

test('tool-loop-guard matcher skips exactly the exempt tools, so no Node spawn for them', async () => {
  const { EXEMPT } = await import('../hooks/scripts/tool-loop-guard.mjs');
  const hooks = JSON.parse(read('hooks/hooks.json')).hooks;
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const group = hooks[event].find((g) =>
      g.hooks.some((h) => /tool-loop-guard/.test(h.command)),
    );
    assert.ok(group, `${event}: no tool-loop-guard group`);
    assert.ok(group.matcher, `${event}: tool-loop-guard has no matcher`);
    const re = new RegExp(group.matcher);
    for (const tool of EXEMPT) {
      assert.ok(!re.test(tool), `${event}: matcher still fires for exempt ${tool}`);
    }
    for (const tool of ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'WebFetch', 'mcp__context7__query-docs', 'Skill']) {
      assert.ok(re.test(tool), `${event}: matcher no longer fires for ${tool}`);
    }
  }
});

test('plugin.json description states the real counts of agents, skills and hooks', () => {
  const d = JSON.parse(read('.claude-plugin/plugin.json')).description;
  const agents = readdirSync(path.join(root, 'agents')).length;
  const skills = readdirSync(path.join(root, 'skills')).length;
  const hooks = readdirSync(path.join(root, 'hooks', 'scripts')).filter(
    (f) => f.endsWith('.mjs'),
  ).length;
  assert.match(d, new RegExp(`\\b${agents} agents\\b`));
  assert.match(d, new RegExp(`\\b${skills} skills\\b`));
  assert.match(d, new RegExp(`\\b${hooks} guard hooks\\b`));
});

test('no leftover former plugin name in shipped files', () => {
  for (const f of ['README.md', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'hooks/hooks.json']) {
    assert.doesNotMatch(read(f), /oh-my-claude-slim/, f);
  }
});

test('run.sh prefers a Rust binary (LIL_HOOK_BIN or hooks/bin) and falls back to Node', (t) => {
  const bash = findBash();
  if (!bash) return t.skip('no bash available');
  const dir = mkdtempSync(path.join(tmpdir(), 'lil-bin-'));
  const fake = path.join(dir, 'lil-hook');
  writeFileSync(fake, '#!/bin/sh\nprintf "RUST:%s" "$1"\n');
  chmodSync(fake, 0o755);
  const sh = posix(path.join(root, 'hooks', 'scripts', 'run.sh'));
  const run = (env) =>
    spawnSync(bash, ['-c', `sh "${sh}" phase-reminder`], {
      input: '{}',
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    });
  assert.equal(run({ LIL_HOOK_BIN: posix(fake) }).stdout, 'RUST:phase-reminder');
  assert.notEqual(run({ LIL_HOOK_BIN: `${dir}/missing` }).stdout, 'RUST:phase-reminder');
  assert.notEqual(run({}).stdout, 'RUST:phase-reminder');
});

test('with a Rust binary present, hooks no longer need Node', (t) => {
  const bash = findBash();
  if (!bash) return t.skip('no bash available');
  const dir = mkdtempSync(path.join(tmpdir(), 'lil-bin2-'));
  const fake = path.join(dir, 'lil-hook');
  writeFileSync(fake, '#!/bin/sh\nprintf "OK"\n');
  chmodSync(fake, 0o755);
  const sh = posix(path.join(root, 'hooks', 'scripts', 'run.sh'));
  const r = spawnSync(bash, ['-c', `sh "${sh}" tool-loop-guard`], {
    input: '{}',
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LIL_HOOK_BIN: posix(fake) },
  });
  assert.equal(r.stdout, 'OK');
});

test('Rust sources, parity script and CI job ship together', () => {
  for (const f of ['hooks/rust/Cargo.toml', 'hooks/rust/Cargo.lock', 'hooks/rust/parity.mjs', 'hooks/rust/src/main.rs']) {
    assert.ok(existsSync(path.join(root, f)), f);
  }
  assert.match(read('.github/workflows/test.yml'), /cargo test/);
  assert.match(read('.github/workflows/test.yml'), /parity\.mjs/);
  assert.match(read('.gitignore'), /hooks\/rust\/target|\/target/);
});
