# Digital Harvest Stitch

Step 3 of **Digital Harvest**: *picking* (3D-scanning nature with Polycam) → *pressing* (the 2D UV texture from Blender's UV editor) → **embroidering** (printing that texture directly onto textile).

This browser app turns a pressed UV texture or a 3D scan into **halftone dots**, sized by the source's tones, and writes the G-code itself, with no slicer. The dots are printed either as separate stationary blobs (**dots**) or joined by a thin extruded thread (**coral**).

Everything runs in the browser. No server, no install, and your files never leave your computer.

## Use it

- **Online:** open the GitHub Pages URL for this repo.
- **Offline:** download the repo, run `python3 -m http.server` in the folder and open http://localhost:8000. Opening `index.html` directly from disk works for images, but browsers block the 3D viewer's modules on `file://`.

### The five panels

1. **Import:** choose **image** or **3D scan**, set the output width in mm (the height follows the source's aspect ratio), and offset it from the bed centre.
   - **Image:** a PNG or JPG is the halftone source directly. Transparent pixels get no dots.
   - **3D scan:** a `.glb` (e.g. a Polycam export with textures) opens in a 3D viewport on the preview's *source* tab: drag to rotate, scroll to zoom, right-drag to pan, *reset view* to go back. The current view is rendered with a transparent background as the halftone source, so empty space gets no dots, and the halftone updates when you let go of the mouse. **Lighting:** *texture only* (unlit, the scan's true colours) or *lit* (shading adds depth). Draco- or meshopt-compressed `.glb` files aren't supported; export uncompressed.
2. **Halftone:** the source is sampled on a grid. Each cell becomes a dot whose diameter follows the darkness there: the printed area grows with darkness, so the diameter is *max* × √darkness. Dots under the minimum are dropped, so light areas stay bare fabric.
   - **Grid:** *square* or *hexagonal*, with **grid spacing** (2 mm by default) and **grid angle** (45° by default).
   - **Minimum and maximum dot diameter:** 0.5 and 1.5 mm by default. 1.5 mm is a hard limit.
   - **Invert:** the big dots go in the light areas.
   - **Merge warning:** if the spacing is smaller than the largest dot, the app warns that dots will merge.
   - **Image:** levels (black point, white point, midtones) and contrast, applied before sampling.
   - **Printability:** dots smaller than the *smallest printable dot* are removed and shown in red on the *halftone* tab.
   - **Dot printing:** Z rise while extruding, dot flow, size correction, pause after each dot, retraction and lift.
   - **Dot calibration:** *export dot calibration* prints a row of 10 dots from the minimum to the maximum diameter, with the size correction at 1×. They're numbered with their intended diameter in the toolpath preview. Measure one dot, enter its number and measured diameter, and *set correction* sets **size correction** to intended ÷ measured. It scales the size each dot is extruded for, so printed dots match the halftone.
3. **Stitch & print:** choose a stitch mode. Both print every halftone dot as a stationary blob, with no movement while extruding and a small Z rise so the nozzle doesn't sink into it, its amount sized from the dot's halftone diameter.
   - **Dots:** between dots, retract, lift and travel, in nearest-neighbour order to keep travel short.
   - **Coral:** between dots there's no lift or retraction. The nozzle keeps extruding a thin thread to the next dot. Dots are ordered in a serpentine along the halftone grid rows (one row left to right, the next right to left), so threads never cross. If the next dot is further than **max thread length** (3× the grid spacing until you change it), the thread breaks with a normal retract, lift and travel. **Thread flow** sets how thick the thread is.
   - **Print settings:** layers (the same dots stacked), line width (for the thread and test square), layer height, pause before a layer, first-layer Z, Z offset, thread, first-layer and travel speeds, and first-layer flow.
4. **Machine & material:** a Bambu Lab printer (A1 mini, A1, P1P, P1S, X1 Carbon, H2D, A2L), nozzle, build plate, *skip auto bed leveling*, an editable material (PLA / PETG / TPU 95A, or your own saved presets), the filament colour, **Export test square**, and the optional magnet keep-out frame.
5. **Preview & export:** three panels.
   - **Source:** the image, or the 3D viewport for scans.
   - **Halftone:** the dots, with removed ones in red.
   - **Toolpaths:** dots as circles at their printed size on the bed, and coral threads as lines, with a layer slider and travel moves dashed.

   A status line shows the time and filament. **Export G-code** saves `name.gcode`.

**Save preset** / **Load preset** write and read every setting as a JSON file. Presets from earlier versions still load; settings of removed features are ignored.

### Getting it onto the printer

Copy the `.gcode` file to the root of the printer's SD card and start it from the printer's screen.

**Before the first real print,** export the test square for your printer and material and print it on the bare plate. It is a 20 mm two-layer square in the middle of the bed, printed at a normal first-layer height. Plain G-code with a wrong start sequence can heat and move without extruding, and this catches that.

### Printing on fabric

- **Height:** layer 1 is printed at *First layer Z + Z offset*. The default `0 + 0` lets the plastic sink into the weave; raise the Z offset for thick or springy fabric. On a bare plate the nozzle would be blocked at Z 0, and the app warns you.
- **Leveling:** the Bambu start sequence probes the bed, and the probe can misread fabric. With *Skip auto bed leveling* on, the `G29` probe commands inside the start G-code's bed-leveling block are commented out. Level once on the bare plate first.
- **Sandwich mode:** *Pause before layer N* lifts and pauses with `M400 U1`, so you can lay fabric over the first layers.
- **Magnet keep-out frame (optional):** if magnets hold the fabric around the plate, turn on *Magnet keep-out frame* at the bottom of *Machine & material*. It's an imaginary frame centred on the bed: 235 × 235 mm outside with a 15 mm magnet band and 10 mm magnet height by default, which leaves 205 × 205 mm inside. The nozzle stays a margin (5 mm by default) inside the band, and export is blocked if the design reaches into it. Any move that crosses the band happens above the magnets (magnet height + clearance, 12 mm by default). That covers the move in after the start routine, pauses and the lift before the end routine. *Pause to lay the fabric and magnets* stops once the printer's own start routine has finished, because that routine (purge line, calibration, leveling) moves low across the plate.

## How it works

| File | Job |
|---|---|
| `js/raster.js` | the working grid, and a grayscale/alpha copy of the source on it |
| `js/halftone.js` | halftone: grid sampling (square / hex, rotated) → dots sized by darkness, the dot printability filter, the coral serpentine and thread breaks, the calibration row |
| `js/scan3d.js` | the 3D scan viewport (three.js): `.glb` loading, orbit controls, texture-only or lit, and rendering the view with a transparent background |
| `js/gcode.js` | dots and coral → G-code: stationary dots rising while extruding, coral threads, nearest-neighbour ordering, relative E, volumetric speed cap, retraction and Z-hop, pauses, Bambu header, `;LAYER:` / `;TYPE:` / `; FEATURE:` comments |
| `js/template.js` | an interpreter for Bambu Studio's template language (`[var]`, `{expr}`, `{if}…{elsif}…{else}…{endif}`) so the official start and end G-code can be used as they are |
| `profiles/printers.js` | generated from Bambu Studio's machine profiles |
| `profiles/materials.js` | PLA, PETG, TPU 95A defaults |

A dot's extrusion is the volume of a disc of its diameter (× size correction) and the Z rise, × dot flow: so it scales with the dot's area. A coral thread's extrusion per mm is `line_width × layer_height × thread_flow × flow / filament area`. With several layers the same dots are printed again, each layer one Z rise higher, so they stack.

### Updating or adding printers

The start, end and layer-change G-code comes from the open-source Bambu Studio profiles. To refresh them, or to add a printer to the `PRINTERS` list in the script:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/bambulab/BambuStudio.git
git -C BambuStudio sparse-checkout set resources/profiles/BBL/machine
python3 tools/import_bambu.py BambuStudio
```

To add or refresh a single printer and keep the others exactly as they are, add `--only <id>`, for example `--only a2l`.

The A2L limits its Y (bed) acceleration as the print gets heavier. Like Bambu Studio, the app writes the limit at each layer change: the printer's maximum Y acceleration, or its maximum Y force divided by the bed mass plus the plastic printed so far, whichever is lower. For textile prints of a few grams that stays at the maximum, 8,000 mm/s².

### Tests

```bash
node tests/run_tests.js
```

The tests check the template interpreter, the halftone (grid types, dot sizes following darkness, the 1.5 mm limit, invert, transparency, the merge rule, the dot printability filter, nearest-neighbour order), coral (serpentine rows, no crossing threads on square and hex grids at 0° and 45°, thread breaks over the max length, no lift or retraction inside a chain, knots sized per dot), stationary dots whose extrusion scales with size and correction, the calibration row, dot stacking, the magnet frame, the A2L acceleration limit, and a full G-code build for every printer with no unresolved placeholders and no NaN moves.

## Status and roadmap

- Done: image and 3D scan input, halftone, dots and coral printing, dot calibration, Bambu profiles plus test square, toolpath preview, stats, presets.
- **Not yet tested on a printer.** Print the test square first on each printer.
- **H2D:** its start G-code is written for two nozzles. The app fills it in for one filament on one nozzle (`filament_map = 1`), so check that one with the test square before anything else.
- Next: export `.gcode.3mf` so files can go through Bambu Studio / Handy.

## Credits

The 3D viewer uses [three.js](https://threejs.org/) r160 (MIT licence, see `vendor/three/LICENSE`), served from this repo.

The interface is set in [Hasköy](https://github.com/ertekinno/haskoy) by Ertekin Erdin. It is licensed under the SIL Open Font License 1.1 (see `fonts/Haskoy-OFL.txt`) and served from this repo.
