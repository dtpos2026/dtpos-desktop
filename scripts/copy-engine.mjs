// ============================================================================
// tsc compiles TypeScript only. The printing engine is CommonJS (.cjs, brought over from the offline v1.21.0 shell
// as it was), so it is copied beside the compiled output — electron-builder ships out/**/* and nothing else.
// ============================================================================
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const from = join('src', 'main', 'printing-engine');
const to = join('out', 'main', 'printing-engine');
mkdirSync(to, { recursive: true });
let n = 0;
for (const f of readdirSync(from)) {
  if (!f.endsWith('.cjs')) continue;
  cpSync(join(from, f), join(to, f));
  n++;
}
console.log(`[copy-engine] ${n} files -> ${to}`);
