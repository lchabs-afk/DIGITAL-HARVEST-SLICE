// Procedural stand-in for a pressed UV texture: a fern frond and a small leaf,
// mottled like a photogrammetry texture. Used until the user loads their own.
(function (DH) {
  "use strict";
  function rng(seed) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }

  function sampleCanvas() {
    const W = 900, H = 640;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const g = c.getContext("2d");
    const r = rng(7);
    g.fillStyle = "#f4f2ec"; g.fillRect(0, 0, W, H);

    // Fern frond along a gentle curve.
    const stem = (t) => [90 + t * 560, 470 - Math.sin(t * 2.4) * 150 - t * 60];
    const pinnae = 15;
    for (let i = 0; i < pinnae; i++) {
      const t = 0.06 + (i / pinnae) * 0.9;
      const [x, y] = stem(t), [x2, y2] = stem(t + 0.01);
      const ang = Math.atan2(y2 - y, x2 - x);
      const len = 120 * (1 - t * 0.75), wid = 26 * (1 - t * 0.6);
      for (const side of [-1, 1]) {
        g.save();
        g.translate(x, y);
        g.rotate(ang + side * (1.05 - t * 0.3));
        const grad = g.createLinearGradient(0, 0, len, 0);
        grad.addColorStop(0, "#16240f"); grad.addColorStop(0.55, "#2c4420"); grad.addColorStop(1, "#7f9a55");
        g.fillStyle = grad;
        g.beginPath();
        g.ellipse(len / 2, 0, len / 2, wid / 2, 0, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = "rgba(220,230,190,0.55)"; g.lineWidth = 2.2;
        g.beginPath(); g.moveTo(4, 0); g.lineTo(len * 0.92, 0); g.stroke();
        g.restore();
      }
    }
    g.strokeStyle = "#5d6b3a"; g.lineWidth = 7; g.lineCap = "round";
    g.beginPath();
    for (let t = 0; t <= 1.0001; t += 0.02) { const [x, y] = stem(t); t === 0 ? g.moveTo(x, y) : g.lineTo(x, y); }
    g.stroke();

    // A separate leaf island, as UV maps often have.
    g.save();
    g.translate(735, 170); g.rotate(-0.5);
    const lg = g.createRadialGradient(0, 0, 10, 0, 0, 120);
    lg.addColorStop(0, "#1e1c0c"); lg.addColorStop(0.5, "#4a4420"); lg.addColorStop(1, "#a8975a");
    g.fillStyle = lg;
    g.beginPath(); g.ellipse(0, 0, 120, 58, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "rgba(240,232,200,0.6)"; g.lineWidth = 3;
    g.beginPath(); g.moveTo(-110, 0); g.lineTo(110, 0); g.stroke();
    for (let k = -3; k <= 3; k++) { g.beginPath(); g.moveTo(k * 28, 0); g.lineTo(k * 28 + 34, -44 + Math.abs(k) * 6); g.moveTo(k * 28, 0); g.lineTo(k * 28 + 34, 44 - Math.abs(k) * 6); g.stroke(); }
    g.restore();

    // Mottling noise.
    const img = g.getImageData(0, 0, W, H), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 235 && d[i + 1] > 235) continue;
      const n = (r() - 0.5) * 34;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
    return c;
  }
  DH.sampleCanvas = sampleCanvas;
})(globalThis.DH = globalThis.DH || {});
