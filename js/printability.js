// Printability filter: removes what the nozzle can't print, level by level,
// and records what was removed so the preview can show it in red.
//   - parts narrower than the minimum feature width (a morphological opening:
//     shrink every level by half the width, grow it back; what doesn't come
//     back was too thin)
//   - islands smaller than the minimum area; holes smaller than it are filled
(function (DH) {
  "use strict";
  const G = DH.geom;

  // lv: height level per pixel (0 = bare). Returns {lv, removed} where removed
  // marks pixels whose level went down.
  function filter(lv, w, h, N, p, s) {
    const n = w * h, out = lv.slice();
    const r = s.minWidthMm / 2 / p; // in pixels
    if (r >= 0.5) {
      for (let k = 1; k <= N; k++) {
        const inK = (i) => out[i] >= k;
        let any = false;
        for (let i = 0; i < n; i++) if (out[i] >= k) { any = true; break; }
        if (!any) break;
        const toEdge = G.edt2d((i) => !inK(i), w, h);           // squared distance to outside
        const core = new Uint8Array(n);
        for (let i = 0; i < n; i++) core[i] = inK(i) && toEdge[i] > r * r ? 1 : 0;
        const toCore = G.edt2d((i) => core[i] === 1, w, h);     // squared distance to the core
        for (let i = 0; i < n; i++) if (inK(i) && toCore[i] > (r + 0.5) * (r + 0.5)) out[i] = k - 1;
      }
    }
    DH.raster.despeckle(out, w, h, N, s.minAreaMm2 / (p * p));
    const removed = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (out[i] < lv[i]) removed[i] = 1;
    return { lv: out, removed };
  }

  DH.printability = { filter };
})(globalThis.DH = globalThis.DH || {});
