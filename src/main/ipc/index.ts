import { INVOKE_CHANNELS } from '../../shared/channels';
import { registeredChannels } from './registry';
import { registerSystemIpc } from './system';
import { registerFileIpc } from './files';
import { registerPrintingIpc } from './printing';
import { registerUpdateIpc } from './updates';
import { registerPraIpc } from './pra';

export function registerAllIpc(): void {
  registerSystemIpc();
  registerFileIpc();
  registerPrintingIpc();
  registerUpdateIpc();
  registerPraIpc();
  assertContractComplete();
}

/**
 * Preload exposes one function per name in INVOKE_CHANNELS. If main forgets to
 * register one, the renderer gets a function that rejects at runtime — on a
 * till, mid-shift, usually while printing. Failing at boot instead turns a
 * silent production bug into an obvious startup crash during development.
 *
 * Note it reads the registry rather than ipcMain.listenerCount(): `handle` does
 * not create an ordinary listener, so listenerCount() is 0 even for channels
 * that are correctly registered.
 */
function assertContractComplete(): void {
  const registered = registeredChannels();
  const missing = INVOKE_CHANNELS.filter((c) => !registered.has(c));
  if (missing.length) {
    throw new Error(`IPC channels declared but not registered: ${missing.join(', ')}`);
  }
}
