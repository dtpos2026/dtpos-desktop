// ============================================================================
// Printing. The whole engine — the fast RAW ESC/POS path, the hidden print worker, the driver path with its
// strategy memory, printer-name matching, LAN printing and scan, spooler tools and diagnostics — is the one the
// offline DT POS Enterprise v1.21.0 shipped, brought over unchanged in behaviour (see printing-engine/engine.cjs).
// This file only wires it to the shell's channel contract and gives it the things it needs from the app.
// ============================================================================
import { app } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { handle } from './registry';
import { getMainWindow } from '../mainWindow';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerPrintingEngine } = require('../printing-engine/engine.cjs') as {
  registerPrintingEngine: (deps: {
    app: typeof app;
    handle: typeof handle;
    getMainWindow: typeof getMainWindow;
    appendLog: (level: string, event: string, detail?: string) => void;
    dataDir: string;
  }) => void;
};

export function registerPrintingIpc(): void {
  const dataDir = join(app.getPath('userData'), 'print');
  const logDir = join(app.getPath('userData'), 'logs');
  try { mkdirSync(dataDir, { recursive: true }); mkdirSync(logDir, { recursive: true }); } catch { /* the engine reports its own failures */ }

  // One line per event, in the same file the rest of the shell writes — a printing problem must be traceable
  // on a till that has no developer console.
  const appendLog = (level: string, event: string, detail?: string): void => {
    try {
      appendFileSync(join(logDir, 'app.log'), `${new Date().toISOString()} ${level} ${event}${detail ? ' — ' + detail : ''}\n`);
    } catch { /* logging must never break printing */ }
  };

  registerPrintingEngine({ app, handle, getMainWindow, appendLog, dataDir });
}
