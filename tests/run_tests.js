// node tests/run_tests.js — checks templates, geometry and G-code without a browser.
const path = require("path");
for (const f of ["profiles/printers.js", "profiles/materials.js", "js/template.js", "js/geometry.js", "js/raster.js", "js/trace.js", "js/stitches.js", "js/gcode.js"]) require(path.join(__dirname, "..", f));
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
const t0 = Date.now();
const traced2 = DH.trace.traceMap(base, { mode: "gray", colours: 2, paths: 70, corners: 60, noiseMm: 0.8, ignoreWhite: true, darkHigh: true, alphaMask: true }, grid.p);
const lv = traced2.lv;
const counts = DH.raster.levelStats(lv, 2);
ok(counts[1] > 0 && counts[2] > 0, "two levels present " + JSON.stringify(counts));
ok(lv[10 * grid.w + 10] === 0, "speck removed by noise");

// Image Trace on the same synthetic image
for (const mode of ["bw", "gray", "colour"]) {
  const tr = DH.trace.traceMap(base, { mode, threshold: 128, colours: 3, paths: 60, corners: 50, noiseMm: 0.5, ignoreWhite: true, darkHigh: true, alphaMask: true }, grid.p);
  const c = DH.raster.levelStats(tr.lv, tr.levels);
  ok(tr.levels >= 1 && c.slice(1).some((n) => n > 0) && tr.swatches.length === tr.levels, `trace ${mode}: ${tr.levels} levels ${JSON.stringify(c)} ${tr.swatches.join(" ")}`);
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

const sq = DH.gcode.build({ name: "square", printer: DH.PRINTERS[0], material: mat, print, layers: DH.gcode.testSquare(DH.PRINTERS[0], print), colours: [{ name: "a" }] });
ok(sq.stats.layers === 2, "test square: 2 layers");
process.exit(fails ? 1 : 0);
