// ============================================================================
// A launch log. "The app does not open" is the hardest report to act on because nothing is left behind. This leaves
// one line per launch step in <userData>/logs/launch.log, so the next report comes with an answer: did the process
// start, did it get the instance lock, did the window load, what killed it.
//
// Best effort in every way: a log that cannot be written must never stop the POS from starting, and the file is
// capped so it can never fill a till's disk.
// ============================================================================
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 256 * 1024;

let dir: string | null = null;

/** Call once with app.getPath('userData'). Until then, logging is a no-op. */
export function initLaunchLog(userDataDir: string): void {
  dir = join(userDataDir, 'logs');
  try { mkdirSync(dir, { recursive: true }); } catch { dir = null; }
}

export function launchLog(event: string, detail?: unknown): void {
  if (!dir) return;
  try {
    const file = join(dir, 'launch.log');
    try { if (statSync(file).size > MAX_BYTES) renameSync(file, join(dir, 'launch.log.1')); } catch { /* no file yet */ }
    const d = detail === undefined ? '' : ' — ' + (detail instanceof Error ? `${detail.name}: ${detail.message}` : typeof detail === 'string' ? detail : safeJson(detail));
    appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${event}${d}\n`);
  } catch { /* never let logging break the launch */ }
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
