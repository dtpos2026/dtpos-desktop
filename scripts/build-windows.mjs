// ============================================================================
// WINDOWS PACKAGING — with the symlink trap defused
//
// THE FAILURE THIS EXISTS FOR
//
//   ERROR: Cannot create symbolic link : A required privilege is not held
//   by the client.
//
// It happens while electron-builder extracts its `winCodeSign` cache. That
// archive is shared across platforms and contains macOS `.dylib` SYMLINKS.
// Creating a symlink on Windows needs SeCreateSymbolicLinkPrivilege, which an
// ordinary user account does not hold, so the extraction dies — and the error
// names a symlink rather than the thing that asked for it.
//
// WHY IT IS BEING DOWNLOADED AT ALL
//
// DT POS is not code-signed (see electron-builder.yml). But electron-builder
// AUTO-DISCOVERS certificates from the Windows certificate store: if the build
// machine happens to hold any code-signing certificate, it decides it can sign,
// and reaches for winCodeSign. On a machine with no certificate it logs "no
// signing info identified, signing is skipped" and never downloads it — which
// is exactly why this failure looks random across machines.
//
// So the fix is to say plainly that we are not signing. With
// CSC_IDENTITY_AUTO_DISCOVERY=false and no certificate configured,
// signUsingSigntool() short-circuits before getSignVendorPath() is ever
// called, and the archive with the symlinks is never fetched.
//
// rcedit — which stamps the version and icon into the .exe — is unaffected ON
// WINDOWS: there electron-builder runs it through its own bundled app-builder
// binary, which touches no symlinks, so the installer keeps its metadata.
//
// ON LINUX the same step goes through winCodeSign's rcedit-ia32.exe under
// wine, so a Linux host downloads that archive regardless of signing. Linux
// can create symlinks, so it never hits this error — it hits the missing-wine
// one instead. Package on Windows, or use the CI workflow.
//
//   node scripts/build-windows.mjs             nsis + portable
//   node scripts/build-windows.mjs --dir       unpacked only, no installer
//   node scripts/build-windows.mjs --clean     purge the poisoned cache first
//
// TO SIGN THE BUILD INSTEAD
// Set WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD (or win.signtoolOptions in
// electron-builder.yml) and run with DT_ALLOW_SIGNING=1. You then DO need the
// symlink privilege: turn on Windows Developer Mode (Settings → Privacy &
// security → For developers), or run the build from an elevated terminal.
// ============================================================================
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

const args = process.argv.slice(2);
const clean = args.includes('--clean');
const dirOnly = args.includes('--dir');
const allowSigning = process.env.DT_ALLOW_SIGNING === '1';

/** electron-builder's download cache, where the half-extracted archive sits. */
function cacheRoot() {
  if (process.env.ELECTRON_BUILDER_CACHE) return process.env.ELECTRON_BUILDER_CACHE;
  if (platform() === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache');
  }
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Caches', 'electron-builder');
  return join(homedir(), '.cache', 'electron-builder');
}

// --------------------------------------------------------------- clean cache
//
// A failed extraction leaves a PARTIAL winCodeSign directory behind. Every
// later run then finds a directory that exists but is incomplete, and fails in
// a new place — so granting the privilege alone does not fix a machine that has
// already hit this once. The directory has to go.
if (clean) {
  const stale = join(cacheRoot(), 'winCodeSign');
  if (existsSync(stale)) {
    rmSync(stale, { recursive: true, force: true });
    console.log(`[build-windows] removed the partially-extracted cache: ${stale}`);
  } else {
    console.log('[build-windows] no winCodeSign cache to remove');
  }
}

// ------------------------------------------------------------------- signing
const env = { ...process.env };
if (allowSigning) {
  console.log('[build-windows] DT_ALLOW_SIGNING=1 — code signing is ENABLED.');
  console.log('[build-windows] Windows Developer Mode or an elevated terminal is required,');
  console.log('[build-windows] because winCodeSign extraction creates symlinks.');
} else {
  // The one line that keeps the symlink archive out of the build.
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  console.log('[build-windows] unsigned build (CSC_IDENTITY_AUTO_DISCOVERY=false).');
  console.log('[build-windows] SmartScreen will warn on first run until a certificate is configured.');
}

// -------------------------------------------------------------------- build
const builderArgs = ['electron-builder', '--win', '--x64'];
if (dirOnly) builderArgs.push('--dir');

console.log(`\n[build-windows] npx ${builderArgs.join(' ')}\n`);
const r = spawnSync('npx', builderArgs, {
  cwd: process.cwd(), stdio: 'inherit', env,
  shell: process.platform === 'win32',
});

if (r.status !== 0) {
  console.error('\n[build-windows] packaging failed.');
  console.error('If the error mentions "Cannot create symbolic link":');
  console.error('  1. node scripts/build-windows.mjs --clean');
  console.error('  2. Turn on Windows Developer Mode, or run this from an elevated terminal.');
  console.error('  3. Confirm no certificate is being auto-discovered:');
  console.error('     the log should say "no signing info identified, signing is skipped".');
  process.exit(r.status ?? 1);
}

console.log('\n[build-windows] done — see release/');
