// Hash of everything that goes into the binary. BUILD.json records it so a test
// can fail when hooks/rust changes without the prebuilt binaries being rebuilt.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function sourceHash(rustDir) {
  const src = readdirSync(path.join(rustDir, 'src'))
    .filter((f) => f.endsWith('.rs'))
    .sort()
    .map((f) => `src/${f}`);
  const h = createHash('sha256');
  for (const f of ['Cargo.toml', 'Cargo.lock', ...src]) {
    const text = readFileSync(path.join(rustDir, f), 'utf8').replace(/\r\n/g, '\n');
    h.update(`${f}\0${text}\0`);
  }
  return h.digest('hex');
}
