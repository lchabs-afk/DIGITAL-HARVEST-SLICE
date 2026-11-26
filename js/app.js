// Digital Harvest Stitch: UI, state, presets and the source → halftone → G-code pipeline.
(function (DH) {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- state
  const DEFAULTS = {
    input: { mode: "image", lighting: "texture" },
    import: { widthMm: 80, offX: 0, offY: 0, mirror: false },
    tone: { black: 0, white: 255, gamma: 1, contrast: 0 },
    halftone: { grid: "square", spacing: 2, angle: 45, minD: 0.5, maxD: 1.5, invert: false },
    // how dots are printed; correction comes from the dot calibration
    dotprint: { height: 0.6, flow: 1.2, dwell: 0.3, retract: 1.2, lift: 2, correction: 1 },
    printable: { minWidthMm: 0.5, alphaMask: true },
    // dots: retract, lift and travel between dots. coral: a thread between dots.
    stitch: { mode: "dots", maxThread: 6, maxThreadAuto: true, threadFlow: 0.6 },
    machine: { printer: "a1mini", nozzle: 0.4, bedType: "Textured PEI Plate", skipLeveling: true },
    material: Object.assign({}, DH.MATERIALS[0]),
    colours: [
      { name: "Moss", hex: "#4f6b3a" }, { name: "Ochre", hex: "#c08a2b" }, { name: "Madder", hex: "#a8402f" },
      { name: "Indigo", hex: "#2f45b5" }, { name: "Bark", hex: "#5b4636" },
    ],
    frame: { enabled: false, outerX: 235, outerY: 235, wall: 15, height: 10, margin: 5, clearance: 2, pauseToPlace: true },
    print: { lineWidth: 0.45, layerHeight: 0.2, layersPerLevel: 2, firstLayerZ: 0, zOffset: 0, speed: 40, firstSpeed: 15, travelSpeed: 150, firstLayerFlow: 1.1, retractMinTravel: 2, zHop: 0.4, pauseLayer: 0 },
    fileName: "digital_harvest",
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

  // Values a stored state or preset may hold that no longer exist fall back to
  // the defaults (settings of removed features are simply not copied by merge).
  function normalize(st) {
    if (!["image", "scan"].includes(st.input.mode)) st.input.mode = "image";
    if (!["texture", "lit"].includes(st.input.lighting)) st.input.lighting = "texture";
    if (!["dots", "coral"].includes(st.stitch.mode)) st.stitch.mode = "dots";
    if (!["square", "hex"].includes(st.halftone.grid)) st.halftone.grid = "square";
    st.halftone.maxD = Math.min(DH.halftone.MAX_DOT, st.halftone.maxD);
    st.halftone.minD = Math.min(st.halftone.maxD, st.halftone.minD);
    return st;
  }
  let state = normalize(merge(clone(DEFAULTS), store.get("dh.state") || {}));
  let customMaterials = store.get("dh.materials") || [];
  let view = "paths", showCalib = false;

  const get = (path) => path.split(".").reduce((o, k) => o[k], state);
  function set(path, v) {
    const ks = path.split("."), last = ks.pop();
    ks.reduce((o, k) => o[k], state)[last] = v;
  }
  const printer = () => DH.PRINTERS.find((p) => p.id === state.machine.printer) || DH.PRINTERS[0];

  // Optional magnet keep-out frame on the plate, centred on the bed. Rectangles
  // [x0, y0, x1, y1] in bed mm: outer edge, inner edge, and the safe area the
  // nozzle must stay inside (inner edge minus the margin).
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
      return `The ${state.frame.outerX} × ${state.frame.outerY} mm magnet frame is bigger than the ${pr.name} bed (${pr.bed[0]} × ${pr.bed[1]} mm).`;
    if (fg.safe[2] <= fg.safe[0] || fg.safe[3] <= fg.safe[1]) return "The magnet band and margin leave no room inside the frame.";
    if (fg.safeZ > pr.maxHeight - 1) return "The magnets are taller than this printer can clear.";
    if (box && !inside(box, fg.safe)) {
      const w = (fg.safe[2] - fg.safe[0]).toFixed(0), h = (fg.safe[3] - fg.safe[1]).toFixed(0);
      return `The design reaches into the magnet keep-out zone. Keep it within the ${w} × ${h} mm area inside the magnets: reduce the width or move the offsets.`;
    }
    return null;
  }

  // ---------------------------------------------------------------- field builder
  // size: new working grid; halftone: redo the dots; scan: re-render the 3D
  // view; paths / gcode: rebuild.
  const NEXT = { size: onSize, halftone: onHalftone, scan: updateFromScan, paths: onPaths, gcode: onGcode, none: () => {} };

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
  // 01: image or 3D scan
  function renderInput() {
    const scan = state.input.mode === "scan";
    $("inputMode").querySelectorAll("button").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.mode === state.input.mode));
      b.onclick = () => {
        if (state.input.mode === b.dataset.mode) return;
        state.input.mode = b.dataset.mode;
        renderInput(); save();
        clearSource();
      };
    });
    $("imageBtns").hidden = scan;
    $("scanBtns").hidden = !scan;
    $("f-scan").hidden = !scan;
    if (!src) {
      $("imgName").textContent = "Nothing imported yet";
      $("imgInfo").textContent = scan ? "Drop a .glb 3D scan (e.g. a Polycam export with textures)" : "Drop a PNG or JPG";
    }
    fill("f-scan", [
      { path: "input.lighting", label: "Lighting", type: "seg", wide: true, options: [["texture", "texture only"], ["lit", "lit"]], on: "scan",
        after: (v) => DH.scan3d && DH.scan3d.setLighting(v),
        help: "Texture only shows the scan's true colours, unlit. Lit adds shading, so the shape's depth shows in the dots." },
    ]);
  }

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
    el.textContent = `Print size ${state.import.widthMm.toFixed(0)} × ${heightMm().toFixed(1)} mm (height follows the source's aspect ratio).`;
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

  // 02: halftone grid, dot sizes, how dots are printed, calibration
  function renderHalftone() {
    fill("f-halftone", [
      { path: "halftone.grid", label: "Grid", type: "seg", wide: true, options: [["square", "square"], ["hex", "hexagonal"]], on: "halftone" },
      { path: "halftone.spacing", label: "Grid spacing", type: "range", min: 0.5, max: 10, step: 0.1, unit: "mm", on: "halftone",
        after: (v) => { updateMergeHint(); if (state.stitch.maxThreadAuto) { state.stitch.maxThread = Math.round(v * 3 * 100) / 100; renderStitch(); } } },
      { path: "halftone.angle", label: "Grid angle", type: "range", min: -90, max: 90, step: 1, unit: "°", on: "halftone" },
      { path: "halftone.minD", label: "Minimum dot diameter", type: "range", min: 0, max: DH.halftone.MAX_DOT, step: 0.05, unit: "mm", on: "halftone",
        after: renderCalibDots, help: "Smaller dots are dropped, so light areas stay bare fabric." },
      { path: "halftone.maxD", label: "Maximum dot diameter", type: "range", min: 0.1, max: DH.halftone.MAX_DOT, step: 0.05, unit: "mm", on: "halftone",
        after: () => { updateMergeHint(); renderCalibDots(); }, help: `The darkest areas get this size. ${DH.halftone.MAX_DOT} mm at most.` },
      { path: "halftone.invert", label: "Invert (light areas get the big dots)", type: "check", on: "halftone" },
    ]);
    const warn = document.createElement("p");
    warn.className = "hint merge-hint"; warn.id = "mergeHint";
    $("f-halftone").appendChild(warn);
    updateMergeHint();
    fill("f-dotprint", [
      { path: "dotprint.height", label: "Z rise while extruding", type: "range", min: 0.1, max: 2, step: 0.05, unit: "mm", on: "paths",
        help: "The nozzle rises this much while pushing a dot, so it doesn't sink into the blob. Dots on later layers sit on top." },
      { path: "dotprint.flow", label: "Dot flow", type: "range", min: 0.5, max: 3, step: 0.05, unit: "×", on: "paths", help: "Extra plastic per dot; fabric soaks some up." },
      { path: "dotprint.correction", label: "Size correction", type: "range", min: 0.5, max: 2, step: 0.01, unit: "×", on: "paths",
        help: "From the dot calibration: intended ÷ measured diameter. Scales the size each dot is extruded for." },
      { path: "dotprint.dwell", label: "Pause after each dot", type: "range", min: 0, max: 2, step: 0.05, unit: "s", on: "paths" },
      { path: "dotprint.retract", label: "Retraction", type: "range", min: 0, max: 4, step: 0.05, unit: "mm", on: "paths",
        help: "After each dot (dots mode), or where a coral thread breaks." },
      { path: "dotprint.lift", label: "Lift", type: "range", min: 0.4, max: 10, step: 0.1, unit: "mm", on: "paths" },
    ]);
    fill("f-tone", [
      { path: "tone.black", label: "Levels: black point", type: "range", min: 0, max: 254, step: 1, unit: "", on: "halftone" },
      { path: "tone.white", label: "Levels: white point", type: "range", min: 1, max: 255, step: 1, unit: "", on: "halftone" },
      { path: "tone.gamma", label: "Levels: midtones (gamma)", type: "range", min: 0.2, max: 4, step: 0.05, unit: "", on: "halftone" },
      { path: "tone.contrast", label: "Contrast", type: "range", min: -90, max: 90, step: 1, unit: "", on: "halftone" },
    ]);
    fill("f-printable", [
      { path: "printable.minWidthMm", label: "Smallest printable dot", type: "range", min: 0, max: 1.5, step: 0.05, unit: "mm", on: "halftone",
        help: "Dots smaller than this can't be printed reliably and are removed. Shown in red on the halftone tab." },
      { path: "printable.alphaMask", label: "Never print transparent pixels", type: "check", on: "halftone",
        help: "Transparent areas (and the empty space around a 3D scan) get no dots." },
    ]);
    renderCalibDots();
  }
  function updateMergeHint() {
    const el = $("mergeHint"), h = state.halftone;
    if (!el) return;
    el.hidden = !DH.halftone.merges(h);
    el.textContent = `Grid spacing (${h.spacing} mm) is smaller than the largest dot (${Math.min(DH.halftone.MAX_DOT, h.maxD)} mm): dark dots will merge.`;
  }
  const calibRow = () => {
    const pr = printer();
    return DH.halftone.calibration(state.halftone.minD, state.halftone.maxD, pr.bed[0] / 2, pr.bed[1] / 2, 10);
  };
  function renderCalibDots() {
    const sel = $("calibDot"), keep = sel.value;
    sel.innerHTML = "";
    for (const c of calibRow()) {
      const o = document.createElement("option");
      o.value = c.n; o.textContent = `${c.n} · ${c.d.toFixed(2)} mm`;
      sel.appendChild(o);
    }
    if (keep) sel.value = keep;
  }

  // 03: stitch mode and print settings
  function renderStitch() {
    const coral = state.stitch.mode === "coral";
    const specs = [
      { path: "stitch.mode", label: "Stitch mode", type: "seg", wide: true, options: [["dots", "dots"], ["coral", "coral"]], after: () => renderStitch(),
        help: coral
          ? "Coral: no lift or retraction between dots; a thin thread is extruded to the next dot, along the grid rows in a serpentine, so threads never cross."
          : "Dots: retract, lift and travel between dots, in nearest-neighbour order." },
    ];
    if (coral) specs.push(
      { path: "stitch.maxThread", label: "Max thread length", type: "range", min: 0.5, max: 30, step: 0.1, unit: "mm",
        after: () => { state.stitch.maxThreadAuto = false; },
        help: "If the next dot is further away, the thread breaks: retract, lift and travel. Follows 3× the grid spacing until you change it." },
      { path: "stitch.threadFlow", label: "Thread flow", type: "range", min: 0.1, max: 2, step: 0.05, unit: "×",
        help: "Plastic in the thread, as a share of a normal line. Lower makes it thinner than the dots." },
    );
    fill("f-stitch", specs);
  }

  function renderPrint() {
    fill("f-print", [
      { path: "print.layersPerLevel", label: "Layers", type: "range", min: 1, max: 20, step: 1, unit: "", help: "The same dots, stacked this many times." },
      { path: "print.lineWidth", label: "Line width", type: "range", min: 0.1, max: 2, step: 0.01, unit: "mm", help: "Used for the coral thread and the test square." },
      { path: "print.layerHeight", label: "Layer height", type: "range", min: 0.04, max: 0.6, step: 0.01, unit: "mm" },
      { path: "print.pauseLayer", label: "Pause before layer", type: "range", min: 0, max: 200, step: 1, unit: "" },
      { path: "print.firstLayerZ", label: "First layer Z", type: "range", min: 0, max: 1, step: 0.01, unit: "mm", on: "gcode" },
      { path: "print.zOffset", label: "Z offset (fabric)", type: "range", min: -1, max: 5, step: 0.01, unit: "mm", on: "gcode" },
      { path: "print.speed", label: "Thread speed", type: "range", min: 5, max: 300, step: 1, unit: "mm/s", on: "gcode" },
      { path: "print.firstSpeed", label: "First-layer speed", type: "range", min: 3, max: 100, step: 1, unit: "mm/s", on: "gcode" },
      { path: "print.travelSpeed", label: "Travel speed", type: "range", min: 20, max: 500, step: 5, unit: "mm/s", on: "gcode" },
      { path: "print.firstLayerFlow", label: "First-layer flow", type: "range", min: 0.5, max: 2, step: 0.01, unit: "×", on: "gcode" },
    ]);
  }

  // 04: machine, material, filament colour, magnet frame
  function renderMachine() {
    const p = printer();
    fill("f-machine", [
      { path: "machine.printer", label: "Printer", type: "select", options: DH.PRINTERS.map((x) => [x.id, "Bambu Lab " + x.name]), on: "paths",
        after: () => { renderMachine(); renderCalibDots(); } },
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
      { path: "frame.enabled", label: "Magnet keep-out frame", type: "check", on: "gcode", after: () => renderFrame(),
        help: "An imaginary frame around the plate where the magnets holding the fabric sit. The nozzle never goes down inside it, and any move that crosses it happens above the magnets." },
    ];
    if (f.enabled) specs.push(
      { path: "frame.outerX", label: "Frame outer width (X)", type: "range", min: 50, max: 350, step: 1, unit: "mm", on: "gcode", after: updateFrameLine },
      { path: "frame.outerY", label: "Frame outer depth (Y)", type: "range", min: 50, max: 350, step: 1, unit: "mm", on: "gcode", after: updateFrameLine },
      { path: "frame.wall", label: "Magnet band width", type: "range", min: 1, max: 50, step: 0.5, unit: "mm", on: "gcode", after: updateFrameLine },
      { path: "frame.height", label: "Magnet height", type: "range", min: 1, max: 40, step: 0.5, unit: "mm", on: "gcode", after: updateFrameLine },
      { path: "frame.margin", label: "Extra margin inside the band", type: "range", min: 0, max: 40, step: 0.5, unit: "mm", on: "gcode", after: updateFrameLine,
        help: "Extra distance between the nozzle and the magnets. The toolhead around the nozzle is wider, so raise this if it gets close to them." },
      { path: "frame.clearance", label: "Clearance above the magnets", type: "range", min: 0.5, max: 20, step: 0.5, unit: "mm", on: "gcode", after: updateFrameLine },
      { path: "frame.pauseToPlace", label: "Pause to lay the fabric and magnets after the start routine", type: "check", on: "gcode",
        help: "The printer's own start routine (purge line, calibration, leveling) moves low across the plate and could hit magnets. With this on, the print pauses after it, raised above magnet height, so you can put them on then." },
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
    el.textContent = `[ inside: ${iw.toFixed(0)} × ${ih.toFixed(0)} mm ]  [ nozzle area: ${Math.max(0, sw).toFixed(0)} × ${Math.max(0, sh).toFixed(0)} mm ]  [ crosses the magnets at z ${fg.safeZ.toFixed(1)} mm ]`;
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

  // One filament colour (dots are a single level).
  function renderColours() {
    const c = $("colours");
    c.innerHTML = "";
    const col = state.colours[0];
    const row = document.createElement("div");
    row.className = "colour-row";
    row.innerHTML = `<span class="lv">dots</span><input type="color" aria-label="Filament colour" id="col_0"><input type="text" aria-label="Filament name" id="colname_0">`;
    const [pick, name] = row.querySelectorAll("input");
    pick.value = col.hex; name.value = col.name;
    pick.addEventListener("input", () => { col.hex = pick.value; redraw(); updateLegend(); save(); });
    name.addEventListener("change", () => { col.name = name.value || "Filament"; onGcode(); save(); });
    c.appendChild(row);
    $("f-colour").innerHTML = "";
  }

  function renderAll() {
    renderInput(); renderImport(); renderHalftone(); renderStitch(); renderPrint(); renderMachine(); renderMaterial(); renderColours();
    $("fileName").value = state.fileName || $("fileName").value;
  }

  // ---------------------------------------------------------------- pipeline
  // src: an image, or the rendered view of the 3D scan (a canvas)
  let src = null, srcName = "", srcImage = null;
  let grid = null, base = null, tone = null, hdots = null, hremoved = [];
  let pathCache = null, result = null, error = null, genToken = 0, stale = true;

  const heightMm = () => (src ? (state.import.widthMm * src.height) / src.width : 0);

  function setSource(img, name, info) {
    src = img; srcName = name;
    $("imgName").textContent = name;
    $("imgInfo").textContent = info || `${img.width} × ${img.height} px`;
    $("thumb").src = img instanceof HTMLCanvasElement ? img.toDataURL("image/png") : img.src;
    $("thumb").hidden = false;
    $("emptyState").hidden = true;
    onSize();
  }
  function clearSource() {
    src = null; srcImage = null; hdots = null; result = null; base = null;
    $("thumb").hidden = true;
    $("emptyState").hidden = false;
    $("dimH").textContent = "–";
    $("stats").hidden = true;
    $("warnings").innerHTML = "";
    if (state.input.mode !== "scan") $("scanView").hidden = true;
    redraw();
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
    onHalftone();
  }

  // Image tones after levels / contrast: lightness 0 (black) … 1 (white).
  function toneMap() {
    const t = state.tone, n = base.gray.length, out = new Float32Array(n);
    const lo = t.black / 255, hi = Math.max(lo + 1 / 255, t.white / 255), g = 1 / Math.max(0.05, t.gamma);
    const c = t.contrast / 100, cf = c >= 0 ? 1 / Math.max(0.02, 1 - c) : 1 + c;
    for (let i = 0; i < n; i++) {
      let v = Math.min(1, Math.max(0, (base.gray[i] - lo) / (hi - lo)));
      v = Math.pow(v, g);
      out[i] = Math.min(1, Math.max(0, (v - 0.5) * cf + 0.5));
    }
    return out;
  }

  // Halftone: dots straight from the source, no vectorizing.
  function onHalftone() {
    if (!base) return;
    tone = toneMap();
    const all = DH.halftone.dots(tone, state.printable.alphaMask ? base.alpha : null, grid.w, grid.h, grid.p, state.halftone);
    const f = DH.halftone.filter(all, state.printable.minWidthMm);
    hdots = f.dots; hremoved = f.removed;
    onPaths();
    if (view === "halftone") redraw();
  }
  function onPaths() { pathCache = null; onGcode(); }
  let genTimer = 0;
  function onGcode() {
    stale = true;
    clearTimeout(genTimer);
    genTimer = setTimeout(() => generate(), 350);
  }

  // ---- 3D scan input: the current view of the model is the source
  function scanReady() { return !!(DH.scan3d && DH.scan3d.loaded); }
  function updateFromScan() {
    if (state.input.mode !== "scan" || !scanReady()) return;
    const c = DH.scan3d.renderSource(1200);
    if (!c) { toast("The model is out of view: reset the view."); return; }
    setSource(c, srcName || "3D scan", `${c.width} × ${c.height} px rendered from the current view · ${state.input.lighting === "lit" ? "lit" : "texture only"}`);
  }
  async function loadScan(file) {
    if (!/\.glb$/i.test(file.name)) { toast("Choose a .glb file (a binary glTF, as Polycam exports)."); return; }
    if (!DH.scan3d) { toast("The 3D viewer is still loading; try again in a moment."); return; }
    state.input.mode = "scan"; renderInput(); save();
    setView("source");
    try {
      srcName = file.name;
      await DH.scan3d.load(file, $("scanView"));
      DH.scan3d.setLighting(state.input.lighting);
      DH.scan3d.onRelease(updateFromScan);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      updateFromScan();
      $("fileName").value = safeName(file.name.replace(/\.[^.]+$/, "")); save();
    } catch (e) {
      console.error(e);
      toast("That 3D scan couldn't be read: " + (e.message || e));
    }
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  function printSettings() {
    const p = state.print;
    return Object.assign({}, p, {
      nozzle: state.machine.nozzle, bedType: state.machine.bedType, skipLeveling: state.machine.skipLeveling, colourChanges: false,
    });
  }

  function placement() {
    const pr = printer(), W = state.import.widthMm, H = heightMm();
    return { x0: pr.bed[0] / 2 + state.import.offX - W / 2, y0: pr.bed[1] / 2 + state.import.offY - H / 2, W, H };
  }

  // The halftone dots on the bed as printable paths.
  //   dots:  single Dot paths, ordered nearest-neighbour by the G-code writer
  //   coral: serpentine chains along the grid rows; each chain is one Coral path
  //          (a dot at every point, a thread between them), kept in that order
  function dotPaths() {
    const pl = placement(), d = state.dotprint;
    const dot = { h: d.height, flow: d.flow, dwell: d.dwell, retract: d.retract, lift: d.lift, correction: d.correction };
    const bed = (q) => [pl.x0 + (state.import.mirror ? pl.W - q.x : q.x), pl.y0 + q.y];
    if (state.stitch.mode !== "coral") return hdots.map((q) => ({ pts: [bed(q)], closed: false, type: "Dot", d: q.d, dot }));
    return DH.halftone.coralChains(hdots, state.stitch.maxThread).map((chain) => (chain.length === 1
      ? { pts: [bed(chain[0])], closed: false, type: "Dot", d: chain[0].d, dot, keepOrder: true }
      : { pts: chain.map(bed), ds: chain.map((q) => q.d), knots: chain.map(() => 1), d: chain[0].d, closed: false, type: "Coral", dot,
          coral: { threadFlow: state.stitch.threadFlow }, keepOrder: true }));
  }

  async function generate() {
    const token = ++genToken;
    if (!hdots) return;
    $("busy").hidden = false;
    await tick();
    try {
      if (!pathCache) pathCache = dotPaths();
      const L = Math.max(1, Math.round(state.print.layersPerLevel));
      const layers = Array.from({ length: L }, () => ({ colour: 0, paths: pathCache })); // the same dots on every layer, so they stack
      if (token !== genToken) return;
      result = DH.gcode.build({ name: srcName, printer: printer(), material: state.material, print: printSettings(), layers, colours: state.colours, frame: frameGeom() });
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
  // The dot calibration row on the bed, numbered, at its real size.
  function drawCalibration() {
    const pr = printer(), row = calibRow();
    const pad = 6, box = [row[0].x - pad, row[0].y - pad, row[row.length - 1].x + pad, row[0].y + pad];
    DH.preview.calibration($("view"), { bed: pr.bed, exclude: pr.excludeArea, frame: frameGeom(), box, row, colour: state.colours[0].hex });
  }

  function redraw() {
    const canvas = $("view");
    // the 3D viewport replaces the canvas on the source tab for scans
    const scanShown = view === "source" && state.input.mode === "scan" && scanReady();
    $("scanView").hidden = !scanShown;
    if (scanShown && DH.scan3d) DH.scan3d.mount($("scanView"));
    canvas.hidden = scanShown;
    $("pathControls").hidden = view !== "paths" || showCalib;
    $("legend").hidden = view === "source";
    if (view === "paths" && showCalib) { drawCalibration(); return; }
    if (!src) { const g = canvas.getContext("2d"); g.clearRect(0, 0, canvas.width, canvas.height); return; }
    if (view === "source") { if (!scanShown) DH.preview.fitImage(canvas, src, 14); return; }
    if (view === "halftone") {
      if (!hdots) return;
      DH.preview.fitImage(canvas, DH.preview.dotsCanvas(hdots, hremoved, grid.w * grid.p, grid.h * grid.p, state.colours[0].hex), 14);
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
    $("layerLabel").textContent = `${j}/${n} · Z ${L.z.toFixed(2)}`;
  }

  function updateLegend() {
    const el = $("legend");
    el.innerHTML = "";
    const add = (html) => { const s = document.createElement("span"); s.innerHTML = html; el.appendChild(s); };
    if (view === "paths" && showCalib) { add("dot calibration: number · intended diameter (printed with size correction 1×) · click a tab to go back"); return; }
    if (view === "paths" && $("colourByLayer").checked) {
      add(`<i style="background:${DH.preview.layerHue(0, 2)}"></i>first layer`);
      add(`<i style="background:${DH.preview.layerHue(1, 2)}"></i>last layer`);
    } else add(`<i style="background:${state.colours[0].hex};height:8px;width:8px;border-radius:50%"></i>dots (${escapeHtml(state.colours[0].name)})`);
    if (view === "paths" && state.stitch.mode === "coral") add(`<i style="background:${state.colours[0].hex};height:1px"></i>coral thread`);
    if (view === "paths" && $("showTravel").checked) add(`<i class="travel"></i>travel (current layer)`);
    if (view === "halftone") add(`<i style="background:#d62828;height:8px;width:8px;border-radius:50%"></i>removed by the printability filter`);
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
    const add = (k, v) => { const span = document.createElement("span"); span.innerHTML = `[ ${k}: ${v} ]`; el.appendChild(span); };
    add("printer", escapeHtml(printer().name.toLowerCase()));
    add("size", `${pl.W.toFixed(0)} × ${pl.H.toFixed(1)} mm`);
    add("stitch", state.stitch.mode);
    add("dots", (s.dots + s.knots).toLocaleString("en"));
    if (s.knots) add("threads", (result.layers[0].paths.filter((p) => p.type === "Coral").length).toLocaleString("en"));
    add("layers", s.layers);
    add("time", fmtTime(s.time) + " + start");
    add("filament", `${(s.filamentMm / 1000).toFixed(2)} m · ${s.filamentG.toFixed(1)} g`);
    add("pauses", s.pauses.length);
  }

  function updateWarnings() {
    const ul = $("warnings");
    ul.innerHTML = "";
    const add = (cls, text) => { const li = document.createElement("li"); if (cls) li.className = cls; li.textContent = text; ul.appendChild(li); };
    if (error) { add("bad", "G-code could not be written: " + error); return; }
    const pr = printer(), pl = placement(), s = state.print;
    if (pl.x0 < 0 || pl.y0 < 0 || pl.x0 + pl.W > pr.bed[0] || pl.y0 + pl.H > pr.bed[1])
      add("bad", `The design (${pl.W.toFixed(0)} × ${pl.H.toFixed(0)} mm) runs off the ${pr.name} bed (${pr.bed[0]} × ${pr.bed[1]} mm). Reduce the width or the offsets.`);
    if (pr.excludeArea) {
      const [a, b, c, d] = pr.excludeArea;
      if (pl.x0 < c && pl.x0 + pl.W > a && pl.y0 < d && pl.y0 + pl.H > b) add("", "The design overlaps the printer's excluded corner (the purge chute area).");
    }
    if (hdots && !hdots.length) add("bad", "Nothing to print: every dot is under the minimum size. Lower the minimum dot diameter or the smallest printable dot, or adjust the levels.");
    const z1 = s.firstLayerZ + s.zOffset;
    if (z1 < 0.05) add("info", `Layer 1 prints with the nozzle at Z ${z1.toFixed(2)} mm. That's meant for fabric. Set Z offset to your fabric's compressed thickness if needed.`);
    if (DH.halftone.merges(state.halftone))
      add("", `Grid spacing (${state.halftone.spacing} mm) is smaller than the largest dot (${Math.min(DH.halftone.MAX_DOT, state.halftone.maxD)} mm): dark dots will merge.`);
    if (state.stitch.mode === "coral" && state.stitch.maxThread < state.halftone.spacing)
      add("", `Max thread length (${state.stitch.maxThread} mm) is shorter than the grid spacing (${state.halftone.spacing} mm), so every thread breaks: this prints like dots.`);
    if (result && result.stats.pauses.length) {
      const list = result.stats.pauses.map((p) => `layer ${p.layer} (${p.why})`).join("; ");
      add("info", `The print pauses ${result.stats.pauses.length}× with M400 U1: ${list}.`);
    }
    if (s.pauseLayer > (result ? result.stats.layers : 0)) add("", `Pause before layer ${s.pauseLayer} never happens: the print has ${result ? result.stats.layers : 0} layers.`);
    const fp = frameProblem(result && result.box);
    if (fp) add("bad", fp);
    if (state.frame.enabled && !state.frame.pauseToPlace)
      add("", "The printer's start routine (purge line, calibration, leveling) moves low across the plate and could hit magnets that are already on. Lay the fabric and magnets after it, or turn on the pause.");
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
    if (!result) { toast(error ? "Fix the error shown in the preview panel first." : (src ? "Nothing to export yet." : "Import an image or a 3D scan first.")); return; }
    if (!result.stats.dots && !result.stats.knots) { toast("Nothing to print: adjust the halftone settings."); return; }
    const fp = frameProblem(result.box);
    if (fp) { toast("Not exported: " + fp); return; }
    const name = safeName($("fileName").value) + ".gcode";
    download(name, result.text);
    toast(`Saved ${name}`);
  }

  function setView(v) {
    view = v; showCalib = false;
    $("viewTabs").querySelectorAll("button").forEach((x) => x.setAttribute("aria-selected", String(x.dataset.view === v)));
    updateLegend(); redraw();
  }
  function showCalibration() {
    setView("paths");
    showCalib = true;
    updateLegend(); redraw();
  }

  // Dot calibration: 10 dots from the minimum to the maximum diameter in the
  // middle of the bed, one layer, printed with the size correction at 1× so the
  // measurements show what the printer really makes of each size.
  function exportCalibration() {
    const pr = printer(), row = calibRow(), d = state.dotprint;
    const dot = { h: d.height, flow: d.flow, dwell: d.dwell, retract: d.retract, lift: d.lift, correction: 1 };
    const fp = frameProblem([row[0].x - 2, row[0].y - 2, row[row.length - 1].x + 2, row[0].y + 2]);
    if (fp) { toast("Not exported: " + fp); return; }
    const paths = row.map((c) => ({ pts: [[c.x, c.y]], closed: false, type: "Dot", d: c.d, dot, keepOrder: true }));
    const s = Object.assign(printSettings(), { pauseLayer: 0, layersPerLevel: 1 });
    try {
      const r = DH.gcode.build({ name: "dot calibration", printer: pr, material: state.material, print: s, layers: [{ colour: 0, paths }], colours: state.colours, frame: frameGeom() });
      const name = `dot_calibration_${pr.id}_${state.material.type.toLowerCase()}.gcode`;
      download(name, r.text);
      toast(`Saved ${name}`);
      showCalibration();
    } catch (e) { toast("Dot calibration failed: " + e.message); }
  }
  // One measured dot → size correction = intended ÷ measured diameter.
  function applyCalibration() {
    const c = calibRow().find((q) => q.n === +$("calibDot").value), measured = parseFloat($("calibMeasured").value);
    if (!c || !(measured > 0)) { toast("Enter the measured diameter of a calibration dot."); return; }
    const k = Math.min(2, Math.max(0.5, Math.round((c.d / measured) * 100) / 100));
    state.dotprint.correction = k;
    renderHalftone(); onPaths(); save();
    toast(`Size correction set to ${k}× (dot ${c.n}: ${c.d.toFixed(2)} mm intended, ${measured} mm measured)`);
  }

  function exportTestSquare() {
    const pr = printer();
    const s = Object.assign(printSettings(), { firstLayerZ: state.print.layerHeight, zOffset: 0, pauseLayer: 0 });
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
    download(name, JSON.stringify({ app: "digital-harvest-stitch", version: 2, settings: state }, null, 2), "application/json");
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
      if (!s.print || !s.machine) { toast("That JSON isn't a Digital Harvest preset."); return; }
      const mode = state.input.mode;
      state = normalize(merge(clone(DEFAULTS), s));
      state.input.mode = mode; // a preset doesn't switch away from what is imported
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

  // ---------------------------------------------------------------- input files
  function loadImage(file) {
    if (!file || !/\.(png|jpe?g)$/i.test(file.name) && !/^image\/(png|jpeg)$/.test(file.type)) { toast("Choose a PNG or JPG image."); return; }
    const img = new Image();
    img.onload = () => {
      state.input.mode = "image"; renderInput(); $("scanView").hidden = true;
      srcImage = img;
      setSource(img, file.name);
      $("fileName").value = safeName(file.name.replace(/\.[^.]+$/, "")); save();
    };
    img.onerror = () => toast("That image couldn't be read.");
    img.src = URL.createObjectURL(file);
  }
  function loadAny(file) {
    if (!file) return;
    if (/\.glb$/i.test(file.name)) loadScan(file); else loadImage(file);
  }

  // ---------------------------------------------------------------- wire up
  function init() {
    renderAll();
    $("imgFile").addEventListener("change", (e) => { loadImage(e.target.files[0]); e.target.value = ""; });
    $("scanFile").addEventListener("change", (e) => { if (e.target.files[0]) loadScan(e.target.files[0]); e.target.value = ""; });
    $("useSample").addEventListener("click", () => { state.input.mode = "image"; renderInput(); srcName = "Sample: fern UV texture"; setSource(DH.sampleCanvas(), srcName); });
    $("resetView").addEventListener("click", () => DH.scan3d && DH.scan3d.resetView());
    const drop = $("drop");
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => loadAny(e.dataTransfer.files[0]));
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) loadAny(e.dataTransfer.files[0]); });

    $("viewTabs").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
    $("layerSlider").addEventListener("input", () => { updateLayerLabel(); redraw(); });
    ["showTravel", "colourByLayer", "wholeBed"].forEach((id) => $(id).addEventListener("change", () => { updateLegend(); redraw(); }));
    $("exportGcode").addEventListener("click", exportGcode);
    $("testSquare").addEventListener("click", exportTestSquare);
    $("savePreset").addEventListener("click", savePreset);
    $("presetFile").addEventListener("change", (e) => { if (e.target.files[0]) loadPreset(e.target.files[0]); e.target.value = ""; });
    $("saveMaterial").addEventListener("click", saveMaterial);
    $("materialFile").addEventListener("change", (e) => { if (e.target.files[0]) loadMaterial(e.target.files[0]); e.target.value = ""; });
    $("fileName").addEventListener("change", save);
    $("exportCalib").addEventListener("click", exportCalibration);
    $("showCalib").addEventListener("click", showCalibration);
    $("calibApply").addEventListener("click", applyCalibration);
    $("dimWidth").addEventListener("input", () => { state.import.widthMm = +$("dimWidth").value; onSize(); save(); });
    new ResizeObserver(() => redraw()).observe($("canvasWrap"));
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);

    // Start empty: nothing is shown until something is imported (or the sample is picked).
    $("thumb").hidden = true;
    $("dimH").textContent = "–";
    redraw();
  }

  // Exposed for debugging and tests in the console.
  DH.app = { get state() { return state; }, get result() { return result; }, get dots() { return hdots; }, generate };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})(globalThis.DH = globalThis.DH || {});
