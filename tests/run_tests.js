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
const sq = DH.gcode.build({ name: "square", printer: DH.PRINTERS[0], material: mat, print, layers: DH.gcode.testSquare(DH.PRINTERS[0], print), colours: [{ name: "a" }] });
ok(sq.stats.layers === 2, "test square: 2 layers");
process.exit(fails ? 1 : 0);
