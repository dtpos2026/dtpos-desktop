// ============================================================================
// Serving the POS over app:// instead of file://
//
// ===== WHY NOT file:// =====
// A file:// page has an opaque origin. That breaks three things this POS needs:
//   - localStorage / IndexedDB are unreliable or per-file, and the POS keeps
//     its offline cache and its deferred sync queue there
//   - Supabase's auth and realtime clients send an Origin header; an opaque
//     one is rejected
//   - the app's assets are referenced by ABSOLUTE paths (/assets/...), which
//     resolve against the filesystem root under file://
//
// app://dtpos/ is registered as a standard, secure scheme, so it behaves like
// https: a stable origin, working storage, and fetch that Supabase accepts —
// while still reading from disk, so the till works with no network at all.
// ============================================================================
import { protocol, net } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

export const APP_SCHEME = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://dtpos`;

/**
 * ===== Server functions still need a server =====
 *
 * A handful of the POS's operations run with the Supabase SERVICE-ROLE key —
 * staff sign-in, saving a staff user, provisioning a restaurant. That key
 * cannot ship inside a desktop binary: a .exe sitting on a customer's counter
 * is fully readable, and the service-role key bypasses every RLS policy on the
 * database. So those stay server-side.
 *
 * The renderer posts them to the relative "/_serverFn/...", which inside the
 * shell resolves to app://dtpos/_serverFn/... and would hit the SPA fallback —
 * staff login would fail with a JSON parse error on a page of HTML. Forwarding
 * them to the hosted deployment keeps the renderer bundle byte-identical to the
 * web build; the shell simply knows where this deployment's backend lives.
 *
 * Authentication is a Bearer token in the request, not a cookie, so forwarding
 * the headers is all that is required.
 */
const SERVER_FN_PREFIX = '/_serverFn/';
const API_ORIGIN = (process.env.DTPOS_API_ORIGIN || 'https://digitaltarget.digital').replace(/\/$/, '');

/** Must be called before app 'ready'. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,      // a real origin, so storage and CORS behave
        secure: true,        // counts as a secure context (service workers, crypto.subtle)
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,        // range requests, for media
      },
    },
  ]);
}

/**
 * @param rootDir directory holding index.html and assets/ (the POS
 *                `dist-desktop/client` output, copied in at package time)
 */
export function serveAppScheme(rootDir: string): void {
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);

    // Only our own host is served. app://something-else/ resolves to nothing.
    if (url.hostname !== 'dtpos') {
      return new Response('Not found', { status: 404 });
    }

    if (url.pathname.startsWith(SERVER_FN_PREFIX)) {
      return proxyServerFn(request, url);
    }

    const resolved = resolveWithinRoot(rootDir, decodeURIComponent(url.pathname));
    if (!resolved) {
      // ===== v1.29.0 — "Forbidden" with nothing else to go on =====
      //
      // This is a path-traversal refusal, and it should be rare enough to be
      // suspicious. Reported from a Windows install as the answer to a staff
      // login, where it named neither the path nor the root it was measured
      // against — so there was no way to tell an attack from a packaging
      // mistake. Both facts are logged, and the body says which path.
      console.error(`[protocol] refused ${url.pathname} — outside ${rootDir}`);
      return new Response(`Forbidden: ${url.pathname}`, { status: 403 });
    }

    // The POS is a single-route SPA that navigates by hash, but a deep link or
    // a reload on an unknown path must still land on the shell rather than 404.
    const isFile = existsSync(resolved) && statSync(resolved).isFile();
    const target = isFile ? resolved : join(rootDir, 'index.html');

    // The document carries the CSP; assets do not need one. Serving it here
    // rather than through a blanket webRequest filter is what makes the nonce
    // possible, because the same response that sets the header also writes it
    // into the HTML.
    if (target.endsWith('index.html')) return serveDocument(target);

    return net.fetch(pathToFileURL(target).toString());
  });
}

/**
 * Forward one server-function call to the hosted deployment.
 *
 * Only the headers that matter are passed on — the caller's Supabase bearer
 * token and the content type. Nothing else from the renderer is copied across,
 * and a failure returns a JSON body so the POS shows its own error rather than
 * choking on an HTML error page.
 */
async function proxyServerFn(request: Request, url: URL): Promise<Response> {
  const target = `${API_ORIGIN}${url.pathname}${url.search}`;
  const headers = new Headers();
  for (const name of ['authorization', 'content-type', 'accept']) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  try {
    const upstream = await net.fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      duplex: 'half',
    } as RequestInit);
    // ===== v1.29.0 — "Forbidden" was all the operator got =====
    //
    // REPORTED from a Windows install: signing in as a staff user answered
    // "Forbidden", with nothing to say where it came from.
    //
    // It came from HERE, forwarded verbatim. A server function is proxied to
    // API_ORIGIN, and when that host refuses — the wrong domain, a deployment
    // that does not carry this function, a firewall in between — the upstream
    // body is a bare status line, which the POS then shows as the login error.
    // The one fact needed to diagnose it, WHICH ORIGIN was called, was the one
    // fact nowhere in the message.
    //
    // A successful response is still passed through untouched. Only a refusal
    // that is not already JSON is rewritten, so nothing that works changes.
    const contentType = upstream.headers.get('content-type') ?? '';
    if (!upstream.ok && !contentType.includes('json')) {
      const text = (await upstream.text()).slice(0, 300);
      return new Response(
        JSON.stringify({
          error:
            `${API_ORIGIN} refused this request (HTTP ${upstream.status}${text ? `: ${text.trim()}` : ''}). ` +
            'The desktop app forwards logins to that address. If the POS is served ' +
            'from somewhere else, set DTPOS_API_ORIGIN to it.',
        }),
        { status: upstream.status, headers: { 'content-type': 'application/json' } },
      );
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': contentType || 'application/json',
      },
    });
  } catch (e) {
    // Offline is the normal case for a till, not an exception. Say so plainly.
    return new Response(
      JSON.stringify({ error: `Cannot reach ${API_ORIGIN}: ${e instanceof Error ? e.message : String(e)}` }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }
}

/**
 * ===== Why the shell rewrites index.html =====
 *
 * TanStack Start's prerendered shell contains two INLINE <script> blocks: the
 * hydration payload and the stream barrier. Under a strict `script-src 'self'`
 * the browser refuses both, and the app dies on "Invariant failed" with a blank
 * window — the POS never mounts.
 *
 * The lazy fix is 'unsafe-inline', which readmits every injected script along
 * with the two legitimate ones. Instead each response gets a fresh random
 * nonce, stamped onto exactly the inline scripts that shipped in the build and
 * named in that same response's CSP. Inline script that was not in the bundle
 * still cannot run.
 */
async function serveDocument(file: string): Promise<Response> {
  const nonce = randomBytes(16).toString('base64');
  const html = (await readFile(file, 'utf8'))
    // Only tags with no src= are inline; the module script is loaded by URL and
    // is already covered by 'self'.
    .replace(/<script(?![^>]*\bsrc=)([^>]*)>/gi, `<script nonce="${nonce}"$1>`);

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': documentCsp(nonce),
    },
  });
}

function documentCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    // The POS injects print stylesheets at runtime to lay out receipts, so
    // inline STYLE is required. Inline script is not, and does not get in.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://*.supabase.co https://*.supabase.in wss://*.supabase.co wss://*.supabase.in https://digitaltarget.digital",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * Join a request path onto the root and refuse anything that escapes it.
 *
 * `..` segments, encoded or not, are the classic way to read C:\ out of a
 * packaged app. normalize() collapses them first, then the result is checked to
 * be inside root — a prefix test alone would accept a sibling directory whose
 * name merely starts with the root's.
 */
function resolveWithinRoot(rootDir: string, pathname: string): string | null {
  const candidate = normalize(join(rootDir, pathname === '/' ? 'index.html' : pathname));
  const rootWithSep = rootDir.endsWith(sep) ? rootDir : rootDir + sep;
  if (candidate !== rootDir && !candidate.startsWith(rootWithSep)) return null;
  return candidate;
}
