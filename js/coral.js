// Coral: differential growth of one polyline per shape.
//
// Each shape gets a short seed line at its deepest point. Every step, each
// point is pulled towards its two neighbours (keeps the line smooth), pushed
// away from every other point closer than the separation radius (makes it
// fold), nudged by a little noise, and kept inside the shape. When two
// neighbours drift further apart than the growth edge length, a new point is
// inserted between them, so the line lengthens and folds to fill the shape.
// The picture's darkness makes growth denser: dark areas use the minimum
// separation and grow fast; light areas use up to 1.8× the separation and
// grow slowly.
//
// While growing, points sit at most half a separation apart and never move more
// than a third of an edge per step, so repulsion between points also keeps the
// segments apart and the line cannot cross itself. When growth ends, each line
// is resampled at the knot spacing and every Nth point is marked as a knot.
(function (DH) {
  "use strict";

  function rng(seed) {
    let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
    return () => ((s = (s * 16807) % 2147483647) / 2147483647);
  }

  // Bilinear sampling of a raster stored top row first, in design mm (y up).
  function sampler(arr, W, H, p, outside) {
    return (x, y) => {
      const fx = x / p - 0.5, fy = H - y / p - 0.5;
      if (fx < 0 || fy < 0 || fx > W - 1 || fy > H - 1) return outside;
      const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
      const i1 = Math.min(W - 1, i + 1), j1 = Math.min(H - 1, j + 1);
      return (arr[j * W + i] * (1 - u) + arr[j * W + i1] * u) * (1 - v) + (arr[j1 * W + i] * (1 - u) + arr[j1 * W + i1] * u) * v;
    };
  }

  // Do segments ab and cd properly cross?
  function crosses(a, b, c, d) {
    const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
  }

  // o: {knotSize, knotSpacing, minSep, steps, seed, tone (bool), knotEvery}
  function grower(field, o) {
    const { sdf, w: W, h: H, p } = field;
    const Wmm = W * p, Hmm = H * p;
    const dist = sampler(sdf, W, H, p, -1e9);
    const toneAt = field.tone && o.tone ? sampler(field.tone, W, H, p, 1) : null;
    const darkAt = (x, y) => (toneAt ? 1 - Math.min(1, Math.max(0, toneAt(x, y))) : 1);
    const margin = Math.max(o.knotSize / 2, p);           // knot centres stay this far inside
    const sep = Math.max(o.minSep, o.knotSize * 0.5);     // minimum spacing between line parts
    const E = Math.min(o.knotSpacing, sep * 0.45);        // growth edge length
    const rMax = toneAt ? sep * 1.8 : sep;
    const rand = rng(o.seed || 1);
    const maxNodes = o.maxNodes || 60000;
    const grad = (x, y) => {
      const e = p;
      const gx = dist(x + e, y) - dist(x - e, y), gy = dist(x, y + e) - dist(x, y - e);
      const l = Math.hypot(gx, gy) || 1;
      return [gx / l, gy / l];
    };

    // Seeds: one per connected shape deep enough to hold a knot.
    const lines = [];
    {
      const seen = new Uint8Array(W * H), stack = new Int32Array(W * H);
      const minArea = Math.max(4 * E * E, Math.PI * margin * margin) / (p * p);
      for (let s0 = 0; s0 < W * H; s0++) {
        if (seen[s0] || !(sdf[s0] > margin)) continue;
        let top = 0, n = 0, best = s0;
        stack[top++] = s0; seen[s0] = 1;
        while (top) {
          const i = stack[--top]; n++;
          if (sdf[i] > sdf[best]) best = i;
          const x = i % W, y = (i / W) | 0;
          const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
          for (const q of nb) if (q >= 0 && !seen[q] && sdf[q] > margin) { seen[q] = 1; stack[top++] = q; }
        }
        if (n < minArea) continue;
        const cx = ((best % W) + 0.5) * p, cy = (H - (((best / W) | 0) + 0.5)) * p;
        for (let t = 0; t < 12; t++) {
          const a = rand() * Math.PI * 2, dx = Math.cos(a) * E, dy = Math.sin(a) * E;
          const seed = [[cx - dx, cy - dy], [cx, cy], [cx + dx, cy + dy]];
          if (seed.every(([x, y]) => dist(x, y) >= margin)) { lines.push(seed); break; }
        }
      }
    }

    let stepCount = 0;
    const gw = Math.max(1, Math.ceil(Wmm / rMax) + 1), gh = Math.max(1, Math.ceil(Hmm / rMax) + 1);

    // Points never come closer than `hard` to any point that isn't their direct
    // neighbour. Segments are at most E long, and two such segments can only
    // cross if two of their endpoints are within E/√2, so with hard = 0.8·E
    // the line can never cross itself.
    const hard = 0.8 * E;
    const maxEdge = 1.1 * E;   // keeps hard > maxEdge/√2, so the argument above holds
    // Parts of the line that are far apart along it must also stay this far apart
    // (the minimum spacing between neighbouring segments, with a little slack).
    const farHard = 0.8 * sep;
    const farSkip = Math.ceil((sep * 1.6) / E) + 1;

    function iterate() {
      let total = 0;
      for (const L of lines) total += L.length;
      const X = new Float64Array(total), Y = new Float64Array(total), owner = new Int32Array(total), idx = new Int32Array(total);
      let t = 0;
      lines.forEach((L, li) => L.forEach(([x, y], i) => { X[t] = x; Y[t] = y; owner[t] = li; idx[t] = i; t++; }));
      // spatial hash (linked lists per cell); positions are updated in place and
      // move at most E/3 per step, so the ±1-cell search still finds every point
      // within `hard`.
      const head = new Int32Array(gw * gh).fill(-1), next = new Int32Array(total);
      const cellX = (x) => Math.min(gw - 1, Math.max(0, Math.floor(x / rMax))), cellY = (y) => Math.min(gh - 1, Math.max(0, Math.floor(y / rMax)));
      for (let k = 0; k < total; k++) { const c = cellY(Y[k]) * gw + cellX(X[k]); next[k] = head[c]; head[c] = k; }
      // Visit points near (x, y), skipping those within `skip` steps along the same line.
      const near = (x, y, li, i, fn, skip = 1) => {
        const gx = cellX(x), gy = cellY(y);
        for (let yy = Math.max(0, gy - 1); yy <= Math.min(gh - 1, gy + 1); yy++)
          for (let xx = Math.max(0, gx - 1); xx <= Math.min(gw - 1, gx + 1); xx++)
            for (let q = head[yy * gw + xx]; q >= 0; q = next[q]) {
              if (owner[q] === li && Math.abs(idx[q] - i) <= skip) continue;
              if (fn(q) === false) return false;
            }
        return true;
      };
      const R = new Float64Array(total), dark = new Float64Array(total);
      let base = 0;
      for (let li = 0; li < lines.length; li++) {
        const n = lines[li].length;
        for (let i = 0; i < n; i++) {
          const k = base + i, x = X[k], y = Y[k];
          const dk = darkAt(x, y);
          dark[k] = dk;
          const r = toneAt ? sep * (1 + 0.8 * (1 - dk)) : sep;
          R[k] = r;
          let fx = 0, fy = 0;
          // attraction: towards the neighbours' midpoint, or to rest length at the ends
          if (i > 0 && i < n - 1) {
            fx += ((X[k - 1] + X[k + 1]) / 2 - x) * 0.25; fy += ((Y[k - 1] + Y[k + 1]) / 2 - y) * 0.25;
          } else if (n > 1) {
            const m = i === 0 ? k + 1 : k - 1, dx = X[m] - x, dy = Y[m] - y, d = Math.hypot(dx, dy) || 1;
            if (d > E) { fx += (dx / d) * (d - E) * 0.5; fy += (dy / d) * (d - E) * 0.5; }
          }
          // repulsion from every other nearby point except the direct neighbours
          let rx = 0, ry = 0;
          near(x, y, li, i, (q) => {
            if (q === k) return;
            const dx = x - X[q], dy = y - Y[q], d = Math.hypot(dx, dy);
            if (d >= r || d < 1e-9) return;
            const f = (r - d) / r;
            rx += (dx / d) * f; ry += (dy / d) * f;
          });
          fx += rx * E; fy += ry * E;
          // a little noise keeps the folding irregular
          fx += (rand() - 0.5) * E * 0.05; fy += (rand() - 0.5) * E * 0.05;
          const m = Math.hypot(fx, fy), cap = E * 0.33;
          if (m > cap) { fx *= cap / m; fy *= cap / m; }
          let nx = x + fx, ny = y + fy;
          // stay inside the shape: project back along the distance gradient
          let s = dist(nx, ny);
          if (s < margin) {
            const [ux, uy] = grad(nx, ny);
            nx += ux * (margin - s); ny += uy * (margin - s);
            s = dist(nx, ny);
            if (s < margin - p * 0.25) continue; // can't place it: stay put
          }
          // hard rules: no edge longer than maxEdge, no point within `hard` of a
          // non-neighbour, and no point within farHard of a far part of the line
          if (i > 0 && Math.hypot(nx - X[k - 1], ny - Y[k - 1]) > maxEdge) continue;
          if (i < n - 1 && Math.hypot(nx - X[k + 1], ny - Y[k + 1]) > maxEdge) continue;
          const okMove = near(nx, ny, li, i, (q) => {
            if (q === k) return;
            const d = Math.hypot(nx - X[q], ny - Y[q]);
            const farAlong = owner[q] !== li || Math.abs(idx[q] - i) > farSkip;
            if (d < hard) return false;
            // far parts: never closer than farHard, but a pair that is already too
            // close (it became "far" as points were inserted) may still move apart
            if (farAlong && d < farHard && d < Math.hypot(x - X[q], y - Y[q])) return false;
            // the moved point's two edges must not cross the segment q → q+1
            const q2 = q + 1;
            if (q2 < total && owner[q2] === owner[q]) {
              const A = [X[q], Y[q]], B = [X[q2], Y[q2]], P = [nx, ny];
              if (i > 0 && q !== k - 1 && q2 !== k - 1 && q2 !== k && crosses([X[k - 1], Y[k - 1]], P, A, B)) return false;
              if (i < n - 1 && q !== k + 1 && q2 !== k && q !== k && crosses(P, [X[k + 1], Y[k + 1]], A, B)) return false;
            }
          });
          // the neighbours are skipped above, so check the Z-shaped folds explicitly:
          // edge (k-1,k) against segment (k+1,k+2), and edge (k,k+1) against (k-2,k-1)
          const P = [nx, ny];
          const zFold = (i > 0 && i + 2 < n && crosses([X[k - 1], Y[k - 1]], P, [X[k + 1], Y[k + 1]], [X[k + 2], Y[k + 2]]))
            || (i > 1 && i + 1 < n && crosses(P, [X[k + 1], Y[k + 1]], [X[k - 2], Y[k - 2]], [X[k - 1], Y[k - 1]]));
          if (okMove && !zFold) { X[k] = nx; Y[k] = ny; }
        }
        base += n;
      }
      // grow: insert a point where neighbours drifted apart and there is room
      base = 0;
      let count = total;
      for (let li = 0; li < lines.length; li++) {
        const n = lines[li].length, out = [];
        for (let i = 0; i < n; i++) {
          const k = base + i;
          out.push([X[k], Y[k]]);
          if (i === n - 1 || count >= maxNodes) continue;
          const k2 = k + 1, d = Math.hypot(X[k2] - X[k], Y[k2] - Y[k]);
          if (d <= 0.85 * E) continue;
          const pIns = toneAt ? 0.1 + 0.9 * ((dark[k] + dark[k2]) / 2) ** 1.5 : 1;
          if (rand() >= pIns) continue;
          const mx = (X[k] + X[k2]) / 2, my = (Y[k] + Y[k2]) / 2, room = Math.min(R[k], R[k2]) * 0.85;
          if (dist(mx, my) < margin) continue;
          // room: no other part of the line within the local separation (points just
          // along the line from here don't count: they are part of the same stretch)
          const reach = Math.min(room, rMax), skip = Math.ceil((reach * 1.6) / E) + 1;
          const free = near(mx, my, li, i + 0.5, (q) => (Math.hypot(mx - X[q], my - Y[q]) >= reach ? undefined : false), skip)
            && near(mx, my, li, i + 0.5, (q) => (Math.hypot(mx - X[q], my - Y[q]) >= hard ? undefined : false));
          if (free) { out.push([mx, my]); count++; }
        }
        lines[li] = out;
        base += n;
      }
      stepCount++;
    }

    // Resample at the knot spacing; every Nth point (and the last) is a knot.
    function resample(L, D) {
      const out = [L[0]];
      let carry = 0;
      for (let i = 1; i < L.length; i++) {
        let [x0, y0] = L[i - 1];
        const [x1, y1] = L[i];
        let seg = Math.hypot(x1 - x0, y1 - y0);
        while (carry + seg >= D) {
          const t = (D - carry) / seg;
          x0 += (x1 - x0) * t; y0 += (y1 - y0) * t; seg -= D - carry; carry = 0;
          out.push([x0, y0]);
        }
        carry += seg;
      }
      const last = L[L.length - 1], tail = out[out.length - 1];
      if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > D * 0.3) out.push(last);
      return out;
    }

    return {
      get lines() { return lines; },
      get stepCount() { return stepCount; },
      get total() { return o.steps; },
      done: () => stepCount >= o.steps || !lines.length,
      step(n) { for (let i = 0; i < n && stepCount < o.steps && lines.length; i++) iterate(); },
      result() {
        const every = Math.max(1, Math.round(o.knotEvery || 1));
        return lines.map((L) => {
          const pts = resample(L, o.knotSpacing);
          const knots = pts.map((_, i) => (i % every === 0 || i === pts.length - 1 ? 1 : 0));
          return { pts, knots };
        });
      },
    };
  }

  // Count crossings between non-adjacent segments of the given open polylines.
  function crossings(lines) {
    const segs = [];
    lines.forEach((L, li) => { for (let i = 0; i + 1 < L.length; i++) segs.push([li, i, L[i], L[i + 1]]); });
    const cross = (a, b, c, d) => {
      const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
    };
    const cell = 2, map = new Map();
    segs.forEach((s, k) => {
      const x0 = Math.floor(Math.min(s[2][0], s[3][0]) / cell), x1 = Math.floor(Math.max(s[2][0], s[3][0]) / cell);
      const y0 = Math.floor(Math.min(s[2][1], s[3][1]) / cell), y1 = Math.floor(Math.max(s[2][1], s[3][1]) / cell);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const key = x + "," + y; (map.get(key) || map.set(key, []).get(key)).push(k); }
    });
    let n = 0;
    const seen = new Set();
    for (const list of map.values()) {
      for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
        const A = segs[list[a]], B = segs[list[b]];
        if (A[0] === B[0] && Math.abs(A[1] - B[1]) <= 1) continue;
        const key = list[a] < list[b] ? list[a] + ":" + list[b] : list[b] + ":" + list[a];
        if (seen.has(key)) continue;
        seen.add(key);
        if (cross(A[2], A[3], B[2], B[3])) n++;
      }
    }
    return n;
  }

  // Keep the parts of grown lines that lie inside another (smaller) field: used
  // for higher levels, so their knots land exactly on the knots below.
  function clip(grown, field, margin) {
    const dist = sampler(field.sdf, field.w, field.h, field.p, -1e9);
    const out = [];
    for (const g of grown) {
      let run = null;
      const flush = () => { if (run && run.pts.length > 1) out.push(run); run = null; };
      g.pts.forEach((q, i) => {
        if (dist(q[0], q[1]) >= margin) {
          if (!run) run = { pts: [], knots: [] };
          run.pts.push(q); run.knots.push(g.knots[i]);
        } else flush();
      });
      flush();
    }
    return out;
  }

  DH.coral = { grower, crossings, clip };
})(globalThis.DH = globalThis.DH || {});
