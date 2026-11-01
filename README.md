# DT POS — Windows desktop shell

The Electron shell for DT POS. It owns the window, the security policy and the
native capabilities Windows can offer a till: printing, the local JSON store,
machine identity, autostart, and the in-app update handoff.

**It contains no business logic.** No POS, no sync, no auth, no backend. All of
that is the existing web application in
[`digitaltarget.digital`](https://github.com/dtpos2026/digitaltarget.digital),
loaded unchanged and reached over `app://`. If a behaviour is wrong in the till,
it is wrong on the website too, and it gets fixed there.

## How the two repositories fit together

```
digitaltarget.digital          dtpos-desktop
  npm run build:desktop   -->    npm run renderer   -->  resources/renderer
  (SPA bundle, no server)        (copies it in)          served over app://
```

The renderer is deliberately **not** committed here. Vendoring it would create a
second copy of the POS that drifts from the first.

## Build it

```bash
# 1. in the web repo, produce the client bundle
cd ../digitaltarget.digital && npm run build:desktop

# 2. here
npm install
npm run renderer        # copies ../digitaltarget.digital/dist-desktop/client
npm start               # run it
npm run smoke           # boot it and assert the bridge, IPC, mount and storage
npm test                # the security properties
npm run dist            # Windows installer + portable exe -> release/
```

`DTPOS_RENDERER=/path/to/client npm run renderer` if the web repo is elsewhere.

### The installer is built on Windows

`npm run dist` on Linux gets as far as `release/win-unpacked/` and then needs
wine — specifically **32-bit** wine, because `rcedit` (which stamps the icon and
version metadata into the .exe) is a 32-bit Windows binary. Use a Windows
machine, or push a `v*` tag and let
[`.github/workflows/build-windows.yml`](.github/workflows/build-windows.yml)
build it on a `windows-latest` runner.

### Code signing

No certificate is configured. Windows SmartScreen will warn on first run until
one is. To add it, set `CSC_LINK` and `CSC_KEY_PASSWORD` in the CI secrets —
electron-builder picks them up with no config change.

## Security

The renderer is a full web app talking to Supabase, so it cannot be cut off from
the network. What it *is* cut off from is everything else.

| Control | Setting |
| --- | --- |
| Node in the page | `nodeIntegration: false`, `sandbox: true` |
| Preload isolation | `contextIsolation: true` |
| Same-origin policy | `webSecurity: true` |
| DevTools | off in packaged builds |
| Page origin | `app://dtpos` — never `file://` |
| Inline script | refused, except the two prerendered blocks, by per-response nonce |
| New windows | denied; links go to the user's browser, allow-listed |
| Navigation away | cancelled |
| `<webview>` | refused |
| Permissions | everything denied except sanitized clipboard write |
| Filesystem | `readFile`/`writeFile` accept only a path returned by a dialog the user saw |
| Updates | only an `https` `.exe` on a `digitaltarget.digital` host |
| Secrets | none. The Supabase publishable key lives in the renderer bundle, as it does on the website |

`npm test` asserts every row of that table, including path traversal on `app://`
and the domain-suffix confusion case (`digitaltarget.digital.evil.com`).

### Why `app://` and not `file://`

A `file://` page has an opaque origin, which breaks the three things this POS
depends on: `localStorage`/IndexedDB (the offline cache and the deferred sync
queue live there), the `Origin` header Supabase auth and realtime require, and
absolute asset paths (`/assets/…`), which resolve against the filesystem root.
`app://` is registered as a standard, secure scheme, so it behaves like `https`
while still reading from disk — the till works with no network at all.

## The IPC contract

`src/shared/channels.ts` is the single source of truth: 22 `invoke` channels
plus `openExternal` and `onUpdateProgress`, 24 in total. Preload exposes exactly
these, one thin wrapper each — never a raw `ipcRenderer`, and never a channel
name supplied by the page.

Main refuses to finish starting if a declared channel has no handler
(`assertContractComplete`), so a missing one is a loud crash in development
rather than a call that rejects mid-shift on a counter.

## Server functions

A few POS operations run with the Supabase **service-role** key — staff
sign-in, saving a staff user, provisioning a restaurant. That key cannot ship
inside a desktop binary: a `.exe` on a customer's counter is fully readable, and
the service-role key bypasses every RLS policy. So they stay server-side.

The renderer posts them to the relative `/_serverFn/…`, which inside the shell
would resolve to `app://dtpos/_serverFn/…` and hit the SPA fallback — staff
login failing with a JSON parse error on a page of HTML. The shell forwards
those requests to the hosted deployment instead, so the renderer bundle stays
byte-identical to the web build and only the shell knows where the backend is.

    DTPOS_API_ORIGIN=https://staging.example.com   # defaults to digitaltarget.digital

Authentication is a Bearer token, not a cookie, so only `authorization`,
`content-type` and `accept` are forwarded — an allow-list, not a blanket copy.
`npm run smoke` asserts the round trip against a stub backend.

**This means staff sign-in needs internet.** That is inherent, not a shortcut:
the check requires a key that must never leave a server. Everything else — the
POS, billing, printing, the offline queue — works with no network at all.

## Auto-update

The POS already owns the update decision: it compares its own `APP_VERSION`
against `getAppVersion()` and shows its own banner. This shell only downloads
what it is handed and launches it. `electron-updater` is deliberately **not**
enabled — two update mechanisms racing on one till is worse than none.

## Launch troubleshooting

**Symptom:** the app opened after installing, but clicking the shortcut again does nothing.

**What was wrong (fixed in v1.77.0):** closing the POS window did not end the program — the printing engine keeps a hidden
window — so a copy stayed running in the background holding the "one copy only" lock. The next click started a second
copy, which quit at once, while the background copy focused its hidden window. The POS window is now what closes the
program, a second launch always surfaces (or recreates) the POS window, and the program itself never asks for
Administrator (`requestedExecutionLevel: asInvoker`; only the installer needs it, because it writes to Program Files).

**If it still happens on a till:**
1. Open `%APPDATA%\DT POS\logs\launch.log`. Each launch writes a line for every step: `start`, `elevated` (true/false),
   `second launch: lock held…`, `hand-over acknowledged / NOT acknowledged`, `window shown`, `main window closed`, and
   any `uncaughtException`, `did-fail-load` or `render-process-gone`. Send that file to support.
2. If DT POS says "already running but could not be brought to the front": a copy is running elevated (started with
   *Run as administrator*) while this one is not — Windows does not let them talk. Open Task Manager (Ctrl+Shift+Esc),
   end every **DT POS** process, then open DT POS from its shortcut. Do not start it as Administrator again.
3. Installing needs Administrator once (per-machine install). Running never does.

**Not verified in the build environment:** a real install, the UAC prompt and the shortcut click need a Windows PC.
The acceptance script is in `docs/qa/` of the web repository (UAT-W1…W6).
