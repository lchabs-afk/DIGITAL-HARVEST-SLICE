// node tests/run_tests.js — checks templates, geometry and G-code without a browser.
const path = require("path");
for (const f of ["profiles/printers.js", "profiles/materials.js", "js/template.js", "js/geometry.js", "js/raster.js", "js/turing.js", "js/printability.js", "js/stitches.js", "js/gcode.js"]) require(path.join(__dirname, "..", f));
const DH = globalThis.DH;
let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log("FAIL", msg); } else console.log("ok  ", msg); };

// Template engine basics
const T = DH.template;
ok(T.render("{if a > 1}big{elsif a == 1}one{else}small{endif}", { a: 1 }) === "one", "if/elsif/else");
ok(T.render("X{max(b[1], 3)/2}", { b: [1, 8] }) === "X4", "array index + max()");
ok(T.render('{if t=="PLA" && !f}y{endif}', { t: "PLA", f: false }) === "y", "string compare, &&, !");
ok(T.render("[n]", { n: [0.4] }) === "0.4", "legacy placeholder");

// Synthetic leaf image: dark ellipse with a light vein and a small speck.
function synth(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const nx = (x - w / 2) / (w * 0.4), ny = (y - h / 2) / (h * 0.3);
    let v = 255;
    if (nx * nx + ny * ny < 1) v = Math.abs(y - h / 2) < 3 ? 200 : 40 + 80 * (x / w);
    if (Math.hypot(x - 10, y - 10) < 1.5) v = 0; // speck
    const i = (y * w + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}
const grid = DH.raster.gridFor(60, 40);
const base = DH.raster.toGray(synth(grid.w, grid.h));
// ---- Turing patterns (JavaScript backend; the app uses the GPU when it can)
const TU = DH.turing;
const flat = (w, h) => new Float32Array(w * h).fill(0.5);
const measure = (V, w, h) => {
  let top = 1e-4; for (const v of V) top = Math.max(top, v);
  const on = (i) => V[i] / top > 0.5;
  let cov = 0; for (let i = 0; i < w * h; i++) cov += on(i);
  const seen = new Uint8Array(w * h); let pieces = 0;
  for (let s0 = 0; s0 < w * h; s0++) {
    if (seen[s0] || !on(s0)) continue; pieces++;
    const st = [s0]; seen[s0] = 1;
    while (st.length) { const i = st.pop(), x = i % w, y = (i / w) | 0;
      for (const q of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (q >= 0 && !seen[q] && on(q)) { seen[q] = 1; st.push(q); } }
  }
  return { coverage: cov / (w * h), pieces };
};
{
  const w = 80, h = 80, res = {};
  for (const [name, pr] of Object.entries(TU.PRESETS)) {
    const sim = TU.createSim({ w, h, dark: flat(w, h), F: pr.F, k: pr.k, influence: 0, seed: 1, backend: "cpu" });
    sim.step(4000);
    res[name] = measure(sim.read(), w, h);
  }
  const fmt = (r) => `${Math.round(r.coverage * 100)}% / ${r.pieces}`;
  // spots: many separate dots about 16 cells apart (80 × 80 cells → roughly 25)
  ok(res.spots.pieces >= 12 && res.spots.pieces <= 45 && res.spots.coverage < 0.35, `turing spots: ${fmt(res.spots)} (coverage / pieces)`);
  ok(res.maze.coverage > 0.3 && res.maze.coverage < 0.7 && res.maze.pieces < 15, `turing maze: ${fmt(res.maze)}`);
  ok(res.coral.coverage > 0.3 && res.coral.coverage < 0.7, `turing coral: ${fmt(res.coral)}`);
  ok(res.stripes.coverage > 0.25 && res.stripes.coverage < 0.6 && res.stripes.pieces > res.maze.pieces, `turing stripes: ${fmt(res.stripes)}`);

  // the image steers it: left half dark, right half light, full influence
  const dark = new Float32Array(w * h).map((_, i) => (i % w < w / 2 ? 0.9 : 0.1));
  const sim = TU.createSim({ w, h, dark, F: TU.PRESETS.maze.F, k: TU.PRESETS.maze.k, influence: 1, seed: 1, backend: "cpu" });
  sim.step(4000);
  const V = sim.read(); let top = 1e-4; for (const v of V) top = Math.max(top, v);
  let L = 0, R = 0; for (let i = 0; i < w * h; i++) if (V[i] / top > 0.5) (i % w < w / 2 ? L++ : R++);
  ok(L > R * 1.5, `turing image influence: dark half ${Math.round((L / (w * h / 2)) * 100)}% printed, light half ${Math.round((R / (w * h / 2)) * 100)}%`);

  // same seed → same pattern; another seed → another pattern
  const run = (seed) => { const s = TU.createSim({ w: 40, h: 40, dark: flat(40, 40), F: 0.029, k: 0.057, influence: 0, seed, backend: "cpu" }); s.step(800); return s.read(); };
  const a = run(5), b = run(5), c = run(6);
  ok(a.every((v, i) => v === b[i]) && a.some((v, i) => v !== c[i]), "turing random seed: repeatable, and changes the pattern");
}

// The pipeline used by the rest of the tests: synthetic leaf → tones → Turing
// (maze, 6 mm) → 2 height levels → printability filter.
const t0 = Date.now();
const sg = TU.gridFor(60, 40, 6);
const smp = TU.sample(base.gray, base.alpha, grid.w, grid.h, sg.w, sg.h);
const tsim = TU.createSim({ w: sg.w, h: sg.h, dark: smp.dark, ok: smp.ok, F: TU.PRESETS.maze.F, k: TU.PRESETS.maze.k, influence: 0.6, seed: 2, backend: "cpu" });
tsim.step(3000);
const V = tsim.read();
const raw = TU.toLevels(V, sg.w, sg.h, grid.w, grid.h, { levels: 2, invert: false }, base.alpha);
const rawCounts = DH.raster.levelStats(raw, 2);
const inv = TU.toLevels(V, sg.w, sg.h, grid.w, grid.h, { levels: 1, invert: true }, base.alpha);
const invCount = DH.raster.levelStats(inv, 1)[1];
ok(rawCounts[1] > 0 && rawCounts[2] > 0, `turing posterized into 2 levels: ${JSON.stringify(rawCounts)} (${sg.w}×${sg.h} cells, ${Date.now() - t0} ms)`);
ok(invCount > 0 && Math.abs(invCount - rawCounts[0]) < grid.w * grid.h * 0.05, `turing invert prints the gaps: ${invCount} vs ${rawCounts[0]} pixels`);
const filt = DH.printability.filter(raw, grid.w, grid.h, 2, grid.p, { minWidthMm: 0.5, minAreaMm2: 0.5 });
const lv = filt.lv;
const counts = DH.raster.levelStats(lv, 2);
ok(counts[1] > 0 && counts[2] > 0, "two levels present after the printability filter " + JSON.stringify(counts));

// Printability filter: a 0.3 mm line and a 0.2 mm² island go, a 5 mm blob stays.
{
  const p = 0.05, w = 300, h = 200, t = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const X = x * p, Y = y * p;
    if (Math.hypot(X - 4, Y - 5) < 2.5) t[y * w + x] = 1;          // blob
    if (X > 8 && X < 14 && Math.abs(Y - 5) < 0.15) t[y * w + x] = 1; // thin line
    if (Math.hypot(X - 12, Y - 8) < 0.25) t[y * w + x] = 1;        // tiny island
  }
  const r = DH.printability.filter(t, w, h, 1, p, { minWidthMm: 0.5, minAreaMm2: 0.5 });
  const at = (X, Y) => Math.round(Y / p) * w + Math.round(X / p);
  ok(r.lv[at(4, 5)] === 1 && r.lv[at(11, 5)] === 0 && r.lv[at(12, 8)] === 0 && r.removed[at(11, 5)] === 1 && r.removed[at(12, 8)] === 1 && r.removed[at(4, 5)] === 0,
    "printability: thin line and tiny island removed (and marked red), blob kept");
}

const print = { nozzle: 0.4, lineWidth: 0.45, layerHeight: 0.2, layersPerLevel: 2, firstLayerZ: 0.2, zOffset: 0, speed: 40, firstSpeed: 15, travelSpeed: 150, firstLayerFlow: 1.1, skipLeveling: true, pauseLayer: 0, bedType: "Textured PEI Plate", retractMinTravel: 2, zHop: 0.4, simplify: 0.03, colourChanges: true };
const layers = [];
const off = [100, 100];
for (let k = 1; k <= 2; k++) {
  const field = DH.raster.levelField(lv, grid.w, grid.h, k, grid.p);
  for (const pattern of ["satin", "tatami", "contour", "running", "outline_fill"]) {
    const paths = DH.stitches.pathsForLayer(field, { pattern, fill: "tatami", angle: 45, spacing: 0.45, outlinePasses: 1, dashed: pattern === "running", dashLen: 2, gapLen: 1 }, print, 0);
    ok(paths.length > 0, `level ${k} ${pattern}: ${paths.length} paths`);
  }
  const paths = DH.stitches.pathsForLayer(field, { pattern: "outline_fill", fill: "satin", angle: 30, spacing: 0.45, outlinePasses: 1 }, print, 0);
  for (let r = 0; r < 2; r++) layers.push({ colour: k - 1, paths: paths.map((p) => ({ ...p, pts: p.pts.map(([x, y]) => [x + off[0], y + off[1]]) })) });
}
console.log("pipeline ms", Date.now() - t0);

const mat = DH.MATERIALS[0];

// Pointillism: every layout gives dots inside the outline; tones change size or density.
{
  const field = DH.raster.levelField(lv, grid.w, grid.h, 1, grid.p);
  field.tone = base.gray;
  for (const dotLayout of ["grid", "hex", "scatter"]) {
    const flat = DH.stitches.pathsForLayer(field, { pattern: "dots", dotLayout, dotSize: 1, dotSpacing: 1.5, dotTone: false, angle: 0 }, print, 0);
    const toned = DH.stitches.pathsForLayer(field, { pattern: "dots", dotLayout, dotSize: 1, dotSpacing: 1.5, dotTone: true, angle: 0 }, print, 0);
    const inside = flat.every((q) => q.type === "Dot" && q.pts.length === 1);
    const varied = dotLayout === "scatter" ? toned.length !== flat.length : new Set(toned.map((q) => q.d.toFixed(2))).size > 1;
    ok(flat.length > 50 && inside && varied, `dots ${dotLayout}: ${flat.length} dots, with tones ${toned.length}`);
  }
  const dotsPaths = DH.stitches.pathsForLayer(field, { pattern: "dots", dotLayout: "hex", dotSize: 1, dotSpacing: 1.5, dotTone: true, angle: 0 }, print, 0)
    .map((q) => ({ ...q, pts: q.pts.map(([x, y]) => [x + 100, y + 100]) }));
  const r = DH.gcode.build({ name: "dots", printer: DH.PRINTERS[0], material: mat, print, layers: [{ colour: 0, paths: dotsPaths }, { colour: 0, paths: dotsPaths }], colours: [{ name: "a" }] });
  const body = r.text.split("; MACHINE_START_GCODE_END")[1].split("; MACHINE_END_GCODE_START")[0];
  const xyExtrude = body.split("\n").filter((l) => /^G1 X[^E]* E[\d.]/.test(l)).length;
  // Each dot: rising push (Z + E, no XY), dwell, retraction, then a lift.
  const L = body.split("\n");
  let blobs = 0, sequenced = 0;
  for (let i = 0; i < L.length; i++) {
    if (/^G1 Z[\d.]+ E[\d.]+ F/.test(L[i])) {
      blobs++;
      if (/^G4 P/.test(L[i + 1]) && /^G1 E-/.test(L[i + 2]) && /^G1 Z/.test(L[i + 3])) sequenced++;
    }
  }
  const e1 = /^G1 Z[\d.]+ E([\d.]+)/m.exec(body);
  ok(r.stats.dots === dotsPaths.length * 2 && xyExtrude === 0 && blobs === r.stats.dots && sequenced === blobs,
    `dots g-code: ${r.stats.dots} dots, ${sequenced} with push → dwell → retract → lift, ${xyExtrude} moving extrusions, first blob E ${e1 && e1[1]}, ${r.stats.filamentG.toFixed(2)} g`);
}
for (const pr of DH.PRINTERS) {
  try {
    const r = DH.gcode.build({ name: "test", printer: pr, material: mat, print, layers, colours: [{ name: "moss" }, { name: "ochre" }] });
    const unresolved = /\{[a-z_]|\[[a-z_]+\]/.test(r.text.split("; EXECUTABLE_BLOCK_START")[1]);
    ok(!unresolved, `${pr.id}: start/end rendered, ${r.text.length} bytes, leveling lines removed ${r.stats.levelingRemoved}, pauses ${r.stats.pauses.length}, ${r.stats.filamentG.toFixed(2)} g, ${Math.round(r.stats.time)} s`);
    ok(r.stats.levelingRemoved > 0, `${pr.id}: bed leveling stripped`);
    const bad = r.text.split("\n").filter((l) => /^G1 .*(NaN|Infinity|undefined)/.test(l));
    ok(bad.length === 0, `${pr.id}: no NaN moves`);
    if (pr.id === "a1mini") require("fs").writeFileSync(path.join(__dirname, "out_a1mini.gcode"), r.text);
  } catch (e) { ok(false, pr.id + ": " + e.message); }
}
// Frame: every XY move outside the first point happens at or above safeZ until
// the nozzle is inside; colour-change pauses and the end lift clear the wall.
{
  const a1 = DH.PRINTERS.find((p) => p.id === "a1");
  const r = DH.gcode.build({ name: "frame", printer: a1, material: mat, print, layers, colours: [{ name: "a" }, { name: "b" }],
    frame: { safeZ: 12, height: 10, pauseToPlace: true } });
  const body = r.text.split("; MACHINE_START_GCODE_END")[1];
  const lines = body.split("\n");
  let z = null, firstLowXY = null, sawPlacePause = false;
  for (const l of lines) {
    if (/lay the fabric and magnets/.test(l)) sawPlacePause = true;
    const mz = / Z([\d.]+)/.exec(l); if (/^G1/.test(l) && mz) z = +mz[1];
    if (/^G1 X/.test(l) && firstLowXY === null) firstLowXY = z;
  }
  ok(sawPlacePause, "frame: pause to lay fabric and magnets after the start routine");
  ok(firstLowXY >= 12, "frame: first XY move into the frame happens at Z " + firstLowXY);
  const pauseLift = /PAUSE_PRINT: change filament[^\n]*\nG1 Z([\d.]+)/.exec(body);
  ok(pauseLift && +pauseLift[1] >= 12, "frame: colour-change pause lifts to Z " + (pauseLift && pauseLift[1]));
  ok(/FRAME: lift clear of the magnets before the end routine/.test(body), "frame: lifts before the end routine");
}

// Dots stack: each layer starts one dot height higher, and no Z move on a layer
// goes below the top of the dots printed on the layer before.
{
  const dp = [[100, 100], [102, 100]].map((q) => ({ pts: [q], type: "Dot", d: 1.2, dot: { h: 0.6, flow: 1.2, dwell: 0.3, retract: 1.2, lift: 2 }, keepOrder: true }));
  const pr = { ...print, firstLayerZ: 0, zOffset: 0 };
  const r = DH.gcode.build({ name: "stack", printer: DH.PRINTERS[1], material: mat, print: pr, layers: [0, 1, 2].map(() => ({ colour: 0, paths: dp })), colours: [{ name: "a" }] });
  const body = r.text.split("; MACHINE_START_GCODE_END")[1].split("; MACHINE_END_GCODE_START")[0];
  const chunks = body.split(";LAYER:").slice(1);
  let prevTop = -1, okStack = true; const starts = [];
  chunks.forEach((c) => {
    const zs = [...c.matchAll(/^G1 Z([\d.]+)/gm)].map((m) => +m[1]);
    if (Math.min(...zs) < prevTop - 1e-6) okStack = false;
    starts.push(+/G1 Z([\d.]+) F\d+\nG1 E[\d.]+ F\d+\nG1 Z[\d.]+ E/.exec(c)[1]);
    prevTop = Math.max(...[...c.matchAll(/^G1 Z([\d.]+) E/gm)].map((m) => +m[1]));
  });
  const steps = starts.slice(1).map((v, i) => +(v - starts[i]).toFixed(3));
  ok(okStack && steps.every((d) => d === 0.6), `dots stack: layer starts ${starts.join(" → ")} mm, never below the dots underneath`);
}

// Coral: each outline (outer border and every hole) is one closed loop with
// knots at a regular spacing on it; the inside stays empty. Printed as one
// continuous loop with no travel or retraction until it closes.
{
  const p = 0.05, w = 500, h = 500, ring = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const r = Math.hypot(x * p - 12.5, y * p - 12.5);
    if (r < 9 && r > 4) ring[y * w + x] = 1;   // a 9 mm disc with a 4 mm hole
  }
  const field = DH.raster.levelField(ring, w, h, 1, p);
  const st = { pattern: "coral", coralSpacing: 2, dotSize: 1.2, coralKnotEvery: 1, coralThreadFlow: 0.6, dotHeight: 0.6, dotFlow: 1.2, dotDwell: 0.3, dotRetract: 1.2, dotLift: 2 };
  const loops = DH.stitches.pathsForLayer(field, st, print, 0);
  const at = (x, y) => field.sdf[Math.round(h - y / p - 0.5) * w + Math.round(x / p - 0.5)];
  const onOutline = loops.every((q) => q.pts.every(([x, y]) => Math.abs(at(x, y)) < 0.1));
  const gaps = loops.map((q) => q.pts.map((v, i) => { const u = q.pts[(i + 1) % q.pts.length]; return Math.hypot(u[0] - v[0], u[1] - v[1]); }));
  const even = gaps.every((g) => Math.max(...g) / Math.min(...g) < 1.1);
  const mean = gaps.flat().reduce((a, b) => a + b, 0) / gaps.flat().length;
  ok(loops.length === 2 && loops.every((q) => q.closed && q.type === "Coral" && q.knots.every((k) => k === 1)) && onOutline && even && Math.abs(mean - 2) < 0.2,
    `coral outlines: ${loops.length} loops (border + hole), ${loops.map((q) => q.pts.length).join(" + ")} knots on the outline, spacing ${mean.toFixed(2)} mm`);

  const every3 = DH.stitches.pathsForLayer(field, { ...st, coralKnotEvery: 3 }, print, 0);
  const k3 = every3.reduce((a, q) => a + q.knots.reduce((x, y) => x + y, 0), 0), n3 = every3.reduce((a, q) => a + q.pts.length, 0);
  ok(Math.abs(k3 - n3 / 3) <= every3.length, `coral knots every 3 points: ${k3} knots on ${n3} points`);

  // G-code: two layers of both loops
  const placed = loops.map((q) => ({ ...q, pts: q.pts.map(([x, y]) => [x + 100, y + 100]) }));
  const knotSet = new Set(placed.flatMap((q) => q.pts.filter((_, i) => q.knots[i]).map(([x, y]) => x.toFixed(3) + "," + y.toFixed(3))));
  const r = DH.gcode.build({ name: "coral", printer: DH.PRINTERS[1], material: mat, print, layers: [{ colour: 0, paths: placed }, { colour: 0, paths: placed }], colours: [{ name: "a" }] });
  const body = r.text.split("; MACHINE_START_GCODE_END")[1].split("; MACHINE_END_GCODE_START")[0].split("\n");
  let inLoop = false, travelInside = 0, loopsSeen = 0, closed = 0, first = null, last = null;
  const knotsAt = new Set();
  for (const l of body) {
    const m = /^G1 X([\d.]+) Y([\d.]+)/.exec(l);
    if (/^G1 X[\d.]+ Y[\d.]+ Z[\d.]+ F/.test(l) && !inLoop) first = [+m[1], +m[2]]; // arrival over the loop start
    if (!inLoop && /^G1 Z[\d.]+ E[\d.]+ F/.test(l)) { inLoop = true; loopsSeen++; last = first; knotsAt.add(first[0].toFixed(3) + "," + first[1].toFixed(3)); continue; }
    if (!inLoop) continue;
    if (/^G1 E-/.test(l)) { inLoop = false; if (Math.hypot(last[0] - first[0], last[1] - first[1]) < 0.002) closed++; continue; }
    if (/^G1 X[\d.]+ Y[\d.]+( Z[\d.]+)? F/.test(l) || /^G1 Z[\d.]+ F/.test(l)) travelInside++;
    if (m) last = [+m[1], +m[2]];
    if (/^G1 Z[\d.]+ E[\d.]+ F/.test(l)) knotsAt.add(last[0].toFixed(3) + "," + last[1].toFixed(3));
  }
  const sameKnots = [...knotsAt].every((k) => knotSet.has(k)) && knotsAt.size === knotSet.size;
  ok(loopsSeen === 4 && closed === 4 && travelInside === 0 && sameKnots && r.stats.knots === 2 * knotSet.size,
    `coral g-code: ${loopsSeen} loops, all closed on their start, ${travelInside} travel moves inside a loop, knots on the same ${knotSet.size} points (start rotated by the printer order)`);
}

const sq = DH.gcode.build({ name: "square", printer: DH.PRINTERS[0], material: mat, print, layers: DH.gcode.testSquare(DH.PRINTERS[0], print), colours: [{ name: "a" }] });
ok(sq.stats.layers === 2, "test square: 2 layers");
process.exit(fails ? 1 : 0);
