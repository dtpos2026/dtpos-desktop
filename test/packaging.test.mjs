// ============================================================================
// v1.28.4 — the Windows installer was never going to build
//
// REPORTED: "Windows app bhi nahi ban rahi — koi update nahi hoi abi tak."
//
// Two independent reasons, both certain rather than intermittent:
//
//   1. The workflow checked the POS repository out at ref 'main'. That
//      repository has exactly one branch and it is not called main, so the
//      job died at step two — before Node was installed, before anything was
//      compiled — every single time.
//
//   2. Locally, `npm run dist` went straight to electron-builder, which
//      packages `extraResources: from: renderer`. renderer/ is git-ignored
//      because it is a build output of the web repo, so it is absent in every
//      fresh clone and the packaging step had no POS to put in the installer.
//
// These assert the fixes for both, and that the signing guard the symlink
// failure depends on is still the path CI takes.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/build-windows.yml', 'utf8');
const script = readFileSync('scripts/build-windows.mjs', 'utf8');
const builder = readFileSync('electron-builder.yml', 'utf8');

test('the POS checkout no longer names a branch that does not exist', () => {
  assert.ok(
    !/ref:\s*\$\{\{\s*github\.event\.inputs\.pos_ref\s*\|\|\s*'main'\s*\}\}/.test(workflow),
    "the workflow still defaults the POS ref to 'main', which does not exist",
  );
  // Blank means "that repository's default branch", so a rename cannot break it.
  assert.match(workflow, /ref:\s*\$\{\{\s*github\.event\.inputs\.pos_ref\s*\}\}/);
});

test('CI packages through the script that disables signature auto-discovery', () => {
  // Calling electron-builder directly skips CSC_IDENTITY_AUTO_DISCOVERY=false,
  // and a runner holding any code-signing certificate then reaches for the
  // winCodeSign archive and dies on its macOS .dylib symlinks.
  assert.ok(!/npx electron-builder --win --publish never/.test(workflow));
  assert.match(workflow, /run: npm run dist:clean/);
  assert.match(script, /env\.CSC_IDENTITY_AUTO_DISCOVERY = 'false'/);
});

test('CI says so when it cannot read the POS repository', () => {
  assert.match(workflow, /POS_REPO_TOKEN is not set/);
});

test('packaging refuses an empty renderer instead of shipping a blank window', () => {
  // The directory electron-builder is told to package...
  assert.match(builder, /extraResources:\s*\n\s*- from: renderer/);
  // ...is checked before electron-builder is started.
  assert.match(script, /renderer\/ is empty — there is no POS to package/);
  assert.ok(
    script.indexOf("join(process.cwd(), 'renderer', 'index.html')") <
    script.indexOf("spawnSync('npx', builderArgs"),
    'the renderer check must run before electron-builder is invoked',
  );
});

test('the workflow proves an installer was actually produced', () => {
  assert.match(workflow, /No installer was produced/);
  assert.match(workflow, /if-no-files-found: error/);
});
