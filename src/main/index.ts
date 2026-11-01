// ============================================================================
// DT POS — Windows desktop shell.
//
// This process owns the window, the security policy and the native
// capabilities. It owns NO business logic: no POS, no sync, no auth, no
// backend. All of that is the existing web application, loaded unchanged from
// the client bundle and reached over app://.
// ============================================================================
import { app, BrowserWindow, dialog, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { registerAppScheme, serveAppScheme, APP_ORIGIN } from './protocol';
import { hardenWindow, hardenWebContents, hardenSession } from './security';
import { registerAllIpc } from './ipc';
import { setMainWindow, getMainWindow } from './mainWindow';
import { initLaunchLog, launchLog } from './launchLog';
import { writeAck, waitForAck, UNREACHABLE_TITLE, UNREACHABLE_MESSAGE } from './singleInstance';

// Node is never available to the page, so this is the only place it exists.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = '';

/**
 * The POS client bundle (`dist-desktop/client` from the web repo).
 *
 * Packaged it sits in resources/renderer; in development it is a sibling
 * checkout, so `npm start` runs the real thing without a packaging step.
 */
function rendererRoot(): string {
  const packaged = join(process.resourcesPath ?? '', 'renderer');
  if (app.isPackaged) return packaged;
  const candidates = [
    join(app.getAppPath(), 'renderer'),
    join(app.getAppPath(), '..', 'digitaltarget.digital', 'dist-desktop', 'client'),
  ];
  return candidates.find(existsSync) ?? candidates[0]!;
}

// Registering the scheme must happen before 'ready'.
registerAppScheme();

// ===== Launch diagnostics (v1.77.0) =====
//
// "I clicked the shortcut and nothing happened" leaves nothing behind. Every launch step is written to
// <userData>/logs/launch.log, so the next report comes with the answer.
let userDataDir = '';
try { userDataDir = app.getPath('userData'); initLaunchLog(userDataDir); } catch { /* logging is best effort */ }
launchLog('start', { version: app.getVersion(), packaged: app.isPackaged, exe: process.execPath, args: process.argv.slice(1) });
process.on('uncaughtException', (e) => { launchLog('uncaughtException', e); });
process.on('unhandledRejection', (e) => { launchLog('unhandledRejection', e instanceof Error ? e : String(e)); });
// Is this copy elevated? Logged only: knowing it turns a "can't reach the other copy" report into a one-line answer.
if (process.platform === 'win32') {
  void import('node:child_process').then(({ execFile }) => {
    execFile('net', ['session'], { windowsHide: true, timeout: 4000 }, (err) => launchLog('elevated', !err));
  }).catch(() => {});
}

// A second copy of a POS on one till means two devices racing the same shift
// and the same order counter. Refuse, and surface the window already running.
const startedAt = Date.now();
if (!app.requestSingleInstanceLock()) {
  launchLog('second launch: lock held by another copy, handing over');
  // The copy that is running writes a note when it receives the hand-over. If none arrives it cannot be reached
  // (it is elevated and this one is not, or it is stuck) — say so instead of quitting without a word.
  void waitForAck(userDataDir, startedAt - 50).then(async (reached) => {
    launchLog('second launch: hand-over', reached ? 'acknowledged' : 'NOT acknowledged');
    if (!reached) {
      await app.whenReady();
      dialog.showMessageBoxSync({ type: 'warning', title: UNREACHABLE_TITLE, message: UNREACHABLE_TITLE, detail: UNREACHABLE_MESSAGE, buttons: ['OK'] });
    }
    app.quit();
  });
} else {
  // The window a second launch should surface is the POS window — never "the first window Electron lists", which can
  // be the printing engine's hidden worker. If the POS window is gone, make a new one rather than doing nothing.
  const surfaceMainWindow = (): void => {
    let win = getMainWindow();
    if (!win) { launchLog('second-instance: no POS window, creating one'); createWindow(); win = getMainWindow(); }
    if (!win) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    // Windows refuses to let a background process take the foreground; a brief always-on-top is the sanctioned nudge.
    win.setAlwaysOnTop(true);
    win.focus();
    win.setAlwaysOnTop(false);
  };

  app.on('second-instance', () => {
    launchLog('second-instance: another launch reached this copy');
    writeAck(userDataDir);
    if (app.isReady()) surfaceMainWindow(); else void app.whenReady().then(surfaceMainWindow);
  });

  app.whenReady().then(() => {
    const root = rendererRoot();
    if (!existsSync(join(root, 'index.html'))) {
      launchLog('renderer missing', root);
      // Better a clear message than a white window nobody can diagnose.
      dialog.showErrorBox(
        'DT POS could not start',
        `The application files are missing from:\n\n${root}\n\n` +
          'Reinstall DT POS, or run "npm run renderer" in development.',
      );
      app.quit();
      return;
    }

    serveAppScheme(root);
    hardenSession();
    registerAllIpc();
    createWindow();
    launchLog('ready: window created', root);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => launchLog('quit'));
  app.on('child-process-gone', (_e, d) => launchLog('child-process-gone', d));
  app.on('render-process-gone', (_e, _wc, d) => launchLog('render-process-gone', d));
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    // The colour the POS opens in (the default theme's primary, hsl(273 89% 23%)): the window shows only after the
    // page has painted, and what it paints first is the boot splash in the restaurant's own colour.
    backgroundColor: '#40066f',
    autoHideMenuBar: true,
    title: 'DT POS',
    icon: join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      // ===== The four settings that matter =====
      contextIsolation: true,   // page script cannot touch preload's scope
      nodeIntegration: false,   // no require() in the page
      sandbox: true,            // renderer runs in the OS sandbox
      webSecurity: true,        // same-origin policy stays on
      // v1.29.2 — the WhatsApp module IS a <webview>, and without this the
      // element never becomes a renderer: blank panel, no linking QR. Not a
      // blanket permission — will-attach-webview in security.ts admits
      // web.whatsapp.com alone and rewrites the attached renderer's privileges
      // instead of trusting the attributes it was handed.
      webviewTag: true,
      // Devtools ship disabled: a till is operated by staff, not developers.
      devTools: !app.isPackaged,
      spellcheck: false,
    },
  });

  setMainWindow(win);
  hardenWindow(win);

  // ===== Closing the POS window ends the program (v1.77.0) =====
  //
  // The printing engine keeps a hidden BrowserWindow. Electron only fires `window-all-closed` when EVERY window is
  // gone, so closing the POS left the process alive — still holding the single-instance lock — and the next click on
  // the shortcut quit silently because "a copy is already running". Take the helper windows down with the POS window.
  win.on('closed', () => {
    launchLog('main window closed');
    for (const w of BrowserWindow.getAllWindows()) {
      try { if (!w.isDestroyed()) w.destroy(); } catch { /* already going */ }
    }
    app.quit();
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => launchLog('did-fail-load', { code, desc, url }));
  win.webContents.on('render-process-gone', (_e, d) => launchLog('main renderer gone', d));

  // Avoid the white flash before the POS paints — jarring on a shop counter.
  win.once('ready-to-show', () => win.show());
  win.once('show', () => launchLog('window shown'));

  if (!app.isPackaged && process.env.DTPOS_SMOKE) {
    void import('./dev/smoke').then((m) => m.attachSmokeProbe(win));
  }

  win.on('page-title-updated', (e) => e.preventDefault());

  void win.loadURL(`${APP_ORIGIN}/`);
}

// Belt and braces: every WebContents the app ever creates gets the same
// attach guard, including ones this file did not make. hardenContents() is the
// single place that decides which webview source is allowed and what
// privileges it may keep, so this defers to it rather than keeping a second,
// stricter copy of the rule that silently overrode it.
app.on('web-contents-created', (_e, contents) => {
  hardenWebContents(contents);
});

export { shell };
