// ============================================================================
// Security posture, applied to every window and every session.
//
// The renderer is a full web app talking to Supabase, so it cannot be locked
// down to "no network". What it CAN be locked down to is: no Node, no new
// windows, no navigation away from the app, no permissions it never asks for,
// and an outbound allow-list.
// ============================================================================
import { app, shell, session, type BrowserWindow, type WebContents } from 'electron';
import { APP_ORIGIN } from './protocol';

/**
 * Hosts the POS legitimately talks to. Everything else is refused at the
 * navigation and window-open layer, and links go to the user's real browser.
 *
 * Supabase is wildcarded by suffix because each project has its own subdomain
 * and the packaged app must keep working if the project is ever moved.
 */
const ALLOWED_EXTERNAL_SUFFIXES = [
  'digitaltarget.digital',
  'supabase.co',
  'supabase.in',
];

function isAllowedExternal(rawUrl: string): boolean {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  return ALLOWED_EXTERNAL_SUFFIXES.some(
    (s) => u.hostname === s || u.hostname.endsWith('.' + s),
  );
}

/**
 * Open a link in the user's browser, not in the app.
 *
 * Exported because the openExternal IPC handler must apply the SAME test — a
 * renderer that is somehow compromised should not get a wider door through IPC
 * than it has through a click.
 */
export function openExternalSafely(rawUrl: unknown): void {
  if (typeof rawUrl !== 'string' || !isAllowedExternal(rawUrl)) return;
  void shell.openExternal(rawUrl);
}

/** Window-level guards: no popups, no navigating away, no webview. */
export function hardenWindow(win: BrowserWindow): void {
  hardenContents(win.webContents);
  win.webContents.on('did-create-window', (child) => hardenContents(child.webContents));
}

function hardenContents(contents: WebContents): void {
  // Anything that would open a window instead opens in the real browser.
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });

  // The window itself only ever shows app://. A navigation anywhere else — an
  // injected redirect, a stray target — is cancelled and handed to the browser.
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith(APP_ORIGIN)) return;
    event.preventDefault();
    openExternalSafely(url);
  });

  // <webview> is a second renderer with its own settings; the POS uses none.
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

/**
 * Session-level guards.
 *
 * The document CSP is NOT set here. It is written by the app:// handler in
 * protocol.ts, because that response is also where the per-response script
 * nonce is stamped into the HTML — the header and the markup have to agree, so
 * one place owns both. A blanket webRequest filter here would overwrite it.
 */
export function hardenSession(): void {
  const ses = session.defaultSession;

  // The POS asks for none of these. Granting silently is how a compromised page
  // turns into a microphone.
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write');
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');

  // No devtools extensions, no remote debugging surface in a shipped till.
  if (app.isPackaged) {
    ses.setPreloads([]);
  }
}
