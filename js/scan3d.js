// 3D scan input: shows a .glb (e.g. a Polycam export with textures) in a
// three.js viewport with orbit controls, and renders the current view to an
// image with a transparent background for the halftone.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const DH = (globalThis.DH = globalThis.DH || {});

let renderer, scene, camera, controls, model = null, host = null, home = null, frameReq = 0;
let lighting = "texture";
const lights = [];
const originals = new Map(); // mesh → its original (lit) material(s)
let onRelease = () => {};

function ensure(container) {
  if (renderer) {
    if (host !== container) { container.appendChild(renderer.domElement); host = container; resize(); }
    return;
  }
  host = container;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.className = "scan-canvas";
  container.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  // lights for "lit": soft fill from above plus a headlight that follows the view
  const hemi = new THREE.HemisphereLight(0xffffff, 0x666666, 1.2);
  const head = new THREE.DirectionalLight(0xffffff, 1.6);
  head.position.set(0.3, 0.5, 1);
  camera.add(head);
  scene.add(camera, hemi);
  lights.push(hemi, head);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.screenSpacePanning = true;
  controls.addEventListener("change", draw);
  controls.addEventListener("end", () => onRelease());
  new ResizeObserver(resize).observe(container);
  resize();
}

function resize() {
  if (!renderer || !host) return;
  const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  draw();
}

function draw() {
  cancelAnimationFrame(frameReq);
  frameReq = requestAnimationFrame(() => renderer && renderer.render(scene, camera));
}

// "texture": unlit, the scan's own colours. "lit": the original materials with
// light, so shading adds depth.
function applyLighting() {
  if (!model) return;
  model.traverse((o) => {
    if (!o.isMesh) return;
    if (!originals.has(o)) originals.set(o, o.material);
    const orig = originals.get(o);
    if (lighting === "lit") o.material = orig;
    else {
      const unlit = (m) => new THREE.MeshBasicMaterial({
        map: m.map || null, color: m.map ? 0xffffff : (m.color || new THREE.Color(0xcccccc)),
        transparent: m.transparent, opacity: m.opacity, alphaTest: m.alphaTest, side: THREE.DoubleSide, vertexColors: !!m.vertexColors,
      });
      o.material = Array.isArray(orig) ? orig.map(unlit) : unlit(orig);
    }
  });
  lights.forEach((l) => { l.visible = lighting === "lit"; });
  draw();
}

function frameModel() {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
  const r = Math.max(size.x, size.y, size.z) / 2 || 1;
  const dist = r / Math.sin((camera.fov * Math.PI) / 360) * 1.15;
  camera.near = dist / 100; camera.far = dist * 100;
  camera.position.copy(centre).add(new THREE.Vector3(0, 0, dist));
  camera.updateProjectionMatrix();
  controls.target.copy(centre);
  controls.update();
  home = { pos: camera.position.clone(), target: centre.clone() };
}

DH.scan3d = {
  // Show the viewport inside `container` (creates it on first use).
  mount(container) { ensure(container); resize(); },
  setLighting(mode) { lighting = mode === "lit" ? "lit" : "texture"; applyLighting(); },
  onRelease(fn) { onRelease = fn; },
  get loaded() { return !!model; },
  // Load a .glb from a File or ArrayBuffer. Resolves when the model is shown.
  async load(data, container) {
    ensure(container);
    const buf = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
    const gltf = await new Promise((ok, fail) => new GLTFLoader().parse(buf, "", ok, fail));
    if (model) { scene.remove(model); originals.clear(); }
    model = gltf.scene;
    scene.add(model);
    applyLighting();
    frameModel();
    draw();
  },
  resetView() {
    if (!home) return;
    camera.position.copy(home.pos);
    controls.target.copy(home.target);
    controls.update();
    draw();
    onRelease();
  },
  // The current view as a canvas (long side about maxPx), transparent where
  // there is no model, cropped to the model with a small margin.
  renderSource(maxPx) {
    if (!model) return null;
    const aspect = camera.aspect || 1;
    const w = Math.round(aspect >= 1 ? maxPx : maxPx * aspect), h = Math.round(aspect >= 1 ? maxPx / aspect : maxPx);
    const rt = new THREE.WebGLRenderTarget(w, h, { samples: 4 });
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    const px = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    renderer.setRenderTarget(null);
    rt.dispose();
    // flip rows (GL reads bottom-up) and find the model's bounding box
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    const img = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
      const from = (h - 1 - y) * w * 4, to = y * w * 4;
      img.data.set(px.subarray(from, from + w * 4), to);
      for (let x = 0; x < w; x++) if (px[from + x * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return null;
    // three.js leaves colour premultiplied by alpha at soft edges; undo it
    for (let i = 0; i < img.data.length; i += 4) {
      const a = img.data[i + 3];
      if (a > 0 && a < 255) for (let c = 0; c < 3; c++) img.data[i + c] = Math.min(255, Math.round((img.data[i + c] * 255) / a));
    }
    const m = Math.round(Math.max(w, h) * 0.01);
    x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
    const full = document.createElement("canvas");
    full.width = w; full.height = h;
    full.getContext("2d").putImageData(img, 0, 0);
    const out = document.createElement("canvas");
    out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
    out.getContext("2d").drawImage(full, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  },
};
// tell the app the 3D module is ready (it loads after the classic scripts)
window.dispatchEvent(new Event("dh-scan3d-ready"));
