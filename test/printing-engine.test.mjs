// ============================================================================
// The printing engine brought over from the offline DT POS Enterprise v1.21.0.
//
// What is pinned without a printer or a display: the engine loads, it registers exactly the printing channels the
// preload exposes (so the renderer's fast path — printHtmlEscpos, printRaw, printHtml — is really there), every
// helper module it needs is shipped beside it, and a missing helper cannot hide behind a lazy require.
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import Module from 'node:module';

const require = createRequire(import.meta.url);

// The engine only needs `BrowserWindow` from electron at load time.
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { BrowserWindow: class { isDestroyed() { return false; } } };
  return realLoad.call(this, request, ...rest);
};
const { registerPrintingEngine } = require('../out/main/printing-engine/engine.cjs');
Module._load = realLoad;

const PRINTING = ['getPrinters', 'getPrinterDetails', 'printReceipt', 'printHtml', 'printHtmlEscpos', 'printRaw', 'printWindowsTestPage',
  'openPrinterProperties', 'resetPrintStrategy', 'getPrintDiagnostics', 'printLanEscpos', 'testLanPrinter', 'scanLanPrinters',
  'pingHost', 'spoolerStatus', 'restartSpooler', 'clearPrintQueue'];

function load() {
  const handlers = new Map();
  const quit = [];
  const app = {
    getPath: () => process.env.TMPDIR || '/tmp',
    getVersion: () => '0.0.0',
    on: (ev, fn) => { if (ev === 'before-quit') quit.push(fn); },
    whenReady: () => new Promise(() => {}),   // never resolves: no worker is started in a test
  };
  registerPrintingEngine({ app, handle: (c, fn) => handlers.set(c, fn), getMainWindow: () => null, appendLog() {}, dataDir: process.env.TMPDIR || '/tmp' });
  return { handlers, quit };
}

test('the engine registers every printing channel, and only those', () => {
  const { handlers } = load();
  assert.deepEqual([...handlers.keys()].sort(), [...PRINTING].sort());
});

test('every printing channel is declared in the preload contract', async () => {
  const { INVOKE_CHANNELS } = await import('../out/shared/channels.js');
  for (const c of PRINTING) assert.ok(INVOKE_CHANNELS.includes(c), `${c} is not in INVOKE_CHANNELS`);
});

test('the helper modules the engine requires are all shipped beside it', () => {
  const src = readFileSync('src/main/printing-engine/engine.cjs', 'utf8');
  const needed = [...src.matchAll(/require\('\.\/([A-Za-z]+\.cjs)'\)/g)].map((m) => m[1]);
  assert.ok(needed.length >= 5, 'expected the engine to require its helper modules');
  for (const f of new Set(needed)) assert.ok(existsSync(`out/main/printing-engine/${f}`), `${f} is not in out/main/printing-engine`);
});

test('a handler refuses nonsense without throwing: empty documents, no host, no payload', async () => {
  const { handlers } = load();
  assert.deepEqual(await handlers.get('printHtml')({}, { html: '<p></p>' }), { success: false, error: 'empty document' });
  const lan = await handlers.get('printLanEscpos')({}, {});
  assert.equal(lan.success, false);
  const raw = await handlers.get('printRaw')({}, {});
  assert.equal(raw.success, false);
});

test('the raw path is Windows-only and says so elsewhere', async () => {
  const { handlers } = load();
  if (process.platform !== 'win32') {
    const r = await handlers.get('printRaw')({}, { printerName: 'X', data: [27, 64] });
    assert.equal(r.success, false);
    assert.match(String(r.error), /Windows/i);
  }
});
