// Geometry helpers: distance fields, iso-contours, simplification, scanlines.
// Raster coordinates: x to the right, y down, one unit per pixel.
(function (DH) {
  "use strict";
  const INF = 1e20;

  // 1D squared Euclidean distance transform (Felzenszwalb & Huttenlocher).
  function edt1d(f, n, d, v, z) {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const dq = q - v[k];
      d[q] = dq * dq + f[v[k]];
    }
  }

  // Squared distance from each pixel to the nearest pixel where feature[i] is true.
  function edt2d(feature, w, h) {
    const out = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = feature(i) ? 0 : INF;
    const n = Math.max(w, h);
    const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = out[y * w + x];
      edt1d(f, h, d, v, z);
      for (let y = 0; y < h; y++) out[y * w + x] = d[y];
    }
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) f[x] = out[o + x];
      edt1d(f, w, d, v, z);
      for (let x = 0; x < w; x++) out[o + x] = d[x];
    }
    return out;
  }

  // Signed distance field in pixels: positive inside the mask, negative outside.
  // The boundary sits halfway between an inside and an outside pixel.
  function signedDistance(mask, w, h) {
    const dOut = edt2d((i) => !mask[i], w, h);
    const dIn = edt2d((i) => !!mask[i], w, h);
    const sdf = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      sdf[i] = mask[i] ? Math.sqrt(dOut[i]) - 0.5 : -(Math.sqrt(dIn[i]) - 0.5);
    }
    return sdf;
  }

  // Separable box blur, in place; `passes` box passes approximate a Gaussian.
  function boxBlur(src, w, h, r, passes) {
    if (r < 1) return src;
    const tmp = new Float32Array(w * h);
    let a = src, b = tmp;
    for (let pass = 0; pass < passes; pass++) {
      // horizontal a -> b
      for (let y = 0; y < h; y++) {
        const o = y * w;
        let acc = 0;
        for (let x = -r; x <= r; x++) acc += a[o + Math.min(w - 1, Math.max(0, x))];
        for (let x = 0; x < w; x++) {
          b[o + x] = acc / (2 * r + 1);
          acc += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)];
        }
      }
      // vertical b -> a
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let y = -r; y <= r; y++) acc += b[Math.min(h - 1, Math.max(0, y)) * w + x];
        for (let y = 0; y < h; y++) {
          a[y * w + x] = acc / (2 * r + 1);
          acc += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
        }
      }
    }
    return a;
  }

  // Gaussian-like blur with standard deviation sigma (pixels), in place.
  function gaussianBlur(src, w, h, sigma) {
    if (sigma < 0.5) return src;
    // three box passes: box radius from sigma (Kovesi approximation, simplified)
    const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2 - 0.5));
    return boxBlur(src, w, h, r, 3);
  }

  // Marching squares. Returns closed loops [[x,y], ...] in pixel-centre coordinates
  // (pixel i has centre x = i) where field > level is inside.
  function isoContours(field, w, h, level) {
    // Pad by one pixel of "outside" so every contour closes.
    const W = w + 2, H = h + 2;
    const val = (x, y) => (x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1 ? -INF : field[(y - 1) * w + (x - 1)]);
    const nEdges = W * H * 2;
    const seg1 = new Int32Array(nEdges).fill(-1);
    const seg2 = new Int32Array(nEdges).fill(-1);
    const segA = [], segB = [];
    const pts = new Map();
    const hEdge = (x, y) => (y * W + x) * 2;
    const vEdge = (x, y) => (y * W + x) * 2 + 1;
    function edgePoint(e) {
      let p = pts.get(e);
      if (p) return p;
      const cell = e >> 1, x = cell % W, y = (cell / W) | 0;
      let x1 = x, y1 = y;
      if (e & 1) y1 = y + 1; else x1 = x + 1;
      const f0 = val(x, y), f1 = val(x1, y1);
      let t = (level - f0) / (f1 - f0);
      if (!isFinite(t)) t = 0.5;
      t = Math.min(1, Math.max(0, t));
      p = [x + (x1 - x) * t - 1, y + (y1 - y) * t - 1];
      pts.set(e, p);
      return p;
    }
    function addSeg(a, b) {
      const s = segA.length;
      segA.push(a); segB.push(b);
      if (seg1[a] < 0) seg1[a] = s; else seg2[a] = s;
      if (seg1[b] < 0) seg1[b] = s; else seg2[b] = s;
    }
    for (let y = 0; y < H - 1; y++) {
      for (let x = 0; x < W - 1; x++) {
        const fa = val(x, y), fb = val(x + 1, y), fc = val(x + 1, y + 1), fd = val(x, y + 1);
        const c = (fa > level ? 8 : 0) | (fb > level ? 4 : 0) | (fc > level ? 2 : 0) | (fd > level ? 1 : 0);
        if (c === 0 || c === 15) continue;
        const T = hEdge(x, y), B = hEdge(x, y + 1), L = vEdge(x, y), R = vEdge(x + 1, y);
        switch (c) {
          case 1: case 14: addSeg(L, B); break;
          case 2: case 13: addSeg(B, R); break;
          case 3: case 12: addSeg(L, R); break;
          case 4: case 11: addSeg(T, R); break;
          case 6: case 9: addSeg(T, B); break;
          case 7: case 8: addSeg(T, L); break;
          case 5: {
            const centre = (fa + fb + fc + fd) / 4 > level;
            if (centre) { addSeg(L, T); addSeg(R, B); } else { addSeg(T, R); addSeg(B, L); }
            break;
          }
          case 10: {
            const centre = (fa + fb + fc + fd) / 4 > level;
            if (centre) { addSeg(T, R); addSeg(B, L); } else { addSeg(T, L); addSeg(R, B); }
            break;
          }
        }
      }
    }
    const used = new Uint8Array(segA.length);
    const loops = [];
    for (let s0 = 0; s0 < segA.length; s0++) {
      if (used[s0]) continue;
      const loop = [];
      let s = s0, e = segA[s0];
      while (s >= 0 && !used[s]) {
        used[s] = 1;
        loop.push(edgePoint(e));
        e = segA[s] === e ? segB[s] : segA[s];
        s = seg1[e] === s ? seg2[e] : seg1[e];
      }
      if (loop.length >= 3) loops.push(loop);
    }
    return loops;
  }

  function polygonArea(pts) {
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
    return a / 2;
  }

  function polylineLength(pts, closed) {
    let l = 0;
    for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (closed && pts.length > 1) l += Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
    return l;
  }

  // Ramer–Douglas–Peucker simplification of an open polyline.
  function simplifyOpen(pts, tol) {
    if (pts.length < 3 || tol <= 0) return pts.slice();
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    const t2 = tol * tol;
    while (stack.length) {
      const [a, b] = stack.pop();
      const ax = pts[a][0], ay = pts[a][1], dx = pts[b][0] - ax, dy = pts[b][1] - ay;
      const len2 = dx * dx + dy * dy;
      let best = -1, bestD = t2;
      for (let i = a + 1; i < b; i++) {
        let px = pts[i][0] - ax, py = pts[i][1] - ay, d;
        if (len2 === 0) d = px * px + py * py;
        else {
          const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
          px -= t * dx; py -= t * dy; d = px * px + py * py;
        }
        if (d > bestD) { bestD = d; best = i; }
      }
      if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  // Simplify a closed loop: split at the point farthest from the first point.
  function simplifyClosed(pts, tol) {
    if (pts.length < 4 || tol <= 0) return pts.slice();
    let far = 0, fd = -1;
    for (let i = 1; i < pts.length; i++) {
      const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
      if (d > fd) { fd = d; far = i; }
    }
    const a = simplifyOpen(pts.slice(0, far + 1), tol);
    const b = simplifyOpen(pts.slice(far).concat([pts[0]]), tol);
    const out = a.concat(b.slice(1, -1));
    return out.length >= 3 ? out : pts.slice();
  }

  // Even-odd scanline intersection of polygons (loops, any orientation) with
  // horizontal lines y = y0 + k*spacing after rotating everything by -angle.
  // Returns rows: [{y, segs:[[x0,x1],...]}] in the rotated frame, plus the rotation helpers.
  function scanlines(loops, angleDeg, spacing, phase) {
    const a = (angleDeg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    const rot = (p) => [p[0] * ca + p[1] * sa, -p[0] * sa + p[1] * ca];
    const unrot = (x, y) => [x * ca - y * sa, x * sa + y * ca];
    const edges = [];
    let ymin = INF, ymax = -INF;
    for (const loop of loops) {
      const r = loop.map(rot);
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const p = r[j], q = r[i];
        if (p[1] === q[1]) continue;
        const lo = p[1] < q[1] ? p : q, hi = p[1] < q[1] ? q : p;
        edges.push([lo[1], hi[1], lo[0], (hi[0] - lo[0]) / (hi[1] - lo[1])]);
        ymin = Math.min(ymin, lo[1]); ymax = Math.max(ymax, hi[1]);
      }
    }
    const rows = [];
    if (!edges.length) return { rows, unrot };
    edges.sort((e1, e2) => e1[0] - e2[0]);
    const start = Math.floor((ymin - (phase || 0)) / spacing) * spacing + (phase || 0) + spacing / 2;
    let active = [], ei = 0;
    for (let y = start; y < ymax; y += spacing) {
      while (ei < edges.length && edges[ei][0] <= y) active.push(edges[ei++]);
      active = active.filter((e) => e[1] > y);
      const xs = [];
      for (const e of active) if (y >= e[0] && y < e[1]) xs.push(e[2] + (y - e[0]) * e[3]);
      xs.sort((u, v) => u - v);
      const segs = [];
      for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 1e-6) segs.push([xs[i], xs[i + 1]]);
      if (segs.length) rows.push({ y, segs });
    }
    return { rows, unrot };
  }

  DH.geom = {
    edt2d, signedDistance, boxBlur, gaussianBlur, isoContours,
    polygonArea, polylineLength, simplifyOpen, simplifyClosed, scanlines,
  };
})(globalThis.DH = globalThis.DH || {});
