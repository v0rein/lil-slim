import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PHASE_REMINDER_TEXT,
  decide,
} from '../hooks/scripts/phase-reminder.mjs';

const FORBIDDEN =
  /task_status|task_cancel|task_reply|apply_patch|wait_for_user|OpenCode|@explorer|@fixer|@oracle|@designer|@observer/;

test('orchestrator SessionStart gets the reminder', () => {
  const out = decide({
    hook_event_name: 'SessionStart',
    agent_type: 'lil-slim:orchestrator',
  });
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /Scheduler workflow/);
  assert.equal(out.hookSpecificOutput.additionalContext, PHASE_REMINDER_TEXT);
});

test('bare or foreign-prefixed orchestrator gets nothing', () => {
  assert.equal(
    decide({ hook_event_name: 'SessionStart', agent_type: 'orchestrator' }),
    null,
  );
  assert.equal(
    decide({
      hook_event_name: 'SessionStart',
      agent_type: 'otherplug:orchestrator',
    }),
    null,
  );
});

test('other agents, no agent, and other events get nothing', () => {
  assert.equal(
    decide({
      hook_event_name: 'SessionStart',
      agent_type: 'lil-slim:explorer',
    }),
    null,
  );
  assert.equal(decide({ hook_event_name: 'SessionStart' }), null);
  assert.equal(
    decide({
      hook_event_name: 'PreToolUse',
      agent_type: 'lil-slim:orchestrator',
    }),
    null,
  );
  assert.equal(decide({}), null);
});

test('reminder text has no OpenCode-only vocabulary', () => {
  assert.doesNotMatch(PHASE_REMINDER_TEXT, FORBIDDEN);
});
