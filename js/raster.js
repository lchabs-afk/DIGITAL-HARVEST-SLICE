// Raster helpers shared by the transform: working grid, grayscale/RGB copy,
// despeckle, and the signed distance field of each height level.
// Level 0 is bare fabric; levels 1..N are printed, N is the tallest.
(function (DH) {
  "use strict";
  const G = DH.geom;

  // Working grid for a print of widthMm × heightMm. Pixel size never goes
  // below 0.08 mm and the grid stays under ~1.5 million pixels.
  function gridFor(widthMm, heightMm) {
    const p = Math.max(0.08, Math.sqrt((widthMm * heightMm) / 1.5e6));
    return { p, w: Math.max(8, Math.round(widthMm / p)), h: Math.max(8, Math.round(heightMm / p)) };
  }

  // imageData: {data: RGBA bytes, width, height} already resampled to the grid.
  function toGray(imageData) {
    const n = imageData.width * imageData.height, d = imageData.data;
    const gray = new Float32Array(n), alpha = new Uint8Array(n), rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = d[i * 4 + 3] / 255;
      const l = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
      gray[i] = l * a + (1 - a); // transparent pixels read as white
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(d[i * 4 + c] * a + 255 * (1 - a));
      alpha[i] = a >= 0.5 ? 1 : 0;
    }
    return { gray, alpha, rgb, w: imageData.width, h: imageData.height };
  }

  // Remove components of `inside(i)` smaller than minArea pixels; set(i) is
  // called for every pixel of a removed component. 4-connected.
  function removeSmall(n, w, h, inside, minArea, set) {
    if (minArea < 2) return;
    const seen = new Uint8Array(n), stack = new Int32Array(n), comp = [];
    for (let s = 0; s < n; s++) {
      if (seen[s] || !inside(s)) continue;
      let top = 0; stack[top++] = s; seen[s] = 1; comp.length = 0;
      let touchesEdge = false;
      while (top) {
        const i = stack[--top]; comp.push(i);
        const x = i % w, y = (i / w) | 0;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesEdge = true;
        if (x > 0 && !seen[i - 1] && inside(i - 1)) { seen[i - 1] = 1; stack[top++] = i - 1; }
        if (x < w - 1 && !seen[i + 1] && inside(i + 1)) { seen[i + 1] = 1; stack[top++] = i + 1; }
        if (y > 0 && !seen[i - w] && inside(i - w)) { seen[i - w] = 1; stack[top++] = i - w; }
        if (y < h - 1 && !seen[i + w] && inside(i + w)) { seen[i + w] = 1; stack[top++] = i + w; }
      }
      if (comp.length < minArea && !(set.keepEdge && touchesEdge)) for (const i of comp) set(i);
    }
  }

  // Remove islands and fill holes smaller than minArea pixels, level by level.
  function despeckle(lv, w, h, N, minArea) {
    const n = w * h;
    for (let k = 1; k <= N; k++) {
      removeSmall(n, w, h, (i) => lv[i] >= k, minArea, (i) => { lv[i] = k - 1; });
      const fill = (i) => { lv[i] = k; };
      fill.keepEdge = true; // background touching the border is never a "hole"
      removeSmall(n, w, h, (i) => lv[i] < k, minArea, fill);
    }
  }

  // Signed distance (mm) to the outline of the region printed at level >= k.
  function levelField(lv, w, h, k, p) {
    const mask = new Uint8Array(w * h);
    let any = false;
    for (let i = 0; i < w * h; i++) if (lv[i] >= k) { mask[i] = 1; any = true; }
    if (!any) return null;
    const sdf = G.signedDistance(mask, w, h);
    G.boxBlur(sdf, w, h, 1, 1); // knock off pixel stair-steps
    for (let i = 0; i < sdf.length; i++) sdf[i] *= p;
    return { sdf, w, h, p };
  }

  function levelStats(lv, N) {
    const count = new Array(N + 1).fill(0);
    for (let i = 0; i < lv.length; i++) count[lv[i]]++;
    return count;
  }

  DH.raster = { gridFor, toGray, levelField, levelStats, despeckle };
})(globalThis.DH = globalThis.DH || {});
