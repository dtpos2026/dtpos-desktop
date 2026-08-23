// ============================================================================
// Identity, machine info, autostart, external links.
// ============================================================================
import { app, ipcMain } from 'electron';
import { handle } from './registry';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { hostname, networkInterfaces, cpus, totalmem, release, arch, platform } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { openExternalSafely } from '../security';

const run = promisify(execFile);

/**
 * ===== Machine identity =====
 *
 * The POS device-approval system treats this as the REAL answer and prefers it
 * over the browser fingerprint, because one physical machine must equal one
 * approved device — switching browser profile must not shed a block.
 *
 * Windows MachineGuid is per-installation and survives app reinstall, which is
 * exactly the property wanted. If it cannot be read (non-Windows, locked-down
 * registry), a uuid is generated once and persisted in userData: still stable
 * for this machine, just not across an OS reinstall.
 */
let cachedMachineId: string | null = null;

async function machineId(): Promise<string> {
  if (cachedMachineId) return cachedMachineId;

  if (process.platform === 'win32') {
    try {
      const { stdout } = await run('reg', [
        'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64',
      ]);
      const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/.exec(stdout);
      if (m?.[1]) return (cachedMachineId = m[1].toLowerCase());
    } catch { /* fall through to the persisted id */ }
  }

  const file = join(app.getPath('userData'), 'machine-id');
  try {
    if (existsSync(file)) {
      const v = (await readFile(file, 'utf8')).trim();
      if (v) return (cachedMachineId = v);
    }
    const fresh = randomUUID();
    await writeFile(file, fresh, 'utf8');
    return (cachedMachineId = fresh);
  } catch {
    // Never throw: the renderer falls back to its own fingerprint.
    return (cachedMachineId = randomUUID());
  }
}

/** MAC addresses, excluding loopback and virtual adapters that change per boot. */
function macAddresses(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.internal) continue;
      if (!nic.mac || nic.mac === '00:00:00:00:00:00') continue;
      out.add(nic.mac.toLowerCase());
    }
  }
  return [...out];
}

export function registerSystemIpc(): void {
  handle('getAppVersion', () => app.getVersion());

  handle('getMachineId', () => machineId());

  handle('getSystemInfo', () => ({
    runtime: 'electron',
    hostname: hostname(),
    macAddresses: macAddresses(),
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    cpuCores: cpus().length,
    memoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    appVersion: app.getVersion(),
    electron: process.versions.electron,
  }));

  handle('getAutoStart', () => {
    try {
      return { enabled: app.getLoginItemSettings().openAtLogin };
    } catch {
      return { enabled: false };
    }
  });

  handle('setAutoStart', (_e, enabled: unknown) => {
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled === true,
        // A till should come back up after a power cut without a visible flash
        // of the window before the shift screen loads.
        openAsHidden: false,
        path: process.execPath,
      });
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // Send, not invoke — and the URL goes through the same allow-list a click
  // would, so IPC is not a wider door than the UI.
  ipcMain.on('openExternal', (_e, url: unknown) => openExternalSafely(url));
}
