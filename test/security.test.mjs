// ============================================================================
// The security properties that must hold for a shipped till, asserted rather
// than described. These run without a display, so CI can gate on them.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';

const root = process.cwd();
const read = (p) => readFileSync(join(root, p), 'utf8');

// ---------------------------------------------------------------------------
test('the window is created with the four hardening settings', () => {
  const main = read('src/main/index.ts');
  assert.match(main, /contextIsolation:\s*true/, 'contextIsolation must be true');
  assert.match(main, /nodeIntegration:\s*false/, 'nodeIntegration must be false');
  assert.match(main, /sandbox:\s*true/, 'sandbox must be true');
  assert.match(main, /webSecurity:\s*true/, 'webSecurity must be true');
});

test('devtools are off in a packaged build', () => {
  assert.match(read('src/main/index.ts'), /devTools:\s*!app\.isPackaged/);
});

test('preload never hands the page a raw ipcRenderer or a caller-named channel', () => {
  const pre = read('src/preload/index.ts');
  // Exposing ipcRenderer itself, or an on/send that takes the channel from the
  // page, would make every channel reachable including future ones.
  assert.doesNotMatch(pre, /exposeInMainWorld\(\s*['"][^'"]+['"]\s*,\s*\{\s*ipcRenderer/);
  assert.doesNotMatch(pre, /invoke:\s*\(\s*channel/);
  assert.doesNotMatch(pre, /send:\s*\(\s*channel/);
  assert.match(pre, /for \(const channel of INVOKE_CHANNELS\)/);
});

test('preload exposes exactly the declared contract, and nothing more', async () => {
  const { INVOKE_CHANNELS } = await import('../out/shared/channels.js');
  const declared = new Set([...INVOKE_CHANNELS, 'openExternal', 'onUpdateProgress']);
  assert.equal(declared.size, 24, `expected 24 exposed methods, got ${declared.size}`);
  // Every invoke channel must be a real handler in main, not just a name.
  const handlers = ['system', 'files', 'printing', 'updates', 'pra']
    .map((f) => read(`src/main/ipc/${f}.ts`))
    .join('\n');
  for (const c of INVOKE_CHANNELS) {
    assert.match(handlers, new RegExp(`\\bhandle\\(\\s*'${c}'`), `no main handler for "${c}"`);
  }
});

// ---------------------------------------------------------------------------
// app:// path traversal. Mirrors src/main/protocol.ts resolveWithinRoot.
function resolveWithinRoot(rootDir, pathname) {
  const candidate = normalize(join(rootDir, pathname === '/' ? 'index.html' : pathname));
  const rootWithSep = rootDir.endsWith(sep) ? rootDir : rootDir + sep;
  if (candidate !== rootDir && !candidate.startsWith(rootWithSep)) return null;
  return candidate;
}

test('app:// cannot be walked out of the renderer directory', () => {
  // ===== v1.28.4 — this asserted nothing on Windows, and failed there =====
  //
  // The root was the literal '/opt/dtpos/renderer'. On Windows join() and
  // normalize() return backslashes, so the candidate never started with a root
  // spelled in forward slashes and EVERY path — including a legitimate asset —
  // resolved to null. The first assertion failed, and the three traversal cases
  // passed for the wrong reason: they were being refused by the separator
  // mismatch rather than by the guard under test.
  //
  // The shell itself is unaffected. rendererRoot() builds its path with join()
  // from process.resourcesPath or app.getAppPath(), so the real root always
  // carries native separators. Only the test's hand-written POSIX string did
  // not — which is why this only appeared once the suite ran on a Windows
  // runner. Building the root from `sep` makes the guard actually execute on
  // both platforms.
  const R = resolve(sep, 'opt', 'dtpos', 'renderer');
  assert.ok(resolveWithinRoot(R, '/assets/index.js'), 'a normal asset must resolve');
  assert.equal(resolveWithinRoot(R, '/../../../etc/passwd'), null);
  assert.equal(resolveWithinRoot(R, '/assets/../../../../etc/shadow'), null);
  // A sibling whose name merely starts with the root's must not pass a naive
  // prefix check.
  assert.equal(resolveWithinRoot(R, '/../renderer-evil/x'), null);
});

// ---------------------------------------------------------------------------
// The installer URL decides what executable the machine runs next.
function isTrustedInstallerUrl(raw) {
  if (typeof raw !== 'string') return false;
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  const ok = host === 'digitaltarget.digital' || host.endsWith('.digitaltarget.digital');
  return ok && /\.exe$/i.test(u.pathname);
}

test('only a DT POS https installer may be downloaded and run', () => {
  assert.ok(isTrustedInstallerUrl('https://digitaltarget.digital/dl/DT-POS-Setup-1.2.3.exe'));
  assert.ok(isTrustedInstallerUrl('https://cdn.digitaltarget.digital/DT-POS.exe'));
  assert.equal(isTrustedInstallerUrl('http://digitaltarget.digital/x.exe'), false, 'http must be refused');
  assert.equal(isTrustedInstallerUrl('https://evil.com/DT-POS.exe'), false);
  // The classic suffix-confusion domain.
  assert.equal(isTrustedInstallerUrl('https://digitaltarget.digital.evil.com/x.exe'), false);
  assert.equal(isTrustedInstallerUrl('https://digitaltarget.digital/payload.bat'), false);
  assert.equal(isTrustedInstallerUrl(undefined), false);
});

// ---------------------------------------------------------------------------
function isAllowedExternal(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  return ['digitaltarget.digital', 'supabase.co', 'supabase.in'].some(
    (s) => u.hostname === s || u.hostname.endsWith('.' + s),
  );
}

test('openExternal is an allow-list, and IPC is no wider than a click', () => {
  assert.ok(isAllowedExternal('https://digitaltarget.digital/help'));
  assert.ok(isAllowedExternal('https://drpzxzpvkpqfxcjbwypo.supabase.co/x'));
  assert.equal(isAllowedExternal('https://evil.com'), false);
  assert.equal(isAllowedExternal('file:///C:/Windows/System32/cmd.exe'), false);
  assert.equal(isAllowedExternal('javascript:alert(1)'), false);
  const sys = read('src/main/ipc/system.ts');
  assert.match(sys, /openExternalSafely/, 'the IPC handler must reuse the click-path check');
});

test('readFile/writeFile only accept a path the user picked in a dialog', () => {
  const files = read('src/main/ipc/files.ts');
  assert.match(files, /userChosenPaths/);
  assert.match(files, /assertChosen\(path\)/);
});

test('the CSP admits the two prerendered inline scripts by nonce, and nothing else', () => {
  const proto = read('src/main/protocol.ts');
  // A per-response nonce, not 'unsafe-inline': the shell's own two blocks run,
  // injected script does not.
  assert.match(proto, /script-src 'self' 'nonce-\$\{nonce\}'/);
  assert.doesNotMatch(proto, /script-src[^"`]*unsafe-inline/);
  assert.doesNotMatch(proto, /script-src[^"`]*unsafe-eval/);
  assert.match(proto, /randomBytes\(16\)/, 'the nonce must be random per response');
  // Only tags WITHOUT src get stamped — a nonce on a remote script would be
  // pointless, and the regex must not match one.
  assert.match(proto, /\(\?!\[\^>\]\*\\b\?src=\)|\(\?!\[\^>\]\*\\bsrc=\)/);
  assert.match(proto, /"object-src 'none'"/);
  assert.match(proto, /"frame-ancestors 'none'"/);
  assert.match(proto, /"form-action 'none'"/);
});

test('the CSP is owned by one place, so header and markup cannot disagree', () => {
  // A blanket webRequest CSP filter would overwrite the nonce header and blank
  // the app — that is exactly how this broke the first time.
  assert.doesNotMatch(read('src/main/security.ts'), /Content-Security-Policy/i);
});

test('new windows and stray navigations never open inside the app', () => {
  const sec = read('src/main/security.ts');
  assert.match(sec, /setWindowOpenHandler/);
  assert.match(sec, /action:\s*'deny'/);
  assert.match(sec, /will-navigate/);
  assert.match(sec, /will-attach-webview/);
});

test('the server-function proxy defaults to https and forwards nothing extra', () => {
  const proto = read('src/main/protocol.ts');
  assert.match(proto, /'https:\/\/digitaltarget\.digital'/, 'the default backend must be https');
  // An allow-list of headers, not a blanket copy: the renderer must not be able
  // to smuggle arbitrary headers to the backend through the shell.
  assert.match(proto, /\['authorization', 'content-type', 'accept'\]/);
  assert.doesNotMatch(proto, /headers:\s*request\.headers/);
});

test('no secret is baked into the shell', () => {
  const all = ['src/main/index.ts', 'src/main/security.ts', 'src/main/protocol.ts',
    'src/main/ipc/system.ts', 'src/main/ipc/files.ts', 'src/main/ipc/printing.ts',
    'src/main/ipc/updates.ts', 'src/main/ipc/pra.ts', 'src/preload/index.ts']
    .map(read).join('\n');
  // The shell holds no keys at all: Supabase credentials live in the renderer
  // bundle (publishable key, by design) and never pass through main.
  assert.doesNotMatch(all, /service_role|sb_secret_|SUPABASE_SERVICE|eyJhbGciOi/);
  assert.doesNotMatch(all, /(api[_-]?key|secret|password)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i);
});

// ---------------------------------------------------------------------------
// v1.29.2 — the one webview the POS genuinely has
//
// REPORTED: "DT POS Windows me WhatsApp QR nahi aata, jis wajah se device link
// nahi ho sakta — pehle aata tha."
//
// PersistentWhatsApp.tsx renders a <webview> at web.whatsapp.com, and only
// under Electron. The shell refused to attach ANY webview, in two places, under
// a comment claiming the POS uses none. So the panel mounted blank: no QR, no
// way to link a phone.
//
// Admitting it must not become a general permission. These assert that exactly
// one origin gets through and that what it gets is rewritten, not trusted.
test('the WhatsApp webview is admitted, and nothing else is', () => {
  const security = readFileSync('src/main/security.ts', 'utf8');
  const index = readFileSync('src/main/index.ts', 'utf8');

  // Enabled, or the element never becomes a renderer at all.
  assert.match(index, /webviewTag: true/);

  // One origin, compared as an ORIGIN — not a substring, which
  // "https://web.whatsapp.com.evil.test" would satisfy.
  assert.match(security, /WEBVIEW_ALLOWED_ORIGINS = \['https:\/\/web\.whatsapp\.com'\]/);
  assert.match(security, /WEBVIEW_ALLOWED_ORIGINS\.includes\(new URL\(raw\)\.origin\)/);

  // Anything else is still refused.
  assert.match(security, /if \(!isAllowedWebviewSrc\(params\.src\)\) \{\s*event\.preventDefault\(\);/);
});

test('the attached webview cannot ask for privileges', () => {
  // will-attach-webview receives preferences built from the ELEMENT'S OWN
  // ATTRIBUTES. A page that can write those must not be able to request node
  // integration or a preload script, so every one is overwritten.
  const security = readFileSync('src/main/security.ts', 'utf8');
  const handler = security.slice(security.indexOf("contents.on('will-attach-webview'"));

  assert.match(handler, /delete \(webPreferences as \{ preload\?: string \}\)\.preload/);
  for (const [key, value] of [
    ['nodeIntegration', 'false'],
    ['nodeIntegrationInSubFrames', 'false'],
    ['contextIsolation', 'true'],
    ['sandbox', 'true'],
    ['webSecurity', 'true'],
    ['allowRunningInsecureContent', 'false'],
  ]) {
    assert.match(handler, new RegExp(`webPreferences\\.${key} = ${value}`), `${key} must be forced`);
  }
});

test('one place owns the webview rule', () => {
  // index.ts kept a second, stricter copy that refused every attach and
  // silently overrode security.ts. That is how the module came to be dead
  // while the code that was supposed to allow it looked correct.
  const index = readFileSync('src/main/index.ts', 'utf8');
  assert.ok(
    !/contents\.on\('will-attach-webview', \(event\) => event\.preventDefault\(\)\)/.test(index),
    'index.ts must not keep its own blanket refusal',
  );
  assert.match(index, /hardenWebContents\(contents\)/);
});
