// Installs CI-built binaries into hooks/bin and records how they were made.
// usage: node hooks/rust/update-binaries.mjs <artifacts-dir>
//   <artifacts-dir>/lil-hook-<platform>/lil-hook[.exe]   (one folder per platform)
// Writes hooks/bin/<platform>/..., SHA256SUMS and BUILD.json, then (inside a git
// checkout) stages everything and marks the unix binaries executable.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sourceHash } from './source-hash.mjs';

const PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'windows-x64'];
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const art = process.argv[2];

if (!art) {
  console.error('usage: node hooks/rust/update-binaries.mjs <artifacts-dir>');
  process.exit(1);
}

const name = (p) => (p.startsWith('windows') ? 'lil-hook.exe' : 'lil-hook');
const missing = PLATFORMS.filter((p) => !existsSync(path.join(art, `lil-hook-${p}`, name(p))));
if (missing.length) {
  console.error(`missing artifacts for: ${missing.join(', ')}`);
  process.exit(1);
}

const bin = path.join(root, 'hooks', 'bin');
rmSync(bin, { recursive: true, force: true });
const sums = [];
const platforms = {};
for (const p of PLATFORMS) {
  const dest = path.join(bin, p, name(p));
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(path.join(art, `lil-hook-${p}`, name(p)), dest);
  const data = readFileSync(dest);
  const hex = createHash('sha256').update(data).digest('hex');
  sums.push(`${hex}  ${p}/${name(p)}`);
  platforms[p] = { file: `${p}/${name(p)}`, bytes: statSync(dest).size, sha256: hex };
}
writeFileSync(path.join(bin, 'SHA256SUMS'), `${sums.join('\n')}\n`);
const build = { sourceHash: sourceHash(here), platforms };
writeFileSync(path.join(bin, 'BUILD.json'), `${JSON.stringify(build, null, 2)}\n`);

const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
if (git('rev-parse', '--is-inside-work-tree').status === 0) {
  git('add', '-f', 'hooks/bin');
  for (const p of PLATFORMS.filter((x) => !x.startsWith('windows'))) {
    git('update-index', '--chmod=+x', `hooks/bin/${p}/lil-hook`);
  }
}
console.log(`installed ${PLATFORMS.length} binaries; sourceHash ${build.sourceHash.slice(0, 12)}`);
