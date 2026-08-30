// ============================================================================
// DT POS — Windows desktop shell.
//
// This process owns the window, the security policy and the native
// capabilities. It owns NO business logic: no POS, no sync, no auth, no
// backend. All of that is the existing web application, loaded unchanged from
// the client bundle and reached over app://.
// ============================================================================
import { app, BrowserWindow, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { registerAppScheme, serveAppScheme, APP_ORIGIN } from './protocol';
import { hardenWindow, hardenWebContents, hardenSession } from './security';
import { registerAllIpc } from './ipc';

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

// A second copy of a POS on one till means two devices racing the same shift
// and the same order counter. Refuse, and surface the window already running.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    const root = rendererRoot();
    if (!existsSync(join(root, 'index.html'))) {
      // Better a clear message than a white window nobody can diagnose.
      const { dialog } = require('electron') as typeof import('electron');
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

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f172a',
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

  hardenWindow(win);

  // Avoid the white flash before the POS paints — jarring on a shop counter.
  win.once('ready-to-show', () => win.show());

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
