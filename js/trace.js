// Image Trace, modelled on Illustrator's Image Trace.
// Modes: black & white (threshold), grayscale (N tones) or colour (N colours,
// k-means in OKLab). Each traced tone/colour becomes one height level, so the
// rest of the pipeline (distance fields, stitches, G-code) works per level.
(function (DH) {
  "use strict";
  const G = DH.geom;

  // sRGB byte → OKLab (perceptual space for colour clustering).
  function toLin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  const LIN = new Float32Array(256).map((_, i) => toLin(i));
  function oklab(r, g, b) {
    const lr = LIN[r], lg = LIN[g], lb = LIN[b];
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  }

  function rng(seed) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }

  // k-means with k-means++ seeding on `dims`-dimensional points (flat array).
  function kmeans(pts, dims, k, iters) {
    const n = pts.length / dims, rand = rng(42);
    const C = new Float64Array(k * dims);
    const d2 = new Float64Array(n).fill(Infinity);
    let first = Math.floor(rand() * n);
    for (let d = 0; d < dims; d++) C[d] = pts[first * dims + d];
    for (let c = 1; c < k; c++) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        let dd = 0;
        for (let d = 0; d < dims; d++) dd += (pts[i * dims + d] - C[(c - 1) * dims + d]) ** 2;
        if (dd < d2[i]) d2[i] = dd;
        sum += d2[i];
      }
      let r = rand() * sum, pick = n - 1;
      for (let i = 0; i < n; i++) { r -= d2[i]; if (r <= 0) { pick = i; break; } }
      for (let d = 0; d < dims; d++) C[c * dims + d] = pts[pick * dims + d];
    }
    const lab = new Int32Array(n);
    for (let it = 0; it < iters; it++) {
      const acc = new Float64Array(k * dims), cnt = new Float64Array(k);
      for (let i = 0; i < n; i++) {
        let best = 0, bd = Infinity;
        for (let c = 0; c < k; c++) {
          let dd = 0;
          for (let d = 0; d < dims; d++) dd += (pts[i * dims + d] - C[c * dims + d]) ** 2;
          if (dd < bd) { bd = dd; best = c; }
        }
        lab[i] = best; cnt[best]++;
        for (let d = 0; d < dims; d++) acc[best * dims + d] += pts[i * dims + d];
      }
      for (let c = 0; c < k; c++) if (cnt[c]) for (let d = 0; d < dims; d++) C[c * dims + d] = acc[c * dims + d] / cnt[c];
    }
    return C;
  }

  const hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

  // s: {mode: "bw"|"gray"|"colour", threshold, colours, paths, corners, noiseMm,
  //     ignoreWhite, darkHigh, alphaMask}
  // Returns {lv, swatches: [hex per level 1..N], levels: N}.
  function traceMap(base, s, p) {
    const { w, h } = base, n = w * h, rgb = base.rgb;
    const usable = (i) => !(s.alphaMask && !base.alpha[i]);
    let N, label = new Int16Array(n).fill(-1), swatches = [];

    if (s.mode === "bw") {
      N = 1;
      const t = s.threshold / 255;
      for (let i = 0; i < n; i++) if (usable(i) && base.gray[i] < t) label[i] = 0;
      let r = 0, g = 0, b = 0, c = 0;
      for (let i = 0; i < n; i++) if (label[i] === 0) { r += rgb[i * 3]; g += rgb[i * 3 + 1]; b += rgb[i * 3 + 2]; c++; }
      swatches = [c ? hex(r / c, g / c, b / c) : "#1d1d1c"];
    } else {
      const want = Math.max(1, Math.min(5, s.colours));
      const k = want + (s.ignoreWhite ? 1 : 0);
      const dims = s.mode === "gray" ? 1 : 3;
      // Sample up to ~25k usable pixels on a regular stride.
      const idx = [];
      for (let i = 0; i < n; i++) if (usable(i)) idx.push(i);
      const stride = Math.max(1, Math.floor(idx.length / 25000));
      const feat = (i) => (dims === 1 ? [oklab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2])[0]] : oklab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]));
      const sample = [];
      for (let j = 0; j < idx.length; j += stride) sample.push(...feat(idx[j]));
      if (!sample.length) return { lv: new Uint8Array(n), swatches: [], levels: want };
      const kk = Math.min(k, sample.length / dims);
      const C = kmeans(Float64Array.from(sample), dims, kk, 14);
      // Order clusters from dark to light by OKLab lightness.
      const order = [...Array(kk).keys()].sort((a, b) => C[a * dims] - C[b * dims]);
      const printed = s.ignoreWhite && kk > 1 ? order.slice(0, kk - 1) : order;
      N = printed.length;
      const rank = new Int16Array(kk).fill(-1);
      printed.forEach((c, r) => { rank[c] = r; }); // 0 = darkest printed
      const sums = Array.from({ length: N }, () => [0, 0, 0, 0]);
      for (let i = 0; i < n; i++) {
        if (!usable(i)) continue;
        const f = feat(i);
        let best = 0, bd = Infinity;
        for (let c = 0; c < kk; c++) {
          let dd = 0;
          for (let d = 0; d < dims; d++) dd += (f[d] - C[c * dims + d]) ** 2;
          if (dd < bd) { bd = dd; best = c; }
        }
        const r = rank[best];
        if (r < 0) continue;
        label[i] = r;
        const sm = sums[r]; sm[0] += rgb[i * 3]; sm[1] += rgb[i * 3 + 1]; sm[2] += rgb[i * 3 + 2]; sm[3]++;
      }
      swatches = sums.map((sm) => (sm[3] ? hex(sm[0] / sm[3], sm[1] / sm[3], sm[2] / sm[3]) : "#888888"));
    }

    // Height: darkest is tallest (level N) unless darkHigh is off.
    let lv = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (label[i] >= 0) lv[i] = s.darkHigh ? N - label[i] : label[i] + 1;
    if (s.darkHigh) swatches = swatches.slice().reverse(); // index by level-1

    // Corners: round each nested mask (blur its indicator, cut at 0.5).
    // 100 keeps corners sharp; 0 rounds them by up to ~1 mm.
    const sigma = ((100 - s.corners) / 100) * (1.0 / p);
    if (sigma >= 0.5) {
      const out = new Uint8Array(n), f = new Float32Array(n);
      for (let k = 1; k <= N; k++) {
        for (let i = 0; i < n; i++) f[i] = lv[i] >= k ? 1 : 0;
        G.gaussianBlur(f, w, h, sigma);
        for (let i = 0; i < n; i++) if (f[i] > 0.5) out[i] = k;
      }
      if (s.alphaMask) for (let i = 0; i < n; i++) if (!base.alpha[i]) out[i] = 0;
      lv = out;
    }
    // Noise: drop islands and holes smaller than noiseMm².
    DH.raster.despeckle(lv, w, h, N, Math.pow(s.noiseMm / p, 2));
    return { lv, swatches, levels: N };
  }

  // Paths (fidelity): 100 follows the pixels closely, 0 simplifies heavily.
  const simplifyFor = (paths) => 0.01 + ((100 - paths) / 100) * 0.3;

  DH.trace = { traceMap, simplifyFor, oklab };
})(globalThis.DH = globalThis.DH || {});
