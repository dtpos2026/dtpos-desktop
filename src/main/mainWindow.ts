// ============================================================================
// The POS window, held in one place so the printing engine can ask "which window am I printing for?" without
// guessing from BrowserWindow.getAllWindows() — the hidden print worker is a BrowserWindow too, and it can sit at
// index 0.
// ============================================================================
import type { BrowserWindow } from 'electron';

let main: BrowserWindow | null = null;

export function setMainWindow(win: BrowserWindow): void {
  main = win;
  win.once('closed', () => { if (main === win) main = null; });
}

export function getMainWindow(): BrowserWindow | null {
  return main && !main.isDestroyed() ? main : null;
}
