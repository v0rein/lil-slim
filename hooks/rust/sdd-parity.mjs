// Parity for `lil-hook sdd ...` against the original bash scripts (the oracle).
// usage: node hooks/rust/sdd-parity.mjs <oracle-dir> <lil-hook-binary>
// For every case both implementations run on the same repo (state dir wiped
// between runs); stdout, stderr, exit code and the files written must match.
import { spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [oracleSrc, bin] = process.argv.slice(2);
if (!oracleSrc || !bin) {
  console.error('usage: node sdd-parity.mjs <oracle-dir> <lil-hook-binary>');
  process.exit(2);
}
const BASH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const fwd = (p) => p.split(path.sep).join('/');

// oracle copy with the state dir renamed, exactly as the port does
const oracle = mkdtempSync(path.join(tmpdir(), 'sdd-oracle-'));
cpSync(oracleSrc, oracle, { recursive: true });
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
for (const f of walk(oracle)) {
  writeFileSync(f, readFileSync(f, 'utf8').replace(/\r/g, '').replaceAll('.superpowers/sdd', '.lil-slim/sdd'));
  chmodSync(f, 0o755);
}
const EXECUTING = new Set(['task-start', 'task-done']);
const O = (name) => fwd(path.join(oracle, EXECUTING.has(name) ? 'executing-plans' : 'subagent-driven-development', 'scripts', name));

// ---- fixture repo --------------------------------------------------------
const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'sdd-repo-')));
const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
git('init', '-q', '-b', 'main');
git('config', 'user.name', 't');
git('config', 'user.email', 't@t.invalid');
git('config', 'core.autocrlf', 'false');
const put = (rel, text) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); };
const commit = (msg) => { git('add', '-A'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD').stdout.trim(); };

put('a.txt', 'one\n');
const c1 = commit('c1');
put('a.txt', 'one\ntwo\n');
put('b.txt', 'b\n');
const c2 = commit('c2');
put('a.txt', 'one\ntwo\nthree\n');
const c3 = commit('c3');

const F = '```';
const plans = {
  'docs/plan.md': `# Plan\n\n### Task 1: One\nbody one\n- [ ] step a\n\n### Task 2: Two\nbody two\n#### Task 2a: sub\nsub body\n### Task 2b: Next\nnext body\n### Task 6: Six\nsix\n### Task 6b: Six b\nsix b\n### Task 10: Ten\nten body\n## Task Overview\nnot a task\n`,
  'docs/fenced.md': `# P\n### Task 1: A\ntext\n${F}md\n### Task 2: inside fence\n${F}\n### Task 2: Real two\nreal\n### Task 3: Three\nthree\n`,
  'docs/unclosed.md': `# P\n### Task 1: A\nfirst\n${F}\n### Task 2: hidden by open fence\nmore\n`,
  'docs/stray.md': `# P\n### Task 1: A\nbody\n${F}\nno headings after this\n`,
  'docs/spanish.md': `# P\n## Tarea 1: Uno\ncuerpo\n## Tarea 2: Dos\n`,
  'docs/depth.md': `# P\n## Task 1: A\na\n### Task 2: B\nb\n#### Task 2.1: B1\nb1\n### Task 3: C\nc\n`,
  'docs/crlf.md': `# P\r\n### Task 1: A\r\nline\r\n### Task 2: B\r\nb\r\n`,
  'docs/noend.md': `# P\n### Task 1: A\nlast line without newline`,
  'docs/alpha/plan.md': `### Task 1: alpha\nA\n`,
  'docs/beta/plan.md': `### Task 1: beta\nB\n`,
  'docs/gamma/plan.md': `### Task 1: gamma\nG\n`,
};
for (const [rel, text] of Object.entries(plans)) put(rel, text);
commit('plans');
const head = git('rev-parse', 'HEAD').stdout.trim();
const outside = mkdtempSync(path.join(tmpdir(), 'sdd-outside-'));
// stop git's upward search at the temp dir so `outside` is truly outside any repo even if a parent is one
const CEIL = fwd(realpathSync.native(tmpdir()));
writeFileSync(path.join(outside, 'ext-plan.md'), '### Task 1: ext\nx\n');

// ---- helpers -------------------------------------------------------------
const norm = (s) =>
  String(s)
    .replace(/\r/g, '')
    .replaceAll('\\', '/')
    .replace(/(^|[^A-Za-z])\/([A-Za-z])\//g, '$1$2:/')
    .replaceAll(fwd(root), '<R>')
    .replaceAll(fwd(root).toLowerCase(), '<R>')
    .replaceAll('/tmp/' + path.basename(outside), '<X>')
    .replaceAll(fwd(outside), '<X>')
    .toLowerCase();
const snap = () => {
  const base = path.join(root, '.lil-slim');
  if (!existsSync(base)) return {};
  const out = {};
  for (const f of walk(base)) {
    const rel = fwd(path.relative(base, f));
    out[rel] = readFileSync(f, 'latin1');
  }
  return out;
};
const wipe = () => rmSync(path.join(root, '.lil-slim'), { recursive: true, force: true });
const runO = (name, args, cwd = root) => spawnSync(BASH, [O(name), ...args], { cwd, encoding: 'utf8', env: { ...process.env, BASH: BASH, GIT_CEILING_DIRECTORIES: CEIL } });
const runR = (sub, args, cwd = root) => spawnSync(bin, ['sdd', sub, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: CEIL } });
const results = [];
function compare(label, name, sub, args, opts = {}) {
  const cwd = opts.cwd ?? root;
  wipe();
  opts.before?.();
  const o = runO(name, args, cwd);
  const so = snap();
  wipe();
  opts.before?.();
  const r = runR(sub, args, cwd);
  const sr = snap();
  const fo = norm(JSON.stringify(so));
  const fr = norm(JSON.stringify(sr));
  const issues = [];
  if (o.status !== r.status) issues.push(`exit ${o.status} vs ${r.status}`);
  if (norm(o.stdout) !== norm(r.stdout)) issues.push(`stdout\n    bash: ${JSON.stringify(norm(o.stdout)).slice(0, 220)}\n    rust: ${JSON.stringify(norm(r.stdout)).slice(0, 220)}`);
  if (!opts.skipStderr && norm(o.stderr) !== norm(r.stderr)) issues.push(`stderr\n    bash: ${JSON.stringify(norm(o.stderr)).slice(0, 260)}\n    rust: ${JSON.stringify(norm(r.stderr)).slice(0, 260)}`);
  if (fo !== fr) issues.push(`files\n    bash: ${fo.slice(0, 260)}\n    rust: ${fr.slice(0, 260)}`);
  results.push({ label, ok: issues.length === 0, issues });
}

// ---- cases ---------------------------------------------------------------
const P = (n) => `docs/${n}.md`;
for (const n of ['1', '2', '2a', '2b', '6', '6b', '10', '99', '2.1', 'x']) compare(`task-brief plan Task ${n}`, 'task-brief', 'task-brief', [P('plan'), n]);
for (const n of ['1', '2', '3']) compare(`task-brief fenced Task ${n}`, 'task-brief', 'task-brief', [P('fenced'), n]);
for (const n of ['1', '2', '3']) compare(`task-brief unclosed Task ${n}`, 'task-brief', 'task-brief', [P('unclosed'), n]);
compare('task-brief stray fence', 'task-brief', 'task-brief', [P('stray'), '1']);
for (const n of ['1', '2']) compare(`task-brief spanish Task ${n}`, 'task-brief', 'task-brief', [P('spanish'), n]);
for (const n of ['1', '2', '2.1', '3']) compare(`task-brief depth Task ${n}`, 'task-brief', 'task-brief', [P('depth'), n]);
for (const n of ['1', '2']) compare(`task-brief crlf Task ${n}`, 'task-brief', 'task-brief', [P('crlf'), n]);
compare('task-brief no trailing newline', 'task-brief', 'task-brief', [P('noend'), '1']);
compare('task-brief explicit OUTFILE', 'task-brief', 'task-brief', [P('plan'), '1', path.join(root, 'out-brief.md')], { before: () => rmSync(path.join(root, 'out-brief.md'), { force: true }) });
compare('task-brief missing plan', 'task-brief', 'task-brief', ['docs/nope.md', '1']);
compare('task-brief too few args', 'task-brief', 'task-brief', [P('plan')]);
compare('task-brief bad -C', 'task-brief', 'task-brief', ['-C', path.join(root, 'nonexistent'), P('plan'), '1']);
compare('task-brief -C from outside', 'task-brief', 'task-brief', ['-C', root, P('plan'), '1'], { cwd: outside });

for (const p of ['plan', 'fenced', 'alpha/plan']) compare(`workspace ${p}`, 'sdd-workspace', 'workspace', [P(p)]);
compare('workspace outside plan', 'sdd-workspace', 'workspace', [path.join(outside, 'ext-plan.md')]);
compare('workspace missing plan', 'sdd-workspace', 'workspace', ['docs/nope.md']);
compare('workspace no args', 'sdd-workspace', 'workspace', []);
compare('workspace outside any repo', 'sdd-workspace', 'workspace', [path.join(outside, 'ext-plan.md')], { cwd: outside });

// same basename collisions: claim alpha first, then beta, then gamma
const claimOrder = (target) => () => {
  for (const p of ['alpha/plan', 'beta/plan', 'gamma/plan']) {
    if (p === target) break;
    runO('sdd-workspace', [P(p)]);
  }
};
compare('workspace collision beta', 'sdd-workspace', 'workspace', [P('beta/plan')], { before: claimOrder('beta/plan') });
compare('workspace collision gamma', 'sdd-workspace', 'workspace', [P('gamma/plan')], { before: claimOrder('gamma/plan') });

compare('repo', 'sdd-repo', 'repo', []);
compare('repo --with-commit', 'sdd-repo', 'repo', ['--with-commit']);
compare('repo bad arg', 'sdd-repo', 'repo', ['x']);
compare('repo outside any repo', 'sdd-repo', 'repo', [], { cwd: outside });

compare('review-package c1..c3', 'review-package', 'review-package', [P('plan'), c1, c3]);
compare('review-package c2..HEAD', 'review-package', 'review-package', [P('plan'), c2, 'HEAD']);
compare('review-package explicit OUTFILE', 'review-package', 'review-package', [P('plan'), c1, c2, path.join(root, 'rp.diff')], { before: () => rmSync(path.join(root, 'rp.diff'), { force: true }) });
compare('review-package bad BASE', 'review-package', 'review-package', [P('plan'), 'deadbeef', c3]);
compare('review-package bad HEAD', 'review-package', 'review-package', [P('plan'), c1, 'deadbeef']);
compare('review-package reversed', 'review-package', 'review-package', [P('plan'), c3, c1]);
compare('review-package empty range', 'review-package', 'review-package', [P('plan'), c3, c3]);
compare('review-package missing plan', 'review-package', 'review-package', ['docs/nope.md', c1, c3]);
compare('review-package usage', 'review-package', 'review-package', [P('plan'), c1]);

compare('task-start', 'task-start', 'task-start', [P('plan'), '2']);
compare('task-start bad task', 'task-start', 'task-start', [P('plan'), '99']);
compare('task-start usage', 'task-start', 'task-start', [P('plan')]);
compare('task-start fenced unclosed', 'task-start', 'task-start', [P('unclosed'), '1']);

const NODE = 'node';
compare('task-done pass', 'task-done', 'task-done', [P('plan'), '1', c1, '--', NODE, '-e', 'console.log("3 pass")']);
compare('task-done fail', 'task-done', 'task-done', [P('plan'), '1', c1, '--', NODE, '-e', 'console.log("boom");process.exit(3)']);
compare('task-done quoted arg', 'task-done', 'task-done', [P('plan'), '2', c2, '--', NODE, '-e', 'console.log("a b | c")']);
compare('task-done long output', 'task-done', 'task-done', [P('plan'), '1', c1, '--', NODE, '-e', 'for(let i=1;i<=9;i++)console.log("line "+i)']);
compare('task-done no output', 'task-done', 'task-done', [P('plan'), '1', c1, '--', NODE, '-e', '0']);
compare('task-done bad BASE', 'task-done', 'task-done', [P('plan'), '1', 'deadbeef', '--', NODE, '-e', '0']);
compare('task-done usage', 'task-done', 'task-done', [P('plan'), '1', c1, NODE]);

const bad = results.filter((r) => !r.ok);
console.log(`sdd parity: ${results.length - bad.length}/${results.length} identical`);
for (const b of bad) console.log(`\nMISMATCH ${b.label}\n  ${b.issues.join('\n  ')}`);
process.exitCode = bad.length ? 1 : 0;
