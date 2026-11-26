// node tests/run_tests.js — checks templates, the halftone and G-code without a browser.
const path = require("path");
for (const f of ["profiles/printers.js", "profiles/materials.js", "js/template.js", "js/raster.js", "js/halftone.js", "js/gcode.js"]) require(path.join(__dirname, "..", f));
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

// ---- Halftone: dots straight from the image
{
  const HT = DH.halftone, p = 0.1, w = 400, h = 200;           // 40 × 20 mm
  // tone: a left-to-right ramp from black (0) to white (1)
  const ramp = new Float32Array(w * h).map((_, i) => (i % w) / (w - 1));
  const flat = (v) => new Float32Array(w * h).fill(v);
  const S = { grid: "square", spacing: 2, angle: 0, minD: 0.5, maxD: 1.5, invert: false };
  const sq = HT.dots(flat(0), null, w, h, p, S), hx = HT.dots(flat(0), null, w, h, p, { ...S, grid: "hex" });
  ok(Math.abs(sq.length - (40 / 2) * (20 / 2)) <= 30 && hx.length > sq.length * 1.05 && hx.length < sq.length * 1.25 && sq.every((q) => Math.abs(q.d - 1.5) < 1e-9),
    `halftone grid: square ${sq.length} dots, hexagonal ${hx.length} (about ${(2 / Math.sqrt(3)).toFixed(2)}× denser), black → 1.5 mm`);
  const r = HT.dots(ramp, null, w, h, p, S);
  const byX = r.slice().sort((a, b) => a.x - b.x);
  const grows = byX.every((q, i) => i === 0 || byX[i - 1].x === q.x || byX[i - 1].d >= q.d - 1e-9);
  const lightEmpty = !r.some((q) => q.x > 36) && r.every((q) => q.d >= 0.5 && q.d <= 1.5);
  ok(grows && lightEmpty, `halftone sizes follow darkness: ${byX[0].d.toFixed(2)} mm at the dark end down to ${byX[byX.length - 1].d.toFixed(2)} mm, none under 0.5 mm, light end left empty`);
  const capped = HT.dots(flat(0), null, w, h, p, { ...S, maxD: 3 });
  const inv = HT.dots(ramp, null, w, h, p, { ...S, invert: true });
  ok(capped.every((q) => q.d <= HT.MAX_DOT) && inv.length > 0 && Math.min(...inv.map((q) => q.x)) > 3 && Math.max(...inv.map((q) => q.x)) > 36,
    "halftone: dots never exceed 1.5 mm; invert puts the big dots in the light areas");
  ok(HT.merges({ spacing: 1.2, maxD: 1.5 }) && !HT.merges({ spacing: 2, maxD: 1.5 }), "halftone: spacing under the largest dot is flagged as merging");
  const rot = HT.dots(flat(0), null, w, h, p, { ...S, angle: 45 });
  ok(Math.abs(rot.length - sq.length) < sq.length * 0.15, `halftone grid angle 45°: ${rot.length} dots (about the same density)`);
  const mask = new Uint8Array(w * h).map((_, i) => (i % w < w / 2 ? 1 : 0));
  const masked = HT.dots(flat(0), mask, w, h, p, S);
  ok(masked.every((q) => q.x <= 21) && masked.length > 0, "halftone: transparent areas get no dots");
  const f = HT.filter(r, 0.9);
  ok(f.dots.every((q) => q.d >= 0.9) && f.removed.every((q) => q.d < 0.9) && f.dots.length + f.removed.length === r.length && f.removed.length > 0,
    `printability for dots: ${f.removed.length} dots under 0.9 mm removed (shown red), ${f.dots.length} kept`);

  // nearest-neighbour order: every dot once, much shorter travel than random order
  const placed = r.map((q) => ({ pts: [[q.x + 100, q.y + 100]], type: "Dot", d: q.d }));
  const shuffled = placed.slice().sort((a, b) => ((a.pts[0][0] * 7919 + a.pts[0][1] * 104729) % 97) - ((b.pts[0][0] * 7919 + b.pts[0][1] * 104729) % 97));
  const ord = DH.gcode.orderDots(shuffled, [100, 100]);
  const travel = (L) => L.reduce((a, q, i) => a + (i ? Math.hypot(q.pts[0][0] - L[i - 1].pts[0][0], q.pts[0][1] - L[i - 1].pts[0][1]) : 0), 0);
  const seen = new Set(ord.map((q) => q.pts[0].join(",")));
  // on a 2 mm grid no order can travel less than about 2 mm per dot
  const floor = (ord.length - 1) * 2;
  ok(ord.length === shuffled.length && seen.size === shuffled.length && travel(ord) <= floor * 1.25 && travel(ord) < travel(shuffled) / 3,
    `halftone nearest-neighbour order: ${ord.length} dots, travel ${Math.round(travel(ord))} mm (minimum about ${floor} mm; ${Math.round(travel(shuffled))} mm unordered)`);
}


// The layers used by the G-code tests: the synthetic leaf → halftone dots, as
// dots on layer 1-2 and as coral on layers 3-4.
const leafDots = DH.halftone.dots(base.gray, base.alpha, grid.w, grid.h, grid.p, { grid: "hex", spacing: 2, angle: 45, minD: 0.5, maxD: 1.5, invert: false });
ok(leafDots.length > 50 && leafDots.every((q) => q.d >= 0.5 && q.d <= 1.5), `synthetic leaf halftone: ${leafDots.length} dots`);
const print = { nozzle: 0.4, lineWidth: 0.45, layerHeight: 0.2, layersPerLevel: 2, firstLayerZ: 0.2, zOffset: 0, speed: 40, firstSpeed: 15, travelSpeed: 150, firstLayerFlow: 1.1, skipLeveling: true, pauseLayer: 0, bedType: "Textured PEI Plate", retractMinTravel: 2, zHop: 0.4, colourChanges: false };
const dotOpt = { h: 0.6, flow: 1.2, dwell: 0.3, retract: 1.2, lift: 2, correction: 1 };
const place = ([x, y]) => [x + 100, y + 100];
const dotLayerPaths = leafDots.map((q) => ({ pts: [place([q.x, q.y])], type: "Dot", d: q.d, dot: dotOpt }));
const coralPaths = (dots, maxThread) => DH.halftone.coralChains(dots, maxThread).map((c) => (c.length === 1
  ? { pts: [place([c[0].x, c[0].y])], type: "Dot", d: c[0].d, dot: dotOpt, keepOrder: true }
  : { pts: c.map((q) => place([q.x, q.y])), ds: c.map((q) => q.d), knots: c.map(() => 1), d: c[0].d, type: "Coral", dot: dotOpt, coral: { threadFlow: 0.6 }, keepOrder: true }));
const coralLayerPaths = coralPaths(leafDots, 6);
const layers = [dotLayerPaths, dotLayerPaths, coralLayerPaths, coralLayerPaths].map((paths) => ({ colour: 0, paths }));
const mat = DH.MATERIALS[0];

// ---- Coral: serpentine along the grid rows, threads never cross, breaks over
// the max thread length; printed with no lift or retraction inside a chain.
{
  const p = 0.1, w = 300, h = 200;
  const blobs = new Float32Array(w * h).fill(1);                 // two dark patches 8 mm apart
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const X = x * p, Y = y * p; if ((X > 2 && X < 12 && Y > 2 && Y < 18) || (X > 20 && X < 28 && Y > 2 && Y < 18)) blobs[y * w + x] = 0; }
  for (const grid of ["square", "hex"]) for (const angle of [0, 45]) {
    const d = DH.halftone.dots(blobs, null, w, h, p, { grid, spacing: 2, angle, minD: 0.5, maxD: 1.5, invert: false });
    const chains = DH.halftone.coralChains(d, 6);
    const segs = [];
    chains.forEach((c) => c.forEach((q, i) => { if (i) segs.push([c[i - 1], q]); }));
    const cross = (a, b, c, e) => { const o = (p1, q1, r1) => (q1.x - p1.x) * (r1.y - p1.y) - (q1.y - p1.y) * (r1.x - p1.x); return o(a, b, c) * o(a, b, e) < -1e-9 && o(c, e, a) * o(c, e, b) < -1e-9; };
    let crossings = 0;
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if (cross(segs[i][0], segs[i][1], segs[j][0], segs[j][1])) crossings++;
    const longest = Math.max(...segs.map(([a, b]) => Math.hypot(a.x - b.x, a.y - b.y)));
    const all = chains.reduce((n, c) => n + c.length, 0);
    ok(crossings === 0 && longest <= 6 + 1e-9 && all === d.length && chains.length >= 2,
      `coral ${grid} grid at ${angle}°: ${d.length} dots in ${chains.length} chains, no crossings, longest thread ${longest.toFixed(2)} mm (max 6)`);
  }
  const rowsOK = (() => { const d = DH.halftone.dots(blobs, null, w, h, p, { grid: "square", spacing: 2, angle: 0, minD: 0.5, maxD: 1.5, invert: false });
    const o = DH.halftone.serpentine(d); let ok2 = true;
    for (let i = 1; i < o.length; i++) if (o[i].row === o[i - 1].row) { const dir = o[i].row % 2 ? -1 : 1; if ((o[i].col - o[i - 1].col) * dir <= 0) ok2 = false; } else if (o[i].row < o[i - 1].row) ok2 = false;
    return ok2; })();
  ok(rowsOK, "coral serpentine: rows in order, alternating direction");
  const short = DH.halftone.coralChains(DH.halftone.dots(blobs, null, w, h, p, { grid: "square", spacing: 2, angle: 0, minD: 0.5, maxD: 1.5, invert: false }), 1.5);
  ok(short.every((c) => c.length === 1), "coral: a max thread length below the grid spacing breaks every thread");

  // G-code for one coral layer: inside a chain only extrusion (dots rising in
  // place, threads moving), no lift, travel or retraction; each knot sized from its dot.
  const chainPaths = coralPaths(leafDots, 6);
  const r = DH.gcode.build({ name: "coral", printer: DH.PRINTERS[1], material: mat, print: { ...print, firstLayerFlow: 1 }, layers: [{ colour: 0, paths: chainPaths }], colours: [{ name: "a" }] });
  const body = r.text.split("; MACHINE_START_GCODE_END")[1].split("; MACHINE_END_GCODE_START")[0].split("\n");
  let inChain = false, travelInside = 0, retractInside = 0, chainsSeen = 0, threads = 0;
  const knotE = [];
  for (const l of body) {
    if (/^;TYPE:/.test(l)) continue;
    if (!inChain && /^G1 Z[\d.]+ E[\d.]+ F/.test(l)) { inChain = true; chainsSeen++; knotE.push(+/E([\d.]+)/.exec(l)[1]); continue; }
    if (!inChain) continue;
    if (/^G1 E-/.test(l)) { inChain = false; continue; }
    if (/^G1 Z[\d.]+ E[\d.]+ F/.test(l)) knotE.push(+/E([\d.]+)/.exec(l)[1]);
    if (/^G1 X[\d.]+ Y[\d.]+( Z[\d.]+)? E[\d.]+/.test(l)) threads++;
    if (/^G1 X[\d.]+ Y[\d.]+( Z[\d.]+)? F/.test(l) || /^G1 Z[\d.]+ F/.test(l)) travelInside++;
  }
  const coralChainsN = chainPaths.filter((q) => q.type === "Coral").length, singles = chainPaths.length - coralChainsN;
  const sizes = chainPaths.filter((q) => q.type === "Coral").flatMap((q) => q.ds);
  const expectRatio = (Math.max(...sizes) / Math.min(...sizes)) ** 2, gotRatio = Math.max(...knotE) / Math.min(...knotE);
  ok(chainsSeen === chainPaths.length && travelInside === 0 && threads > 0 && r.stats.knots === sizes.length && Math.abs(gotRatio / expectRatio - 1) < 0.05,
    `coral g-code: ${coralChainsN} chains + ${singles} lone dots, ${threads} threads, 0 travel/lift inside a chain, knot extrusion follows each dot's size (×${gotRatio.toFixed(2)} largest/smallest)`);
}

for (const pr of DH.PRINTERS) {
  try {
    const r = DH.gcode.build({ name: "test", printer: pr, material: mat, print, layers, colours: [{ name: "moss" }] });
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
  const r = DH.gcode.build({ name: "frame", printer: a1, material: mat, print: { ...print, pauseLayer: 2 }, layers, colours: [{ name: "a" }],
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
  const pauseLift = /PAUSE_PRINT: pause before layer[^\n]*\nG1 Z([\d.]+)/.exec(body);
  ok(pauseLift && +pauseLift[1] >= 12, "frame: a pause lifts to Z " + (pauseLift && pauseLift[1]));
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

// A2L: the per-layer Y acceleration limit follows Bambu Studio's rule
// min(max Y acceleration, max Y force / (bed mass + printed mass)).
{
  const a2l = DH.PRINTERS.find((p) => p.id === "a2l");
  const lim = DH.gcode.yAccelLimit;
  const r = DH.gcode.build({ name: "a2l", printer: a2l, material: mat, print, layers, colours: [{ name: "a" }] });
  const perLayer = (r.text.match(/^M201 N1 Y(\d+)/gm) || []).length;
  ok(a2l && a2l.bed[0] === 330 && a2l.bed[1] === 320 && lim(a2l, 0) === 8000 && lim(a2l, 1000) === Math.round(29e6 / 3700) && perLayer === r.stats.layers,
    `A2L: 330 × 320 mm bed, Y acceleration 8000 empty and ${lim(a2l, 1000)} with 1 kg printed, limit written on all ${perLayer} layers`);
}

// Halftone dots in G-code: stationary, rising while extruding, retract + lift
// between dots, extrusion scaled to size (and to the size correction).
{
  const dot = { h: 0.6, flow: 1.2, dwell: 0.3, retract: 1.2, lift: 2, correction: 1 };
  const mk = (d, corr) => [[100, 100], [104, 100], [108, 100]].map((q, i) => ({ pts: [q], type: "Dot", d: i === 1 ? d : 1, dot: { ...dot, correction: corr } }));
  const build = (paths) => DH.gcode.build({ name: "ht", printer: DH.PRINTERS[1], material: mat, print: { ...print, firstLayerFlow: 1 }, layers: [{ colour: 0, paths }], colours: [{ name: "a" }] });
  const body = (r) => r.text.split("; MACHINE_START_GCODE_END")[1].split("; MACHINE_END_GCODE_START")[0];
  const pushes = (r) => [...body(r).matchAll(/^G1 Z[\d.]+ E([\d.]+) F/gm)].map((m) => +m[1]);
  const r1 = build(mk(1.0, 1)), r2 = build(mk(1.5, 1)), rc = build(mk(1.0, 1.2));
  const b1 = body(r1).split("\n");
  const moving = b1.filter((l) => /^G1 X[^E]* E[\d.]/.test(l)).length;
  let between = 0;
  for (let i = 0; i < b1.length; i++) if (/^G1 Z[\d.]+ E/.test(b1[i]) && /^G4/.test(b1[i + 1]) && /^G1 E-/.test(b1[i + 2]) && /^G1 Z/.test(b1[i + 3])) between++;
  const e = pushes(r1), e2 = pushes(r2), ec = pushes(rc);
  ok(moving === 0 && between === 3 && Math.abs(e2[1] / e[1] - 2.25) < 0.01 && Math.abs(ec[1] / e[1] - 1.44) < 0.01,
    `halftone g-code: no moving extrusion, every dot pushed while rising then retract + lift; 1.5 mm dot gets ${(e2[1] / e[1]).toFixed(2)}× the 1 mm dot, correction 1.2 gives ${(ec[1] / e[1]).toFixed(2)}×`);
  const row = DH.halftone.calibration(0.5, 1.5, 128, 128, 10);
  const rr = build(row.map((c) => ({ pts: [[c.x, c.y]], type: "Dot", d: c.d, dot, keepOrder: true })));
  const ce = pushes(rr);
  ok(row.length === 10 && Math.abs(row[0].d - 0.5) < 1e-9 && Math.abs(row[9].d - 1.5) < 1e-9 && ce.length === 10 && ce.every((v, i) => i === 0 || v > ce[i - 1]),
    `dot calibration: 10 dots ${row.map((c) => c.d.toFixed(2)).join(" ")} mm, extrusion rising ${ce[0]} → ${ce[9]}`);
}

const sq = DH.gcode.build({ name: "square", printer: DH.PRINTERS[0], material: mat, print, layers: DH.gcode.testSquare(DH.PRINTERS[0], print), colours: [{ name: "a" }] });
ok(sq.stats.layers === 2, "test square: 2 layers");
process.exit(fails ? 1 : 0);
