// Toolpaths → Bambu-flavoured G-code.
// Relative extrusion (M83). E = width × height × length / filament area × flow.
(function (DH) {
  "use strict";
  const TYPES = ["Travel", "Outline", "Satin", "Tatami", "Contour", "Running"];
  const FEATURE = { Outline: "Outer wall", Satin: "Sparse infill", Tatami: "Internal solid infill", Contour: "Inner wall", Running: "Outer wall" };

  const f3 = (v) => (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, "") || "0";
  const f5 = (v) => (Math.round(v * 100000) / 100000).toFixed(5).replace(/\.?0+$/, "") || "0";

  // Nearest-neighbour ordering. Closed loops may start at any vertex,
  // open paths may be reversed.
  function orderPaths(paths, start) {
    const left = paths.slice();
    const out = [];
    let cx = start[0], cy = start[1];
    while (left.length) {
      let best = -1, bestD = Infinity, bestIdx = 0, bestRev = false;
      for (let i = 0; i < left.length; i++) {
        const p = left[i], pts = p.pts;
        if (p.closed) {
          for (let k = 0; k < pts.length; k++) {
            const d = (pts[k][0] - cx) ** 2 + (pts[k][1] - cy) ** 2;
            if (d < bestD) { bestD = d; best = i; bestIdx = k; bestRev = false; }
          }
        } else {
          const a = pts[0], b = pts[pts.length - 1];
          const da = (a[0] - cx) ** 2 + (a[1] - cy) ** 2, db = (b[0] - cx) ** 2 + (b[1] - cy) ** 2;
          if (da < bestD) { bestD = da; best = i; bestRev = false; }
          if (db < bestD) { bestD = db; best = i; bestRev = true; }
        }
      }
      const p = left.splice(best, 1)[0];
      let pts;
      if (p.closed) pts = p.pts.slice(bestIdx).concat(p.pts.slice(0, bestIdx + 1));
      else pts = bestRev ? p.pts.slice().reverse() : p.pts;
      out.push({ pts, type: p.type });
      const last = pts[pts.length - 1];
      cx = last[0]; cy = last[1];
    }
    return out;
  }

  function bbox(layers) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const L of layers) for (const p of L.paths) for (const [x, y] of p.pts) {
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
    return isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 0, 0];
  }

  // Variables for Bambu Studio's start / end / layer-change templates.
  function templateVars(ctx) {
    const { printer, material: m, print: s, firstBox, maxZ, totalLayers } = ctx;
    const bedT = m.bedTemp;
    const vol = Math.min(m.maxVolSpeed, s.lineWidth * s.layerHeight * s.speed);
    return {
      bed_temperature_initial_layer_single: bedT,
      bed_temperature: [bedT], bed_temperature_initial_layer: [bedT],
      nozzle_temperature_initial_layer: [m.firstLayerTemp], nozzle_temperature: [m.nozzleTemp],
      initial_extruder: 0, initial_no_support_extruder: 0, initial_no_support_filament_id: 0,
      initial_nozzle_id: 0, initial_no_support_hotend: 0, filament_map: [1],
      // H2D (two nozzles): everything prints from extruder slot 1 with filament 0.
      first_non_support_filaments: [0, -1], first_filaments: [0, -1],
      nozzle_diameter: [s.nozzle], nozzle_diameter_at_nozzle_id: [s.nozzle, s.nozzle],
      filament_type: [m.type], curr_bed_type: s.bedType,
      first_layer_print_min: [firstBox[0], firstBox[1]],
      first_layer_print_size: [firstBox[2] - firstBox[0], firstBox[3] - firstBox[1]],
      first_layer_center_no_wipe_tower: [(firstBox[0] + firstBox[2]) / 2, (firstBox[1] + firstBox[3]) / 2],
      flush_temperatures: [m.nozzleTemp], flush_volumetric_speeds: [m.maxVolSpeed],
      filament_max_volumetric_speed: [m.maxVolSpeed], outer_wall_volumetric_speed: vol,
      default_acceleration: Math.min(10000, printer.maxAccel), outer_wall_acceleration: 5000,
      initial_layer_acceleration: 500, scan_first_layer: false,
      retraction_length: [m.retractLength], retraction_distances_when_cut: [18],
      retraction_distance_when_cut: 18, retraction_distance_when_ec: 0,
      long_retractions_when_cut: [0], long_retraction_when_cut: false, long_retraction_when_ec: false,
      max_layer_z: maxZ, max_print_z: maxZ, total_layer_count: totalLayers,
      spiral_mode: false, print_sequence: "by layer", is_all_bbl_filament: true,
      overall_chamber_temperature: 0, min_vitrification_temperature: m.vitrification,
      has_tpu_in_first_layer: m.type === "TPU", cooling_filter_enabled: false,
      initial_layer_print_height: s.layerHeight, layer_z: 0, layer_num: 0,
    };
  }

  // Remove the auto bed-leveling probe moves (G29 / G29.20) between the
  // ";===== bed leveling" markers. Compensation switches (G29.1/G29.2) stay.
  function stripLeveling(text) {
    const lines = text.split("\n");
    let inBlock = false, removed = 0;
    const out = lines.map((l) => {
      if (/;=+ *bed leveling end/i.test(l)) inBlock = false;
      else if (/;=+ *bed leveling/i.test(l)) inBlock = true;
      if (inBlock && /^\s*G29(\.20)?(\s|$)/.test(l)) { removed++; return ";" + l.trim() + " ; removed by Digital Harvest: skip auto bed leveling"; }
      return l;
    });
    return { text: out.join("\n"), removed };
  }

  // job: {name, printer, material, print, layers:[{band, colour, paths}], colours:[{name,hex}]}
  function build(job) {
    const { printer, material: m, print: s } = job;
    const out = [];
    const emit = (l) => out.push(l);
    const fArea = Math.PI * (m.diameter / 2) ** 2;
    const maxSpeedVol = m.maxVolSpeed / (s.lineWidth * s.layerHeight);
    const speedOf = (first) => Math.min(first ? s.firstSpeed : s.speed, maxSpeedVol, printer.maxSpeedXY);
    const layers = job.layers;
    const total = layers.length;
    const zOf = (j) => s.firstLayerZ + s.zOffset + j * s.layerHeight;
    const maxZ = total ? zOf(total - 1) : 0;
    const firstBox = bbox(layers.slice(0, 1));
    const vars = templateVars({ printer, material: m, print: s, firstBox, maxZ, totalLayers: total });

    // Pass 1: order paths and estimate time so the header and M73 are right.
    let pos = [printer.bed[0] / 2, 10];
    const plan = layers.map((L) => {
      const ordered = orderPaths(L.paths, pos);
      if (ordered.length) { const lp = ordered[ordered.length - 1].pts; pos = lp[lp.length - 1]; }
      return ordered;
    });
    let est = 0;
    const layerTime = plan.map((ordered, j) => {
      const sp = speedOf(j === 0);
      let t = 0, cx = null, cy = null;
      for (const p of ordered) {
        if (cx !== null) t += Math.hypot(p.pts[0][0] - cx, p.pts[0][1] - cy) / s.travelSpeed + 0.15;
        t += DH.geom.polylineLength(p.pts, false) / sp;
        const l = p.pts[p.pts.length - 1]; cx = l[0]; cy = l[1];
      }
      t = t * 1.15 + 2; // acceleration and layer-change allowance
      est += t;
      return t;
    });

    // Pass 2: write.
    const stats = { time: est, layers: total, perColour: {}, extrudeLen: 0, travelLen: 0, pauses: [] };
    const preview = [];
    let cx = null, cy = null, cz = 0, retracted = false, elapsed = 0;

    const retract = () => {
      if (retracted || m.retractLength <= 0) return;
      emit("G1 E-" + f5(m.retractLength) + " F" + Math.round(m.retractSpeed * 60));
      retracted = true;
    };
    const unretract = () => {
      if (!retracted) return;
      emit("G1 E" + f5(m.retractLength) + " F" + Math.round(m.retractSpeed * 60));
      retracted = false;
    };

    let prevColour = null;
    for (let j = 0; j < total; j++) {
      const L = layers[j], z = zOf(j), first = j === 0;
      const moves = [];
      const colour = L.colour;
      // Colour change or requested pause happens before this layer.
      const colourChange = s.colourChanges && prevColour !== null && colour !== prevColour;
      const sandwich = s.pauseLayer > 0 && j + 1 === s.pauseLayer && j > 0;
      if (colourChange || sandwich) {
        const why = colourChange
          ? "change filament to " + (job.colours[colour] ? job.colours[colour].name : "colour " + (colour + 1))
          : "pause before layer " + (j + 1);
        retract();
        emit("; PAUSE_PRINT: " + why);
        emit("G1 Z" + f3(Math.min(printer.maxHeight, cz + 5)) + " F600");
        emit("M400");
        emit(printer.pauseGcode || "M400 U1");
        stats.pauses.push({ layer: j + 1, why });
      }
      prevColour = colour;

      emit("; CHANGE_LAYER");
      emit("; Z_HEIGHT: " + f3(z));
      emit("; LAYER_HEIGHT: " + f3(s.layerHeight));
      emit(";LAYER:" + j);
      const lc = DH.template.render(printer.layerChangeGcode || "", Object.assign({}, vars, { layer_num: j, layer_z: z }));
      if (lc.trim()) emit(lc.trim());
      const remaining = Math.max(0, est - elapsed);
      emit("M73 P" + Math.min(99, Math.floor((elapsed / Math.max(1, est)) * 100)) + " R" + Math.round(remaining / 60));
      if (j === 1) {
        if (m.nozzleTemp !== m.firstLayerTemp) emit("M104 S" + m.nozzleTemp);
        emit("M106 S" + Math.round((m.fanRest / 100) * 255));
      }
      retract();
      emit("G1 Z" + f3(z) + " F" + Math.round(Math.min(printer.maxSpeedZ, 15) * 60));
      cz = z;

      const sp = speedOf(first);
      const flow = m.flow * (first ? s.firstLayerFlow : 1);
      const ePerMm = (s.lineWidth * s.layerHeight * flow) / fArea;
      const key = colour;
      stats.perColour[key] = stats.perColour[key] || { colour, filamentMm: 0 };
      let curType = null;

      for (const p of plan[j]) {
        const [sx, sy] = p.pts[0];
        const d = cx === null ? Infinity : Math.hypot(sx - cx, sy - cy);
        if (d > 0.001) {
          const lift = d > s.retractMinTravel;
          if (lift) {
            retract();
            if (s.zHop > 0) emit("G1 Z" + f3(z + s.zHop) + " F" + Math.round(Math.min(printer.maxSpeedZ, 15) * 60));
          }
          emit("G1 X" + f3(sx) + " Y" + f3(sy) + " F" + Math.round(s.travelSpeed * 60));
          if (lift && s.zHop > 0) emit("G1 Z" + f3(z) + " F" + Math.round(Math.min(printer.maxSpeedZ, 15) * 60));
          if (cx !== null) { moves.push(cx, cy, sx, sy, 0); stats.travelLen += d; }
        }
        unretract();
        if (p.type !== curType) {
          emit(";TYPE:" + p.type);
          emit("; FEATURE: " + (FEATURE[p.type] || "Outer wall"));
          curType = p.type;
        }
        let px = sx, py = sy, first_move = true;
        const ti = TYPES.indexOf(p.type);
        for (let k = 1; k < p.pts.length; k++) {
          const [x, y] = p.pts[k];
          const len = Math.hypot(x - px, y - py);
          if (len < 1e-4) continue;
          const e = len * ePerMm;
          emit("G1 X" + f3(x) + " Y" + f3(y) + " E" + f5(e) + (first_move ? " F" + Math.round(sp * 60) : ""));
          first_move = false;
          moves.push(px, py, x, y, ti);
          stats.extrudeLen += len;
          stats.perColour[key].filamentMm += e;
          px = x; py = y;
        }
        cx = px; cy = py;
      }
      elapsed += layerTime[j];
      preview.push({ z, colour, moves: new Float32Array(moves) });
    }
    retract();
    const body = out.splice(0, out.length);

    // Assemble: header, start, body, end.
    const minutes = (t) => { const h = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = Math.round(t % 60); return (h ? h + "h " : "") + mm + "m " + ss + "s"; };
    let filamentMm = 0;
    for (const k in stats.perColour) filamentMm += stats.perColour[k].filamentMm;
    const volCm3 = (filamentMm * fArea) / 1000;
    stats.filamentMm = filamentMm;
    stats.filamentG = volCm3 * m.density;
    for (const k in stats.perColour) {
      const pc = stats.perColour[k];
      pc.grams = ((pc.filamentMm * fArea) / 1000) * m.density;
    }

    let start = DH.template.render(printer.startGcode, vars);
    let levelingRemoved = 0;
    if (s.skipLeveling) { const r = stripLeveling(start); start = r.text; levelingRemoved = r.removed; }
    const end = DH.template.render(printer.endGcode, Object.assign({}, vars, { layer_z: maxZ }));
    stats.levelingRemoved = levelingRemoved;

    const head = [
      "; HEADER_BLOCK_START",
      "; generated by Digital Harvest Stitch",
      "; model printing time: " + minutes(est) + "; total estimated time: " + minutes(est),
      "; total layer number: " + total,
      "; total filament length [mm] : " + filamentMm.toFixed(2),
      "; total filament volume [cm^3] : " + volCm3.toFixed(2),
      "; total filament weight [g] : " + stats.filamentG.toFixed(2),
      "; filament_density: " + m.density,
      "; filament_diameter: " + m.diameter,
      "; max_z_height: " + maxZ.toFixed(2),
      "; HEADER_BLOCK_END",
      "",
      "; CONFIG_BLOCK_START",
      "; printer_model = Bambu Lab " + printer.name,
      "; source_profile = " + printer.source,
      "; nozzle_diameter = " + s.nozzle,
      "; line_width = " + s.lineWidth,
      "; layer_height = " + s.layerHeight,
      "; first_layer_z = " + s.firstLayerZ + " ; z_offset = " + s.zOffset,
      "; filament_type = " + m.type + " ; nozzle " + m.firstLayerTemp + "/" + m.nozzleTemp + " C ; bed " + m.bedTemp + " C",
      "; flow = " + m.flow + " ; first_layer_flow = " + s.firstLayerFlow,
      "; curr_bed_type = " + s.bedType,
      "; skip_auto_bed_leveling = " + (s.skipLeveling ? 1 : 0),
      "; design = " + (job.name || "untitled"),
      "; CONFIG_BLOCK_END",
      "",
      "; EXECUTABLE_BLOCK_START",
      "M73 P0 R" + Math.round(est / 60),
    ];
    const text = head.join("\n") + "\n" +
      start.trim() + "\n; MACHINE_START_GCODE_END\n" +
      "G90\nG21\nM83 ; relative extrusion\nM106 S" + Math.round((m.fanFirst / 100) * 255) + "\n" +
      body.join("\n") + "\n" +
      "; MACHINE_END_GCODE_START\n" + end.trim() + "\nM73 P100 R0\n; EXECUTABLE_BLOCK_END\n";
    return { text, preview, stats };
  }

  // A 20 × 20 mm two-layer square in the middle of the bed for checking a profile.
  function testSquare(printer, print) {
    const c = [printer.bed[0] / 2, printer.bed[1] / 2], hs = 10;
    const sq = [[c[0] - hs, c[1] - hs], [c[0] + hs, c[1] - hs], [c[0] + hs, c[1] + hs], [c[0] - hs, c[1] + hs]];
    const paths = [{ pts: sq, closed: true, type: "Outline" }];
    // Solid fill lines inside the outline.
    const w = print.lineWidth;
    for (let y = c[1] - hs + w, k = 0; y < c[1] + hs - w * 0.5; y += w, k++) {
      const a = [c[0] - hs + w * 0.85, y], b = [c[0] + hs - w * 0.85, y];
      paths.push({ pts: k % 2 ? [b, a] : [a, b], closed: false, type: "Tatami" });
    }
    return [{ colour: 0, paths }, { colour: 0, paths }];
  }

  DH.gcode = { build, bbox, orderPaths, stripLeveling, templateVars, testSquare, TYPES };
})(globalThis.DH = globalThis.DH || {});
