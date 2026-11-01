// ============================================================
// REVERSED TEXT — white text on a dark fill must stay white on paper.
//
// The print stylesheet paints every piece of slip text pure black, which is
// what keeps thermal output dark. A block drawn as white text on a black
// fill (a TOTAL bar, an ORDER # banner, an UNPAID box) therefore printed as
// black on black: the bar came out, the price on it did not. Templates that
// mark such blocks with .dt-reverse are exempt, but a block that is not
// marked — any template, any future one — lost its text.
//
// This runs in the print window before the slip is measured, captured or
// handed to the driver, and decides by what the head will actually do:
//   * an element whose own background prints as ink (darker than the raster
//     cut-off) is filled solid black;
//   * text whose nearest painted background is such a fill prints white;
//   * a light box nested inside a dark fill keeps black text;
//   * white text is kept at least bold: a thin white stroke on a black fill
//     loses its grey edges to the threshold and bleeds shut on thermal
//     paper (the Standard text weight would otherwise thin it to regular).
// Inline !important declarations outrank the stylesheet's !important rule,
// and the element-level choice (not a blanket rule) is what keeps nested
// light boxes correct.
// ============================================================

/** Luminance below which the raster stage marks a dot (see packDots). */
function cutoffFor(darkness) {
  const d = Math.max(1, Math.min(10, Math.round(Number(darkness) || 6)));
  return 108 + d * 13;
}

function reversedTextJs(cutoff) {
  const cut = Number.isFinite(Number(cutoff)) ? Number(cutoff) : cutoffFor(6);
  return `(() => {
  const CUT = ${cut};
  const root = document.querySelector('.dt-fast-root') || document.body;
  const parse = (v) => {
    const m = /rgba?\\(([^)]*)\\)/.exec(v || '');
    if (!m) return null;
    const p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const els = Array.from(root.querySelectorAll('*'));
  // Read everything first, then write: a style read after a write forces a
  // fresh style pass, and doing that per element would slow every print.
  const dark = new Set();
  const light = new Set();
  const weight = new Map();
  for (const el of els) {
    const cs = getComputedStyle(el);
    weight.set(el, parseInt(cs.fontWeight, 10) || 400);
    const bg = parse(cs.backgroundColor);
    if (!bg || !(bg.a >= 0.5)) continue;
    // Over white paper, as the capture composites it.
    const mix = (c) => c * bg.a + 255 * (1 - bg.a);
    const lum = 0.299 * mix(bg.r) + 0.587 * mix(bg.g) + 0.114 * mix(bg.b);
    (lum < CUT ? dark : light).add(el);
  }
  if (!dark.size) return 0;
  const white = [];
  for (const el of els) {
    let p = el;
    while (p && p !== root && !dark.has(p) && !light.has(p)) p = p.parentElement;
    if (p && dark.has(p)) white.push(el);
  }
  for (const el of dark) el.style.setProperty('background-color', '#000', 'important');
  for (const el of white) {
    el.style.setProperty('color', '#fff', 'important');
    if (weight.get(el) < 700) el.style.setProperty('font-weight', '700', 'important');
  }
  const n = white.length;
  return n;
})()`;
}

/** Apply to the slip loaded in `webContents`. Never throws. */
async function applyReversedText(webContents, darkness) {
  if (!webContents) return 0;
  try { return await webContents.executeJavaScript(reversedTextJs(cutoffFor(darkness))); } catch { return 0; }
}

module.exports = { cutoffFor, reversedTextJs, applyReversedText };
