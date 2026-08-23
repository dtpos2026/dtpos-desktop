// ============================================================================
// Preload — the ONLY bridge between the POS renderer and Node.
//
// Runs with sandbox:true and contextIsolation:true, so it has no filesystem,
// no child_process and no require() of its own. Everything it exposes is an
// ipcRenderer.invoke onto a channel main has explicitly registered.
//
// What is deliberately NOT here:
//   - no `ipcRenderer` object handed to the page (that would let any script
//     reach every channel, including ones added later)
//   - no `send`/`on` passthrough with a caller-supplied channel name
//   - no Node globals, no `process`, no module loader
//
// The renderer sees 24 functions and nothing else.
// ============================================================================
import { contextBridge, ipcRenderer } from 'electron';
import { INVOKE_CHANNELS, EVENT_UPDATE_PROGRESS } from '../shared/channels';

type Api = Record<string, unknown>;

const api: Api = {};

// One thin wrapper per known channel. The channel name is captured from our own
// constant list — it can never come from the page.
for (const channel of INVOKE_CHANNELS) {
  api[channel] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
}

// openExternal is fire-and-forget in the renderer (`api.openExternal(href)`),
// so it stays a send rather than an invoke. Main still validates the URL.
api.openExternal = (url: unknown) => {
  ipcRenderer.send('openExternal', url);
};

/**
 * Download progress for the in-app updater.
 *
 * The renderer calls this and expects an unsubscribe function back
 * (`onUpdateProgress(cb) -> () => void`). Returning a real disposer matters:
 * the update banner mounts and unmounts, and a leaked listener would fire into
 * a dead React tree.
 */
api.onUpdateProgress = (cb: unknown) => {
  if (typeof cb !== 'function') return () => {};
  const listener = (_e: unknown, pct: unknown) => {
    if (typeof pct === 'number' && Number.isFinite(pct)) {
      (cb as (n: number) => void)(pct);
    }
  };
  ipcRenderer.on(EVENT_UPDATE_PROGRESS, listener);
  return () => ipcRenderer.removeListener(EVENT_UPDATE_PROGRESS, listener);
};

contextBridge.exposeInMainWorld('electronAPI', Object.freeze(api));
