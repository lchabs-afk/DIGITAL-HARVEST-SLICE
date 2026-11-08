// Material presets. Values follow the project spec for PLA and Bambu Studio's
// Generic PETG / Generic TPU filament profiles. Every value is editable in the app.
(globalThis.DH = globalThis.DH || {}).MATERIALS = [
  { id: "pla", name: "PLA", type: "PLA", nozzleTemp: 220, firstLayerTemp: 230, bedTemp: 60,
    maxVolSpeed: 15, flow: 0.98, retractLength: 0.8, retractSpeed: 30, fanFirst: 0, fanRest: 100,
    diameter: 1.75, density: 1.24, vitrification: 45 },
  { id: "petg", name: "PETG", type: "PETG", nozzleTemp: 255, firstLayerTemp: 255, bedTemp: 70,
    maxVolSpeed: 12, flow: 0.95, retractLength: 0.8, retractSpeed: 30, fanFirst: 0, fanRest: 90,
    diameter: 1.75, density: 1.27, vitrification: 64 },
  { id: "tpu", name: "TPU 95A", type: "TPU", nozzleTemp: 240, firstLayerTemp: 240, bedTemp: 35,
    maxVolSpeed: 3.2, flow: 1.0, retractLength: 0.2, retractSpeed: 20, fanFirst: 0, fanRest: 100,
    diameter: 1.75, density: 1.22, vitrification: 30 },
];
