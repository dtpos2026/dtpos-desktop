// ============================================================================
// v1.77.0 — launching the POS a second time.
//
// REPORTED: installed as Administrator, the app opens; clicking the shortcut again does nothing.
//
// The cause found in the code, not guessed:
//   • the printing engine keeps a HIDDEN BrowserWindow, so closing the POS window never fired `window-all-closed`
//     and the process lingered, holding the single-instance lock;
//   • a later click on the shortcut then quit silently ("a copy is already running"), while the lingering copy
//     focused `getAllWindows()[0]` — the hidden worker — so nothing appeared;
//   • a copy running elevated cannot be messaged by a normal one at all.
//
// These tests pin each repair. A real install, UAC prompt and shortcut click can only be exercised on Windows;
// that is in README "Launch troubleshooting" and the QA record, and is NOT claimed here.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const read = (p) => readFileSync(join(root, p), 'utf8');
const require = createRequire(import.meta.url);
const si = require(join(root, 'out/main/singleInstance.js'));
const ll = require(join(root, 'out/main/launchLog.js'));

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

// ---------------------------------------------------------------- the cause
test('the printing engine really does keep a hidden window (why closing the POS used to leave a process behind)', () => {
  assert.match(read('src/main/printing-engine/engine.cjs'), /printWorker = new BrowserWindow\(\{\s*show: false/);
});

// ---------------------------------------------------------------- the repairs
test('closing the POS window takes every helper window down and ends the program', () => {
  const idx = stripComments(read('src/main/index.ts'));
  assert.match(idx, /win\.on\('closed', \(\) => \{[\s\S]*?BrowserWindow\.getAllWindows\(\)[\s\S]*?\.destroy\(\)[\s\S]*?app\.quit\(\)/);
});

test('a second launch surfaces the POS window, not "the first window Electron lists"', () => {
  const idx = stripComments(read('src/main/index.ts'));
  assert.doesNotMatch(idx, /getAllWindows\(\)\[0\]/);
  assert.doesNotMatch(idx, /const \[win\] = BrowserWindow\.getAllWindows\(\)/);
  assert.match(idx, /getMainWindow\(\)/);
});

test('a second launch recreates the window if the POS window is gone, and shows it if it is hidden', () => {
  const idx = stripComments(read('src/main/index.ts'));
  assert.match(idx, /if \(!win\) \{[^}]*createWindow\(\)/);
  assert.match(idx, /if \(!win\.isVisible\(\)\) win\.show\(\)/);
  assert.match(idx, /if \(win\.isMinimized\(\)\) win\.restore\(\)/);
});

test('the running copy acknowledges a hand-over, and the copy that handed over says so when nobody answers', () => {
  const idx = stripComments(read('src/main/index.ts'));
  assert.match(idx, /app\.on\('second-instance'[\s\S]*?writeAck\(userDataDir\)/);
  assert.match(idx, /waitForAck\(userDataDir/);
  assert.match(idx, /showMessageBoxSync/);
});

test('the program itself never requests Administrator, and the installer starts it as the normal user', () => {
  const y = read('electron-builder.yml');
  assert.match(y, /^\s{2}requestedExecutionLevel: asInvoker$/m);
  assert.match(y, /^\s{2}runAfterFinish: true$/m);
  // Installing per machine is still the way a shared till is set up — the installer asks once.
  assert.match(y, /^\s{2}perMachine: true\b/m);
});

test('the POS writes only under the user profile, never beside its own executable (Program Files is read-only to a normal user)', () => {
  for (const f of ['src/main/ipc/files.ts', 'src/main/ipc/system.ts', 'src/main/ipc/printing.ts', 'src/main/launchLog.ts']) {
    const src = stripComments(read(f));
    assert.doesNotMatch(src, /process\.resourcesPath[^;]*write|getAppPath\(\)[^;]*write/i, f);
  }
  const eng = read('src/main/printing-engine/engine.cjs');
  assert.match(eng, /app\.getPath\('userData'\)/);
});

// ---------------------------------------------------------------- the hand-over note
test('writeAck / readAck round-trip, and a missing or corrupt note reads as nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtpos-ack-'));
  assert.equal(si.readAck(dir), null);
  si.writeAck(dir, 1234, 99);
  assert.deepEqual(si.readAck(dir), { at: 1234, pid: 99 });
  writeFileSync(si.ackPath(dir), '{not json');
  assert.equal(si.readAck(dir), null);
  writeFileSync(si.ackPath(dir), JSON.stringify({ at: 'soon' }));
  assert.equal(si.readAck(dir), null);
});

test('writeAck never throws, even when the folder cannot be written', () => {
  // A path BELOW a regular file cannot be created (ENOTDIR). Not /proc: a recursive mkdir under it never returns.
  const dir = mkdtempSync(join(tmpdir(), 'dtpos-ack-'));
  const file = join(dir, 'a-file');
  writeFileSync(file, 'x');
  assert.doesNotThrow(() => si.writeAck(join(file, 'child')));
});

test('waitForAck: true as soon as a note newer than the launch appears', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtpos-ack-'));
  let t = 1000;
  const sleep = async (ms) => { t += ms; if (t >= 1300) si.writeAck(dir, t); };
  const ok = await si.waitForAck(dir, 1000, { timeoutMs: 3000, stepMs: 100, sleep, now: () => t });
  assert.equal(ok, true);
  assert.ok(t < 2000, 'returned promptly instead of waiting out the timeout');
});

test('waitForAck: a note from an EARLIER launch does not count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtpos-ack-'));
  si.writeAck(dir, 500);
  let t = 1000;
  const ok = await si.waitForAck(dir, 1000, { timeoutMs: 600, stepMs: 100, sleep: async (ms) => { t += ms; }, now: () => t });
  assert.equal(ok, false);
});

test('waitForAck: false when nobody answers within the time limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtpos-ack-'));
  let t = 0;
  const ok = await si.waitForAck(dir, 0, { timeoutMs: 1000, stepMs: 250, sleep: async (ms) => { t += ms; }, now: () => t });
  assert.equal(ok, false);
});

test('the message tells the user what to do, in plain words', () => {
  assert.match(si.UNREACHABLE_MESSAGE, /Task Manager/);
  assert.match(si.UNREACHABLE_MESSAGE, /Run as administrator/);
});

// ---------------------------------------------------------------- the log
test('the launch log writes lines, stays silent before init, and never throws', () => {
  assert.doesNotThrow(() => ll.launchLog('before init'));
  const dir = mkdtempSync(join(tmpdir(), 'dtpos-log-'));
  ll.initLaunchLog(dir);
  ll.launchLog('start', { a: 1 });
  ll.launchLog('boom', new Error('x'));
  const text = readFileSync(join(dir, 'logs', 'launch.log'), 'utf8');
  assert.match(text, /start — \{"a":1\}/);
  assert.match(text, /boom — Error: x/);
});

test('the launch log is capped, so it can never fill a till disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtpos-log-'));
  ll.initLaunchLog(dir);
  const big = 'x'.repeat(2000);
  for (let i = 0; i < 400; i++) ll.launchLog('fill', big);   // ~800 kB written
  const files = readdirSync(join(dir, 'logs'));
  assert.ok(files.includes('launch.log.1'), 'rotated');
  assert.ok(existsSync(join(dir, 'logs', 'launch.log')));
});
