// Halftone: the image becomes dots directly, with no vectorizing.
// The adjusted grayscale is sampled on a square or hexagonal grid (rotated by
// the grid angle). Each cell becomes one dot whose diameter follows the
// darkness of that cell: printed area grows with darkness, so the diameter is
// maxD × √darkness. Dots under the minimum diameter are dropped, so light areas
// stay bare fabric. Dots never exceed MAX_DOT.
(function (DH) {
  "use strict";
  const MAX_DOT = 1.5; // mm, hard limit

  // Summed-area table, so the average darkness of any cell costs four lookups.
  function integral(values, w, h) {
    const I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += values[y * w + x];
        I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
      }
    }
    return I;
  }

  // tone: lightness 0..1 per pixel of the working grid (after levels/contrast),
  // mask: printable pixels (or null), p: mm per pixel.
  // s: {spacing, angle, grid: "square"|"hex", minD, maxD, invert}
  // Returns dots in design mm (y up): [{x, y, d}].
  function dots(tone, mask, w, h, p, s) {
    const maxD = Math.min(MAX_DOT, Math.max(0.05, s.maxD));
    const minD = Math.min(maxD, Math.max(0, s.minD));
    const sp = Math.max(0.1, s.spacing);
    const dark = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) dark[i] = s.invert ? tone[i] : 1 - tone[i];
    const I = integral(dark, w, h), M = mask ? integral(Float32Array.from(mask), w, h) : null;
    const box = (T, x0, y0, x1, y1) => T[y1 * (w + 1) + x1] - T[y0 * (w + 1) + x1] - T[y1 * (w + 1) + x0] + T[y0 * (w + 1) + x0];

    const Wmm = w * p, Hmm = h * p, cx = Wmm / 2, cy = Hmm / 2;
    const a = ((s.angle || 0) * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    const hex = s.grid === "hex", rowStep = hex ? (sp * Math.sqrt(3)) / 2 : sp;
    const R = Math.hypot(Wmm, Hmm) / 2 + sp, half = sp / 2;
    const out = [];
    let row = 0;
    for (let v = -R; v <= R; v += rowStep, row++) {
      const shift = hex && row % 2 ? sp / 2 : 0;
      for (let u = -R + shift; u <= R; u += sp) {
        const x = cx + u * ca - v * sa, y = cy + u * sa + v * ca;
        if (x < 0 || y < 0 || x > Wmm || y > Hmm) continue;
        // the cell: a square of one spacing around the dot, in pixels (y down)
        const px = x / p, py = (Hmm - y) / p, r = half / p;
        const x0 = Math.max(0, Math.floor(px - r)), x1 = Math.min(w, Math.ceil(px + r));
        const y0 = Math.max(0, Math.floor(py - r)), y1 = Math.min(h, Math.ceil(py + r));
        const n = (x1 - x0) * (y1 - y0);
        if (n <= 0) continue;
        if (M && box(M, x0, y0, x1, y1) / n < 0.5) continue; // mostly transparent: never printed
        const dk = Math.min(1, Math.max(0, box(I, x0, y0, x1, y1) / n));
        const d = maxD * Math.sqrt(dk);
        if (d < minD || d <= 0) continue;
        out.push({ x, y, d });
      }
    }
    return out;
  }

  // Dots closer than their diameters will merge into each other.
  const merges = (s) => s.spacing < Math.min(MAX_DOT, s.maxD);

  // Printability for dots: anything under the minimum printable size goes,
  // and is returned separately so the preview can show it in red.
  function filter(list, minPrintable) {
    const keep = [], removed = [];
    for (const q of list) (q.d < minPrintable ? removed : keep).push(q);
    return { dots: keep, removed };
  }

  // Calibration row: n dots with diameters evenly from minD to maxD, centred
  // on (cx, cy), spaced so the largest ones stay well apart.
  function calibration(minD, maxD, cx, cy, n) {
    n = n || 10;
    const hi = Math.min(MAX_DOT, maxD), lo = Math.min(hi, minD);
    const gap = Math.max(4, hi * 3);
    return Array.from({ length: n }, (_, i) => ({
      n: i + 1, d: lo + ((hi - lo) * i) / (n - 1), x: cx + (i - (n - 1) / 2) * gap, y: cy,
    }));
  }

  DH.halftone = { dots, merges, filter, calibration, MAX_DOT };
})(globalThis.DH = globalThis.DH || {});
