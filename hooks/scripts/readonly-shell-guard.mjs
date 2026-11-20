import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  agentName,
  denyOutput,
  isMain,
  isPluginAgent,
  runHook,
} from './lib/hook-io.mjs';

// Read-only auditors that keep Bash only to inspect the repo and run tests.
// This is a seatbelt against accidents, not a sandbox: an unknown command or
// a script file run through `node x.js` cannot be inspected and is allowed.
export const READONLY_SHELL_AGENTS = new Set(['arbiter', 'hunter', 'proctor']);

const GIT_READ = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'grep',
  'cat-file', 'ls-tree', 'describe', 'shortlog', 'rev-list', 'show-ref',
  'merge-base', 'diff-tree', 'for-each-ref', 'name-rev', 'version',
]);
const ALWAYS_WRITE = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'touch', 'mkdir', 'chmod', 'chown', 'ln', 'tee',
  'dd', 'truncate', 'install', 'patch', 'wget', 'apt', 'apt-get', 'brew',
  'choco', 'winget', 'sudo',
]);
const TMP_OK = new Set(['rm', 'rmdir', 'mv', 'cp', 'touch', 'mkdir', 'tee']);
const PKG_WRITE = /^(install|i|add|remove|rm|uninstall|update|upgrade|ci|link|publish|unlink|dedupe)$/;
const CODE_WRITES = /writeFile|appendFile|unlink|rmSync|\brm\(|rename|mkdir|copyFile|truncate|createWriteStream|child_process|execSync|\bspawn|\bexec\(|\.write\(|open\([^)]*['"][wax+]|os\.(remove|system|unlink)|shutil|subprocess/;

function tmpPrefixes(tmp) {
  const raw = String(tmp).replaceAll('\\', '/').replace(/\/+$/, '');
  const out = new Set(['/tmp', raw, String(tmpdir()).replaceAll('\\', '/').replace(/\/+$/, '')]);
  for (const p of [...out]) {
    const m = /^([A-Za-z]):(\/.*)$/.exec(p);
    if (m) out.add(`/${m[1].toLowerCase()}${m[2]}`);
  }
  return [...out].filter(Boolean);
}

function isTmp(target, prefixes) {
  const t = target.replaceAll('\\', '/');
  if (t.includes('..')) return false;
  if (/^\$\{?(TMP|TEMP|TMPDIR)\}?(\/|$)/.test(t)) return true;
  return prefixes.some((p) => t === p || t.startsWith(`${p}/`));
}

const MASK = /"(?:[^"\\]|\\.)*"|'[^']*'/g;
const SPLIT = /&&|\|\||[|;\n]|(?<![>&])&(?![>&0-9])/;

function segmentReason(seg, prefixes) {
  let tokens = seg.trim().split(/\s+/).filter(Boolean);
  while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || /^(command|time|env|nohup|exec)$/.test(tokens[0]))) tokens = tokens.slice(1);
  if (!tokens.length) return null;
  const cmd = path.basename(tokens[0]).replace(/\.exe$/i, '');
  const args = tokens.slice(1);
  const plain = args.filter((t) => !t.startsWith('-'));

  if (cmd === 'git') {
    const sub = plain[0];
    if (!sub) return null;
    if (GIT_READ.has(sub)) return null;
    if (sub === 'branch' && args.every((t) => /^(-a|-r|-v|-vv|--list|--all|--show-current|--contains)$/.test(t) || t === 'branch')) return null;
    if (sub === 'remote' && (args.includes('-v') || plain.length === 1)) return null;
    if (sub === 'stash' && plain[1] === 'list') return null;
    if (sub === 'worktree' && plain[1] === 'list') return null;
    if (sub === 'config' && args.some((t) => /^--(get|list|get-all)$/.test(t) || t === '-l')) return null;
    return `git ${sub} changes repository state`;
  }
  if (cmd === 'sed' && args.some((t) => /^-[a-zA-Z]*i/.test(t) || t.startsWith('--in-place'))) return 'sed -i edits files in place';
  if (cmd === 'perl' && args.some((t) => /^-[a-zA-Z]*i/.test(t))) return 'perl -i edits files in place';
  if (cmd === 'curl' && args.some((t) => /^(-o|-O|--output|--remote-name|-T|--upload-file)$/.test(t))) return 'curl writes a file';
  if (/^(npm|pnpm|yarn|bun)$/.test(cmd) && PKG_WRITE.test(plain[0] ?? '')) return `${cmd} ${plain[0]} changes dependencies`;
  if (/^(pip|pip3|gem|cargo|go)$/.test(cmd) && /^(install|uninstall|add|remove|get)$/.test(plain[0] ?? '')) return `${cmd} ${plain[0]} changes the environment`;
  if (cmd === 'find') {
    if (args.some((t) => /^-(delete|fprint|fprintf|fls)$/.test(t))) return 'find writes or deletes';
    const i = args.findIndex((t) => /^-(exec|execdir|ok|okdir)$/.test(t));
    if (i >= 0) return segmentReason(args.slice(i + 1).join(' '), prefixes);
    return null;
  }
  if (cmd === 'xargs') return segmentReason(plain.join(' '), prefixes);
  if (cmd === 'eval' || cmd === 'source' || cmd === '.') return 'eval/source runs uninspectable code';
  if (ALWAYS_WRITE.has(cmd)) {
    if (TMP_OK.has(cmd) && plain.length && plain.every((p) => isTmp(p, prefixes))) return null;
    return `${cmd} modifies the filesystem`;
  }
  return null;
}

export function classify(command, deps = {}) {
  const cmd = String(command ?? '');
  if (!cmd.trim()) return null;
  const prefixes = tmpPrefixes(deps.tmp ?? tmpdir());

  // Code carried in quotes: shells recurse, interpreters are checked for write APIs.
  for (const m of cmd.matchAll(/\b(?:ba|z)?sh\s+-c\s+(["'])([\s\S]*?)\1/g)) {
    const r = classify(m[2], deps);
    if (r) return r;
  }
  for (const m of cmd.matchAll(/\beval\s+(["'])([\s\S]*?)\1/g)) {
    const r = classify(m[2], deps);
    if (r) return r;
  }
  for (const m of cmd.matchAll(/\b(?:node|nodejs|python3?|perl|ruby)\s+(?:-e|-c|-p|--eval|--print)\s+(["'])([\s\S]*?)\1/g)) {
    if (CODE_WRITES.test(m[2])) return 'inline code writes files or spawns processes';
  }
  for (const m of cmd.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    const r = classify(m[1] ?? m[2], deps);
    if (r) return r;
  }

  const masked = cmd.replace(MASK, 'Q');
  for (const m of masked.matchAll(/(?:\d|&)?>>?\s*([^\s;&|)]+)/g)) {
    const target = m[1];
    if (target.startsWith('&') || target === '/dev/null' || target === 'NUL') continue;
    if (isTmp(target, prefixes)) continue;
    return `redirect to ${target} writes a file`;
  }
  for (const seg of masked.split(SPLIT)) {
    const r = segmentReason(seg, prefixes);
    if (r) return r;
  }
  return null;
}

export function decide(input, deps = {}) {
  if (input.tool_name !== 'Bash') return null;
  if (!isPluginAgent(input, deps.agentsDir)) return null;
  const agent = agentName(input);
  if (!READONLY_SHELL_AGENTS.has(agent)) return null;
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return null;
  const reason = classify(command, deps);
  if (!reason) return null;
  return denyOutput(
    `${agent} is read-only: ${reason}. Run only inspection or test commands, and report what should change instead of changing it.`,
  );
}

if (isMain(import.meta.url)) await runHook((input) => decide(input));
