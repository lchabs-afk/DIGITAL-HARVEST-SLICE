# Digital Harvest Stitch

Step 3 of **Digital Harvest**: *picking* (3D-scanning nature with Polycam) → *pressing* (the 2D UV texture from Blender's UV editor) → **embroidering** (printing that texture directly onto textile).

This browser app turns the pressed UV texture into stamp-like shapes, like Photoshop's Stamp filter, and writes the G-code itself, with no slicer. Fill paths imitate embroidery stitches, and up to five height levels build a stepped relief, each in its own filament colour.

Everything runs in the browser. No server, no install, and your image never leaves your computer.

## Use it

- **Online:** open the GitHub Pages URL for this repo.
- **Offline:** download the repo and open `index.html`, or run `python3 -m http.server` in the folder and open http://localhost:8000.

### The five panels

1. **Import:** drop a PNG/JPG, set the output width in mm (the height follows the aspect ratio), and offset it from the bed centre. Transparent pixels are never printed.
2. **Stamp:** levels (black point, white point, midtones), contrast, smoothness, light/dark balance, 1–5 height levels, min feature size, path simplification, invert, and which tone is tallest.
3. **Machine & material:** a Bambu Lab printer (A1 mini, A1, P1P, P1S, X1 Carbon, H2D), nozzle, build plate, *skip auto bed leveling*, an editable material (PLA / PETG / TPU 95A, or your own saved presets), a filament colour per level, and **Export test square**.
4. **Stitch & print:** a pattern per level: *Satin* (dense zigzag), *Fill / tatami* (parallel lines, optionally rotated each layer), *Contour* (concentric inward rings), *Running stitch* (outline, optionally dashed), or *Outline + fill*. Then line width, layer height, layers per level, first-layer Z, Z offset, speeds, first-layer flow, retraction and a pause layer for sandwich mode.
5. **Preview & export:** original, stamp or toolpath view with a layer slider, travel moves dashed, colour by filament or by layer. Stats show the time and the filament length and weight per colour. **Export G-code** saves `name.gcode`.

**Save preset** / **Load preset** write and read every setting as a JSON file, e.g. `fern_satin.json`.

### Getting it onto the printer

Copy the `.gcode` file to the root of the printer's SD card and start it from the printer's screen.

**Before the first real print,** export the test square for your printer and material and print it on the bare plate. It is a 20 mm two-layer square in the middle of the bed, printed at a normal first-layer height. Plain G-code with a wrong start sequence can heat and move without extruding, and this catches that.

### Printing on fabric

- **Height:** layer 1 is printed at *First layer Z + Z offset*. The default `0 + 0` lets the plastic sink into the weave; raise the Z offset for thick or springy fabric. On a bare plate the nozzle would be blocked at Z 0, and the app warns you.
- **Leveling:** the Bambu start sequence probes the bed, and the probe can misread fabric. With *Skip auto bed leveling* on, the `G29` probe commands inside the start G-code's bed-leveling block are commented out. Level once on the bare plate first.
- **Colour changes:** when the next level has a different colour, the print lifts 5 mm and pauses with `M400 U1` at that level's first layer. Swap the filament on the printer, then resume.
- **Sandwich mode:** *Pause before layer N* pauses the same way, so you can lay fabric over the first layers.

## How it works

| File | Job |
|---|---|
| `js/stamp.js` | image → grayscale → levels → blur → posterize → despeckle → level map; signed distance field per level |
| `js/geometry.js` | exact Euclidean distance transform, marching-squares iso-contours, Douglas–Peucker simplification, scanline clipping |
| `js/stitches.js` | distance field → stitch toolpaths (outlines are iso-contours at ½, 1½ … line widths inside the edge) |
| `js/gcode.js` | toolpaths → G-code: nearest-neighbour ordering, relative E, volumetric speed cap, retraction and Z-hop, pauses, Bambu header, `;LAYER:` / `;TYPE:` / `; FEATURE:` comments |
| `js/template.js` | an interpreter for Bambu Studio's template language (`[var]`, `{expr}`, `{if}…{elsif}…{else}…{endif}`) so the official start and end G-code can be used as they are |
| `profiles/printers.js` | generated from Bambu Studio's machine profiles |
| `profiles/materials.js` | PLA, PETG, TPU 95A defaults |

Extrusion per move: `E = line_width × layer_height × length / (π × (filament_d/2)²) × flow`. Print speed is capped so `line_width × layer_height × speed ≤ max volumetric speed`.

Level *k* is printed up to `k × layers_per_level × layer_height`. Each layer prints every region whose level reaches that height, using that level's stitch pattern and colour.

### Updating or adding printers

The start, end and layer-change G-code comes from the open-source Bambu Studio profiles. To refresh them, or to add a printer to the `PRINTERS` list in the script:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/bambulab/BambuStudio.git
git -C BambuStudio sparse-checkout set resources/profiles/BBL/machine
python3 tools/import_bambu.py BambuStudio
```

### Tests

```bash
node tests/run_tests.js
```

The tests check the template interpreter, the stamp pipeline on a synthetic image, every stitch pattern, and a full G-code build for every printer, with no unresolved placeholders and no NaN moves.

## Status and roadmap

- Done: milestones 1–5 of the spec (import and stamp, Bambu profiles plus test square, all stitch patterns, height levels with manual colour change, toolpath preview, stats, presets).
- **Not yet tested on a printer.** Print the test square first on each printer.
- **H2D:** its start G-code is written for two nozzles. The app fills it in for one filament on one nozzle (`filament_map = 1`), so check that one with the test square before anything else.
- Next, milestone 6: export `.gcode.3mf` so files can go through Bambu Studio / Handy with AMS slot mapping and automatic colour changes.
