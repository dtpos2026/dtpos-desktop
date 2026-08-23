// ============================================================================
// The preload must be ONE self-contained file.
//
// With sandbox:true a preload script has no module loader: `require('../shared/
// channels')` fails at load with "module not found", the bridge never runs, and
// the renderer sees no window.electronAPI at all — the POS then silently
// behaves as if it were a browser tab (no printing, no local DB, no machine id)
// rather than erroring.
//
// So it is bundled, with `electron` left external because the runtime provides
// it. The shared channel list is compiled in, which keeps one source of truth
// with main.
// ============================================================================
import { build } from 'esbuild';

await build({
  entryPoints: ['src/preload/index.ts'],
  outfile: 'out/preload/index.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});
