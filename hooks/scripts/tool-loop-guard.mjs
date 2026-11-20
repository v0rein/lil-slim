import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  contextOutput,
  denyOutput,
  isMain,
  isPluginAgent,
  runHook,
  stateDir,
} from './lib/hook-io.mjs';

export const WARN_AT = 3;
export const BLOCK_AT = 5;
export const MAX_STATE_FILES = 64;
const BLOCK_TOOLS = new Set(['Read', 'Grep', 'Glob']);
// Delegation and background-job polling legitimately repeat identically.
// hooks.json's matcher for this hook must skip exactly these (a test pins it).
export const EXEMPT = new Set([
  'Task',
  'Agent',
  'TaskOutput',
  'TaskStop',
  'TaskGet',
  'TaskList',
  'BashOutput',
  'KillShell',
  'Monitor',
]);
const STALE_TMP_MS = 60_000;

// Timing fields differ on every call and would hide an identical result.
const VOLATILE_KEYS = new Set(['durationMs', 'duration_ms']);

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v)
      .filter((k) => !VOLATILE_KEYS.has(k))
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'undefined';
}

const sha = (s) => createHash('sha1').update(s).digest('hex');

export function fingerprint(tool, args) {
  return sha(`${tool}\0${stable(args)}`);
}

function stateFile(dir, input) {
  const key = `${input.session_id ?? ''}\0${input.agent_id ?? 'main'}`;
  return path.join(dir, `loop-${sha(key)}.json`);
}

function load(file) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    if (s && typeof s.fp === 'string' && typeof s.runs === 'number') return s;
  } catch {
    // missing or corrupt: start over
  }
  return null;
}

/** Best effort: a contended rename (Windows) must not throw or leak the
 * temp file. A lost update only delays a warning by one call. */
function save(dir, file, state) {
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state));
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameSync(tmp, file);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
      }
    }
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
  }
  prune(dir);
}

function prune(dir) {
  const now = Date.now();
  const files = [];
  for (const f of readdirSync(dir)) {
    const full = path.join(dir, f);
    let mtime;
    try {
      mtime = statSync(full).mtimeMs;
    } catch {
      continue; // another process removed it
    }
    if (f.endsWith('.tmp')) {
      if (now - mtime > STALE_TMP_MS) {
        try {
          unlinkSync(full);
        } catch {
          // another process removed it
        }
      }
    } else if (f.startsWith('loop-') && f.endsWith('.json')) {
      files.push({ f, t: mtime });
    }
  }
  if (files.length <= MAX_STATE_FILES) return;
  files.sort((a, b) => a.t - b.t);
  for (const { f } of files.slice(0, files.length - MAX_STATE_FILES)) {
    try {
      unlinkSync(path.join(dir, f));
    } catch {
      // another process pruned it
    }
  }
}

export function decide(input, deps = {}) {
  const tool = input.tool_name;
  const event = input.hook_event_name;
  if (typeof tool !== 'string' || EXEMPT.has(tool)) return null;
  if (event !== 'PreToolUse' && event !== 'PostToolUse') return null;
  if (!isPluginAgent(input, deps.agentsDir)) return null;

  const dir = deps.dir ?? stateDir();
  const file = stateFile(dir, input);
  const fp = fingerprint(tool, input.tool_input);
  const prev = load(file);

  if (event === 'PreToolUse') {
    if (BLOCK_TOOLS.has(tool) && prev?.fp === fp && prev.runs >= BLOCK_AT) {
      return denyOutput(
        `Blocked: identical ${tool} call repeated ${prev.runs} times with identical results. Change approach.`,
      );
    }
    return null;
  }

  const out = sha(stable(input.tool_response));
  const runs = prev?.fp === fp && prev.out === out ? prev.runs + 1 : 1;
  save(dir, file, { fp, out, runs });
  if (runs >= WARN_AT) {
    return contextOutput(
      'PostToolUse',
      `You repeated the identical ${tool} call ${runs} times with identical results. Stop and change approach.`,
    );
  }
  return null;
}

if (isMain(import.meta.url)) await runHook((input) => decide(input));
