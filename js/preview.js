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
  function levelCanvas(lv, w, h, colours) {
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
    if (o.wholeBed || !o.layers.length) { vx0 = 0; vy0 = 0; vx1 = o.bed[0]; vy1 = o.bed[1]; }
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
    g.lineCap = "round"; g.lineJoin = "round";
    const n = o.layers.length;
    for (let j = 0; j < Math.min(o.current, n); j++) {
      const L = o.layers[j], mv = L.moves, isCur = j === o.current - 1;
      const col = o.byLayer ? layerHue(j, n) : (o.colours[L.colour] ? o.colours[L.colour].hex : ink);
      g.globalAlpha = isCur ? 1 : 0.35;
      g.strokeStyle = col; g.lineWidth = lw;
      g.beginPath();
      let lx = NaN, ly = NaN;
      for (let i = 0; i < mv.length; i += 5) {
        if (mv[i + 4] === 0) continue;
        if (mv[i] !== lx || mv[i + 1] !== ly) g.moveTo(X(mv[i]), Y(mv[i + 1]));
        g.lineTo(X(mv[i + 2]), Y(mv[i + 3]));
        lx = mv[i + 2]; ly = mv[i + 3];
      }
      g.stroke();
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
  }

  DH.preview = { fitImage, levelCanvas, toolpaths, layerHue };
})(globalThis.DH = globalThis.DH || {});
