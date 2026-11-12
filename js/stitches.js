// Signed distance field of one level → embroidery-like toolpaths (mm, bed frame).
// Path: {pts: [[x,y],...], closed: bool, type: "Outline"|"Satin"|"Tatami"|"Contour"|"Running"}
(function (DH) {
  "use strict";
  const G = DH.geom;

  const PATTERNS = {
    satin: { label: "Satin", outline: false, fill: "satin" },
    tatami: { label: "Fill / tatami", outline: false, fill: "tatami" },
    contour: { label: "Contour", outline: false, fill: "contour" },
    running: { label: "Running stitch", outline: true, fill: null },
    outline_fill: { label: "Outline + fill", outline: true, fill: "choice" },
    dots: { label: "Dots (pointillism)", outline: false, fill: "dots" },
  };

  function rng(seed) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }

  // Pointillism: single dots of extruded plastic. Each dot is a one-point
  // path {pts:[[x,y]], type:"Dot", d} in design mm.
  //   grid / hex: dots on a regular grid (rotated by st.angle); with tones on,
  //               dot size follows the picture's darkness (halftone).
  //   scatter:    random dots that keep their distance (Poisson disk); with
  //               tones on, they bunch up in dark areas (stippling).
  // Positions don't depend on the layer, so dots stack into columns.
  function dots(field, st) {
    const { sdf, w: W, h: H, p, tone } = field;
    const d0 = Math.max(0.1, st.dotSize), s0 = Math.max(d0 * 0.5, st.dotSpacing);
    const at = (arr, x, y) => {
      const i = Math.round(x / p - 0.5), j = Math.round(H - y / p - 0.5);
      return i < 0 || j < 0 || i >= W || j >= H ? null : arr[j * W + i];
    };
    const dark = (x, y) => { const g = tone ? at(tone, x, y) : null; return g === null ? 1 : 1 - g; };
    // A dot fits if its centre is at least a quarter of its diameter inside the
    // outline, so thin shapes still get dots (a blob may bulge out slightly).
    const fits = (x, y, d) => { const v = at(sdf, x, y); return v !== null && v >= d / 4; };
    const out = [];
    const Wmm = W * p, Hmm = H * p;
    // How each dot is printed (read by the G-code writer).
    const dot = { h: st.dotHeight, flow: st.dotFlow, dwell: st.dotDwell, retract: st.dotRetract, lift: st.dotLift };

    if (st.dotLayout === "scatter") {
      const rand = rng(1234567);
      const rOf = (x, y) => (st.dotTone ? s0 * (0.65 + 1.6 * (1 - dark(x, y))) : s0);
      const rMin = st.dotTone ? s0 * 0.65 : s0, rMax = st.dotTone ? s0 * 2.25 : s0;
      const cell = rMin / Math.SQRT2, gw = Math.ceil(Wmm / cell) + 1, gh = Math.ceil(Hmm / cell) + 1;
      const grid = new Int32Array(gw * gh).fill(-1);
      const pts = [];
      const reach = Math.ceil(rMax / cell);
      const tries = Math.min(600000, Math.ceil(((Wmm * Hmm) / (rMin * rMin)) * 4));
      for (let t = 0; t < tries; t++) {
        const x = rand() * Wmm, y = rand() * Hmm;
        if (!fits(x, y, d0)) continue;
        const r = rOf(x, y), gx = Math.floor(x / cell), gy = Math.floor(y / cell);
        let ok = true;
        for (let yy = Math.max(0, gy - reach); ok && yy <= Math.min(gh - 1, gy + reach); yy++) {
          for (let xx = Math.max(0, gx - reach); xx <= Math.min(gw - 1, gx + reach); xx++) {
            const k = grid[yy * gw + xx];
            if (k >= 0 && Math.hypot(pts[k][0] - x, pts[k][1] - y) < r) { ok = false; break; }
          }
        }
        if (!ok) continue;
        if (grid[gy * gw + gx] >= 0) continue; // cell already taken (cell < rMin, so rare)
        grid[gy * gw + gx] = pts.length;
        pts.push([x, y]);
      }
      // Serpentine order in bands one spacing tall: short travels, no sorting later.
      const band = (q) => Math.floor(q[1] / s0);
      pts.sort((a, b) => band(a) - band(b) || (band(a) % 2 ? b[0] - a[0] : a[0] - b[0]));
      for (const q of pts) out.push({ pts: [q], closed: false, type: "Dot", d: d0, dot, keepOrder: true });
      return out;
    }

    // grid or hex, rotated about the design centre
    const a = ((st.angle || 0) * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    const cx = Wmm / 2, cy = Hmm / 2, R = Math.hypot(Wmm, Hmm) / 2 + s0;
    const hex = st.dotLayout === "hex";
    const rowStep = hex ? (s0 * Math.sqrt(3)) / 2 : s0;
    let row = 0;
    for (let v = -R; v <= R; v += rowStep, row++) {
      const shift = hex && row % 2 ? s0 / 2 : 0;
      const line = [];
      for (let u = -R + shift; u <= R; u += s0) {
        const x = cx + u * ca - v * sa, y = cy + u * sa + v * ca;
        const d = st.dotTone ? d0 * (0.35 + 0.65 * dark(x, y)) : d0;
        if (st.dotTone && d < d0 * 0.4) continue; // lightest areas stay bare
        if (fits(x, y, d)) line.push({ pts: [[x, y]], closed: false, type: "Dot", d, dot, keepOrder: true });
      }
      if (row % 2) line.reverse();
      out.push(...line);
    }
    return out;
  }

  // Contours of the field at `depth` mm inside the outline, in bed coordinates
  // relative to the design's bottom-left corner.
  function contoursAt(field, depth, tol, minLen) {
    const { sdf, w, h, p } = field;
    const loops = G.isoContours(sdf, w, h, depth);
    const out = [];
    for (const loop of loops) {
      const mm = loop.map(([x, y]) => [(x + 0.5) * p, (h - (y + 0.5)) * p]);
      const s = G.simplifyClosed(mm, tol);
      if (s.length >= 3 && G.polylineLength(s, true) >= minLen) out.push(s);
    }
    return out;
  }

  // Group scanline segments into vertical "columns": runs of segments on
  // consecutive rows that overlap each other.
  function chains(rows, spacing) {
    const used = rows.map((r) => new Uint8Array(r.segs.length));
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      for (let j = 0; j < rows[i].segs.length; j++) {
        if (used[i][j]) continue;
        used[i][j] = 1;
        const chain = [{ y: rows[i].y, a: rows[i].segs[j][0], b: rows[i].segs[j][1] }];
        let r = i, cur = rows[i].segs[j];
        while (r + 1 < rows.length && rows[r + 1].y - rows[r].y < spacing * 1.5) {
          const next = rows[r + 1];
          let k = -1;
          for (let m = 0; m < next.segs.length; m++) {
            if (!used[r + 1][m] && Math.max(cur[0], next.segs[m][0]) < Math.min(cur[1], next.segs[m][1])) { k = m; break; }
          }
          if (k < 0) break;
          used[r + 1][k] = 1;
          cur = next.segs[k];
          chain.push({ y: next.y, a: cur[0], b: cur[1] });
          r++;
        }
        out.push(chain);
      }
    }
    return out;
  }

  function tatami(loops, angle, spacing, lineWidth) {
    const { rows, unrot } = G.scanlines(loops, angle, spacing, 0);
    const paths = [];
    const maxJump = Math.max(2 * spacing, 1.5 * lineWidth);
    for (const chain of chains(rows, spacing)) {
      let cur = [];
      chain.forEach((s, m) => {
        const fwd = m % 2 === 0;
        const p0 = fwd ? [s.a, s.y] : [s.b, s.y], p1 = fwd ? [s.b, s.y] : [s.a, s.y];
        if (cur.length && Math.abs(cur[cur.length - 1][0] - p0[0]) > maxJump) {
          paths.push(cur); cur = [];
        }
        cur.push(p0, p1);
      });
      if (cur.length) paths.push(cur);
    }
    return paths.map((pts) => ({ pts: pts.map(([x, y]) => unrot(x, y)), closed: false, type: "Tatami" }));
  }

  // Satin: a zigzag whose points sit `spacing` apart along each edge of the
  // shape, so strokes touch at the edges and overlap in the middle.
  function satin(loops, angle, spacing, lineWidth) {
    const step = spacing / 2;
    const { rows, unrot } = G.scanlines(loops, angle, step, 0);
    const paths = [];
    const maxJump = Math.max(1, 4 * lineWidth);
    for (const chain of chains(rows, step)) {
      // Zigzag: left edge of row 0 → right edge of row 1 → left edge of row 2 …
      let cur = [], prev = null;
      const flush = () => {
        if (cur.length > 1) paths.push(cur);
        else if (cur.length === 1 && prev) paths.push([[prev.a, prev.y], [prev.b, prev.y]]);
        cur = [];
      };
      chain.forEach((s) => {
        if (prev && (Math.abs(s.a - prev.a) > maxJump || Math.abs(s.b - prev.b) > maxJump)) flush();
        cur.push(cur.length % 2 === 1 ? [s.b, s.y] : [s.a, s.y]);
        prev = s;
      });
      flush();
    }
    return paths.map((pts) => ({ pts: pts.map(([x, y]) => unrot(x, y)), closed: false, type: "Satin" }));
  }

  function dash(loop, dashLen, gapLen) {
    const out = [];
    const pts = loop.concat([loop[0]]);
    let cur = [pts[0]], on = true, left = dashLen;
    for (let i = 1; i < pts.length; i++) {
      let [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      let segLen = Math.hypot(x1 - x0, y1 - y0);
      while (segLen > left) {
        const t = left / segLen;
        x0 += (x1 - x0) * t; y0 += (y1 - y0) * t; segLen -= left;
        if (on) { cur.push([x0, y0]); out.push(cur); cur = []; left = gapLen; }
        else { cur = [[x0, y0]]; left = dashLen; }
        on = !on;
      }
      left -= segLen;
      if (on) cur.push([x1, y1]);
    }
    if (on && cur.length > 1) out.push(cur);
    return out;
  }

  // st: {pattern, fill, angle, spacing, outlinePasses, dashed, dashLen, gapLen}
  // print: {lineWidth, simplify}
  function pathsForLayer(field, st, print, layerAngle) {
    const w = print.lineWidth, tol = print.simplify, minLen = w * 1.5;
    const pat = PATTERNS[st.pattern] || PATTERNS.tatami;
    const passes = pat.outline ? Math.max(1, st.outlinePasses) : 0;
    const fillKind = pat.fill === "choice" ? st.fill : pat.fill;
    if (fillKind === "dots") return dots(field, st);
    const paths = [];
    for (let i = 0; i < passes; i++) {
      for (const loop of contoursAt(field, (i + 0.5) * w, tol, minLen)) {
        if (st.pattern === "running" && st.dashed) {
          for (const d of dash(loop, st.dashLen, st.gapLen)) paths.push({ pts: d, closed: false, type: "Running" });
        } else paths.push({ pts: loop, closed: true, type: st.pattern === "running" ? "Running" : "Outline" });
      }
    }
    if (!fillKind) return paths;
    const spacing = Math.max(0.05, st.spacing);
    const inset = passes * w;
    if (fillKind === "contour") {
      for (let d = inset + w / 2, guard = 0; guard < 2000; d += spacing, guard++) {
        const loops = contoursAt(field, d, tol, minLen);
        if (!loops.length) break;
        for (const loop of loops) paths.push({ pts: loop, closed: true, type: "Contour" });
      }
      return paths;
    }
    // Line ends sit half a line inside the region, overlapping the outline by 15%.
    const fillDepth = inset + w / 2 - (passes ? 0.15 * w : 0);
    const region = contoursAt(field, fillDepth, tol, 0);
    if (!region.length) return paths;
    const angle = st.angle + layerAngle;
    const fill = fillKind === "satin" ? satin(region, angle, spacing, w) : tatami(region, angle, spacing, w);
    return paths.concat(fill);
  }

  DH.stitches = { PATTERNS, pathsForLayer, contoursAt, dash, dots };
})(globalThis.DH = globalThis.DH || {});
