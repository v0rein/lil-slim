// Parity check: feed the SAME events to each Node hook and the Rust binary; outputs must match.
// usage: node hooks/rust/parity.mjs <plugin-root> <path-to-lil-hook-binary>
// Exits 1 on any mismatch.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [plug, bin] = process.argv.slice(2);
const node = (hook, input, env) => spawnSync(process.execPath, [path.join(plug, 'hooks', 'scripts', `${hook}.mjs`)], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } });
const rust = (hook, input, env) => spawnSync(bin, [hook], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env, CLAUDE_PLUGIN_ROOT: plug } });
const norm = (s) => { try { return JSON.stringify(JSON.parse(s)); } catch { return s.trim(); } };

const ws = mkdtempSync(path.join(tmpdir(), 'parity-'));
mkdirSync(path.join(ws, 'src'), { recursive: true });
writeFileSync(path.join(ws, 'src', 'links.js'), 'x');
writeFileSync(path.join(ws, 'f.txt'), 'x');
const A = (n) => `lil-slim:${n}`;
const base = (over = {}) => ({ agent_type: A('explorer'), cwd: ws, session_id: 's', ...over });
const sep = path.sep;
const wsParent = path.dirname(ws);
const guessRoot = path.join(path.dirname(wsParent), 'zz-gone', path.basename(ws), 'src', 'links.js');

const cases = [];
const add = (name, hook, input, env = {}) => cases.push({ name, hook, input, env });

add('phase: orchestrator', 'phase-reminder', { hook_event_name: 'SessionStart', agent_type: A('orchestrator') });
add('phase: explorer', 'phase-reminder', { hook_event_name: 'SessionStart', agent_type: A('explorer') });
add('phase: foreign prefix', 'phase-reminder', { hook_event_name: 'SessionStart', agent_type: 'other:orchestrator' });
add('phase: bare', 'phase-reminder', { hook_event_name: 'SessionStart', agent_type: 'orchestrator' });
add('phase: wrong event', 'phase-reminder', { hook_event_name: 'PreToolUse', agent_type: A('orchestrator') });

for (const [n, tool, p] of [['missing', 'Grep', 'nope-dir'], ['existing', 'Grep', 'src'], ['file-as-dir', 'Glob', 'f.txt/sub'], ['undefined-glob', 'Glob', 'undefined'], ['empty', 'Grep', ''], ['absolute-missing', 'Grep', path.join(ws, 'gone')]]) {
  add(`guard: ${n}`, 'search-path-guard', base({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { pattern: 'x', path: p } }));
}
add('guard: non-plugin', 'search-path-guard', base({ agent_type: 'other:agent', hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { path: 'nope' } }));
add('guard: Read ignored', 'search-path-guard', base({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { path: 'nope' } }));
add('guard: rescuable absolute', 'search-path-guard', base({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'x', path: path.join(path.dirname(wsParent), 'zz-gone', path.basename(ws), 'src') } }));

add('rescue: dropped parent', 'absolute-path-rescue', base({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: guessRoot, offset: 3, limit: 9 } }));
add('rescue: correct path', 'absolute-path-rescue', base({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(ws, 'src', 'links.js') } }));
add('rescue: missing tail', 'absolute-path-rescue', base({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(path.dirname(wsParent), 'zz-gone', path.basename(ws), 'src', 'nope.js') } }));
add('rescue: relative', 'absolute-path-rescue', base({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'src/links.js' } }));
add('rescue: dotdot', 'absolute-path-rescue', base({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(path.dirname(wsParent), 'zz-gone', '..', path.basename(ws), 'src', 'links.js') } }));
add('rescue: Grep path key', 'absolute-path-rescue', base({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'x', path: path.join(path.dirname(wsParent), 'zz-gone', path.basename(ws), 'src') } }));
add('rescue: Edit ignored', 'absolute-path-rescue', base({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: guessRoot } }));

const shellCmds = ['rm -rf src', 'git status --short', 'git commit -am x', 'sed -i s/a/b/ f', 'echo hi > out.txt', 'echo hi > /dev/null', 'node --test 2>&1 | tail -3', 'ls && rm x', 'cat a | tee out', 'node -e "require(\'fs\').writeFileSync(\'a\',\'b\')"', 'bash -c "rm -rf x"', 'find . -name x -delete', 'grep -l x . | xargs rm', 'npm install zod', 'git diff HEAD --stat', 'mktemp -d', `rm -rf ${path.join(tmpdir(), 'scratch').replaceAll('\\', '/')}`, 'echo $(rm -rf x)', 'cd "/w" && git log --oneline | head -5', 'curl -o x http://y', 'eval "rm x"', 'FOO=1 rm x', 'cat <<EOF\nhi\nEOF', 'a & b'];
for (const c of shellCmds) for (const a of ['arbiter', 'validator']) add(`shell[${a}]: ${c.slice(0, 40)}`, 'readonly-shell-guard', base({ agent_type: A(a), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: c } }));
add('shell: Read tool ignored', 'readonly-shell-guard', base({ agent_type: A('arbiter'), hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { command: 'rm x' } }));

const results = [];
for (const c of cases) {
  const n = node(c.hook, c.input, c.env);
  const r = rust(c.hook, c.input, c.env);
  const same = norm(n.stdout) === norm(r.stdout) && n.status === 0 && r.status === 0;
  results.push({ ...c, same, n: norm(n.stdout).slice(0, 170), r: norm(r.stdout).slice(0, 170), rs: r.status, ns: n.status });
}

// tool-loop-guard: replay a 6-step sequence against separate state dirs in each implementation
const seq = [];
for (let i = 1; i <= 6; i++) seq.push(['PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'a' }, tool_response: { content: 'same', durationMs: 10 + i } }, `post${i}`]);
seq.push(['PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'a' } }, 'pre-after-6']);
seq.push(['PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }, 'pre-bash']);
seq.push(['PostToolUse', { tool_name: 'Agent', tool_input: {}, tool_response: {} }, 'post-agent-exempt']);
const sn = mkdtempSync(path.join(tmpdir(), 'st-node-')), sr = mkdtempSync(path.join(tmpdir(), 'st-rust-'));
for (const [ev, body, label] of seq) {
  const input = base({ hook_event_name: ev, ...body });
  const n = node('tool-loop-guard', input, { CLAUDE_PLUGIN_DATA: sn });
  const r = rust('tool-loop-guard', input, { CLAUDE_PLUGIN_DATA: sr });
  results.push({ name: `loop: ${label}`, same: norm(n.stdout) === norm(r.stdout), n: norm(n.stdout).slice(0, 120), r: norm(r.stdout).slice(0, 120), ns: n.status, rs: r.status });
}
// cross-read: state written by Rust must be understood by Node and vice versa
const sx = mkdtempSync(path.join(tmpdir(), 'st-x-'));
for (let i = 1; i <= 4; i++) rust('tool-loop-guard', base({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'x' }, tool_response: { c: 1 } }), { CLAUDE_PLUGIN_DATA: sx });
const nodeAfterRust = node('tool-loop-guard', base({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'x' }, tool_response: { c: 1 } }), { CLAUDE_PLUGIN_DATA: sx });
const nodePre = node('tool-loop-guard', base({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'x' } }), { CLAUDE_PLUGIN_DATA: sx });
results.push({ name: 'loop: Node continues Rust state (5th post, then pre denies)', same: /5 times/.test(nodeAfterRust.stdout) && /"deny"/.test(nodePre.stdout), n: norm(nodePre.stdout).slice(0, 120), r: '', ns: 0, rs: 0 });

const bad = results.filter((x) => !x.same);
console.log(`parity: ${results.length - bad.length}/${results.length} identical`);
process.exitCode = bad.length ? 1 : 0;
for (const b of bad) console.log(`\nMISMATCH ${b.name}\n  node(${b.ns}): ${b.n}\n  rust(${b.rs}): ${b.r}`);
