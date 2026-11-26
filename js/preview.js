// Canvas rendering for the three preview modes.
(function (DH) {
  "use strict";

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function setup(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const g = canvas.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g, w, h, dpr };
  }

  function fitImage(canvas, src, pad) {
    const { g, w, h } = setup(canvas);
    const s = Math.min((w - pad * 2) / src.width, (h - pad * 2) / src.height);
    const dw = src.width * s, dh = src.height * s;
    g.imageSmoothingEnabled = true;
    g.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  // Level map → small canvas, coloured by filament colour per level.
  // `removed` (optional) marks pixels the printability filter took away: red hatching.
  function levelCanvas(lv, w, h, colours, removed) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    const img = g.createImageData(w, h), d = img.data;
    const rgb = colours.map((col) => {
      const n = parseInt(col.hex.slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    });
    for (let i = 0; i < lv.length; i++) {
      const k = lv[i];
      if (removed && removed[i] && !k) {
        // red diagonal hatching, so it can't be mistaken for a red filament
        const x = i % w, y = (i / w) | 0, line = (x + y) % 8 < 4;
        d[i * 4] = line ? 214 : 245; d[i * 4 + 1] = line ? 40 : 205; d[i * 4 + 2] = line ? 40 : 205; d[i * 4 + 3] = 255;
        continue;
      }
      if (!k) continue;
      const [r, gg, b] = rgb[k - 1] || [0, 0, 0];
      d[i * 4] = r; d[i * 4 + 1] = gg; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  function layerHue(j, n) {
    const t = n > 1 ? j / (n - 1) : 0;
    return "hsl(" + Math.round(210 - t * 200) + " 65% 45%)";
  }

  // o: {bed:[w,h], exclude, box:[x0,y0,x1,y1], layers, current, showTravel, byLayer, colours, wholeBed, lineWidth}
  function toolpaths(canvas, o) {
    const { g, w, h, dpr } = setup(canvas);
    const pad = 18 * dpr;
    let vx0, vy0, vx1, vy1;
    if (o.wholeBed || (!o.layers.length && !o.fit)) { vx0 = 0; vy0 = 0; vx1 = o.bed[0]; vy1 = o.bed[1]; }
    else { const b = o.fit || o.box, m = 4; [vx0, vy0, vx1, vy1] = [b[0] - m, b[1] - m, b[2] + m, b[3] + m]; }
    const s = Math.min((w - 2 * pad) / (vx1 - vx0), (h - 2 * pad) / (vy1 - vy0));
    const ox = (w - (vx1 - vx0) * s) / 2 - vx0 * s, oy = (h + (vy1 - vy0) * s) / 2 + vy0 * s;
    const X = (x) => ox + x * s, Y = (y) => oy - y * s;
    const ink = css("--ink") || "#18201a", muted = css("--muted") || "#5b665d";

    // Bed outline, 10 mm grid, excluded zone.
    g.lineWidth = 1;
    g.strokeStyle = muted; g.globalAlpha = 0.18;
    g.beginPath();
    for (let x = 0; x <= o.bed[0]; x += 10) { g.moveTo(X(x), Y(0)); g.lineTo(X(x), Y(o.bed[1])); }
    for (let y = 0; y <= o.bed[1]; y += 10) { g.moveTo(X(0), Y(y)); g.lineTo(X(o.bed[0]), Y(y)); }
    g.stroke();
    g.globalAlpha = 0.7;
    g.strokeRect(X(0), Y(o.bed[1]), o.bed[0] * s, o.bed[1] * s);
    if (o.exclude) {
      const [a, b, c, d] = o.exclude;
      g.fillStyle = muted; g.globalAlpha = 0.18;
      g.fillRect(X(a), Y(d), (c - a) * s, (d - b) * s);
    }
    g.globalAlpha = 1;
    if (o.frame) {
      // Frame wall as a hatched band, and the nozzle keep-out line inside it.
      const R = (r) => [X(r[0]), Y(r[3]), (r[2] - r[0]) * s, (r[3] - r[1]) * s];
      g.save();
      g.beginPath();
      g.rect(...R(o.frame.outer)); g.rect(...R(o.frame.inner));
      g.clip("evenodd");
      g.strokeStyle = ink; g.globalAlpha = 0.35; g.lineWidth = 1;
      g.beginPath();
      const [ox, oy, ow, oh] = R(o.frame.outer), step = 6 * dpr;
      for (let k = -oh; k < ow; k += step) { g.moveTo(ox + k, oy + oh); g.lineTo(ox + k + oh, oy); }
      g.stroke();
      g.restore();
      g.strokeStyle = ink; g.lineWidth = 1; g.globalAlpha = 0.9;
      g.strokeRect(...R(o.frame.outer)); g.strokeRect(...R(o.frame.inner));
      g.setLineDash([2 * dpr, 3 * dpr]); g.globalAlpha = 0.7;
      g.strokeRect(...R(o.frame.safe));
      g.setLineDash([]); g.globalAlpha = 1;
    }
    if (o.box) {
      g.setLineDash([4 * dpr, 4 * dpr]); g.strokeStyle = muted; g.globalAlpha = 0.6;
      g.strokeRect(X(o.box[0]), Y(o.box[3]), (o.box[2] - o.box[0]) * s, (o.box[3] - o.box[1]) * s);
      g.setLineDash([]); g.globalAlpha = 1;
    }

    const lw = Math.max(0.7 * dpr, o.lineWidth * s * 0.9);
    const CORAL = DH.gcode ? DH.gcode.TYPES.indexOf("Coral") : -1;
    g.lineCap = "round"; g.lineJoin = "round";
    const n = o.layers.length;
    for (let j = 0; j < Math.min(o.current, n); j++) {
      const L = o.layers[j], mv = L.moves, isCur = j === o.current - 1;
      const col = o.byLayer ? layerHue(j, n) : (o.colours[L.colour] ? o.colours[L.colour].hex : ink);
      g.globalAlpha = isCur ? 1 : 0.35;
      g.strokeStyle = col; g.lineWidth = lw;
      // Extruded lines; coral thread is drawn thinner than normal lines.
      const strokeType = (wanted, width) => {
        g.lineWidth = width;
        g.beginPath();
        let lx = NaN, ly = NaN;
        for (let i = 0; i < mv.length; i += 5) {
          const t = mv[i + 4];
          if (t === 0 || (t === CORAL) !== wanted) continue;
          if (mv[i] !== lx || mv[i + 1] !== ly) g.moveTo(X(mv[i]), Y(mv[i + 1]));
          g.lineTo(X(mv[i + 2]), Y(mv[i + 3]));
          lx = mv[i + 2]; ly = mv[i + 3];
        }
        g.stroke();
      };
      strokeType(false, lw);
      strokeType(true, Math.max(0.6 * dpr, lw * 0.4));
      if (L.dots && L.dots.length) {
        g.fillStyle = col;
        g.beginPath();
        for (let i = 0; i < L.dots.length; i += 3) {
          const r = Math.max(0.6 * dpr, (L.dots[i + 2] / 2) * s);
          g.moveTo(X(L.dots[i]) + r, Y(L.dots[i + 1]));
          g.arc(X(L.dots[i]), Y(L.dots[i + 1]), r, 0, Math.PI * 2);
        }
        g.fill();
      }
      if (isCur && o.showTravel) {
        g.globalAlpha = 0.8; g.strokeStyle = ink; g.lineWidth = Math.max(0.6, 0.6 * dpr);
        g.setLineDash([3 * dpr, 3 * dpr]);
        g.beginPath();
        for (let i = 0; i < mv.length; i += 5) {
          if (mv[i + 4] !== 0) continue;
          g.moveTo(X(mv[i]), Y(mv[i + 1])); g.lineTo(X(mv[i + 2]), Y(mv[i + 3]));
        }
        g.stroke(); g.setLineDash([]);
      }
    }
    g.globalAlpha = 1;
    return { g, X, Y, s, dpr, lw };
  }

  // A frame of the coral growth animation: bed, layers already built (faint),
  // and the growing lines with their points.
  function growth(canvas, o) {
    const v = toolpaths(canvas, { ...o, layers: [], current: 0, fit: o.box, lineWidth: 0.4 });
    const { g, X, Y, dpr } = v;
    g.lineCap = "round"; g.lineJoin = "round";
    g.globalAlpha = 0.25;
    for (const U of o.under || []) {
      g.strokeStyle = U.colour; g.lineWidth = 1 * dpr;
      g.beginPath();
      for (const p of U.paths) p.pts.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
      g.stroke();
    }
    g.globalAlpha = 1;
    g.strokeStyle = o.colour; g.fillStyle = o.colour; g.lineWidth = 1.25 * dpr;
    for (const L of o.lines) {
      g.beginPath();
      L.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
      g.stroke();
    }
    g.beginPath();
    for (const L of o.lines) for (const [x, y] of L) { g.moveTo(X(x) + 1.4 * dpr, Y(y)); g.arc(X(x), Y(y), 1.4 * dpr, 0, Math.PI * 2); }
    g.fill();
  }

  // Halftone dots at their real size on a canvas of the design (wMm × hMm),
  // with dots the printability filter removed drawn in red.
  function dotsCanvas(dots, removed, wMm, hMm, colour) {
    const k = Math.min(2400 / Math.max(wMm, hMm), 20); // pixels per mm
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(wMm * k)); c.height = Math.max(1, Math.round(hMm * k));
    const g = c.getContext("2d");
    const draw = (list, fill) => {
      g.fillStyle = fill; g.beginPath();
      for (const q of list) { const r = Math.max(0.5, (q.d / 2) * k); g.moveTo(q.x * k + r, (hMm - q.y) * k); g.arc(q.x * k, (hMm - q.y) * k, r, 0, Math.PI * 2); }
      g.fill();
    };
    draw(dots, colour);
    draw(removed || [], "#d62828");
    return c;
  }

  // The dot calibration row on the bed: real-size dots, each numbered with its
  // intended diameter underneath.
  function calibration(canvas, o) {
    const v = toolpaths(canvas, { bed: o.bed, exclude: o.exclude, frame: o.frame, box: null, fit: o.box, layers: [], current: 0, lineWidth: 0.4 });
    const { g, X, Y, s, dpr } = v;
    const ink = css("--ink") || "#1d1d1c";
    g.fillStyle = o.colour;
    for (const c of o.row) { g.beginPath(); g.arc(X(c.x), Y(c.y), Math.max(1, (c.d / 2) * s), 0, Math.PI * 2); g.fill(); }
    g.fillStyle = ink; g.textAlign = "center"; g.textBaseline = "top";
    const fs = Math.max(10 * dpr, Math.min(16 * dpr, s * 1.1));
    for (const c of o.row) {
      g.font = `500 ${fs}px Haskoy, system-ui, sans-serif`;
      g.fillText(String(c.n), X(c.x), Y(c.y) + Math.max(8 * dpr, 1.6 * s));
      g.font = `400 ${fs * 0.8}px Haskoy, system-ui, sans-serif`;
      g.fillText(c.d.toFixed(2), X(c.x), Y(c.y) + Math.max(8 * dpr, 1.6 * s) + fs * 1.2);
    }
  }

  DH.preview = { fitImage, levelCanvas, toolpaths, dotsCanvas, calibration, growth, layerHue };
})(globalThis.DH = globalThis.DH || {});
