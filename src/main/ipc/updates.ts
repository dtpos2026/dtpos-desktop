// ============================================================================
// In-app update: download the installer the POS points us at, then run it.
//
// The POS already OWNS the update decision — it compares its own APP_VERSION
// against getAppVersion() and shows its own banner. This side does not poll,
// does not decide, and does not pick a URL: it downloads what it is given and
// launches it. Anything more would duplicate logic that already exists.
// ============================================================================
import { app, shell, BrowserWindow } from 'electron';
import { handle } from './registry';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { EVENT_UPDATE_PROGRESS } from '../../shared/channels';

/**
 * Where an installer may be fetched from.
 *
 * A URL arriving over IPC decides what executable this machine runs next, so it
 * is the single most dangerous input in the app. Restricting it to our own
 * HTTPS host means a compromised renderer cannot turn the updater into a
 * malware dropper.
 */
function isTrustedInstallerUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  const ok = host === 'digitaltarget.digital' || host.endsWith('.digitaltarget.digital');
  return ok && /\.exe$/i.test(u.pathname);
}

export function registerUpdateIpc(): void {
  handle('downloadAndRunInstaller', async (e, url: unknown) => {
    if (!isTrustedInstallerUrl(url)) {
      return { success: false, error: 'update URL is not a trusted DT POS installer' };
    }

    const win = BrowserWindow.fromWebContents(e.sender);
    const dir = join(app.getPath('temp'), 'dtpos-update');
    const file = join(dir, `DT-POS-Setup-${Date.now()}.exe`);

    try {
      await mkdir(dir, { recursive: true });

      const res = await fetch(url);
      if (!res.ok || !res.body) {
        return { success: false, error: `download failed: HTTP ${res.status}` };
      }

      const total = Number(res.headers.get('content-length') ?? 0);
      let received = 0;
      let lastPct = -1;

      const body = Readable.fromWeb(res.body as never);
      body.on('data', (chunk: Buffer) => {
        if (!total) return;
        received += chunk.length;
        const pct = Math.floor((received / total) * 100);
        // Only forward when the whole number changes: a 90MB installer would
        // otherwise post thousands of IPC messages into the React tree.
        if (pct !== lastPct && !win?.isDestroyed()) {
          lastPct = pct;
          win?.webContents.send(EVENT_UPDATE_PROGRESS, pct);
        }
      });

      await pipeline(body, createWriteStream(file));

      // Hand off to the installer and step out of its way — NSIS cannot replace
      // files that a running DT POS still holds open.
      const opened = await shell.openPath(file);
      if (opened) {
        await rm(file, { force: true });
        return { success: false, error: opened };
      }
      setTimeout(() => app.quit(), 1200);
      return { success: true };
    } catch (err) {
      await rm(file, { force: true }).catch(() => undefined);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
