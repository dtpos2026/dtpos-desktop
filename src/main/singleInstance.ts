// ============================================================================
// Second-launch hand-over — so "I clicked the shortcut and nothing happened" can no longer be silent.
//
// REPORTED: after installing as Administrator the app opens; clicking the shortcut again does nothing.
//
// The shell allows one copy (two tills racing one shift is worse than none). A second launch asks Electron for the
// lock, fails, and quits — that is correct ONLY IF the copy already running shows its window. It did not:
//   1. closing the POS window did not end the process. The printing engine keeps a hidden BrowserWindow, so
//      `window-all-closed` never fired and the process lingered, still holding the lock;
//   2. the lingering copy's `second-instance` handler then focused `getAllWindows()[0]` — the hidden print worker —
//      so the user saw nothing;
//   3. a copy running elevated cannot be messaged by a normal one (Windows blocks it across integrity levels), so a
//      normal launch quit without the first copy ever hearing of it.
//
// (1) and (2) are fixed in index.ts. This module covers (3) and anything unforeseen: the running copy leaves a
// timestamped note when it receives a hand-over, and the copy that handed over waits briefly for it. If no note
// arrives the user is TOLD, instead of being left staring at an empty taskbar.
//
// Pure fs functions with an injectable filesystem and clock: nothing here imports Electron, so it is unit-tested in
// plain Node.
// ============================================================================
import * as nodeFs from 'node:fs';
import { join } from 'node:path';

export const ACK_FILE = 'second-instance-ack.json';

export interface Ack { at: number; pid: number }

export interface AckFs {
  readFileSync(path: string, enc: 'utf8'): string;
  writeFileSync(path: string, data: string, enc: 'utf8'): void;
  mkdirSync(path: string, opts: { recursive: boolean }): unknown;
}

export const ackPath = (dir: string): string => join(dir, ACK_FILE);

/** The running copy calls this when a second launch reached it. Never throws. */
export function writeAck(dir: string, now: number = Date.now(), pid: number = process.pid, fs: AckFs = nodeFs): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ackPath(dir), JSON.stringify({ at: now, pid } satisfies Ack), 'utf8');
  } catch { /* a note that cannot be written only means the other copy will show its explanation */ }
}

export function readAck(dir: string, fs: AckFs = nodeFs): Ack | null {
  try {
    const v = JSON.parse(fs.readFileSync(ackPath(dir), 'utf8')) as Partial<Ack>;
    return typeof v.at === 'number' && Number.isFinite(v.at) ? { at: v.at, pid: Number(v.pid) || 0 } : null;
  } catch { return null; }
}

/**
 * Wait for the running copy's note, written at or after `sinceMs`.
 * Resolves true as soon as it appears, false when `timeoutMs` passes without one.
 */
export async function waitForAck(
  dir: string,
  sinceMs: number,
  opts: { timeoutMs?: number; stepMs?: number; fs?: AckFs; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const stepMs = opts.stepMs ?? 150;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const end = now() + timeoutMs;
  for (;;) {
    const a = readAck(dir, opts.fs ?? nodeFs);
    if (a && a.at >= sinceMs) return true;
    if (now() >= end) return false;
    await sleep(stepMs);
  }
}

/** What the user is told when the copy that is running cannot be reached. */
export const UNREACHABLE_TITLE = 'DT POS is already running';
export const UNREACHABLE_MESSAGE =
  'DT POS is already open on this computer, but it could not be brought to the front.\n\n' +
  'This usually means a copy is still running in the background, or was started with "Run as administrator" ' +
  'while this one was not (Windows does not let the two talk to each other).\n\n' +
  'To fix it: open Task Manager (Ctrl+Shift+Esc), end every "DT POS" process, then open DT POS again from its shortcut.';
