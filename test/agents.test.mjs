import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentsDir = path.join(root, 'agents');

export const FORBIDDEN =
  /task_status|task_cancel|task_reply|apply_patch|wait_for_user|OpenCode|@explorer|@fixer|@oracle|@designer|@observer/;

function parse(file) {
  const text = readFileSync(file, 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, `${file}: frontmatter`);
  const fm = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    fm[k] = v;
  }
  return { fm, body: m[2] };
}

const files = readdirSync(agentsDir).filter((f) => f.endsWith('.md'));
const agents = Object.fromEntries(
  files.map((f) => [f.slice(0, -3), parse(path.join(agentsDir, f))]),
);

const CORE = ['designer', 'explorer', 'fixer', 'observer', 'oracle', 'orchestrator'];
const AUDIT = ['arbiter', 'hunter', 'janitor', 'paladin', 'proctor'];
const DOCS = ['chronicler', 'documenter'];
const UTIL = ['debugger', 'validator'];
const COUNCIL = ['council', 'councillor'];
const ALL = [...CORE, ...AUDIT, ...DOCS, ...UTIL, ...COUNCIL].sort();

test('the shipped agent set is exactly the expected seventeen', () => {
  assert.deepEqual(Object.keys(agents).sort(), ALL);
});

test('leaf agents cannot use the Agent tool (oracle/designer may only reach observer)', () => {
  const mayDispatch = new Set(['orchestrator', 'oracle', 'designer']);
  for (const n of ALL.filter((x) => !mayDispatch.has(x))) {
    const { fm } = agents[n];
    const allow = fm.tools === undefined ? null : String(fm.tools);
    const deny = String(fm.disallowedTools ?? '');
    const blocked = allow !== null ? !/\bAgent\b/.test(allow) : /\bAgent\b/.test(deny);
    assert.ok(blocked, `${n} can dispatch`);
  }
  for (const n of ['explorer', 'oracle', 'designer', 'fixer', 'observer']) {
    assert.match(agents[n].body, /do not (dispatch|spawn)/i, n);
  }
});

test('audit and council agents cannot edit files', () => {
  for (const n of [...AUDIT, 'council', 'councillor', 'debugger', 'validator']) {
    const { fm } = agents[n];
    const allow = fm.tools === undefined ? null : String(fm.tools);
    if (allow !== null) {
      assert.doesNotMatch(allow, /\b(Edit|Write|NotebookEdit)\b/, `${n} allow`);
    } else {
      const d = String(fm.disallowedTools);
      assert.ok(d.includes('Edit') && d.includes('Write'), `${n} deny`);
    }
  }
  for (const n of DOCS) assert.match(String(agents[n].fm.tools), /Write/, n);
});

test('orchestrator routes to every dispatchable agent with a Don\'t clause', () => {
  const b = agents.orchestrator.body;
  const routed = ALL.filter((x) => !['orchestrator', 'councillor', 'council'].includes(x));
  for (const n of routed) {
    // designer's upstream line is a rule ("Never do UI/design work yourself"),
    // not a Delegate/Don't pair
    const clause = n === 'designer' ? /Never do UI/ : /(Don't|Delegate)/;
    const line = b.split('\n').find((l) => l.startsWith(`\`lil-slim:${n}\``));
    assert.ok(line, `${n}: no routing line`);
    assert.match(line, clause, n);
  }
  assert.match(b, /council/i);
});

test('copied agents carry no sibling-plugin names or optional third-party tools', () => {
  for (const [n, { fm, body }] of Object.entries(agents)) {
    assert.doesNotMatch(body + fm.description, /slim-claude/, n);
    assert.doesNotMatch(body, /\brtk\b/, n);
  }
});

test('each agent has name = filename, description, no colon in name', () => {
  for (const [name, { fm }] of Object.entries(agents)) {
    assert.equal(fm.name, name);
    assert.ok(!name.includes(':'));
    assert.ok(fm.description && fm.description.length > 10, name);
  }
});

test('no OpenCode-only vocabulary in any agent', () => {
  for (const [name, { fm, body }] of Object.entries(agents)) {
    assert.doesNotMatch(body, FORBIDDEN, name);
    assert.doesNotMatch(fm.description, FORBIDDEN, name);
  }
});

test('read-only agents cannot write', () => {
  for (const n of ['explorer', 'oracle']) {
    const d = agents[n].fm.disallowedTools;
    assert.ok(String(d).includes('Edit') && String(d).includes('Write'), n);
  }
  assert.equal(agents.observer.fm.tools, 'Read');
});

test('models: explorer haiku, oracle opus, others as designed', () => {
  assert.equal(agents.explorer.fm.model, 'haiku');
  assert.equal(agents.oracle.fm.model, 'opus');
  for (const n of ['designer', 'fixer', 'observer']) {
    assert.equal(agents[n].fm.model, 'sonnet', n);
  }
  assert.equal(agents.orchestrator.fm.model, undefined);
});

test('every preloaded skill exists', () => {
  for (const [name, { fm }] of Object.entries(agents)) {
    for (const s of fm.skills ?? []) {
      assert.ok(s.startsWith('lil-slim:'), `${name}: ${s} unprefixed`);
      const dir = s.slice('lil-slim:'.length);
      assert.ok(
        existsSync(path.join(root, 'skills', dir, 'SKILL.md')),
        `${name} -> ${s}`,
      );
    }
  }
});

test('orchestrator delegates by prefixed name and specialists do not dispatch', () => {
  assert.match(agents.orchestrator.body, /lil-slim:explorer/);
  assert.match(agents.orchestrator.body, /lil-slim:fixer/);
  for (const n of ['explorer', 'oracle', 'designer', 'fixer', 'observer']) {
    assert.match(agents[n].body, /do not (dispatch|spawn)/i, n);
  }
});

test('leaf specialists cannot use the Agent tool', () => {
  for (const n of ['explorer', 'fixer']) {
    const d = agents[n].fm.disallowedTools;
    assert.ok(String(d ?? '').includes('Agent'), n);
  }
});

test('.mcp.json declares context7 and gh_grep', () => {
  const j = JSON.parse(readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  assert.ok(j.mcpServers.context7.url.includes('context7'));
  assert.ok(j.mcpServers.gh_grep.url.includes('grep.app'));
});

test('orchestrator keeps per-agent delegate/do-not routing criteria', () => {
  const b = agents.orchestrator.body;
  assert.match(b, /Never do UI\/design work yourself/);
  assert.match(b, /Don't:[^\n]*small/);
  assert.match(b, /escalation, not a default/);
  assert.match(b, /full file path/);
});

test('read-only agents have no shell tools', () => {
  for (const n of ['explorer', 'oracle']) {
    const d = String(agents[n].fm.disallowedTools);
    for (const t of ['Bash', 'PowerShell', 'Monitor']) {
      assert.ok(d.includes(t), `${n} allows ${t}`);
    }
  }
});

test('orchestrator carries the basics the default prompt would have', () => {
  const b = agents.orchestrator.body;
  assert.match(b, /prefer dedicated file\/search tools over shell/i);
  assert.match(b, /authorized security testing/i);
  assert.match(b, /Reference code as `?file_path:line_number/);
});
