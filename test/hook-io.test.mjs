import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  agentName,
  contextOutput,
  denyOutput,
  isPluginAgent,
  parseInput,
  stateDir,
} from '../hooks/scripts/lib/hook-io.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hookIo = path.join(here, '..', 'hooks', 'scripts', 'lib', 'hook-io.mjs');

test('parseInput returns null for non-object JSON and garbage', () => {
  for (const bad of ['', 'nope', '[1]', '"x"', 'null', '5']) {
    assert.equal(parseInput(bad), null, bad);
  }
});

test('parseInput returns the object for a JSON object', () => {
  assert.deepEqual(parseInput('{"a":1}'), { a: 1 });
});

test('agentName requires the plugin prefix and rejects non-strings', () => {
  assert.equal(
    agentName({ agent_type: 'lil-slim:explorer' }),
    'explorer',
  );
  assert.equal(agentName({ agent_type: 'explorer' }), null);
  assert.equal(agentName({ agent_type: 'otherplug:explorer' }), null);
  assert.equal(agentName({}), null);
  assert.equal(agentName({ agent_type: 5 }), null);
  assert.equal(agentName({ agent_type: '' }), null);
});

test('isPluginAgent requires prefix and a matching agents/<name>.md file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'omcs-agents-'));
  writeFileSync(path.join(dir, 'explorer.md'), '---\nname: explorer\n---\n');
  mkdirSync(path.join(dir, 'sub'));
  const p = (n) => ({ agent_type: `lil-slim:${n}` });
  assert.equal(isPluginAgent(p('explorer'), dir), true);
  assert.equal(isPluginAgent({ agent_type: 'explorer' }, dir), false);
  assert.equal(isPluginAgent({ agent_type: 'otherplug:explorer' }, dir), false);
  assert.equal(isPluginAgent(p('ghost'), dir), false);
  assert.equal(isPluginAgent(p('../x'), dir), false);
  assert.equal(isPluginAgent(p('sub/explorer'), dir), false);
  assert.equal(isPluginAgent({}, dir), false);
});

test('isMain survives a junction path to the plugin', () => {
  const link = path.join(mkdtempSync(path.join(tmpdir(), 'omcs-link-')), 'p');
  symlinkSync(path.join(here, '..'), link, 'junction');
  const r = spawnSync(
    process.execPath,
    [path.join(link, 'hooks', 'scripts', 'phase-reminder.mjs')],
    {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        agent_type: 'lil-slim:orchestrator',
      }),
      encoding: 'utf8',
    },
  );
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Scheduler workflow/);
});

test('denyOutput and contextOutput shape', () => {
  assert.deepEqual(denyOutput('no'), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'no',
    },
  });
  assert.deepEqual(contextOutput('SessionStart', 'hi'), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hi' },
  });
});

test('stateDir prefers CLAUDE_PLUGIN_DATA, falls back to tmpdir', () => {
  assert.equal(stateDir({ CLAUDE_PLUGIN_DATA: '/d' }), '/d');
  assert.equal(
    stateDir({}),
    path.join(tmpdir(), 'lil-slim'),
  );
});

function runInline(stdin, body) {
  const code = `import { runHook } from ${JSON.stringify(
    `file:///${hookIo.replaceAll('\\', '/')}`,
  )};\nawait runHook(${body});`;
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', code],
    { input: stdin, encoding: 'utf8' },
  );
}

test('runHook is silent and exits 0 on garbage stdin', () => {
  const r = runInline('garbage', '() => ({ never: true })');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('runHook is silent and exits 0 when decide throws', () => {
  const r = runInline('{"a":1}', '() => { throw new Error("boom"); }');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('runHook prints decide output as JSON', () => {
  const r = runInline('{"a":1}', '(i) => ({ got: i.a })');
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { got: 1 });
});

test('runHook prints nothing when decide returns null', () => {
  const r = runInline('{"a":1}', '() => null');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
