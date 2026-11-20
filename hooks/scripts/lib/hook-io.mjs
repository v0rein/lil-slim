import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_AGENTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'agents',
);

export function parseInput(text) {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export const PLUGIN_NAME = 'lil-slim';

/** Name of a plugin-owned agent, or null. A bare or foreign-prefixed
 * `agent_type` belongs to the user or another plugin and is not ours. */
export function agentName(input) {
  const t = input?.agent_type;
  const prefix = `${PLUGIN_NAME}:`;
  if (typeof t !== 'string' || !t.startsWith(prefix)) return null;
  return t.slice(prefix.length) || null;
}

export function isPluginAgent(input, agentsDir = DEFAULT_AGENTS_DIR) {
  const name = agentName(input);
  if (name === null || !/^[a-z0-9-]+$/.test(name)) return false;
  return existsSync(path.join(agentsDir, `${name}.md`));
}

export function denyOutput(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

export function contextOutput(event, text) {
  return {
    hookSpecificOutput: { hookEventName: event, additionalContext: text },
  };
}

export function stateDir(env = process.env) {
  return env.CLAUDE_PLUGIN_DATA || path.join(tmpdir(), 'lil-slim');
}

export function isMain(metaUrl) {
  if (process.argv[1] === undefined) return false;
  try {
    // Node realpaths import.meta.url; argv[1] keeps junctions/symlinks.
    return (
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl))
    );
  } catch {
    return false;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** Fail-safe wrapper: any error or odd input exits 0 with no output. */
export async function runHook(decide) {
  try {
    const input = parseInput(await readStdin());
    if (input === null) return;
    const out = await decide(input);
    if (out !== null && out !== undefined) {
      process.stdout.write(JSON.stringify(out));
    }
  } catch {
    // never block the user because of a hook bug
  }
}
