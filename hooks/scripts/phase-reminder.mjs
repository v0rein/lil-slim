import { agentName, contextOutput, isMain, runHook } from './lib/hook-io.mjs';

export const PHASE_REMINDER_TEXT = `<system-reminder>
Scheduler workflow: pick the lightest workflow that fits. Direct work: execute and verify proportionately. Otherwise: plan lanes → dispatch specialists with the Agent tool (independent lanes in parallel, run_in_background when useful) → reconcile their results → verify.
</system-reminder>`;

export function decide(input) {
  if (input.hook_event_name !== 'SessionStart') return null;
  if (agentName(input) !== 'orchestrator') return null;
  return contextOutput('SessionStart', PHASE_REMINDER_TEXT);
}

if (isMain(import.meta.url)) await runHook((input) => decide(input));
