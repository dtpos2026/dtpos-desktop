// ============================================================================
// A thin recording wrapper around ipcMain.handle.
//
// ===== WHY THIS EXISTS =====
// The obvious completeness check — ipcMain.listenerCount(channel) — is silently
// wrong: `handle` does NOT register an ordinary listener, so listenerCount()
// returns 0 for every correctly registered channel. A guard built on it either
// always fires or, if inverted, never does.
//
// Electron exposes no way to enumerate handlers, so registration is recorded
// here instead. Typing the channel as InvokeChannel also means a typo is a
// compile error rather than a renderer call that rejects mid-shift.
// ============================================================================
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { InvokeChannel } from '../../shared/channels';

const registered = new Set<InvokeChannel>();

export function handle(
  channel: InvokeChannel,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
): void {
  ipcMain.handle(channel, listener);
  registered.add(channel);
}

export function registeredChannels(): ReadonlySet<InvokeChannel> {
  return registered;
}
