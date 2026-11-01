// ============================================================================
// The IPC contract, in one place.
//
// This list is derived from what the POS renderer actually calls on
// `window.electronAPI` — nothing is invented here and nothing is exposed that
// the app does not use. Adding a channel means the renderer needed it.
//
// Every name is also the ipcMain.handle channel, so preload and main cannot
// drift apart: both import this file.
// ============================================================================

export const INVOKE_CHANNELS = [
  // --- system / identity --------------------------------------------------
  'getAppVersion',
  'getMachineId',
  'getSystemInfo',
  'getDataPath',
  'getAutoStart',
  'setAutoStart',

  // --- local JSON database + files ----------------------------------------
  'dbRead',
  'dbWrite',
  'readFile',
  'writeFile',
  'showSaveDialog',
  'showOpenDialog',

  // --- printing -------------------------------------------------------------
  // The fast-printing engine of the offline DT POS Enterprise v1.21.0 (src/main/printing-engine).
  'getPrinters',
  'getPrinterDetails',
  'printReceipt',
  'printHtml',
  'printHtmlEscpos',
  'printRaw',
  'printWindowsTestPage',
  'openPrinterProperties',
  'resetPrintStrategy',
  'getPrintDiagnostics',
  'printLanEscpos',
  'testLanPrinter',
  'scanLanPrinters',
  'pingHost',
  'spoolerStatus',
  'restartSpooler',
  'clearPrintQueue',

  // --- updates + fiscal ------------------------------------------------------
  'downloadAndRunInstaller',
  'praFiscalRequest',
] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];

/** Fire-and-forget, renderer -> main. */
export const SEND_CHANNELS = ['openExternal'] as const;
export type SendChannel = (typeof SEND_CHANNELS)[number];

/** Push, main -> renderer. */
export const EVENT_UPDATE_PROGRESS = 'update:progress';
