// ============================================================================
// Printing: Windows driver printing, raw ESC/POS over TCP, and the diagnostics
// the Printer Settings screen offers when a till will not print.
// ============================================================================
import { BrowserWindow } from 'electron';
import { handle } from './registry';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Socket } from 'node:net';

const run = promisify(execFile);
const WINDOWS_ONLY = 'Only available in the Windows desktop app';

export function registerPrintingIpc(): void {
  // ---- installed printers ------------------------------------------------
  handle('getPrinters', async (e) => {
    try {
      const printers = await e.sender.getPrintersAsync();
      return printers.map((p) => ({
        name: p.name,
        displayName: p.displayName,
        description: p.description,
        status: p.status,
        isDefault: p.isDefault,
        // The diagnostics screen classifies drivers by name to guess whether a
        // printer is ESC/POS-capable, so pass the driver through verbatim.
        driverName: (p.options as Record<string, string> | undefined)?.['printer-make-and-model'] ?? '',
      }));
    } catch {
      return [];
    }
  });

  // ---- driver print (the receipt portal already rendered in the page) -----
  handle('printReceipt', (e, raw: unknown) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const opts: Record<string, unknown> = {
      silent: o.silent !== false,          // a till must not raise a print dialog
      printBackground: true,
      margins: { marginType: 'none' },
      copies: clampInt(o.copies, 1, 1, 20),
    };
    if (typeof o.printerName === 'string' && o.printerName) opts.deviceName = o.printerName;
    if (typeof o.dpi === 'number' && o.dpi > 0) opts.dpi = { horizontal: o.dpi, vertical: o.dpi };

    // The renderer asks for the printer's own page size for thermal roll paper
    // (usePrinterDefaultPageSize), because a fixed height is what makes a
    // thermal printer eject a blank page after every receipt. Only override it
    // when the caller explicitly supplied a height.
    if (o.usePrinterDefaultPageSize !== true
        && typeof o.pageWidthMicrons === 'number'
        && typeof o.pageHeightMicrons === 'number') {
      opts.pageSize = { width: o.pageWidthMicrons, height: o.pageHeightMicrons };
    }

    return new Promise((resolve) => {
      e.sender.print(opts as never, (success, failureReason) => {
        resolve(success ? { success: true } : { success: false, error: failureReason });
      });
    });
  });

  // ---- raw ESC/POS to a network printer ----------------------------------
  handle('printLanEscpos', async (_e, raw: unknown) => {
    const a = (raw ?? {}) as Record<string, unknown>;
    const host = typeof a.host === 'string' ? a.host : '';
    const port = clampInt(a.port, 9100, 1, 65535);
    const data = a.data;
    if (!host) return { success: false, error: 'no printer host' };
    if (!Array.isArray(data) && !(data instanceof Uint8Array)) {
      return { success: false, error: 'no ESC/POS payload' };
    }
    const bytes = Buffer.from(data as number[]);
    try {
      await writeToSocket(host, port, bytes, 8000);
      return { success: true };
    } catch (err) {
      return { success: false, error: msg(err) };
    }
  });

  handle('testLanPrinter', async (_e, raw: unknown) => {
    const a = (raw ?? {}) as Record<string, unknown>;
    const host = typeof a.host === 'string' ? a.host : '';
    const port = clampInt(a.port, 9100, 1, 65535);
    if (!host) return { success: false, error: 'no printer host' };
    const r = await tcpPing(host, port, 4000);
    return r.ok ? { success: true, ms: r.ms } : { success: false, error: r.error };
  });

  handle('pingHost', async (_e, raw: unknown) => {
    const a = (raw ?? {}) as Record<string, unknown>;
    const host = typeof a.host === 'string' ? a.host : '';
    if (!host) return { ok: false, error: 'no host' };
    return tcpPing(host, clampInt(a.port, 9100, 1, 65535), clampInt(a.timeout, 2500, 100, 30000));
  });

  // ---- Windows print spooler ---------------------------------------------
  handle('spoolerStatus', async () => {
    if (process.platform !== 'win32') return { running: true, note: WINDOWS_ONLY };
    try {
      const { stdout } = await run('sc', ['query', 'spooler']);
      return { running: /STATE\s+:\s+4\s+RUNNING/i.test(stdout), raw: stdout.trim() };
    } catch (e) {
      return { running: false, raw: msg(e) };
    }
  });

  handle('restartSpooler', async () => {
    if (process.platform !== 'win32') return { success: false, error: WINDOWS_ONLY };
    try {
      // `net stop` fails if it is already stopped, which is not an error here.
      await run('net', ['stop', 'spooler']).catch(() => undefined);
      await run('net', ['start', 'spooler']);
      return { success: true };
    } catch (e) {
      return { success: false, error: `${msg(e)} — try running DT POS as Administrator` };
    }
  });

  handle('clearPrintQueue', async () => {
    if (process.platform !== 'win32') return { success: false, error: WINDOWS_ONLY };
    try {
      await run('net', ['stop', 'spooler']).catch(() => undefined);
      const dir = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\spool\\PRINTERS`;
      // cmd's del is used rather than fs so a locked handle does not abort the
      // whole clear; the spooler is restarted either way.
      await run('cmd', ['/c', 'del', '/q', '/f', `${dir}\\*.*`]).catch(() => undefined);
      await run('net', ['start', 'spooler']);
      return { success: true };
    } catch (e) {
      return { success: false, error: `${msg(e)} — try running DT POS as Administrator` };
    }
  });
}

// ---------------------------------------------------------------------------

function writeToSocket(host: string, port: number, bytes: Buffer, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      sock.destroy();
      err ? reject(err) : resolve();
    };
    sock.setTimeout(timeoutMs);
    sock.once('timeout', () => finish(new Error(`timed out connecting to ${host}:${port}`)));
    sock.once('error', (e) => finish(e));
    sock.connect(port, host, () => {
      // end() flushes then FINs; the printer prints on connection close.
      sock.end(bytes, () => finish());
    });
  });
}

function tcpPing(host: string, port: number, timeoutMs: number): Promise<{ ok: boolean; ms?: number; error?: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = new Socket();
    let done = false;
    const finish = (r: { ok: boolean; ms?: number; error?: string }) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(timeoutMs);
    sock.once('timeout', () => finish({ ok: false, error: `no answer from ${host}:${port} in ${timeoutMs}ms` }));
    sock.once('error', (e) => finish({ ok: false, error: msg(e) }));
    sock.connect(port, host, () => finish({ ok: true, ms: Date.now() - started }));
  });
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? Math.round(v) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
