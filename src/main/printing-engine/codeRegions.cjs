// ============================================================
// CODE REGIONS — where a slip's QR code and barcode sit, for the raster stage.
//
// The raster stage thresholds text towards ink so small print stays solid;
// inside a QR code or barcode that bias grows every dark module by a dot
// whenever its edge falls between two printer dots, and the code stops
// scanning (see EXACT_LOW/HIGH in escposRaster.cjs). The print window reports
// the codes' boxes here, in CSS px from the page origin (where the capture
// starts), before the capture zoom; toCaptureRegions scales them into the
// capture's pixels.
// ============================================================

const CODE_BOXES_JS = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('.dt-receipt-codes svg')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      out.push({ x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height });
    }
  }
  return out;
})()`;

/** CSS-px boxes → capture pixels at `zoom`. Anything malformed is dropped. */
function toCaptureRegions(boxes, zoom) {
  const z = Number(zoom) > 0 ? Number(zoom) : 1;
  if (!Array.isArray(boxes)) return [];
  return boxes
    .filter(b => b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 0 && b.height > 0)
    .map(b => ({ x: b.x * z, y: b.y * z, width: b.width * z, height: b.height * z }));
}

module.exports = { CODE_BOXES_JS, toCaptureRegions };
