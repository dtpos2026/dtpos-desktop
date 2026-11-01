// ============================================================================
// DT POS printing engine — brought over from the offline DT POS Enterprise v1.21.0 shell (electron/main.cjs),
// unchanged in behaviour: the fast RAW ESC/POS path, the hidden print worker, the driver path with its
// strategy memory, printer-name matching, LAN printing and scan, spooler tools and diagnostics.
//
// Only the wiring differs: the offline shell registered these with ipcMain.handle('kebab-name', ...) inside one
// 2,300-line file; here they are registered through `handle('camelName', ...)` so the channel contract
// (src/shared/channels.ts) stays the single list the preload and main agree on.
// ============================================================================
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { BrowserWindow } = require('electron');

/**
 * @param {{ app: any, handle: (channel: string, fn: Function) => void, getMainWindow: () => any,
 *           appendLog: (level: string, event: string, detail?: string) => void, dataDir: string }} deps
 */
function registerPrintingEngine({ app, handle, getMainWindow, appendLog, dataDir }) {
  const DATA_DIR = dataDir;
// ============================================================
// PRINTER NAME MATCHING — ONE implementation, used by every path.
//
// Mirrors src/printing/printerMatch.ts so the renderer's "is this printer
// installed?" answer and the main process's "which device do I print to?"
// answer can never disagree. Both the driver path (runPrintJob) and the RAW
// ESC/POS path call this; the raw path used to hand the stored name straight
// to winspool, so a printer installed as "BIXOLON SRP-352plusIII (Copy 1)"
// failed to open while the same printer printed fine through the driver.
//
// Windows reasons a name fails to match exactly:
//   • "(Copy 1)" / "(Copy 2)"   — duplicate driver install
//   • "(redirected 2)"          — RDP / session printers
//   • double spaces, non-breaking space (\u00A0), trailing space
//   • `name` vs `displayName`
//   • the printer was renamed after the setting was saved
// ============================================================
function normalizePrinterName(s) {
  return String(s || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function stripPrinterSuffix(s) {
  return normalizePrinterName(s)
    .replace(/\s*\((?:copy|redirected)\s*\d*\)\s*$/i, '')
    .trim();
}

/**
 * Resolve a requested printer name against the installed list, strictest
 * match first. Never hard-fails: an unmatched name is passed through to
 * Windows, which often resolves names Electron's list does not carry.
 */
function matchPrinterName(requested, printers) {
  const raw = String(requested || '').replace(/\u00A0/g, ' ').trim();
  const list = Array.isArray(printers) ? printers : [];
  if (!raw) return { name: '', stage: 'none' };
  if (list.length === 0) return { name: raw, stage: 'passthrough' };

  const cand = list.map(p => ({ name: String(p.name || ''), display: String(p.displayName || '') }));
  const reqN = normalizePrinterName(raw);
  const reqS = stripPrinterSuffix(raw);

  const stages = [
    ['exact',       c => c.name === raw || c.display === raw],
    ['normalized',  c => normalizePrinterName(c.name) === reqN || normalizePrinterName(c.display) === reqN],
    ['no-suffix',   c => stripPrinterSuffix(c.name) === reqS || stripPrinterSuffix(c.display) === reqS],
    ['starts-with', c => !!reqS && (normalizePrinterName(c.name).startsWith(reqS) || normalizePrinterName(c.display).startsWith(reqS))],
    ['contains',    c => reqS.length >= 4 && (normalizePrinterName(c.name).includes(reqS) || normalizePrinterName(c.display).includes(reqS))],
    ['reverse',     c => {
      if (reqS.length < 4) return false;
      const n = normalizePrinterName(c.name);
      const d = normalizePrinterName(c.display);
      return (!!n && reqS.includes(n)) || (!!d && reqS.includes(d));
    }],
  ];
  for (const [stage, fn] of stages) {
    const hit = cand.find(fn);
    if (hit) return { name: hit.name, stage };
  }
  return { name: raw, stage: 'passthrough' };
}

/** Installed printers, or an empty list when enumeration fails. */
async function listSystemPrinters() {
  try {
    const wc = (getMainWindow() && !getMainWindow().isDestroyed()) ? getMainWindow().webContents : null;
    if (wc) return (await wc.getPrintersAsync()) || [];
  } catch { /* fall through */ }
  return [];
}

// The installed printer a RAW job should open, for a saved name — follows a
// Windows rename ("… (Copy 1)") with the same matcher the text RAW route and
// the driver route use. Cached, shared between slips printing together, and
// never allowed to hold a slip: see printerResolve.cjs.
const printerResolver = require('./printerResolve.cjs').createPrinterResolver({
  list: () => listSystemPrinters(),
  match: (name, printers) => matchPrinterName(name, printers),
});
const resolveRawPrinter = (requested, fresh = false) => printerResolver.resolve(requested, fresh);

// ===== IPC HANDLERS =====

// Get list of available printers
handle('getPrinters', async () => {
  if (!getMainWindow()) return [];
  try {
    return await getMainWindow().webContents.getPrintersAsync();
  } catch {
    return [];
  }
});

// Silent thermal print — centralized rules (see src/printing/printConfig.ts).
// Rule 5,6: NO forced page height. Default = printer default page size so the
// printer feeds only as much paper as the content needs (fixes blank paper at
// start of receipt). Rule 8: silent + printBackground + marginType:none + scaleFactor:100.
// Rule 9,10: no paper-feed / form-feed injected before printing.

// ===== Printer PORT / DRIVER diagnostics (Windows) =====
// Port Windows printer ki property hoti hai (USB001/COM3/IP) — Electron
// deviceName se print karta hai, port khud select nahi karta. Yeh handlers
// software ke andar port+driver DIKHATE hain, driver ka apna test page
// chalate hain (hamari HTML pipeline ko bypass — foran pata chalta hai ke
// masla software me hai ya driver/paper me), aur Windows properties kholte
// hain jahan se port change hota hai.
const { exec } = require('child_process');
function psSafe(name) { return String(name || '').replace(/["`$]/g, ''); }

handle('getPrinterDetails', async () => {
  if (process.platform !== 'win32') return { success: false, printers: [] };
  return new Promise((resolve) => {
    exec('powershell -NoProfile -Command "Get-Printer | Select-Object Name,PortName,DriverName | ConvertTo-Json -Compress"',
      { windowsHide: true, timeout: 10000 }, (err, stdout) => {
        if (err) { appendLog('get-printer-details FAIL ' + err); return resolve({ success: false, error: String(err), printers: [] }); }
        try {
          let d = JSON.parse(String(stdout || '[]').trim() || '[]');
          if (!Array.isArray(d)) d = [d];
          resolve({ success: true, printers: d });
        } catch (e) { resolve({ success: false, error: String(e), printers: [] }); }
      });
  });
});

handle('printWindowsTestPage', async (_e, printerName) => {
  if (process.platform !== 'win32') return { success: false, error: 'Windows only' };
  const n = psSafe(printerName);
  return new Promise((resolve) => {
    exec(`rundll32 printui.dll,PrintUIEntry /k /n "${n}"`, { windowsHide: true, timeout: 15000 }, (err) => {
      appendLog(`windows-test-page "${n}" ${err ? 'FAIL ' + err : 'sent'}`);
      resolve(err ? { success: false, error: String(err) } : { success: true });
    });
  });
});

handle('openPrinterProperties', async (_e, printerName) => {
  if (process.platform !== 'win32') return { success: false, error: 'Windows only' };
  const n = psSafe(printerName);
  exec(`rundll32 printui.dll,PrintUIEntry /p /n "${n}"`, { windowsHide: true });
  return { success: true };
});


// ============================================================
// PRINT STRATEGY MEMORY (v1.0.39)
// Har printer ke liye yaad rakhte hain ke kaunsi strategy chali thi,
// taake agli baar seedha wohi use ho (pehli dafa ke baad koi delay nahi).
// ============================================================
const printStrategyMemory = new Map(); // printerName -> 'custom' | 'driver' | 'minimal'

// Strategy memory ab disk par bhi rehti hai — EXE restart ke baad PEHLA hi
// bill seedhi kaamyaab strategy par jata hai (koi 2-3 second ki azmaish nahi).
function strategyFile() {
  try { return path.join(app.getPath('userData'), 'print-strategy.json'); } catch { return null; }
}
(function loadStrategyMemory() {
  try {
    const f = strategyFile();
    if (f && fs.existsSync(f)) {
      const obj = JSON.parse(fs.readFileSync(f, 'utf8') || '{}');
      for (const [k, v] of Object.entries(obj)) printStrategyMemory.set(k, v);
    }
  } catch {}
})();
function saveStrategyMemory() {
  try {
    const f = strategyFile();
    if (f) fs.writeFileSync(f, JSON.stringify(Object.fromEntries(printStrategyMemory)));
  } catch {}
}

handle('resetPrintStrategy', async (_e, printerName) => {
  if (printerName) printStrategyMemory.delete(String(printerName));
  else printStrategyMemory.clear();
  saveStrategyMemory();
  return { success: true };
});

// ============================================================
// HIDDEN PRINT WORKER (fast path)
// Receipt/KOT ab POS ki apni window se print NAHI hoti. Ek chhupi hui
// window slip ka HTML load kar ke print karti hai — is se:
//   • POS screen print mode me nahi jati (na CSS switch, na freeze)
//   • cashier foran agla bill shuru kar sakta hai
//   • blank slip ka khatra khatam (slip ka apna alag document hota hai)
// ============================================================
let printWorker = null;
function getPrintWorker() {
  if (printWorker && !printWorker.isDestroyed()) return printWorker;
  printWorker = new BrowserWindow({
    show: false,
    width: 400,
    height: 900,
    // Parked far off-screen and kept out of the taskbar/alt-tab. show:false
    // already hides it, but a resize or capture on some Windows drivers used
    // to flash a blank frame in the corner of the screen — that flash is the
    // "white screen" the cashier saw during KOT printing.
    x: -32000,
    y: -32000,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    // JavaScript is required only for local layout/font readiness measurement.
    // The worker never loads remote content and remains fully isolated.
    webPreferences: { offscreen: false, nodeIntegration: false, contextIsolation: true, javascript: true },
  });
  printWorker.on('closed', () => { printWorker = null; });
  return printWorker;
}
app.on('before-quit', () => { try { printWorker?.destroy(); } catch {} });

// ============================================================
// PRINT-WORKER SERIALIZATION
// There is exactly ONE hidden worker window and every slip loads its own
// document into it. Two jobs landing together (a Pay that prints receipt +
// KOT + token, or a test print fired during a bill) used to overwrite each
// other's document mid-flight: one loadFile superseded the other, its await
// never settled and capturePage returned the wrong slip or nothing at all.
// Jobs now queue, so each one owns the worker until it is finished.
// ============================================================
let printWorkerChain = Promise.resolve();
const PRINT_WORKER_JOB_TIMEOUT_MS = 30000;

function withPrintWorker(job) {
  const run = () => Promise.race([
    Promise.resolve().then(job),
    new Promise(resolve => setTimeout(
      () => resolve({ success: false, error: 'print job timed out' }),
      PRINT_WORKER_JOB_TIMEOUT_MS,
    )),
  ]);
  // Chain on settle (not on success) so one failed job never blocks the queue.
  const result = printWorkerChain.then(run, run);
  printWorkerChain = result.then(() => undefined, () => undefined);
  return result;
}

// Use a local file instead of a data: URL. A data document has an opaque
// origin, so Chromium can refuse the packaged file:// Urdu fonts and silently
// substitute a plain system font. The stable file origin also avoids encoding
// and parsing a multi-megabyte URL on every receipt.
function loadPrintWorkerHtml(win, html) {
  const file = path.join(DATA_DIR, '.dtpos-print-worker.html');
  fs.writeFileSync(file, html, 'utf8');
  return win.loadFile(file);
}

// Raster conversion lives in escposRaster.cjs so the printer simulator can
// drive the exact same code offline (scripts/simulate-print.mjs). A copy
// would drift, and a drifting simulation stops telling the truth.
const { escposRasterBytes, rasterGeometry } = require('./escposRaster.cjs');
const { applyTextWeight } = require('./textWeight.cjs');
const { applyReversedText } = require('./reversedText.cjs');
const { CODE_BOXES_JS, toCaptureRegions } = require('./codeRegions.cjs');

handle('printHtml', async (_event, options = {}) => {
  const html = String(options.html || '');
  if (html.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length < 10) {
    return { success: false, error: 'empty document' };
  }
  return withPrintWorker(async () => {
  let win;
  try {
    win = getPrintWorker();
    await new Promise((resolve, reject) => {
      const done = () => { cleanup(); resolve(); };
      const fail = (_e, _c, desc) => { cleanup(); reject(new Error(desc || 'load failed')); };
      const cleanup = () => {
        win.webContents.removeListener('dom-ready', done);
        win.webContents.removeListener('did-finish-load', done);
        win.webContents.removeListener('did-fail-load', fail);
        clearTimeout(t);
      };
      // Large data: documents occasionally never emit did-finish-load on some
      // Electron/Windows combinations. Waiting for that old 4-second safety
      // timer was the exact delay users felt. Inline styles are parsed by
      // dom-ready; complex fonts are awaited separately below.
      const t = setTimeout(() => { cleanup(); resolve(); }, 800);
      win.webContents.once('dom-ready', done);
      win.webContents.once('did-finish-load', done);
      win.webContents.once('did-fail-load', fail);
      loadPrintWorkerHtml(win, html).catch(() => {});
    });
    // Urdu/Nastaleeq must finish shaping. Latin-only slips get a much shorter
    // safety cap so a Pay click is not held up by an unrelated font.
    try {
      const needsComplexFont = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]|aseer|sameer|jameel|nastaleeq|urdu/i.test(html);
      // Latin-only slips (99% of receipts/KOT/tokens) no longer wait at all —
      // system fonts are already loaded, so this was pure delay.
      if (needsComplexFont) {
        await Promise.race([
          win.webContents.executeJavaScript('document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true'),
          new Promise(resolve => setTimeout(resolve, 900)),
        ]);
      }
    } catch {}
    await applyTextWeight(win.webContents, options.textWeight);
    // White text on a black fill stays white (see reversedText.cjs).
    await applyReversedText(win.webContents, options.darkness);
    return await runPrintJob(win.webContents, options);
  } catch (e) {
    return { success: false, error: String(e && e.message ? e.message : e) };
  }
  });
});

// Exact-template direct printing: render the same React receipt in Chromium,
// capture its complete dynamic height, convert to ESC/POS raster bytes, and
// submit one RAW spooler job. No preview/dialog and no text-template bypass.
handle('printHtmlEscpos', async (_event, options = {}) => {
  const started = Date.now();
  const html = String(options.html || '');
  if (html.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length < 10) {
    return { success: false, error: 'empty document' };
  }
  if (process.platform !== 'win32') return { success: false, error: 'Windows only' };
  // Resolve the printer while the slip renders (see printerResolve.cjs).
  const target = resolveRawPrinter(options.printerName);
  return withPrintWorker(async () => {
  try {
    const win = getPrintWorker();
    await loadPrintWorkerHtml(win, html);
    const needsComplexFont = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]|aseer|sameer|jameel|nastaleeq|urdu/i.test(html);
    if (needsComplexFont) {
      await Promise.race([
        win.webContents.executeJavaScript('document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true'),
        new Promise(resolve => setTimeout(resolve, 1200)),
      ]);
    }
    // The shop's text weight (Print Quality): Standard prints body text
    // regular and keeps headings and totals bold. Before measuring.
    await applyTextWeight(win.webContents, options.textWeight);
    // White text on a black fill stays white (see reversedText.cjs).
    await applyReversedText(win.webContents, options.darkness);
    // ===== SQUEEZED-SLIP FIX (narrow content, wide blank right band) =====
    // The WIDTH must be the slip's AUTHORED width, never scrollWidth.
    //
    // This used to take Math.max(rect.width, scrollWidth). The document is
    // laid out at exactly the content width, so scrollWidth only ever exceeds
    // rect.width when some child OVERFLOWS — a long unbroken word, a table
    // whose columns will not compress, an oversized image. That overflow is
    // blank paper to the right of the real content, and taking it as the
    // capture width meant the downscale to the printer's dots squeezed the
    // whole receipt into a fraction of the roll: narrow content with a wide
    // empty band down the right, on a slip whose margins were already equal.
    //
    // Overflow is CLIPPED (the head cannot print past the paper anyway), not
    // scaled down, and reported so the cause is visible in the log instead of
    // being guessed at from a photograph. Height still uses scrollHeight,
    // because a slip legitimately grows downwards.
    const measure = `(() => {
      const root = document.querySelector('.dt-fast-root') || document.body;
      const r = root.getBoundingClientRect();
      const authored = Math.ceil(Math.max(r.width, 1));
      return {
        width: authored,
        overflow: Math.max(0, Math.ceil(root.scrollWidth) - authored),
        height: Math.ceil(Math.max(r.height, root.scrollHeight, document.body.scrollHeight, 1)),
      };
    })()`;
    let metrics = await win.webContents.executeJavaScript(measure);
    if (!metrics || metrics.width < 20 || metrics.height < 20) throw new Error('Rendered receipt has no printable area');
    // QR code / barcode boxes at 1x, so the raster stage prints them dot-exact
    // (see codeRegions.cjs). None on most slips.
    const codeBoxes = await win.webContents.executeJavaScript(CODE_BOXES_JS).catch(() => []);
    if (metrics.overflow > 2) {
      try {
        appendLog('WARN', 'DT-Print slip overflow',
          `content overflows its ${metrics.width}px box by ${metrics.overflow}px — clipped rather than scaled. ` +
          `A long unbroken word or a table that will not compress is the usual cause.`);
      } catch {}
    }

    // HIGH-RESOLUTION CAPTURE (print-quality fix):
    // The slip lays out at ~302 CSS px for 80 mm, but the printer has 576 dots.
    // Capturing at 1x and stretching the bitmap produced grey, fuzzy text.
    // Zooming the worker so one CSS px maps to ~1 printer dot (or more) means
    // the bitmap is only ever DOWN-sampled -> sharp, solid, dark characters.
    const paperLabel = options.paperLabel || '80mm';
    const paperDots = paperLabel === '58mm' ? 384 : paperLabel === '110mm' ? 832 : 576;
    const paperMm = paperLabel === '58mm' ? 48 : paperLabel === '110mm' ? 104 : 72;
    const marginLeftMm = Number(options.marginLeftMm) || 0;
    const marginRightMm = Number(options.marginRightMm) || 0;
    const contentDots = Math.max(32, paperDots - Math.round((marginLeftMm + marginRightMm) * (paperDots / paperMm)));
    const quality = Math.max(1, Math.min(3, Number(options.qualityScale) || 2));
    const requestedZoom = Math.max(1, Math.min(8, (contentDots / metrics.width) * quality));
    // Never trade receipt completeness for supersampling. Extremely long bills
    // lower their capture scale automatically instead of hitting Chromium's
    // bitmap limit and losing the final rows.
    const fittingZoom = Math.min(4000 / metrics.width, 30000 / metrics.height);
    const zoom = Math.max(1, Math.min(requestedZoom, fittingZoom));

    // ===== SQUEEZED-SLIP FIX (huge blank right margin) =====
    // The capture size MUST be derived from the 1x measurement taken above.
    // This used to re-measure after zooming and overwrite `metrics` with the
    // result, then multiply that by the zoom again. Whether the re-measured
    // rect comes back in CSS pixels or already-scaled pixels depends on the
    // Chromium/Windows/display-scaling combination, so on some machines the
    // capture came out several times wider than the slip. The extra width is
    // blank paper, and the downscale to the printer's dots then squeezed the
    // whole receipt into a fraction of the roll — a narrow slip with a wide
    // empty right margin, exactly as reported.
    //
    // Layout does not change under zoom (the slip is sized in mm, an absolute
    // unit), so the 1x numbers stay correct and there is nothing to re-read.
    const baseWidth = metrics.width;
    const baseHeight = metrics.height;
    try {
      win.webContents.setZoomFactor(zoom);
      await new Promise(resolve => setTimeout(resolve, 20));
    } catch { /* keep 1x layout */ }

    // Resize before capture so capturePage includes the complete receipt rather
    // than only the old 900px viewport (the source of truncated short strips).
    // capturePage uses device-independent pixels while getBoundingClientRect
    // reports CSS pixels, so include the zoom once to capture the entire slip.
    const capW = Math.ceil(baseWidth * zoom);
    const capH = Math.ceil(baseHeight * zoom);
    win.setContentSize(Math.min(4000, capW), Math.min(30000, capH));
    await new Promise(resolve => setImmediate(resolve));

    // ===== BLANK-CAPTURE RETRY =====
    // The worker window is hidden. On a slower PC it may not have painted the
    // zoomed, resized slip yet when the capture is taken, and the capture
    // comes back empty or pure white — which used to go to the printer as a
    // blank slip. The raster stage now refuses a slip with no ink; here the
    // page is asked to repaint and captured again. Only a blank capture pays
    // for the retry; a normal slip goes straight through as before. If it is
    // still blank after the retries, the error makes the renderer print this
    // slip through the Windows driver instead.
    const rect = { x: 0, y: 0, width: Math.min(4000, capW), height: Math.min(30000, capH) };
    const RETRY_WAIT_MS = [0, 120, 350];
    let bytes = null;
    let diag = null;
    let lastErr = null;
    for (let attempt = 0; attempt < RETRY_WAIT_MS.length && !bytes; attempt++) {
      if (attempt > 0) {
        try { win.webContents.invalidate(); } catch { /* older Electron */ }
        await new Promise(resolve => setTimeout(resolve, RETRY_WAIT_MS[attempt]));
      }
      const image = await win.webContents.capturePage(rect);
      if (image.isEmpty()) { lastErr = new Error('Rendered receipt capture is empty'); continue; }
      try {
        bytes = escposRasterBytes(image, paperLabel, options.autoCut !== false, {
          onDiagnostics: d => { diag = d; },
          darkness: options.darkness,
          bold: options.boldPrint === true,
          marginLeftMm,
          marginRightMm,
          bottomFeedLines: options.bottomFeedLines,
          exactRegions: toCaptureRegions(codeBoxes, zoom),
        });
      } catch (e) {
        lastErr = e;
        // Only a blank capture is worth capturing again.
        if (!/blank/i.test(String(e && e.message))) break;
      }
    }
    try { win.webContents.setZoomFactor(1); } catch {}
    if (!bytes) {
      try { appendLog('WARN', 'DT-Print blank capture', `${String((lastErr && lastErr.message) || lastErr)} — the slip goes to the Windows driver instead`); } catch {}
      throw lastErr || new Error('Rendered receipt capture is empty');
    }
    // A healthy slip fills nearly the whole printable width. Anything much
    // narrower means the capture was wider than the slip and the downscale
    // squeezed it into part of the roll — the narrow-receipt-with-a-wide-
    // right-margin fault. Record it so the cause is visible in the log
    // instead of being guessed at from a photograph.
    if (diag && diag.coverage > 0 && diag.coverage < 0.75) {
      try {
        appendLog('WARN', 'DT-Print narrow slip',
          `ink covered ${(diag.coverage * 100).toFixed(0)}% of ${diag.contentDots} dots ` +
          `(capture ${baseWidth}x${baseHeight} css px, zoom ${zoom.toFixed(2)})`);
      } catch {}
    }

    const copies = Math.max(1, Number(options.copies) || 1);
    let resolved = await target;
    let result = await sendRawWithWarmWorker(resolved.name, bytes, copies);
    // The printer may have been renamed since the list was read: read it
    // again and retry once, before the renderer gives up on RAW.
    if (!result.success && /OpenPrinter failed/i.test(String(result.error || ''))) {
      const again = await resolveRawPrinter(options.printerName, true);
      if (again.name && again.name !== resolved.name) {
        resolved = again;
        result = await sendRawWithWarmWorker(resolved.name, bytes, copies);
      }
    }
    if (resolved.stage !== 'exact' && resolved.stage !== 'none') {
      try {
        appendLog('WARN', 'DT-Print printer name resolved',
          `saved="${String(options.printerName || '').trim()}" printed-on="${resolved.name}" match=${resolved.stage} result=${result.success ? 'ok' : (result.error || 'fail')}`);
      } catch {}
    }
    return { ...result, printerName: resolved.name, matchStage: resolved.stage, durationMs: Date.now() - started, renderedHeightPx: baseHeight, bytes: bytes.length, bands: diag ? diag.bands : undefined };
  } catch (e) {
    return { success: false, error: String((e && e.message) || e), durationMs: Date.now() - started };
  } finally {
    // Always hand the worker back at 1x. A job that threw between
    // setZoomFactor and the reset used to leave the zoom applied, so the
    // NEXT slip was measured and captured at the wrong scale.
    try { if (printWorker && !printWorker.isDestroyed()) printWorker.webContents.setZoomFactor(1); } catch {}
  }
  });
});

handle('printReceipt', async (_event, options = {}) => {
  if (!getMainWindow()) return { success: false, error: 'No window' };
  // FREEZE FIX: this handler must ALWAYS resolve. A rejected invoke() made
  // the renderer throw out of its print function, skipping the cleanup that
  // takes the POS out of print mode — the window then stayed blank until
  // the app was restarted. Failures are reported as a value instead.
  try {
    return await runPrintJob(getMainWindow().webContents, options);
  } catch (e) {
    const error = String((e && e.message) || e);
    try { appendLog('ERROR', 'DT-Print print-receipt crashed', error); } catch {}
    return { success: false, error };
  }
});

async function runPrintJob(targetContents, options = {}) {
  if (!targetContents || targetContents.isDestroyed()) return { success: false, error: 'No window' };


  const copies = Math.max(1, Number(options.copies) || 1);
  const usePrinterDefaultPageSize = options.usePrinterDefaultPageSize === true;

  const baseOptions = {
    silent: options.silent !== false,
    printBackground: true,
    margins: { marginType: 'none' },
    copies,
  };

  // ============================================================
  // PRINTER NAME RESOLUTION
  //
  // Reported fault: the app said printer "BIXOLON SRP-352plusIII (Copy 1)"
  // was not found although Windows had it installed. The old code compared
  // names for EXACT equality and hard-failed on a miss, so it never even
  // attempted the print and the fallback chain never ran.
  //
  // Resolution is delegated to matchPrinterName (the single shared matcher),
  // which never hard-fails: an unmatched name is handed to Windows as-is,
  // because the spooler frequently knows names Electron's list does not
  // carry. If that fails too, the job falls back to the default printer.
  // ============================================================
  let deviceName = '';
  let printerList = [];
  let matchStage = 'none';
  if (options.printerName) {
    const requested = String(options.printerName).replace(/\u00A0/g, ' ').trim();
    try {
      printerList = (await targetContents.getPrintersAsync()) || [];
      // ONE matcher for the whole app — see matchPrinterName above. This used
      // to be a second, inline copy of the same six stages.
      const hit = matchPrinterName(requested, printerList);
      deviceName = hit.name;
      matchStage = hit.stage;
      if (matchStage === 'passthrough') {
        appendLog('WARN', 'DT-Print printer-not-in-list',
          `requested="${requested}" available="${printerList.map(p => p.name).join(' | ')}" → passthrough`);
      }
    } catch (e) {
      deviceName = requested;
      matchStage = 'enumerate-failed';
    }
  }

  // ---- Build the candidate strategies ----
  // custom  : explicit pageSize (best on Epson/generic ESC-POS Windows drivers)
  // driver  : NO pageSize — printer ki apni preferences (BIXOLON 352 / 111 Plus
  //           jaise drivers custom page size REJECT kar dete hain → job fail)
  // minimal : sirf silent+copies (aakhri koshish)
  const width = Number(options.pageWidthMicrons) || 80000;
  const hasExplicitHeight = Number(options.pageHeightMicrons) > 0;
  const height = hasExplicitHeight
    ? Math.max(20000, Number(options.pageHeightMicrons))
    : null;

  const strategies = {
    ...(hasExplicitHeight ? { custom: { ...baseOptions, pageSize: { width, height } } } : {}),
    driver: { ...baseOptions },
    minimal: { silent: baseOptions.silent, copies },
  };
  // FREEZE FIX: `custom` only exists when an explicit page height was sent.
  // Assigning into it unconditionally threw a TypeError for every job that
  // used the printer's default page size — and because that throw escaped
  // both this function's try block and the `print-receipt` handler, the
  // renderer's await rejected before it could take the POS out of print
  // mode. That is the white, stuck screen after a KOT. Assign per strategy.
  if (deviceName) {
    for (const s of Object.values(strategies)) s.deviceName = deviceName;
  }

  // Order: agar printer ke liye pehle se koi strategy chali thi to wohi pehle.
  let order = hasExplicitHeight && !usePrinterDefaultPageSize
    ? ['custom', 'driver', 'minimal']
    : ['driver', ...(hasExplicitHeight ? ['custom'] : []), 'minimal'];
  const remembered = deviceName ? printStrategyMemory.get(deviceName) : null;
  if (remembered) order = [remembered, ...order.filter(s => s !== remembered)];
  // A remembered strategy can name one that does not exist for this job
  // (e.g. 'custom' without an explicit height). Never dispatch undefined
  // options to webContents.print.
  order = order.filter(s => !!strategies[s]);

  // FREEZE FIX: some Windows thermal drivers never invoke the print
  // callback when the spooler stalls. Without a cap the await below never
  // settles, the print queue's job stays "printing" and the POS sits in
  // print mode. Treat silence as a failed attempt and move to the next
  // strategy — the job is reported, not lost.
  const PRINT_CALLBACK_TIMEOUT_MS = 12000;
  const tryPrint = (opts) => new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ success: false, error: 'printer did not respond in time' }),
      PRINT_CALLBACK_TIMEOUT_MS,
    );
    try {
      targetContents.print(opts, (success, failureReason) => {
        finish({ success: !!success, error: failureReason || null });
      });
    } catch (e) {
      finish({ success: false, error: String(e && e.message ? e.message : e) });
    }
  });

  try {
    appendLog('INFO', 'DT-Print request',
      `printer="${deviceName || options.printerName || 'default'}" ` +
      `paper=${options.paperLabel || '80mm'} order=${order.join('>')} ` +
      `pageSize=${width}x${height} copies=${copies} silent=${baseOptions.silent}`);
  } catch {}

  const attempts = [];
  for (const name of order) {
    const res = await tryPrint(strategies[name]);
    attempts.push(`${name}:${res.success ? 'ok' : (res.error || 'fail')}`);
    if (res.success) {
      if (deviceName) { printStrategyMemory.set(deviceName, name); saveStrategyMemory(); }
      try {
        appendLog('INFO', 'DT-Print result',
          `result=success strategy=${name} match=${matchStage} printer="${deviceName || 'default'}" attempts=[${attempts.join(' | ')}]`);
      } catch {}
      return { success: true, error: null, strategy: name, matchStage };
    }
    if (/cancel/i.test(String(res.error || ''))) break;
  }

  // ---- AAKHRI SAFETY NET ----
  // Named printer par sab kuch fail ho gaya. Ho sakta hai naam hi ghalat ho
  // (rename/duplicate). Windows ke DEFAULT printer par ek koshish kar lo —
  // kaam ruke na. (Sirf tab jab humne koi naam bheja tha.)
  if (deviceName) {
    const noName = { ...baseOptions };
    const res = await tryPrint(noName);
    attempts.push(`default-printer:${res.success ? 'ok' : (res.error || 'fail')}`);
    if (res.success) {
      try {
        appendLog('WARN', 'DT-Print result',
          `result=success-on-default requested="${deviceName}" match=${matchStage} attempts=[${attempts.join(' | ')}]`);
      } catch {}
      return {
        success: true, error: null, strategy: 'default-printer', matchStage,
        warning: `Printed on the Windows default printer because "${deviceName}" could not be used.`,
      };
    }
  }

  const available = printerList.map(p => p.name).filter(Boolean);
  try {
    appendLog('ERROR', 'DT-Print result',
      `result=fail printer="${deviceName || 'default'}" match=${matchStage} ` +
      `available="${available.join(' | ')}" attempts=[${attempts.join(' | ')}]`);
  } catch {}
  return {
    success: false,
    error:
      `Print failed on "${deviceName || 'default printer'}".\n` +
      (available.length
        ? `Printers Windows reports: ${available.join(', ')}.\n`
        : `Windows reported no printers at all — check that the print spooler service is running.\n`) +
      `Tried: ${attempts.join(' | ')}`,
    attempts,
    available,
    matchStage,
  };
}

// Show Save dialog for backup export
// ============================================================
// PRINT DIAGNOSTICS (v1.0.39)
// Requirement 16: printer masla aane par asal wajah pakadne ke liye.
// NOTE: koi customer/business data yahan record NAHI hota — sirf machine,
// printer aur driver ki technical info.
// ============================================================
handle('getPrintDiagnostics', async () => {
  try {
    let printers = [];
    try {
      printers = (await getMainWindow().webContents.getPrintersAsync()) || [];
    } catch (e) { printers = []; }
    return {
      success: true,
      data: {
        appVersion: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        platform: process.platform,
        osRelease: os.release(),
        arch: process.arch,
        timestamp: new Date().toISOString(),
        printers: printers.map(p => ({
          name: p.name,
          displayName: p.displayName,
          isDefault: !!p.isDefault,
          status: p.status,
          // driver/page info jahan available ho
          description: p.description || '',
          options: p.options || {},
          workingStrategy: printStrategyMemory.get(p.name) || null,
        })),
      },
    };
  } catch (e) {
    return { success: false, error: String(e && e.message ? e.message : e) };
  }
});

// ===== LAN / Network ESC/POS Printing =====
// Sends raw ESC/POS bytes directly to a network thermal printer
// over TCP (typical port 9100). No Windows driver needed.
function humanizeNetError(err) {
  const code = (err && err.code) || '';
  const msg = (err && err.message) || String(err);
  switch (code) {
    case 'ETIMEDOUT':
    case 'ERR_SOCKET_TIMEOUT':
      return 'Could not connect to the printer (timed out). Check that the printer is switched on, the network cable is connected, the computer and printer are on the same network, and the IP address is correct.';
    case 'ECONNREFUSED':
      return 'The printer refused the connection. The port may be wrong (9100 is the usual one), or another application is already using the printer.';
    case 'EHOSTUNREACH':
      return 'The printer is on a different subnet. The computer and the printer need IP addresses in the same range — for example both 192.168.1.x.';
    case 'ENETUNREACH':
      return 'The network is unreachable. Check the network cable, or restart the router.';
    case 'EHOSTDOWN':
      return 'The printer is switched off or restarting.';
    case 'ENOTFOUND':
      return 'The printer IP address could not be found. Run the printer self-test print to read its current IP.';
    case 'ECONNRESET':
      return 'The printer dropped the connection. Power cycle it: switch off, wait ten seconds, switch on.';
    default:
      return msg || 'Unknown network error';
  }
}

// Attempt one TCP send. Resolves with { success, error }.
function sendEscposOnce(host, port, buffer, timeout) {
  return new Promise((resolve) => {
    const client = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { client.destroy(); } catch {}
      resolve(result);
    };
    client.setTimeout(timeout);
    client.on('timeout', () => finish({ success: false, error: humanizeNetError({ code: 'ETIMEDOUT' }) }));
    client.on('error', (err) => finish({ success: false, error: humanizeNetError(err), code: err.code }));
    client.connect(port, host, () => {
      client.write(buffer, (err) => {
        if (err) return finish({ success: false, error: humanizeNetError(err), code: err.code });
        // small delay to let printer buffer flush
        setTimeout(() => finish({ success: true }), 400);
      });
    });
  });
}

handle('printLanEscpos', async (_event, options = {}) => {
  const host = options.host;
  const port = Number(options.port) || 9100;
  const timeout = Number(options.timeout) || 6000;
  const maxAttempts = Math.max(1, Number(options.retries) || 3);
  const data = options.data; // Array<number> | base64 string
  if (!host) return { success: false, error: 'No printer IP' };
  if (!data) return { success: false, error: 'No data' };

  let buffer;
  if (Array.isArray(data)) {
    buffer = Buffer.from(data);
  } else if (typeof data === 'string') {
    buffer = Buffer.from(data, 'base64');
  } else {
    return { success: false, error: 'Invalid data format' };
  }

  // Retry loop — network printers often need 2-3 attempts (thermal buffers,
  // WiFi router hiccups, printer just woke from sleep).
  let last = { success: false, error: 'No attempts made' };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await sendEscposOnce(host, port, buffer, timeout);
    if (last.success) return { success: true, attempts: attempt };
    // Do not retry on refusals — root cause is config, not transient
    if (last.code === 'ECONNREFUSED' || last.code === 'ENOTFOUND') break;
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 600));
  }
  return { success: false, error: last.error, attempts: maxAttempts };
});

// Ping LAN printer (quick TCP connect test)
handle('testLanPrinter', async (_event, options = {}) => {
  const host = options.host;
  const port = Number(options.port) || 9100;
  if (!host) return { success: false, error: 'No IP' };
  return new Promise((resolve) => {
    const client = new net.Socket();
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { client.destroy(); } catch {} resolve(r); } };
    client.setTimeout(4000);
    client.on('timeout', () => finish({ success: false, error: humanizeNetError({ code: 'ETIMEDOUT' }) }));
    client.on('error', (err) => finish({ success: false, error: humanizeNetError(err), code: err.code }));
    client.connect(port, host, () => finish({ success: true }));
  });
});


// ============================================================
// LAN PRINTER DISCOVERY
//
// Network thermal printers listen on TCP 9100 (the "RAW"/JetDirect port).
// There is no broadcast protocol they all agree on, so the reliable way to
// find one is to probe that port across the machine's own subnet — which is
// exactly what a printer setup wizard does.
//
// Deliberately narrow and honest about it:
//   • Only /24 subnets are scanned. Anything larger is thousands of probes,
//     and a restaurant counter is never on one.
//   • Only the interfaces this machine actually has, never a guessed range.
//   • Short timeout, capped concurrency: the scan must not saturate the
//     network the POS is also using to take orders.
//   • A host that merely ACCEPTS a connection on 9100 is REPORTED, not
//     assumed to be a printer. Nothing is auto-configured; the user still
//     chooses. Claiming certainty we do not have would be worse than a
//     manual IP box.
// ============================================================
function localIpv4Subnets() {
  const out = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) {
        if (i.family !== 'IPv4' || i.internal) continue;
        // Only /24 — see above.
        if (String(i.netmask) !== '255.255.255.0') continue;
        const parts = String(i.address).split('.');
        if (parts.length !== 4) continue;
        out.push({ base: `${parts[0]}.${parts[1]}.${parts[2]}`, self: i.address });
      }
    }
  } catch { /* no interfaces we can read */ }
  return out;
}

/** Probe one host:port. Resolves true only on a completed connection. */
function probePort(host, port, timeout) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host, () => done(true));
  });
}

handle('scanLanPrinters', async (_event, options = {}) => {
  const port = Number(options.port) || 9100;
  const timeout = Math.max(150, Math.min(2000, Number(options.timeout) || 400));
  const concurrency = Math.max(8, Math.min(128, Number(options.concurrency) || 64));
  const started = Date.now();

  const subnets = localIpv4Subnets();
  if (!subnets.length) {
    return { success: false, error: 'No IPv4 network with a /24 subnet was found on this machine.', printers: [] };
  }

  const targets = [];
  for (const { base, self } of subnets) {
    for (let n = 1; n <= 254; n++) {
      const ip = `${base}.${n}`;
      if (ip !== self) targets.push(ip);
    }
  }

  const found = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const ip = targets[cursor++];
      if (await probePort(ip, port, timeout)) found.push(ip);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  found.sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
  });

  try {
    appendLog('INFO', 'DT-Print lan scan',
      `subnets=${subnets.map(s => s.base + '.0/24').join(',')} port=${port} ` +
      `found=${found.length} in ${Date.now() - started}ms`);
  } catch {}

  return {
    success: true,
    port,
    scanned: targets.length,
    durationMs: Date.now() - started,
    subnets: subnets.map(s => `${s.base}.0/24`),
    printers: found.map(host => ({ host, port })),
  };
});

handle('pingHost', async (_event, options = {}) => {
  const host = options.host;
  const port = Number(options.port) || 9100;
  const timeout = Number(options.timeout) || 3500;
  if (!host) return { ok: false, error: 'No host' };
  const start = Date.now();
  // Try up to 2 attempts — first packet often lost on cold LAN
  const tryOnce = () => new Promise((resolve) => {
    const client = new net.Socket();
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { client.destroy(); } catch {} resolve(r); } };
    client.setTimeout(timeout);
    client.on('timeout', () => finish({ ok: false, error: humanizeNetError({ code: 'ETIMEDOUT' }), code: 'ETIMEDOUT', ms: Date.now() - start }));
    client.on('error', (err) => finish({ ok: false, error: humanizeNetError(err), code: err.code, ms: Date.now() - start }));
    client.connect(port, host, () => finish({ ok: true, ms: Date.now() - start }));
  });
  let r = await tryOnce();
  if (!r.ok && r.code !== 'ECONNREFUSED' && r.code !== 'ENOTFOUND') {
    await new Promise((res) => setTimeout(res, 400));
    r = await tryOnce();
  }
  // Add subnet hint if unreachable
  if (!r.ok) {
    try {
      const ifaces = os.networkInterfaces();
      const locals = [];
      for (const list of Object.values(ifaces)) {
        for (const i of list || []) {
          if (i.family === 'IPv4' && !i.internal) locals.push(i.address);
        }
      }
      const hostPrefix = host.split('.').slice(0, 3).join('.');
      const sameSubnet = locals.some((ip) => ip.startsWith(hostPrefix + '.'));
      r.localIps = locals;
      if (!sameSubnet && locals.length) {
        r.error = `${r.error} | Laptop IPs: ${locals.join(', ')} — printer (${host}) different subnet me hai. Same range me lao (e.g. ${locals[0].split('.').slice(0,3).join('.')}.x)`;
      }
    } catch {}
  }
  return r;
});

// Run a shell command (used for spooler diagnostics & auto-fix on Windows)
function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    try {
      const { spawn } = require('child_process');
      const child = spawn(cmd, args, { windowsHide: true, ...opts });
      let out = '', err = '';
      child.stdout && child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr && child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('error', (e) => resolve({ code: -1, out, err: err || e.message }));
      child.on('close', (code) => resolve({ code, out, err }));
    } catch (e) {
      resolve({ code: -1, out: '', err: e.message });
    }
  });
}

// Windows Print Spooler status (uses `sc query Spooler`)
handle('spoolerStatus', async () => {
  if (process.platform !== 'win32') return { running: true, platform: process.platform, note: 'Not Windows — spooler not applicable' };
  const r = await runCmd('sc', ['query', 'Spooler']);
  const running = /STATE\s*:\s*4\s*RUNNING/i.test(r.out);
  return { running, raw: r.out || r.err };
});

// Restart spooler (requires admin on Windows — will fail silently otherwise)
handle('restartSpooler', async () => {
  if (process.platform !== 'win32') return { success: false, error: 'Only on Windows' };
  const stop = await runCmd('net', ['stop', 'Spooler']);
  const start = await runCmd('net', ['start', 'Spooler']);
  const ok = /successful|started/i.test(start.out);
  return { success: ok, stopOut: stop.out, startOut: start.out, error: ok ? null : (start.err || start.out) };
});

// Clear all stuck print jobs (Windows: delete files in spool folder)
handle('clearPrintQueue', async () => {
  if (process.platform !== 'win32') return { success: false, error: 'Only on Windows' };
  try {
    const spoolDir = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'spool', 'PRINTERS');
    if (!fs.existsSync(spoolDir)) return { success: true, cleared: 0 };
    const files = fs.readdirSync(spoolDir);
    let cleared = 0;
    for (const f of files) {
      try { fs.unlinkSync(path.join(spoolDir, f)); cleared++; } catch {}
    }
    return { success: true, cleared };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ============================================================
// DIRECT RAW (ESC/POS) PRINTING — v1.1.2
// POS -> raw bytes -> Windows spooler (RAW datatype) -> printer -> cut.
// No HTML, no hidden window, no page layout: the printer receives exactly
// the bytes we build, which is why it starts instantly and never emits a
// half slip. Implemented with a tiny winspool.drv P/Invoke through
// PowerShell so no native module has to be compiled/shipped.
// ============================================================
const RAW_PS = `
$ErrorActionPreference = "Stop"
$src = @"
using System;
using System.IO;
using System.Runtime.InteropServices;
public class DtRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFOW { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOW di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
  public static void SendBytes(string printer, byte[] bytes) {
    IntPtr h; int written = 0;
    if (!OpenPrinter(printer.Normalize(), out h, IntPtr.Zero))
      throw new Exception("OpenPrinter failed for '" + printer + "' (" + Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFOW di = new DOCINFOW();
      di.pDocName = "DT POS Receipt"; di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, di)) throw new Exception("StartDocPrinter failed (" + Marshal.GetLastWin32Error() + ")");
      try {
        if (!StartPagePrinter(h)) throw new Exception("StartPagePrinter failed (" + Marshal.GetLastWin32Error() + ")");
        IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
        try {
          Marshal.Copy(bytes, 0, p, bytes.Length);
          if (!WritePrinter(h, p, bytes.Length, out written))
            throw new Exception("WritePrinter failed (" + Marshal.GetLastWin32Error() + ")");
        } finally { Marshal.FreeCoTaskMem(p); }
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
Add-Type -TypeDefinition $src -Language CSharp
[Console]::Out.WriteLine("READY")
[Console]::Out.Flush()
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  try {
    $req = $line | ConvertFrom-Json
    $printer = [string]$req.printerName
    if ([string]::IsNullOrWhiteSpace($printer)) {
      $d = Get-CimInstance -Class Win32_Printer -Filter "Default=True" -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($d) { $printer = $d.Name }
    }
    if ([string]::IsNullOrWhiteSpace($printer)) { throw "No printer" }
    $bytes = [Convert]::FromBase64String([string]$req.data)
    $copies = [Math]::Max(1, [int]$req.copies)
    for ($i = 0; $i -lt $copies; $i++) { [DtRawPrinter]::SendBytes($printer, $bytes) }
    [Console]::Out.WriteLine("OK:" + [string]$req.id)
  } catch {
    $msg = ([string]$_.Exception.Message) -replace "[\r\n]+", " "
    [Console]::Out.WriteLine("ERR:" + [string]$req.id + ":" + $msg)
  }
  [Console]::Out.Flush()
}
`;

let rawScriptPath = null;
function ensureRawScript() {
  if (rawScriptPath && fs.existsSync(rawScriptPath)) return rawScriptPath;
  // Version the helper path so an older app's one-shot script cannot be reused
  // after an update (that stale script waited for command-line arguments).
  const p = path.join(os.tmpdir(), 'dtpos-rawprint-worker-v2.ps1');
  fs.writeFileSync(p, RAW_PS, 'utf8');
  rawScriptPath = p;
  return p;
}

// One warm PowerShell/Winspool bridge for the whole session — see
// rawWorker.cjs (moved out so its failure handling is tested).
const rawBridge = require('./rawWorker.cjs').createRawWorker({
  spawn: (cmd, args, opts) => require('child_process').spawn(cmd, args, opts),
  scriptPath: () => ensureRawScript(),
  platform: process.platform,
});
const getRawWorker = () => rawBridge.get();
const sendRawWithWarmWorker = (printerName, buffer, copies) => rawBridge.send(printerName, buffer, copies);
const stopRawWorker = () => rawBridge.stop();
app.on('before-quit', () => rawBridge.setQuitting(true));

app.whenReady().then(() => {
  if (process.platform === 'win32') setTimeout(() => { getRawWorker().catch(() => {}); }, 300);
  // The hidden print window too: created on the first slip, it made the
  // first bill of the day the slowest one.
  setTimeout(() => { try { getPrintWorker(); } catch { /* created on first print instead */ } }, 1500);
});
app.on('before-quit', stopRawWorker);

/** List of installed printer names (used to resolve/verify a target). */
handle('printRaw', async (_event, options = {}) => {
  const started = Date.now();
  try {
    if (process.platform !== 'win32') {
      return { success: false, error: 'Direct printing is available on Windows only' };
    }
    const data = options.data;
    const buffer = Array.isArray(data)
      ? Buffer.from(data)
      : (typeof data === 'string' ? Buffer.from(data, 'base64') : null);
    if (!buffer || buffer.length < 8) return { success: false, error: 'No data' };

    const copies = Math.max(1, Number(options.copies) || 1);
    const requested = String(options.printerName || '').trim();

    // ===== SHARED NAME MATCHING =====
    // winspool's OpenPrinter wants the exact Windows device name. Handing it
    // the stored setting verbatim meant a printer installed as
    // "BIXOLON SRP-352plusIII (Copy 1)", or one carrying a non-breaking
    // space, failed to open on the raw path while the very same printer
    // printed fine through the driver. Same matcher as runPrintJob.
    let printerName = requested;
    let matchStage = 'none';
    if (requested) {
      const hit = matchPrinterName(requested, await listSystemPrinters());
      printerName = hit.name || requested;
      matchStage = hit.stage;
    }

    const result = await sendRawWithWarmWorker(printerName, buffer, copies);
    if (!result.success) {
      try {
        appendLog('WARN', 'DT-Print raw failed',
          `requested="${requested}" resolved="${printerName}" match=${matchStage} error=${result.error || 'unknown'}`);
      } catch {}
    }
    return { ...result, matchStage, printerName, durationMs: Date.now() - started };
  } catch (e) {
    return { success: false, error: String((e && e.message) || e) };
  }
});

}

module.exports = { registerPrintingEngine };
