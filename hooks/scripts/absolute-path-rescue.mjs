import { statSync } from 'node:fs';
import path from 'node:path';

import { isMain, isPluginAgent, runHook } from './lib/hook-io.mjs';

const PATH_KEY = { Read: 'file_path', Grep: 'path', Glob: 'path' };

function defaultExists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** True only for a plain ENOENT; other stat errors are not "absent". */
function defaultIsMissing(p) {
  try {
    statSync(p);
    return false;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

/**
 * Re-anchor a guessed absolute path onto the workspace. Anchor = longest
 * workspace suffix found in the guess; it must occur exactly once and its
 * FULL tail must exist. Never invents paths.
 */
export function findRescuedSuffix(
  raw,
  workspace,
  pathOps = path,
  exists = defaultExists,
) {
  const sep = pathOps.sep;
  const root = pathOps.resolve(workspace);
  const resolvedRaw = pathOps.resolve(raw);
  if (resolvedRaw === root || resolvedRaw.startsWith(`${root}${sep}`)) {
    return null;
  }
  const normalized = sep === '/' ? raw : raw.replaceAll('/', sep);
  const guess = normalized.split(sep).filter((s) => s.length > 0);
  if (guess.some((s) => s === '..' || s === '.')) return null;
  const rootSegs = root.split(sep).filter((s) => s.length > 0);

  for (let len = rootSegs.length; len >= 1; len -= 1) {
    const anchor = rootSegs.slice(rootSegs.length - len);
    const hits = [];
    for (let i = 0; i + len <= guess.length; i += 1) {
      if (anchor.every((seg, j) => guess[i + j] === seg)) hits.push(i);
    }
    if (hits.length === 0) continue;
    if (hits.length > 1) return null;
    const candidate = [root, ...guess.slice(hits[0] + len)].join(sep);
    return exists(candidate) ? candidate : null;
  }
  return null;
}

export function decide(input, deps = {}) {
  const key = PATH_KEY[input.tool_name];
  if (key === undefined) return null;
  if (!isPluginAgent(input, deps.agentsDir)) return null;
  const toolInput = input.tool_input;
  if (toolInput === null || typeof toolInput !== 'object') return null;
  const raw = toolInput[key];
  const pathOps = deps.pathOps ?? path;
  if (typeof raw !== 'string' || raw === '' || !pathOps.isAbsolute(raw)) {
    return null;
  }
  if (typeof input.cwd !== 'string' || input.cwd === '') return null;
  if (!(deps.isMissing ?? defaultIsMissing)(raw)) return null;

  const rescued = findRescuedSuffix(
    raw,
    input.cwd,
    pathOps,
    deps.exists ?? defaultExists,
  );
  if (rescued === null) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...toolInput, [key]: rescued },
    },
  };
}

if (isMain(import.meta.url)) await runHook((input) => decide(input));
