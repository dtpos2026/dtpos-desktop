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

/**
 * ===== v1.29.2 — the one webview the POS genuinely has =====
 *
 * REPORTED: "DT POS Windows me WhatsApp QR nahi aata, jis wajah se device link
 * nahi ho sakta — pehle aata tha."
 *
 * PersistentWhatsApp.tsx renders a <webview> pointed at web.whatsapp.com, and
 * renders it ONLY under Electron (`if (!isElectron()) return null`). That
 * webview is where the linking QR appears. The guard below refused to attach
 * ANY webview, under a comment saying the POS uses none — which was not true.
 * So the module mounted, the element never became a renderer, and the operator
 * got a blank panel with no QR and no way to link a phone.
 *
 * Turning webviewTag on by itself would hand every page in the app the ability
 * to spawn a second renderer, which is what this guard exists to prevent. So
 * the allowance is narrow: this origin and no other. Everything the attached
 * webview is given is then OVERWRITTEN rather than trusted — attach-time
 * preferences come from the element's own attributes, so a page that can set
 * them must not be able to ask for node integration or a preload script.
 */
const WEBVIEW_ALLOWED_ORIGINS = ['https://web.whatsapp.com'];

function isAllowedWebviewSrc(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  try {
    return WEBVIEW_ALLOWED_ORIGINS.includes(new URL(raw).origin);
  } catch {
    return false;
  }
}

/** Window-level guards: no popups, no navigating away, one allow-listed webview. */
export function hardenWindow(win: BrowserWindow): void {
  hardenContents(win.webContents);
  win.webContents.on('did-create-window', (child) => hardenContents(child.webContents));
}

/**
 * The same guards, applied to a WebContents the window did not create.
 *
 * index.ts used to keep its own, stricter copy of the webview rule here, which
 * refused every attach and quietly overrode whatever this file decided. One
 * place owns the rule now, so the two cannot disagree again.
 */
export function hardenWebContents(contents: WebContents): void {
  hardenContents(contents);
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

  // A <webview> is a second renderer with its own settings. Exactly one is
  // legitimate — WhatsApp Web, for linking a phone and sending order messages —
  // and it is admitted by ORIGIN, with its privileges rewritten rather than
  // trusted.
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!isAllowedWebviewSrc(params.src)) {
      event.preventDefault();
      return;
    }
    delete (webPreferences as { preload?: string }).preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.experimentalFeatures = false;
  });
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

  // ===== geolocation was denied, and the POS does ask for it =====
  //
  // REPORTED from Windows: "GPS error: User denied Geolocation".
  //
  // The comment here used to say the POS asks for none of these. It does:
  // AppLayout, CustomerProfilePanel, staffLocation, supabaseSync and geo.ts all
  // call navigator.geolocation.getCurrentPosition — for a delivery address, for
  // the live rider map, for staff location. Denying every request turned each
  // of those into that exact error message, on every till, always. Nobody had
  // denied anything; this handler had.
  //
  // Scoped by the REQUESTING page, not granted blanket. Only our own app://
  // content may ask. The WhatsApp webview is a full renderer on
  // web.whatsapp.com and must never be able to locate the till, so it is
  // matched by origin — startsWith would let app://dtpos.evil.test through.
  const mayLocate = (wc: Electron.WebContents | null | undefined): boolean => {
    try {
      const u = new URL(wc?.getURL() ?? '');
      return u.protocol === 'app:' && u.host === 'dtpos';
    } catch {
      return false;
    }
  };

  const ALWAYS = new Set(['clipboard-sanitized-write']);

  ses.setPermissionRequestHandler((wc, permission, callback) => {
    if (ALWAYS.has(permission)) return callback(true);
    if (permission === 'geolocation') return callback(mayLocate(wc));
    // Everything else still refused. Granting silently is how a compromised
    // page turns into a microphone.
    callback(false);
  });

  ses.setPermissionCheckHandler((wc, permission) => {
    if (ALWAYS.has(permission)) return true;
    if (permission === 'geolocation') return mayLocate(wc);
    return false;
  });

  // No devtools extensions, no remote debugging surface in a shipped till.
  if (app.isPackaged) {
    ses.setPreloads([]);
  }
}
