// ============================================================================
// PRA (Pakistan Revenue Authority) fiscal requests.
//
// The renderer routes these through main for two reasons it states itself: a
// browser tab cannot reach a localhost fiscal device, and PRAL's cloud endpoint
// does not send CORS headers a browser origin would accept. Main has neither
// restriction.
//
// The response shape here matches what praTransport.ts already expects, so the
// existing transport, retry and compliance logic is reused untouched.
// ============================================================================
import { handle } from './registry';

export function registerPraIpc(): void {
  handle('praFiscalRequest', async (_e, raw: unknown) => {
    const a = (raw ?? {}) as Record<string, unknown>;
    const url = typeof a.url === 'string' ? a.url : '';
    const method = a.method === 'POST' ? 'POST' : 'GET';
    const token = typeof a.token === 'string' ? a.token : '';
    const timeoutMs = typeof a.timeoutMs === 'number' && a.timeoutMs > 0
      ? Math.min(a.timeoutMs, 120_000)
      : 15_000;

    let parsed: URL;
    try { parsed = new URL(url); } catch { return { success: false, error: 'invalid URL' }; }
    // http is allowed ONLY for the on-premises fiscal box, which is what the
    // 'local' transport is; anything off-machine must be https.
    const isLoopback = parsed.hostname === 'localhost'
      || parsed.hostname === '127.0.0.1'
      || parsed.hostname === '::1';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
      return { success: false, error: 'fiscal endpoint must be https, or http on this machine' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (a.body != null) headers['Content-Type'] = 'application/json';
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch(url, {
        method,
        headers,
        body: a.body == null ? undefined : JSON.stringify(a.body),
        signal: controller.signal,
      });
      const text = await res.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch { body = undefined; }
      return { success: res.ok, status: res.status, body, text };
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      return {
        success: false,
        timeout: aborted || undefined,
        code: aborted ? 'ETIMEDOUT' : (e as NodeJS.ErrnoException)?.code,
        error: aborted ? `fiscal request timed out after ${timeoutMs}ms` : msg(e),
      };
    } finally {
      clearTimeout(timer);
    }
  });
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
