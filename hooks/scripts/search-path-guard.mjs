import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { findRescuedSuffix } from './absolute-path-rescue.mjs';
import { denyOutput, isMain, isPluginAgent, runHook } from './lib/hook-io.mjs';

/** Git-Bash style `/d/x` -> `D:\x` (win32 only; Claude Code accepts both). */
const MSYS_DRIVE = /^\/([a-zA-Z])\/(.*)$/s;

export function resolveSearchPath(
  cwd,
  raw,
  pathOps = path,
  platform = process.platform,
) {
  if (!cwd) return null;
  if (
    raw === '~' ||
    raw.startsWith('~/') ||
    (platform === 'win32' && raw.startsWith('~\\'))
  ) {
    return pathOps.resolve(cwd, pathOps.join(homedir(), raw.slice(2)));
  }
  if (platform === 'win32') {
    const m = MSYS_DRIVE.exec(raw);
    if (m) return pathOps.resolve(`${m[1].toUpperCase()}:\\`, m[2]);
  }
  if (pathOps.isAbsolute(raw)) return raw;
  return pathOps.resolve(cwd, raw);
}

export function decide(input, deps = {}) {
  const tool = input.tool_name;
  if (tool !== 'Grep' && tool !== 'Glob') return null;
  if (!isPluginAgent(input, deps.agentsDir)) return null;
  const raw = input.tool_input?.path;
  if (
    typeof raw !== 'string' ||
    raw === '' ||
    (tool === 'Glob' && (raw === 'undefined' || raw === 'null'))
  ) {
    return null;
  }
  const pathOps = deps.pathOps ?? path;
  const resolved = resolveSearchPath(input.cwd, raw, pathOps);
  if (resolved === null) return null;

  try {
    (deps.stat ?? statSync)(resolved);
    return null;
  } catch (error) {
    const code = error?.code;
    if (code === 'ENOTDIR') {
      return denyOutput(
        `Search path is invalid: ${resolved} (from "${raw}"). A path component is not a directory (ENOTDIR), so the ${tool} search was blocked before it ran. Verify the target path and that every parent component is a directory.`,
      );
    }
    if (code !== 'ENOENT') return null;
  }

  // The rescue hook runs in parallel and may rewrite this path; do not
  // cancel a call it is about to fix.
  if (
    pathOps.isAbsolute(raw) &&
    findRescuedSuffix(raw, input.cwd, pathOps, deps.exists) !== null
  ) {
    return null;
  }
  return denyOutput(
    `Search path does not exist: ${resolved} (from "${raw}"). The ${tool} search was blocked before it ran. Verify the target path, or list its parent directory to find the correct location.`,
  );
}

if (isMain(import.meta.url)) await runHook((input) => decide(input));
