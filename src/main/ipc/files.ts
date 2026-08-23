// ============================================================================
// Local JSON database, backup export/import, file dialogs.
// ============================================================================
import { app, dialog, BrowserWindow } from 'electron';
import { handle } from './registry';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The offline JSON store the POS mirrors localStorage into on desktop. */
function dbPath(): string {
  return join(app.getPath('userData'), 'dtpos-data.json');
}

/**
 * ===== Paths the USER chose, and only those =====
 *
 * readFile/writeFile take a path from the renderer. The renderer only ever
 * passes one it just received from showSaveDialog/showOpenDialog — but the IPC
 * channel itself would accept any string, which would let a compromised page
 * read C:\Users\...\.ssh or overwrite a system file.
 *
 * So a path becomes usable only by coming back out of a dialog the user
 * actually saw and confirmed, in this session. That keeps the renderer's real
 * flow working untouched and closes the arbitrary-filesystem hole, without the
 * renderer needing to change at all.
 */
const userChosenPaths = new Set<string>();

function assertChosen(p: unknown): string {
  if (typeof p !== 'string' || !userChosenPaths.has(p)) {
    throw new Error('path was not chosen by the user in a file dialog');
  }
  return p;
}

export function registerFileIpc(): void {
  handle('getDataPath', () => dbPath());

  handle('dbRead', async () => {
    try {
      const file = dbPath();
      if (!existsSync(file)) return { success: true, data: null };
      return { success: true, data: await readFile(file, 'utf8') };
    } catch (e) {
      return { success: false, error: msg(e) };
    }
  });

  handle('dbWrite', async (_e, json: unknown) => {
    if (typeof json !== 'string') return { success: false, error: 'expected a string' };
    try {
      const file = dbPath();
      await mkdir(dirname(file), { recursive: true });
      // Write-then-rename. A till loses power mid-write eventually, and a
      // half-written JSON file is an empty POS on next boot.
      const tmp = `${file}.tmp`;
      await writeFile(tmp, json, 'utf8');
      await rename(tmp, file);
      return { success: true };
    } catch (e) {
      return { success: false, error: msg(e) };
    }
  });

  handle('showSaveDialog', async (e, defaultName: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      defaultPath: typeof defaultName === 'string' ? defaultName : 'dtpos-backup.json',
      filters: [{ name: 'DT POS backup', extensions: ['json'] }],
    };
    const r = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts);
    if (!r.canceled && r.filePath) userChosenPaths.add(r.filePath);
    return { canceled: r.canceled, filePath: r.filePath };
  });

  handle('showOpenDialog', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      properties: ['openFile' as const],
      filters: [{ name: 'DT POS backup', extensions: ['json'] }],
    };
    const r = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (!r.canceled) for (const p of r.filePaths) userChosenPaths.add(p);
    return { canceled: r.canceled, filePaths: r.filePaths };
  });

  handle('readFile', async (_e, path: unknown) => {
    try {
      return { success: true, data: await readFile(assertChosen(path), 'utf8') };
    } catch (e) {
      return { success: false, error: msg(e) };
    }
  });

  handle('writeFile', async (_e, path: unknown, data: unknown) => {
    if (typeof data !== 'string') return { success: false, error: 'expected a string' };
    try {
      await writeFile(assertChosen(path), data, 'utf8');
      return { success: true };
    } catch (e) {
      return { success: false, error: msg(e) };
    }
  });
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
