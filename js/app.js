// Digital Harvest Stitch: UI, state, presets and the image → G-code pipeline.
(function (DH) {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- state
  const STITCH_DEFAULT = { pattern: "outline_fill", fill: "tatami", angle: 45, spacing: 0.45, rotate: 90, outlinePasses: 1, dashed: false, dashLen: 2, gapLen: 1 };
  const DEFAULTS = {
    import: { widthMm: 80, offX: 0, offY: 0, mirror: false },
    trace: { mode: "colour", threshold: 128, colours: 3, paths: 60, corners: 50, noiseMm: 0.5, ignoreWhite: true, darkHigh: true, alphaMask: true },
    machine: { printer: "a1mini", nozzle: 0.4, bedType: "Textured PEI Plate", skipLeveling: true },
    material: Object.assign({}, DH.MATERIALS[0]),
    colours: [
      { name: "Moss", hex: "#4f6b3a" }, { name: "Ochre", hex: "#c08a2b" }, { name: "Madder", hex: "#a8402f" },
      { name: "Indigo", hex: "#2f45b5" }, { name: "Bark", hex: "#5b4636" },
    ],
    colourChanges: true,
    frame: { enabled: false, outerX: 235, outerY: 235, wall: 15, height: 10, margin: 5, clearance: 2, pauseToPlace: true },
    stitchSame: false,
    stitches: [
      Object.assign({}, STITCH_DEFAULT),
      Object.assign({}, STITCH_DEFAULT, { pattern: "satin", angle: -30, rotate: 0 }),
      Object.assign({}, STITCH_DEFAULT, { pattern: "contour" }),
      Object.assign({}, STITCH_DEFAULT, { pattern: "tatami", angle: 0 }),
      Object.assign({}, STITCH_DEFAULT, { pattern: "running", outlinePasses: 1, dashed: true }),
    ],
    print: { lineWidth: 0.45, layerHeight: 0.2, layersPerLevel: 2, firstLayerZ: 0, zOffset: 0, speed: 40, firstSpeed: 15, travelSpeed: 150, firstLayerFlow: 1.1, retractMinTravel: 2, zHop: 0.4, pauseLayer: 0 },
    fileName: "fern_satin",
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function merge(base, over) {
    if (Array.isArray(base)) return base.map((b, i) => (over && over[i] !== undefined ? merge(b, over[i]) : b));
    if (base && typeof base === "object") {
      const out = {};
      for (const k in base) out[k] = over && k in over ? merge(base[k], over[k]) : base[k];
      return out;
    }
    return over === undefined || over === null || typeof over !== typeof base ? base : over;
  }

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };

  let state = merge(clone(DEFAULTS), store.get("dh.state") || {});
  let customMaterials = store.get("dh.materials") || [];
  let levelTab = 0, view = "paths";

  const get = (path) => path.split(".").reduce((o, k) => o[k], state);
  function set(path, v) {
    const ks = path.split("."), last = ks.pop();
    ks.reduce((o, k) => o[k], state)[last] = v;
  }
  const printer = () => DH.PRINTERS.find((p) => p.id === state.machine.printer) || DH.PRINTERS[0];
  // Number of height levels the trace produces.
  const levelCount = () => (state.trace.mode === "bw" ? 1 : state.trace.colours);

  // Optional frame on the plate, centred on the bed. Returns rectangles
  // [x0, y0, x1, y1] in bed mm: the outer edge, the inner edge, and the safe
  // area the nozzle must stay inside (inner edge minus the keep-out margin).
  function frameGeom() {
    const f = state.frame;
    if (!f.enabled) return null;
    const pr = printer(), cx = pr.bed[0] / 2, cy = pr.bed[1] / 2;
    const outer = [cx - f.outerX / 2, cy - f.outerY / 2, cx + f.outerX / 2, cy + f.outerY / 2];
    const inner = [outer[0] + f.wall, outer[1] + f.wall, outer[2] - f.wall, outer[3] - f.wall];
    const safe = [inner[0] + f.margin, inner[1] + f.margin, inner[2] - f.margin, inner[3] - f.margin];
    return { outer, inner, safe, safeZ: f.height + f.clearance, height: f.height, pauseToPlace: f.pauseToPlace };
  }
  const inside = (b, r) => b[0] >= r[0] - 1e-6 && b[1] >= r[1] - 1e-6 && b[2] <= r[2] + 1e-6 && b[3] <= r[3] + 1e-6;
  // A reason export must stop, or null.
  function frameProblem(box) {
    const fg = frameGeom();
    if (!fg) return null;
    const pr = printer();
    if (fg.outer[0] < 0 || fg.outer[1] < 0 || fg.outer[2] > pr.bed[0] || fg.outer[3] > pr.bed[1])
      return `The ${state.frame.outerX} × ${state.frame.outerY} mm frame is bigger than the ${pr.name} bed (${pr.bed[0]} × ${pr.bed[1]} mm).`;
    if (fg.safe[2] <= fg.safe[0] || fg.safe[3] <= fg.safe[1]) return "The frame's wall and margin leave no room inside it.";
    if (fg.safeZ > pr.maxHeight - 1) return "The frame is taller than this printer can clear.";
    if (box && !inside(box, fg.safe)) {
      const w = (fg.safe[2] - fg.safe[0]).toFixed(0), h = (fg.safe[3] - fg.safe[1]).toFixed(0);
      return `The design reaches into the frame's keep-out zone. Keep it within the ${w} × ${h} mm area inside the frame: reduce the width or move the offsets.`;
    }
    return null;
  }

  // ---------------------------------------------------------------- field builder
  const NEXT = { size: onSize, trace: onTrace, paths: onPaths, gcode: onGcode, none: () => {} };

  // Slider end labels in the [04] [07] [10] style.
  function tickLabel(v, step) {
    if (step !== undefined) v = Math.round(v / step) * step;
    v = Math.round(v * 100) / 100;
    return Number.isInteger(v) && v >= 0 && v < 10 ? "0" + v : String(v);
  }

  function field(spec) {
    const el = document.createElement("div");
    el.className = "field" + (spec.type === "check" ? " check" : "") + (spec.type === "range" ? " ranged" : "") + (spec.wide ? " wide" : "");
    const id = "f_" + spec.path.replace(/\./g, "_");
    const val = get(spec.path);
    const changed = (v) => { set(spec.path, v); (spec.after || (() => {}))(v); NEXT[spec.on || "paths"](); save(); };
    if (spec.type === "check") {
      el.innerHTML = `<input type="checkbox" id="${id}"><label for="${id}">${spec.label}</label>`;
      const cb = el.querySelector("input"); cb.checked = !!val;
      cb.addEventListener("change", () => changed(cb.checked));
    } else if (spec.type === "select") {
      el.innerHTML = `<label for="${id}">${spec.label}</label><select id="${id}"></select>`;
      const sel = el.querySelector("select");
      for (const [v, t] of spec.options) { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o); }
      sel.value = String(val);
      sel.addEventListener("change", () => changed(typeof val === "number" ? parseFloat(sel.value) : sel.value));
    } else if (spec.type === "seg") {
      el.innerHTML = `<label id="${id}_l">${spec.label}</label><div class="seg" role="group" aria-labelledby="${id}_l"></div>`;
      const seg = el.querySelector(".seg");
      for (const [v, t] of spec.options) {
        const b = document.createElement("button"); b.type = "button"; b.textContent = t;
        b.setAttribute("aria-pressed", String(v === val));
        b.addEventListener("click", () => {
          seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", "false"));
          b.setAttribute("aria-pressed", "true"); changed(v);
        });
        seg.appendChild(b);
      }
    } else if (spec.type === "text") {
      el.innerHTML = `<label for="${id}">${spec.label}</label><input type="text" id="${id}">`;
      const t = el.querySelector("input"); t.value = val;
      t.addEventListener("change", () => changed(t.value));
    } else {
      const showRange = spec.type === "range";
      el.innerHTML = `<label for="${id}">${spec.label}</label>
        <span class="num-in"><input type="number" id="${id}" min="${spec.min}" max="${spec.max}" step="${spec.step}"><span class="unit">${spec.unit || ""}</span></span>
        ${showRange ? `<input type="range" aria-label="${spec.label}" min="${spec.min}" max="${spec.max}" step="${spec.step}">
        <div class="ticks" aria-hidden="true"><span>[${tickLabel(spec.min)}]</span><span>[${tickLabel((spec.min + spec.max) / 2, spec.step)}]</span><span>[${tickLabel(spec.max)}]</span></div>` : ""}`;
      const num = el.querySelector('input[type="number"]'), rng = el.querySelector('input[type="range"]');
      num.value = val; if (rng) rng.value = val;
      const clamp = (v) => Math.min(spec.max, Math.max(spec.min, v));
      if (rng) rng.addEventListener("input", () => { num.value = rng.value; changed(parseFloat(rng.value)); });
      num.addEventListener("change", () => {
        let v = parseFloat(num.value);
        if (!isFinite(v)) v = get(spec.path);
        v = clamp(v); num.value = v; if (rng) rng.value = v; changed(v);
      });
    }
    if (spec.help) { const h = document.createElement("div"); h.className = "help"; h.textContent = spec.help; el.appendChild(h); }
    return el;
  }
  function fill(containerId, specs, grid) {
    const c = $(containerId);
    c.innerHTML = "";
    let host = c;
    if (grid) { host = document.createElement("div"); host.className = "grid2"; c.appendChild(host); }
    for (const s of specs) host.appendChild(field(s));
  }

  // ---------------------------------------------------------------- panels
  function renderImport() {
    fill("f-import", [
      { path: "import.widthMm", label: "Output width", type: "range", min: 10, max: 340, step: 1, unit: "mm", on: "size" },
      { path: "import.offX", label: "Offset X from bed centre", type: "number", min: -170, max: 170, step: 0.5, unit: "mm", on: "paths" },
      { path: "import.offY", label: "Offset Y from bed centre", type: "number", min: -170, max: 170, step: 0.5, unit: "mm", on: "paths" },
      { path: "import.mirror", label: "Mirror left to right", type: "check", on: "paths" },
    ]);
    const sz = document.createElement("p");
    sz.className = "hint"; sz.id = "sizeLine";
    $("f-import").appendChild(sz);
    updateSizeLine();
  }
  function updateSizeLine() {
    const el = $("sizeLine");
    if (!el || !src) return;
    el.textContent = `Print size ${state.import.widthMm.toFixed(0)} × ${heightMm().toFixed(1)} mm (height follows the image's aspect ratio).`;
    $("dimW").textContent = state.import.widthMm.toFixed(0);
    $("dimH").textContent = heightMm().toFixed(1);
    $("dimWidth").value = state.import.widthMm;
    const f = $("f_import_widthMm");
    if (f && +f.value !== state.import.widthMm) {
      f.value = state.import.widthMm;
      const r = f.closest(".field").querySelector('input[type="range"]');
      if (r) r.value = state.import.widthMm;
    }
  }

  function levelsChanged() {
    levelTab = Math.min(levelTab, levelCount() - 1);
    renderColours(); renderStitch();
  }

  // Panel 02: Image Trace turns the picture into flat tones, one per height level.
  function renderTrace() {
    const t = state.trace, specs = [
      { path: "trace.mode", label: "Mode", type: "seg", wide: true, options: [["bw", "b&w"], ["gray", "grayscale"], ["colour", "colour"]], on: "trace",
        after: () => { renderTrace(); levelsChanged(); } },
    ];
    if (t.mode === "bw") {
      specs.push({ path: "trace.threshold", label: "Threshold", type: "range", min: 0, max: 255, step: 1, unit: "", on: "trace", help: "Pixels darker than this are printed." });
    } else {
      specs.push({ path: "trace.colours", label: t.mode === "gray" ? "Grays" : "Colours", type: "seg", options: [1, 2, 3, 4, 5].map((n) => [n, String(n)]), on: "trace",
        after: levelsChanged, help: "How many tones to keep. Each one is printed as its own height level." });
    }
    specs.push(
      { path: "trace.paths", label: "Paths", type: "range", min: 0, max: 100, step: 1, unit: "%", on: "paths", help: "High follows the pixels closely; low gives smoother, simpler paths." },
      { path: "trace.corners", label: "Corners", type: "range", min: 0, max: 100, step: 1, unit: "%", on: "trace", help: "High keeps sharp corners; low rounds them." },
      { path: "trace.noiseMm", label: "Noise", type: "range", min: 0, max: 5, step: 0.1, unit: "mm", on: "trace", help: "Ignores islands and holes smaller than this." },
    );
    if (t.mode !== "bw") specs.push({ path: "trace.ignoreWhite", label: "Ignore white", type: "check", on: "trace", help: "Leaves the lightest tone as bare fabric." });
    specs.push(
      { path: "trace.darkHigh", label: "Dark areas are the tallest", type: "check", on: "trace" },
      { path: "trace.alphaMask", label: "Never print transparent pixels", type: "check", on: "trace" },
    );
    fill("f-trace", specs);
    renderTracedColours();
  }

  let traced = [];
  function renderTracedColours() {
    const box = $("tracedSwatches");
    box.innerHTML = "";
    traced.forEach((hex, k) => {
      const s = document.createElement("span");
      s.innerHTML = `<i style="background:${hex}"></i>l${k + 1}`;
      box.appendChild(s);
    });
    $("useTraced").disabled = !traced.length;
  }
  function useTracedColours() {
    traced.forEach((hex, k) => { if (state.colours[k]) state.colours[k].hex = hex; });
    lvCanvas = null;
    renderColours(); renderStitchTabs(); updateLegend(); updateStats(); redraw(); save();
    toast("Filament colours set from the trace");
  }

  function renderMachine() {
    const p = printer();
    fill("f-machine", [
      { path: "machine.printer", label: "Printer", type: "select", options: DH.PRINTERS.map((x) => [x.id, "Bambu Lab " + x.name]), on: "paths",
        after: () => renderMachine() },
      { path: "machine.nozzle", label: "Nozzle", type: "select", options: p.nozzles.map((n) => [n, n + " mm"]), on: "paths",
        after: (n) => { state.print.lineWidth = Math.round(n * 1.125 * 100) / 100; renderPrint(); } },
      { path: "machine.bedType", label: "Build plate", type: "select", options: ["Textured PEI Plate", "Cool Plate", "Engineering Plate", "High Temp Plate"].map((x) => [x, x]), on: "gcode",
        help: "Only changes the plate-specific Z trim in the start G-code." },
      { path: "machine.skipLeveling", label: "Skip auto bed leveling", type: "check", on: "gcode",
        help: "The probe can misread fabric. Level once on the bare plate, then print with this on." },
    ]);
    const info = document.createElement("p");
    info.className = "hint";
    info.textContent = `Bed ${p.bed[0]} × ${p.bed[1]} mm · start/end G-code from Bambu Studio profile “${p.source}”.`;
    $("f-machine").appendChild(info);
    renderFrame();
  }

  function renderFrame() {
    const f = state.frame;
    const specs = [
      { path: "frame.enabled", label: "Frame on the plate", type: "check", on: "gcode", after: () => renderFrame(),
        help: "A frame (hoop) around the fabric that the nozzle must never enter. Moves that cross its wall happen above it." },
    ];
    if (f.enabled) specs.push(
      { path: "frame.outerX", label: "Outer width (X)", type: "range", min: 50, max: 350, step: 1, unit: "mm", on: "gcode", after: updateFrameLine },
      { path: "frame.outerY", label: "Outer depth (Y)", type: "range", min: 50, max: 350, step: 1, unit: "mm", on: "gcode", after: updateFrameLine },
      { path: "frame.wall", label: "Wall width", type: "range", min: 1, max: 50, step: 0.5, unit: "mm", on: "gcode", after: updateFrameLine },
      { path: "frame.height", label: "Wall height", type: "range", min: 1, max: 40, step: 0.5, unit: "mm", on: "gcode", after: updateFrameLine },
      { path: "frame.margin", label: "Keep-out margin inside the wall", type: "range", min: 0, max: 40, step: 0.5, unit: "mm", on: "gcode", after: updateFrameLine,
        help: "Extra distance between the nozzle and the inner wall. The toolhead around the nozzle is wider, so raise this if it gets close to the wall." },
      { path: "frame.clearance", label: "Clearance above the wall", type: "range", min: 0.5, max: 20, step: 0.5, unit: "mm", on: "gcode", after: updateFrameLine },
      { path: "frame.pauseToPlace", label: "Pause to place the frame after the start routine", type: "check", on: "gcode",
        help: "The printer's own start routine (purge line, calibration, leveling) moves low across the plate. With this on, the frame goes on only after it." },
    );
    fill("f-frame", specs);
    if (f.enabled) {
      const p = document.createElement("p");
      p.className = "hint frame-line"; p.id = "frameLine";
      $("f-frame").appendChild(p);
      updateFrameLine();
    }
  }
  function updateFrameLine() {
    const el = $("frameLine"), fg = frameGeom();
    if (!el || !fg) return;
    const iw = fg.inner[2] - fg.inner[0], ih = fg.inner[3] - fg.inner[1];
    const sw = fg.safe[2] - fg.safe[0], sh = fg.safe[3] - fg.safe[1];
    el.textContent = `[ inside: ${iw.toFixed(0)} × ${ih.toFixed(0)} mm ]  [ nozzle area: ${Math.max(0, sw).toFixed(0)} × ${Math.max(0, sh).toFixed(0)} mm ]  [ crosses the wall at z ${fg.safeZ.toFixed(1)} mm ]`;
  }

  function materialOptions() {
    return DH.MATERIALS.map((m) => ["builtin:" + m.id, m.name]).concat(customMaterials.map((m, i) => ["custom:" + i, m.name + " (custom)"]));
  }
  function renderMaterial() {
    const c = $("f-material");
    c.innerHTML = "";
    const pick = document.createElement("div");
    pick.className = "field";
    pick.innerHTML = `<label for="materialPick">Preset</label><select id="materialPick"></select>`;
    const sel = pick.querySelector("select");
    for (const [v, t] of materialOptions()) { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o); }
    const match = materialOptions().find(([v, t]) => t.replace(" (custom)", "") === state.material.name);
    sel.value = match ? match[0] : "builtin:pla";
    sel.addEventListener("change", () => {
      const [kind, k] = sel.value.split(":");
      const m = kind === "builtin" ? DH.MATERIALS.find((x) => x.id === k) : customMaterials[+k];
      state.material = merge(clone(DEFAULTS.material), clone(m));
      renderMaterial(); onGcode(); save();
    });
    c.appendChild(pick);
    const grid = document.createElement("div");
    grid.className = "grid2";
    c.appendChild(grid);
    const specs = [
      { path: "material.name", label: "Preset name", type: "text", on: "none" },
      { path: "material.type", label: "Type", type: "select", options: [["PLA", "PLA"], ["PETG", "PETG"], ["TPU", "TPU"], ["ABS", "ABS"], ["ASA", "ASA"]], on: "gcode" },
      { path: "material.firstLayerTemp", label: "First-layer nozzle", type: "number", min: 150, max: 320, step: 1, unit: "°C", on: "gcode" },
      { path: "material.nozzleTemp", label: "Nozzle temp", type: "number", min: 150, max: 320, step: 1, unit: "°C", on: "gcode" },
      { path: "material.bedTemp", label: "Bed temp", type: "number", min: 0, max: 120, step: 1, unit: "°C", on: "gcode" },
      { path: "material.maxVolSpeed", label: "Max volumetric speed", type: "number", min: 0.5, max: 40, step: 0.1, unit: "mm³/s", on: "gcode" },
      { path: "material.flow", label: "Flow multiplier", type: "number", min: 0.5, max: 1.5, step: 0.01, unit: "×", on: "gcode" },
      { path: "material.retractLength", label: "Retraction length", type: "number", min: 0, max: 5, step: 0.05, unit: "mm", on: "gcode" },
      { path: "material.retractSpeed", label: "Retraction speed", type: "number", min: 5, max: 60, step: 1, unit: "mm/s", on: "gcode" },
      { path: "material.fanFirst", label: "Fan, first layer", type: "number", min: 0, max: 100, step: 1, unit: "%", on: "gcode" },
      { path: "material.fanRest", label: "Fan, other layers", type: "number", min: 0, max: 100, step: 1, unit: "%", on: "gcode" },
      { path: "material.diameter", label: "Filament diameter", type: "number", min: 1.5, max: 3, step: 0.01, unit: "mm", on: "gcode" },
      { path: "material.density", label: "Density", type: "number", min: 0.8, max: 2, step: 0.01, unit: "g/cm³", on: "gcode" },
    ];
    for (const s of specs) grid.appendChild(field(s));
  }

  function renderColours() {
    const c = $("colours");
    c.innerHTML = "";
    for (let k = 0; k < levelCount(); k++) {
      const col = state.colours[k];
      const row = document.createElement("div");
      row.className = "colour-row";
      row.innerHTML = `<span class="lv">L${k + 1}</span><input type="color" aria-label="Level ${k + 1} colour" id="col_${k}"><input type="text" aria-label="Level ${k + 1} filament name" id="colname_${k}">`;
      const [pick, name] = row.querySelectorAll("input");
      pick.value = col.hex; name.value = col.name;
      pick.addEventListener("input", () => { col.hex = pick.value; renderStitchTabs(); redraw(); updateLegend(); save(); });
      name.addEventListener("change", () => { col.name = name.value || "Level " + (k + 1); onGcode(); save(); });
      c.appendChild(row);
    }
    fill("f-colour", [
      { path: "colourChanges", label: "Pause for a filament change when the colour changes", type: "check", on: "gcode",
        help: "The print pauses (M400 U1) at the first layer of a level whose colour differs. Swap filament on the printer, then resume." },
    ]);
  }

  function renderStitchTabs() {
    const tabs = $("levelTabs");
    tabs.innerHTML = "";
    tabs.hidden = state.stitchSame || levelCount() < 2;
    if (tabs.hidden) return;
    for (let k = 0; k < levelCount(); k++) {
      const b = document.createElement("button");
      b.type = "button"; b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(k === levelTab));
      b.innerHTML = `<span class="dot" style="background:${state.colours[k].hex}"></span>Level ${k + 1}`;
      b.addEventListener("click", () => { levelTab = k; renderStitch(); });
      tabs.appendChild(b);
    }
  }
  function renderStitch() {
    fill("f-stitch-mode", [
      { path: "stitchSame", label: "Same stitch for every level", type: "check", on: "paths", after: () => renderStitch() },
    ]);
    renderStitchTabs();
    const k = state.stitchSame ? 0 : levelTab;
    const st = state.stitches[k], base = "stitches." + k + ".";
    const pat = st.pattern;
    const specs = [
      { path: base + "pattern", label: "Stitch pattern", type: "select", options: Object.entries(DH.stitches.PATTERNS).map(([v, p]) => [v, p.label]), after: () => renderStitch() },
    ];
    if (pat === "outline_fill") specs.push({ path: base + "fill", label: "Fill after the outline", type: "select", options: [["tatami", "Fill / tatami"], ["satin", "Satin"], ["contour", "Contour"]], after: () => renderStitch() });
    const fillKind = pat === "outline_fill" ? st.fill : pat;
    if (pat === "running" || pat === "outline_fill") specs.push({ path: base + "outlinePasses", label: "Outline passes", type: "range", min: 1, max: 6, step: 1, unit: "" });
    if (fillKind === "satin" || fillKind === "tatami") {
      specs.push({ path: base + "angle", label: "Angle", type: "range", min: -90, max: 90, step: 1, unit: "°" });
      specs.push({ path: base + "rotate", label: "Rotate angle each layer", type: "range", min: 0, max: 180, step: 5, unit: "°" });
    }
    if (pat !== "running") specs.push({ path: base + "spacing", label: "Line spacing (density)", type: "range", min: 0.2, max: 3, step: 0.01, unit: "mm", help: "Equal to the line width gives a solid fill; wider leaves the weave showing." });
    if (pat === "running") {
      specs.push({ path: base + "dashed", label: "Dashed, like a running stitch", type: "check", after: () => renderStitch() });
      if (st.dashed) {
        specs.push({ path: base + "dashLen", label: "Stitch length", type: "range", min: 0.5, max: 10, step: 0.1, unit: "mm" });
        specs.push({ path: base + "gapLen", label: "Gap length", type: "range", min: 0.3, max: 10, step: 0.1, unit: "mm" });
      }
    }
    fill("f-stitch", specs);
  }

  function renderPrint() {
    fill("f-print", [
      { path: "print.lineWidth", label: "Line width", type: "range", min: 0.1, max: 2, step: 0.01, unit: "mm" },
      { path: "print.layerHeight", label: "Layer height", type: "range", min: 0.04, max: 0.6, step: 0.01, unit: "mm" },
      { path: "print.layersPerLevel", label: "Layers per level", type: "range", min: 1, max: 20, step: 1, unit: "" },
      { path: "print.pauseLayer", label: "Pause before layer", type: "range", min: 0, max: 200, step: 1, unit: "" },
      { path: "print.firstLayerZ", label: "First layer Z", type: "range", min: 0, max: 1, step: 0.01, unit: "mm", on: "gcode" },
      { path: "print.zOffset", label: "Z offset (fabric)", type: "range", min: -1, max: 5, step: 0.01, unit: "mm", on: "gcode" },
      { path: "print.speed", label: "Print speed", type: "range", min: 5, max: 300, step: 1, unit: "mm/s", on: "gcode" },
      { path: "print.firstSpeed", label: "First-layer speed", type: "range", min: 3, max: 100, step: 1, unit: "mm/s", on: "gcode" },
      { path: "print.travelSpeed", label: "Travel speed", type: "range", min: 20, max: 500, step: 5, unit: "mm/s", on: "gcode" },
      { path: "print.firstLayerFlow", label: "First-layer flow", type: "range", min: 0.5, max: 2, step: 0.01, unit: "×", on: "gcode" },
      { path: "print.retractMinTravel", label: "Retract on travel over", type: "range", min: 0, max: 20, step: 0.5, unit: "mm", on: "gcode" },
      { path: "print.zHop", label: "Z lift on retract", type: "range", min: 0, max: 3, step: 0.05, unit: "mm", on: "gcode" },
    ]);
  }

  function renderAll() {
    renderImport(); renderTrace(); renderMachine(); renderMaterial(); renderColours(); renderStitch(); renderPrint();
    $("fileName").value = state.fileName || $("fileName").value;
  }

  // ---------------------------------------------------------------- pipeline
  let src = null, srcName = "";
  let grid = null, base = null, lv = null, lvCanvas = null, presentLevels = 0;
  let fields = {}, pathCache = {}, result = null, error = null, genToken = 0, stale = true;

  const heightMm = () => (src ? (state.import.widthMm * src.height) / src.width : 0);

  function setSource(img, name) {
    src = img; srcName = name;
    $("imgName").textContent = name;
    $("imgInfo").textContent = `${img.width} × ${img.height} px`;
    $("thumb").src = img instanceof HTMLCanvasElement ? img.toDataURL("image/png") : img.src;
    $("thumb").hidden = false;
    $("emptyState").hidden = true;
    onSize();
  }

  function onSize() {
    if (!src) return;
    grid = DH.raster.gridFor(state.import.widthMm, heightMm());
    const c = document.createElement("canvas");
    c.width = grid.w; c.height = grid.h;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.drawImage(src, 0, 0, grid.w, grid.h);
    base = DH.raster.toGray(g.getImageData(0, 0, grid.w, grid.h));
    updateSizeLine();
    onTrace();
  }

  let traceRaf = 0;
  function onTrace() {
    cancelAnimationFrame(traceRaf);
    traceRaf = requestAnimationFrame(() => {
      if (!base) return;
      const r = DH.trace.traceMap(base, state.trace, grid.p);
      lv = r.lv; traced = r.swatches;
      renderTracedColours();
      const N = levelCount();
      const counts = DH.raster.levelStats(lv, N);
      presentLevels = 0;
      for (let k = 1; k <= N; k++) if (counts.slice(k).some((n) => n > 0)) presentLevels = k;
      lvCanvas = null;
      fields = {};
      onPaths();
      if (view === "trace") redraw();
    });
  }
  function onPaths() { pathCache = {}; onGcode(); }
  let genTimer = 0;
  function onGcode() {
    stale = true;
    clearTimeout(genTimer);
    genTimer = setTimeout(() => generate(), 350);
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  function printSettings() {
    const p = state.print;
    return Object.assign({}, p, {
      nozzle: state.machine.nozzle, bedType: state.machine.bedType, skipLeveling: state.machine.skipLeveling,
      simplify: DH.trace.simplifyFor(state.trace.paths), colourChanges: state.colourChanges,
    });
  }

  function placement() {
    const pr = printer(), W = state.import.widthMm, H = heightMm();
    return { x0: pr.bed[0] / 2 + state.import.offX - W / 2, y0: pr.bed[1] / 2 + state.import.offY - H / 2, W, H };
  }

  async function buildLayers(token) {
    const pl = placement(), s = printSettings();
    const layers = [];
    const L = Math.max(1, Math.round(s.layersPerLevel));
    for (let k = 1; k <= presentLevels; k++) {
      if (!fields[k]) {
        fields[k] = DH.raster.levelField(lv, grid.w, grid.h, k, grid.p);
        await tick();
        if (token !== genToken) return null;
      }
      const st = state.stitchSame ? state.stitches[0] : state.stitches[k - 1];
      for (let r = 0; r < L; r++) {
        const j = (k - 1) * L + r;
        const ang = ((j * (st.rotate || 0)) % 360 + 360) % 360;
        const key = k + "|" + ang;
        if (!pathCache[key]) {
          const raw = fields[k] ? DH.stitches.pathsForLayer(fields[k], st, s, ang) : [];
          pathCache[key] = raw.map((p) => ({
            closed: p.closed, type: p.type,
            pts: p.pts.map(([x, y]) => [pl.x0 + (state.import.mirror ? pl.W - x : x), pl.y0 + y]),
          }));
          await tick();
          if (token !== genToken) return null;
        }
        layers.push({ colour: k - 1, paths: pathCache[key] });
      }
    }
    return layers;
  }

  async function generate() {
    const token = ++genToken;
    if (!lv) return;
    $("busy").hidden = false;
    await tick();
    try {
      const layers = await buildLayers(token);
      if (!layers || token !== genToken) return;
      const pr = printer();
      result = DH.gcode.build({
        name: srcName, printer: pr, material: state.material, print: printSettings(), layers,
        colours: state.colours, frame: frameGeom(),
      });
      result.layers = layers;
      result.box = layers.length ? DH.gcode.bbox(layers) : null;
      error = null;
    } catch (e) {
      console.error(e);
      result = null; error = e.message || String(e);
    }
    if (token !== genToken) return;
    stale = false;
    $("busy").hidden = true;
    const slider = $("layerSlider"), atEnd = +slider.value >= +slider.max;
    const n = result ? result.preview.length : 0;
    slider.max = Math.max(1, n);
    if (atEnd || +slider.value > n) slider.value = Math.max(1, n);
    updateLayerLabel(); updateStats(); updateWarnings(); updateLegend(); redraw();
  }

  // ---------------------------------------------------------------- view
  function redraw() {
    const canvas = $("view");
    $("pathControls").hidden = view !== "paths";
    $("legend").hidden = view === "original";
    if (!src) { const g = canvas.getContext("2d"); g.clearRect(0, 0, canvas.width, canvas.height); return; }
    if (view === "original") { DH.preview.fitImage(canvas, src, 14); return; }
    if (view === "trace") {
      if (!lv) return;
      if (!lvCanvas) lvCanvas = DH.preview.levelCanvas(lv, grid.w, grid.h, state.colours);
      DH.preview.fitImage(canvas, lvCanvas, 14);
      return;
    }
    const pr = printer(), pl = placement();
    DH.preview.toolpaths(canvas, {
      bed: pr.bed, exclude: pr.excludeArea, box: [pl.x0, pl.y0, pl.x0 + pl.W, pl.y0 + pl.H], fit: result && result.box,
      layers: result ? result.preview : [], current: +$("layerSlider").value,
      showTravel: $("showTravel").checked, byLayer: $("colourByLayer").checked,
      colours: state.colours, wholeBed: $("wholeBed").checked, lineWidth: state.print.lineWidth, frame: frameGeom(),
    });
  }
  function updateLayerLabel() {
    const n = result ? result.preview.length : 0, j = +$("layerSlider").value;
    if (!n) { $("layerLabel").textContent = "–"; return; }
    const L = result.preview[j - 1];
    $("layerLabel").textContent = `${j}/${n} · Z ${L.z.toFixed(2)} · ${state.colours[L.colour].name}`;
  }

  function updateLegend() {
    const el = $("legend");
    el.innerHTML = "";
    const add = (html) => { const s = document.createElement("span"); s.innerHTML = html; el.appendChild(s); };
    if (view === "paths" && $("colourByLayer").checked) {
      add(`<i style="background:${DH.preview.layerHue(0, 2)}"></i>first layer`);
      add(`<i style="background:${DH.preview.layerHue(1, 2)}"></i>last layer`);
    } else {
      for (let k = 0; k < levelCount(); k++) {
        const c = state.colours[k];
        add(`<i style="background:${c.hex}"></i>L${k + 1} ${escapeHtml(c.name)}`);
      }
    }
    if (view === "paths" && $("showTravel").checked) add(`<i class="travel"></i>travel (current layer)`);
  }
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function fmtTime(t) {
    const h = Math.floor(t / 3600), m = Math.round((t % 3600) / 60);
    return h ? `${h} h ${m} min` : `${Math.max(1, m)} min`;
  }

  function updateStats() {
    const el = $("stats");
    el.innerHTML = "";
    el.hidden = !result;
    if (!result) return;
    const s = result.stats, pl = placement();
    const add = (k, v, swatch) => {
      const span = document.createElement("span");
      span.innerHTML = `[ ${swatch ? `<i class="swatch" style="background:${swatch}"></i>` : ""}${k}: ${v} ]`;
      el.appendChild(span);
    };
    const topZ = state.print.firstLayerZ + state.print.zOffset + Math.max(0, s.layers - 1) * state.print.layerHeight;
    add("printer", escapeHtml(printer().name.toLowerCase()));
    add("size", `${pl.W.toFixed(0)} × ${pl.H.toFixed(1)} mm`);
    add("levels", presentLevels);
    add("layers", `${s.layers} · top z ${topZ.toFixed(2)}`);
    add("time", fmtTime(s.time) + " + start");
    add("filament", `${(s.filamentMm / 1000).toFixed(2)} m · ${s.filamentG.toFixed(1)} g`);
    for (const k of Object.keys(s.perColour)) {
      const pc = s.perColour[k], c = state.colours[pc.colour];
      add(escapeHtml(c.name.toLowerCase()), `${pc.grams.toFixed(1)} g`, c.hex);
    }
    add("pauses", s.pauses.length);
  }

  function updateWarnings() {
    const ul = $("warnings");
    ul.innerHTML = "";
    const add = (cls, text) => { const li = document.createElement("li"); if (cls) li.className = cls; li.textContent = text; ul.appendChild(li); };
    if (error) { add("bad", "G-code could not be written: " + error); return; }
    const pr = printer(), pl = placement(), s = state.print, m = state.material;
    if (pl.x0 < 0 || pl.y0 < 0 || pl.x0 + pl.W > pr.bed[0] || pl.y0 + pl.H > pr.bed[1])
      add("bad", `The design (${pl.W.toFixed(0)} × ${pl.H.toFixed(0)} mm) runs off the ${pr.name} bed (${pr.bed[0]} × ${pr.bed[1]} mm). Reduce the width or the offsets.`);
    if (pr.excludeArea) {
      const [a, b, c, d] = pr.excludeArea;
      if (pl.x0 < c && pl.x0 + pl.W > a && pl.y0 < d && pl.y0 + pl.H > b) add("", "The design overlaps the printer's excluded corner (the purge chute area).");
    }
    if (!presentLevels || (result && !result.stats.extrudeLen)) add("bad", "Nothing to print: change the threshold or colours, turn off ignore white, or lower the noise.");
    const z1 = s.firstLayerZ + s.zOffset;
    if (z1 < s.layerHeight * 0.5) add("info", `Layer 1 prints with the nozzle at Z ${z1.toFixed(2)} mm. That's meant for fabric; on a bare plate the nozzle would block. Set Z offset to your fabric's compressed thickness if needed.`);
    const noz = state.machine.nozzle;
    if (s.lineWidth < noz * 0.85 || s.lineWidth > noz * 1.7) add("", `A ${s.lineWidth} mm line width is unusual for a ${noz} mm nozzle (try ${(noz * 1.125).toFixed(2)} mm).`);
    const cap = m.maxVolSpeed / (s.lineWidth * s.layerHeight);
    if (cap < s.speed) add("info", `${m.name} max volumetric speed limits printing to ${cap.toFixed(0)} mm/s.`);
    if (result && result.stats.pauses.length) {
      const list = result.stats.pauses.map((p) => `layer ${p.layer} (${p.why})`).join("; ");
      add("info", `The print pauses ${result.stats.pauses.length}× with M400 U1: ${list}.`);
    }
    if (s.pauseLayer > (result ? result.stats.layers : 0)) add("", `Pause before layer ${s.pauseLayer} never happens: the print has ${result ? result.stats.layers : 0} layers.`);
    const fp = frameProblem(result && result.box);
    if (fp) add("bad", fp);
    if (state.frame.enabled && !state.frame.pauseToPlace)
      add("", "Place the frame only after the printer's start routine: the purge line, calibration and leveling move low across the plate.");
    if (pr.multiNozzle) add("info", `${pr.name}: dual-nozzle start G-code is filled for one filament on one nozzle. Print the test square before a real job.`);
    if (state.machine.skipLeveling && result && !result.stats.levelingRemoved) add("", "No bed-leveling block was found in this printer's start G-code; nothing was removed.");
  }

  // ---------------------------------------------------------------- export
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const safeName = (s) => (s || "digital_harvest").trim().replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "_").replace(/\.gcode$/i, "") || "digital_harvest";
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2600);
  }

  async function exportGcode() {
    if (stale) { clearTimeout(genTimer); await generate(); }
    if (!result) { toast(error ? "Fix the error shown in the preview panel first." : (src ? "Nothing to export yet." : "Load an image first.")); return; }
    if (!result.stats.extrudeLen) { toast("Nothing to print: adjust the trace settings."); return; }
    const fp = frameProblem(result.box);
    if (fp) { toast("Not exported: " + fp); return; }
    const name = safeName($("fileName").value) + ".gcode";
    download(name, result.text);
    toast(`Saved ${name}`);
  }

  function exportTestSquare() {
    const pr = printer();
    const s = Object.assign(printSettings(), { firstLayerZ: state.print.layerHeight, zOffset: 0, pauseLayer: 0, colourChanges: false });
    const c = [pr.bed[0] / 2, pr.bed[1] / 2], fp = frameProblem([c[0] - 10, c[1] - 10, c[0] + 10, c[1] + 10]);
    if (fp) { toast("Not exported: " + fp); return; }
    try {
      const r = DH.gcode.build({ name: "test square", printer: pr, material: state.material, print: s, layers: DH.gcode.testSquare(pr, s), colours: state.colours, frame: frameGeom() });
      const name = `test_square_${pr.id}_${state.material.type.toLowerCase()}.gcode`;
      download(name, r.text);
      toast(`Saved ${name}`);
    } catch (e) { toast("Test square failed: " + e.message); }
  }

  // ---------------------------------------------------------------- presets
  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { state.fileName = $("fileName").value; store.set("dh.state", state); }, 300);
  }
  function savePreset() {
    state.fileName = $("fileName").value;
    const name = safeName($("fileName").value) + ".json";
    download(name, JSON.stringify({ app: "digital-harvest-stitch", version: 1, settings: state }, null, 2), "application/json");
    toast(`Saved preset ${name}`);
  }
  function readJson(file, then) {
    const r = new FileReader();
    r.onload = () => { try { then(JSON.parse(r.result)); } catch (e) { toast("That file isn't valid JSON."); } };
    r.readAsText(file);
  }
  function loadPreset(file) {
    readJson(file, (j) => {
      const s = j.settings || j;
      if (!s.print || !s.stitches) { toast("That JSON isn't a Digital Harvest preset."); return; }
      state = merge(clone(DEFAULTS), s);
      levelTab = 0;
      renderAll(); onSize(); save();
      toast(`Loaded preset ${file.name}`);
    });
  }
  function saveMaterial() {
    const m = clone(state.material);
    m.name = (m.name || "Custom").trim();
    const i = customMaterials.findIndex((x) => x.name === m.name);
    if (i >= 0) customMaterials[i] = m; else customMaterials.push(m);
    store.set("dh.materials", customMaterials);
    download(safeName(m.name) + ".material.json", JSON.stringify(m, null, 2), "application/json");
    renderMaterial();
    toast(`Saved material “${m.name}”`);
  }
  function loadMaterial(file) {
    readJson(file, (m) => {
      if (typeof m.nozzleTemp !== "number") { toast("That JSON isn't a material preset."); return; }
      m.name = m.name || file.name.replace(/\..*$/, "");
      customMaterials = customMaterials.filter((x) => x.name !== m.name).concat([m]);
      store.set("dh.materials", customMaterials);
      state.material = merge(clone(DEFAULTS.material), m);
      renderMaterial(); onGcode(); save();
      toast(`Loaded material “${m.name}”`);
    });
  }

  // ---------------------------------------------------------------- image input
  function loadFile(file) {
    if (!file || !/^image\//.test(file.type)) { toast("Choose a PNG or JPG image."); return; }
    const img = new Image();
    img.onload = () => {
      setSource(img, file.name);
      const stem = file.name.replace(/\.[^.]+$/, "");
      $("fileName").value = safeName(stem); save();
    };
    img.onerror = () => toast("That image couldn't be read.");
    img.src = URL.createObjectURL(file);
  }

  // ---------------------------------------------------------------- wire up
  function init() {
    renderAll();
    $("imgFile").addEventListener("change", (e) => loadFile(e.target.files[0]));
    $("useSample").addEventListener("click", () => setSource(DH.sampleCanvas(), "Sample: fern UV texture"));
    const drop = $("drop");
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => loadFile(e.dataTransfer.files[0]));
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });

    $("viewTabs").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      view = b.dataset.view;
      $("viewTabs").querySelectorAll("button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      updateLegend(); redraw();
    }));
    $("layerSlider").addEventListener("input", () => { updateLayerLabel(); redraw(); });
    ["showTravel", "colourByLayer", "wholeBed"].forEach((id) => $(id).addEventListener("change", () => { updateLegend(); redraw(); }));
    $("exportGcode").addEventListener("click", exportGcode);
    $("testSquare").addEventListener("click", exportTestSquare);
    $("savePreset").addEventListener("click", savePreset);
    $("presetFile").addEventListener("change", (e) => { if (e.target.files[0]) loadPreset(e.target.files[0]); e.target.value = ""; });
    $("saveMaterial").addEventListener("click", saveMaterial);
    $("materialFile").addEventListener("change", (e) => { if (e.target.files[0]) loadMaterial(e.target.files[0]); e.target.value = ""; });
    $("fileName").addEventListener("change", save);
    $("useTraced").addEventListener("click", useTracedColours);
    $("dimWidth").addEventListener("input", () => { state.import.widthMm = +$("dimWidth").value; onSize(); save(); });
    new ResizeObserver(() => redraw()).observe($("canvasWrap"));
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);

    // Start empty: nothing is shown until an image is loaded (or the sample is picked).
    $("thumb").hidden = true;
    $("dimH").textContent = "–";
    redraw();
  }

  // Exposed for debugging in the console.
  DH.app = { get state() { return state; }, get result() { return result; }, generate };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})(globalThis.DH = globalThis.DH || {});
