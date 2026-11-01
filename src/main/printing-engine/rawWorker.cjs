// ============================================================
// RAW PRINT HELPER — one warm PowerShell/Winspool bridge for the session.
//
// The old implementation launched PowerShell and compiled the C# bridge for
// EVERY receipt, which alone could cost 2–5 seconds. The warm helper compiles
// once; each later slip only writes one JSON line and reaches Winspool.
//
// Moved out of main.cjs so its failure handling can be tested with a fake
// process — it is the part of printing that turned "print comes out 20
// seconds later" into a fact of life for a slow PC:
//   • a start slower than the old 8 s limit rejected the ready promise but
//     left it in place, so EVERY later slip got that rejection and went to
//     the Windows driver (slow, and cut through its footer) until restart;
//   • a helper that exited before READY left the promise pending forever:
//     the waiting slip hung until the 30 s job timeout and every slip queued
//     behind it hung too;
//   • a helper stopped after a slow job was only restarted by the NEXT slip,
//     which then paid the whole cold start;
//   • nothing read the helper's error output: enough PowerShell warnings
//     fill that pipe and the helper blocks mid-job, and a helper that died
//     at start left no reason in the log;
//   • writing a job to a helper that had just died raised an unhandled
//     stream error in the main process.
// ============================================================

/**
 * @param {object} deps
 * @param {(cmd: string, args: string[], opts: object) => any} deps.spawn   child_process.spawn
 * @param {() => string} deps.scriptPath   writes/returns the helper script path
 * @param {string} [deps.platform]         process.platform
 * @param {number} [deps.startupMs]        how long the helper may take to start
 * @param {number} [deps.waitMs]           how long ONE slip waits for a starting helper
 * @param {number} [deps.jobTimeoutMs]     how long one job may take
 * @param {number} [deps.rewarmMs]         delay before restarting a stopped helper
 */
function createRawWorker(deps) {
  const platform = deps.platform || process.platform;
  const STARTUP_MS = deps.startupMs ?? 30000;
  const WAIT_MS = deps.waitMs ?? 8000;
  const JOB_TIMEOUT_MS = deps.jobTimeoutMs ?? 5000;
  const REWARM_MS = deps.rewarmMs ?? 400;

  let worker = null;
  let ready = null;
  let buffer = '';
  let pending = null;
  let errTail = '';
  let chain = Promise.resolve();
  let quitting = false;

  function stop() {
    try { worker?.kill(); } catch { /* already gone */ }
    worker = null;
    ready = null;
    buffer = '';
    if (pending) {
      pending.resolve({ success: false, error: 'Direct print worker stopped' });
      pending = null;
    }
    // Start the next one now, in the background, so the next slip does not
    // pay the cold start.
    if (!quitting && platform === 'win32') {
      setTimeout(() => { if (!worker && !quitting) get().catch(() => {}); }, REWARM_MS);
    }
  }

  function get() {
    if (platform !== 'win32') return Promise.reject(new Error('Windows only'));
    if (worker && ready) return ready;
    const me = deps.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', deps.scriptPath()], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    worker = me;
    errTail = '';
    // Drain the error output (a full pipe blocks the helper) and keep its
    // tail, so a helper that dies says why.
    try {
      me.stderr?.on?.('data', (chunk) => {
        if (worker === me) errTail = (errTail + String(chunk || '')).slice(-300);
      });
    } catch { /* no stderr pipe */ }
    // A helper that dies between jobs makes the next write fail with EPIPE;
    // without a listener that error would be thrown in the main process.
    try { me.stdin?.on?.('error', () => { /* reported by 'exit' / the job timeout */ }); } catch { /* no stdin pipe */ }
    // The ready promise ALWAYS settles, and only the process that failed can
    // clear the state — never a newer one.
    const p = new Promise((resolve, reject) => {
      const fail = (err) => {
        clearTimeout(timer);
        const why = worker === me ? errTail.replace(/\s+/g, ' ').trim() : '';
        reject(why ? new Error(`${err.message}: ${why}`) : err);
        if (worker === me) stop();
      };
      const timer = setTimeout(() => fail(new Error('Direct print worker startup timed out')), STARTUP_MS);
      me.stdout.on('data', (chunk) => {
        if (worker !== me) return;
        buffer += String(chunk || '');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim() === 'READY') {
            clearTimeout(timer);
            resolve(me);
            continue;
          }
          if (!pending) continue;
          if (line.startsWith(`OK:${pending.id}`)) {
            const done = pending;
            pending = null;
            done.resolve({ success: true });
          } else if (line.startsWith(`ERR:${pending.id}:`)) {
            const done = pending;
            pending = null;
            done.resolve({ success: false, error: line.slice(`ERR:${done.id}:`.length) || 'raw print failed' });
          }
        }
      });
      me.once('error', (e) => fail(e));
      me.once('exit', () => fail(new Error('Direct print worker exited')));
    });
    p.catch(() => { /* reported to the slip that waits for it */ });
    ready = p;
    return p;
  }

  /** Send one job. Always resolves: { success, error? }. Jobs run one at a time. */
  function send(printerName, data, copies) {
    const workerOrTimeout = () => {
      let wait;
      return Promise.race([
        get(),
        new Promise((_, reject) => { wait = setTimeout(() => reject(new Error('Direct print worker is still starting')), WAIT_MS); }),
      ]).finally(() => clearTimeout(wait));
    };
    const task = () => workerOrTimeout().then(w => new Promise((resolve) => {
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      // A stalled printer must never hold the queue. The caller falls back to
      // the driver path on a timeout; the helper is restarted in the background.
      const timer = setTimeout(() => {
        if (pending?.id === id) pending = null;
        resolve({ success: false, error: 'Direct print timed out' });
        stop();
      }, JOB_TIMEOUT_MS);
      pending = { id, resolve: (result) => { clearTimeout(timer); resolve(result); } };
      try {
        w.stdin.write(JSON.stringify({ id, printerName, copies, data: Buffer.from(data).toString('base64') }) + '\n');
      } catch (e) {
        // The helper is gone: fail this slip now (the caller falls back)
        // rather than after the job timeout, and start a fresh helper.
        if (pending?.id === id) pending = null;
        clearTimeout(timer);
        resolve({ success: false, error: `Direct print worker unavailable: ${String((e && e.message) || e)}` });
        if (worker === w) stop();
      }
    }), (err) => ({ success: false, error: String((err && err.message) || err || 'Direct print worker unavailable') }));
    const run = chain.then(task, task);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    get,
    send,
    stop,
    setQuitting(v = true) { quitting = !!v; },
    /** Test seam. */
    state: () => ({ running: !!worker, ready: !!ready, pending: !!pending }),
  };
}

module.exports = { createRawWorker };
