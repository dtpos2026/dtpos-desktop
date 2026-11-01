// ============================================================
// PRINTER NAME RESOLVER — the installed printer a RAW job should open.
//
// Windows renames a USB printer when it is re-plugged or wakes from sleep
// ("BlackCopper 80mm Series (Copy 1)"). The image route used to hand the
// saved name straight to OpenPrinter, so after a rename every bill and KOT
// failed RAW and silently fell back to the Windows-driver route — slow, and
// cut through its last lines — until somebody pressed Re-detect.
//
// Resolving must never make a slip late:
//   * the printer list is kept for a short while (one Windows query per
//     30 s, not per slip), and a bill and a KOT printing together share one
//     query;
//   * a list that takes longer than `waitMs` (an unreachable network printer
//     can stall Windows' enumeration for seconds) is not waited for — the
//     slip prints on the saved name, exactly as before, and the list is
//     still cached for the next slip when it arrives;
//   * it never rejects: any failure prints on the saved name.
//
// `list` and `match` are injected so this is tested without Electron; the
// app passes its own printer enumeration and matchPrinterName.
// ============================================================

function createPrinterResolver({ list, match, maxAgeMs = 30000, waitMs = 1500, now = Date.now }) {
  let cache = { at: 0, list: [] };
  let inflight = null;

  function printers(maxAge = maxAgeMs) {
    if (cache.list.length && now() - cache.at < maxAge) return Promise.resolve(cache.list);
    if (!inflight) {
      inflight = Promise.resolve()
        .then(() => list())
        .then(found => {
          const arr = Array.isArray(found) ? found : [];
          cache = { at: now(), list: arr };
          return arr;
        })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  /**
   * `fresh` re-reads the list (after a job could not open its printer).
   * Resolves `{ name, stage }`: `stage` is the matcher's stage, or
   * 'timeout' / 'error' when the saved name was used unchecked.
   */
  async function resolve(requested, fresh = false) {
    const saved = String(requested || '').trim();
    if (!saved) return { name: '', stage: 'none' };
    let timer;
    const late = new Promise(done => { timer = setTimeout(() => done(null), waitMs); });
    try {
      const listed = await Promise.race([printers(fresh ? 0 : maxAgeMs), late]);
      if (!listed) return { name: saved, stage: 'timeout' };
      const hit = match(saved, listed) || {};
      return { name: hit.name || saved, stage: hit.stage || 'passthrough' };
    } catch {
      return { name: saved, stage: 'error' };
    } finally {
      clearTimeout(timer);
    }
  }

  return { resolve, printers };
}

module.exports = { createPrinterResolver };
