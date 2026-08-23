// ============================================================================
// Boot verification — a real window, the real bundle, the real bridge.
//
// Unit tests cannot tell you that the preload actually loaded, that the CSP let
// the app mount, or that localStorage survives the app:// origin. Those are the
// things that break a desktop build, and all three have broken during this one.
//
// Never reachable from a shipped installer: index.ts only imports this when the
// build is unpackaged AND DTPOS_SMOKE is set.
//
//     npm run smoke
// ============================================================================
import { app, type BrowserWindow } from 'electron';
import { appendFileSync } from 'node:fs';

const LOG = process.env.DTPOS_SMOKE_LOG || '/tmp/dtpos-smoke.log';

export function smoke(line: string): void {
  try { appendFileSync(LOG, line + '\n'); } catch { /* a probe must never break the app */ }
}

export function attachSmokeProbe(win: BrowserWindow): void {
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    smoke(`did-fail-load ${code} ${desc} ${url}`));
  win.webContents.on('console-message', (_e, _lvl, message) =>
    smoke('page: ' + String(message).slice(0, 200)));

  win.webContents.once('did-finish-load', async () => {
    try {
      const bridge = await win.webContents.executeJavaScript(`(() => ({
        origin: location.origin,
        api: Object.keys(window.electronAPI || {}).sort(),
        hasNodeRequire: typeof window.require !== 'undefined',
        hasProcess: typeof window.process !== 'undefined',
      }))()`);
      smoke('BRIDGE ' + JSON.stringify(bridge));

      smoke('IPC getAppVersion=' + await win.webContents.executeJavaScript('window.electronAPI.getAppVersion()'));
      smoke('IPC getMachineId=' + await win.webContents.executeJavaScript('window.electronAPI.getMachineId()'));
      smoke('IPC getDataPath=' + await win.webContents.executeJavaScript('window.electronAPI.getDataPath()'));
      smoke('IPC getSystemInfo=' + JSON.stringify(
        await win.webContents.executeJavaScript('window.electronAPI.getSystemInfo()')));

      // The POS is a React app behind a router; give it time to mount before
      // asking whether it did.
      await new Promise((r) => setTimeout(r, 9000));
      const painted = await win.webContents.executeJavaScript(`(() => ({
        rootMounted: document.body.children.length > 0,
        text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
        storageWorks: (() => { try { localStorage.setItem('__t','1');
          const v = localStorage.getItem('__t'); localStorage.removeItem('__t'); return v === '1'; }
          catch (e) { return 'ERROR: ' + e.message; } })(),
        idbWorks: typeof indexedDB !== 'undefined',
      }))()`);
      smoke('PAINTED ' + JSON.stringify(painted));

      // The staff-login path goes through a server function. Prove the shell
      // forwards it to the backend and hands JSON back to the page, from the
      // page's own origin (so the CSP's connect-src 'self' still covers it).
      const proxied = await win.webContents.executeJavaScript(`(async () => {
        try {
          const r = await fetch('/_serverFn/smoke-ping', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer smoke.token.value' },
            body: JSON.stringify({ hello: 'world' }),
          });
          return { status: r.status, body: (await r.text()).slice(0, 200) };
        } catch (e) { return { error: String(e) }; }
      })()`);
      smoke('SERVERFN ' + JSON.stringify(proxied));
      smoke('DONE');
    } catch (err) {
      smoke('PROBE ERROR ' + ((err as Error)?.stack || String(err)));
    }
    setTimeout(() => app.quit(), 500);
  });
}
