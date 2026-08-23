// ============================================================================
// Copy the POS client bundle in, so it can be packaged.
//
// The renderer is NOT vendored in git — it is a build output of the web repo
// (`npm run build:desktop` there, producing dist-desktop/client). Committing it
// would mean two copies of the POS drifting apart, which is exactly what this
// repository must not create.
// ============================================================================
import { cpSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_SRC = resolve(process.cwd(), '..', 'digitaltarget.digital', 'dist-desktop', 'client');
const src = resolve(process.env.DTPOS_RENDERER ?? DEFAULT_SRC);
const dest = resolve(process.cwd(), 'renderer');

if (!existsSync(resolve(src, 'index.html'))) {
  console.error(`[renderer] No client bundle at: ${src}`);
  console.error('[renderer] Build it in the web repo first:');
  console.error('[renderer]     npm run build:desktop');
  console.error('[renderer] Or point DTPOS_RENDERER at the output directory.');
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`[renderer] copied ${src} -> ${dest}`);
