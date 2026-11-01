// ============================================================
// TEXT WEIGHT — "Standard" weight for thermal slips.
//
// Shops reported slips "too bold": every template draws most of its text at
// 700–900, the print stylesheet forces 800–900 on headings and item names,
// and the raster stage used to add a one-dot smear on top. Standard keeps
// the hierarchy (headings, item names and totals stay bold) and prints the
// body in a regular weight:
//
//     900, 800  →  700   (bold)
//     700, 600  →  500   (regular for most system fonts)
//
// Run inside the print window, after the slip is laid out and before it is
// measured, captured or printed. Two passes: every computed weight is read
// first, then written — so a child that only inherited its weight is not
// reduced twice after its parent changed.
// ============================================================

const STANDARD_MAP = { 900: 700, 800: 700, 700: 500, 600: 500 };

/** Pure mapping, exported for tests. */
function standardWeight(weight) {
  const w = parseInt(String(weight), 10);
  return STANDARD_MAP[w] || null;
}

const STANDARD_WEIGHT_JS = `(() => {
  const map = ${JSON.stringify(STANDARD_MAP)};
  const root = document.querySelector('.dt-fast-root') || document.body;
  const els = Array.from(root.querySelectorAll('*'));
  const plan = [];
  for (const el of els) {
    const w = parseInt(getComputedStyle(el).fontWeight, 10);
    if (map[w]) plan.push([el, map[w]]);
  }
  for (const [el, w] of plan) el.style.setProperty('font-weight', String(w), 'important');
  return plan.length;
})()`;

/** Apply the shop's text weight to the document loaded in `webContents`. */
async function applyTextWeight(webContents, weight) {
  if (weight !== 'standard' || !webContents) return 0;
  try { return await webContents.executeJavaScript(STANDARD_WEIGHT_JS); } catch { return 0; }
}

module.exports = { STANDARD_MAP, STANDARD_WEIGHT_JS, standardWeight, applyTextWeight };
