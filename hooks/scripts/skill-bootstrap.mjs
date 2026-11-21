import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentName, contextOutput, isMain, runHook } from './lib/hook-io.mjs';

const DEFAULT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OFF = new Set(['off', '0', 'false', 'no']);

/** The skill body without its frontmatter, LF only; null if absent or empty. */
function loadSkill(root) {
  const f = path.join(root, 'skills', 'using-lil-slim', 'SKILL.md');
  if (!existsSync(f)) return null;
  const text = readFileSync(f, 'utf8').replace(/\r/g, '');
  const m = /^---\n[\s\S]*?\n---\n/.exec(text);
  const body = (m ? text.slice(m[0].length) : text).trim();
  return body === '' ? null : body;
}

/**
 * Mirrors how the original plugin starts a session: inject the "how to use
 * skills" skill as mandatory context. Applies to the orchestrator and to a
 * plain session; subagents and other plugins' agents are left alone.
 */
export function decide(input, deps = {}) {
  if (input.hook_event_name !== 'SessionStart') return null;
  const type = input.agent_type;
  if (type !== undefined && agentName(input) !== 'orchestrator') return null;
  const env = deps.env ?? process.env;
  if (OFF.has(String(env.LIL_SLIM_SKILLS ?? '').toLowerCase())) return null;
  const body = loadSkill(deps.root ?? DEFAULT_ROOT);
  if (body === null) return null;
  const text = `<EXTREMELY_IMPORTANT>
You have lil-slim skills.

**Below is the full content of your 'lil-slim:using-lil-slim' skill. For all other skills, use the 'Skill' tool:**

---
${body}
</EXTREMELY_IMPORTANT>`;
  return contextOutput('SessionStart', text);
}

if (isMain(import.meta.url)) await runHook((input) => decide(input));
