import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  READONLY_SHELL_AGENTS,
  classify,
  decide,
} from '../hooks/scripts/readonly-shell-guard.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentsDir = mkdtempSync(path.join(tmpdir(), 'omcs-rsg-'));
for (const n of ['arbiter', 'hunter', 'proctor', 'validator', 'fixer']) {
  writeFileSync(path.join(agentsDir, `${n}.md`), `---\nname: ${n}\n---\n`);
}
const deps = { agentsDir, tmp: '/tmp' };
const run = (command, over = {}) =>
  decide(
    {
      hook_event_name: 'PreToolUse',
      agent_type: 'lil-slim:arbiter',
      tool_name: 'Bash',
      tool_input: { command },
      cwd: '/w',
      ...over,
    },
    deps,
  );
const denied = (c) => run(c)?.hookSpecificOutput?.permissionDecision === 'deny';

const WRITES = [
  'rm -rf src',
  'rm src/a.js',
  'git commit -am x',
  'git checkout -- .',
  'git reset --hard HEAD',
  'git stash',
  'git apply fix.diff',
  'git push origin main',
  'git clean -fd',
  'sed -i s/a/b/ src/a.js',
  'sed --in-place s/a/b/ src/a.js',
  'echo hi > src/x.js',
  'cat a >> README.md',
  'cat a | tee out.txt',
  'mv a b',
  'cp a b',
  'touch f',
  'mkdir out',
  'chmod +x run.sh',
  'npm install left-pad',
  'pnpm add zod',
  'pip install requests',
  `node -e "require('fs').writeFileSync('a','b')"`,
  `python -c "open('a','w').write('x')"`,
  'bash -c "rm -rf x"',
  'find . -name x -delete',
  'find . -name x -exec rm {} ;',
  'grep -l x . | xargs rm',
  'ls && rm x',
  'ls; git push',
  'curl -o out.sh http://x',
  'eval "rm -rf x"',
];
const READS = [
  'git status --short',
  'git diff HEAD --stat',
  'git log --oneline | head -5',
  'git show HEAD:src/a.js',
  'cat -n src/a.js',
  'ls -R src test',
  'grep -rn "rm -rf" src',
  'grep -c "a>b" f',
  'echo "a > b"',
  'node --test 2>&1 | tail -30',
  'node --test > /dev/null 2>&1',
  'node --test > /tmp/run.log 2>&1',
  'git diff 2>/dev/null',
  'cd "/w" && git status',
  `node -e "console.log(1+1)"`,
  'sed -n 1,5p f',
  'wc -l src/*.js',
  'mktemp -d',
  'rm -rf /tmp/scratch',
  'find . -name "*.js"',
  'find . -name x -exec grep -l y {} ;',
];

test('write-capable shell commands are denied for read-only audit agents', () => {
  for (const c of WRITES) assert.ok(denied(c), `should deny: ${c}`);
});

test('inspection and test-running commands are allowed', () => {
  for (const c of READS) assert.equal(run(c), null, `should allow: ${c}`);
});

test('deny reason names the agent and says what to do instead', () => {
  const r = run('rm -rf src').hookSpecificOutput.permissionDecisionReason;
  assert.match(r, /arbiter/);
  assert.match(r, /read-only/i);
  assert.match(r, /report/i);
});

test('only the listed read-only agents are restricted', () => {
  assert.deepEqual([...READONLY_SHELL_AGENTS].sort(), ['arbiter', 'hunter', 'proctor']);
  for (const a of ['hunter', 'proctor']) {
    assert.ok(
      run('rm -rf src', { agent_type: `lil-slim:${a}` }),
      a,
    );
  }
  for (const a of ['validator', 'fixer']) {
    assert.equal(run('rm -rf src', { agent_type: `lil-slim:${a}` }), null, a);
  }
  assert.equal(run('rm -rf src', { agent_type: undefined }), null);
  assert.equal(run('rm -rf src', { agent_type: 'other:arbiter' }), null);
});

test('non-Bash tools and malformed input are ignored', () => {
  assert.equal(run('rm -rf src', { tool_name: 'Read' }), null);
  assert.equal(run('x', { tool_input: null }), null);
  assert.equal(run('x', { tool_input: { command: 5 } }), null);
  assert.equal(classify(''), null);
});

test('every restricted agent really has Bash and no edit tools', () => {
  for (const n of READONLY_SHELL_AGENTS) {
    const text = readFileSync(path.join(root, 'agents', `${n}.md`), 'utf8');
    const tools = text.match(/^tools:\s*(.+)$/m)?.[1] ?? '';
    assert.match(tools, /\bBash\b/, n);
    assert.doesNotMatch(tools, /\b(Edit|Write|NotebookEdit)\b/, n);
  }
});

test('hooks.json runs the guard on Bash through run.sh', () => {
  const hooks = JSON.parse(readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const g = hooks.PreToolUse.find((x) => x.hooks.some((h) => /readonly-shell-guard/.test(h.command)));
  assert.ok(g, 'no group');
  assert.equal(g.matcher, 'Bash');
  assert.match(g.hooks[0].command, /run\.sh" readonly-shell-guard/);
});
