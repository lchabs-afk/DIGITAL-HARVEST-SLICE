// Turing patterns: a Gray-Scott reaction-diffusion simulation that turns the
// image into shapes. Inspired by Ivan Murit's TexTuring; this is our own code.
//
// Two chemicals U and V spread across the design (V half as fast as U) and
// react: U + 2V → 3V. U is fed in at rate F, V is removed at rate F + k.
// Depending on F and k, V settles into spots, stripes, mazes or coral-like
// branches. The image steers the pattern: each cell's darkness shifts its F
// and k, so dark and light parts of the plant grow different patterns.
//
// Runs on the GPU (WebGL2 with float render targets) and falls back to the
// same equations in JavaScript when WebGL isn't available (and in the tests).
(function (DH) {
  "use strict";

  // Feed / kill pairs on the Du = 1, Dv = 0.5 scale used below.
  const PRESETS = {
    spots: { label: "Spots", F: 0.0367, k: 0.0649 },
    stripes: { label: "Stripes", F: 0.046, k: 0.063 },
    maze: { label: "Maze", F: 0.029, k: 0.057 },
    coral: { label: "Coral", F: 0.0545, k: 0.062 },
  };
  const DU = 1.0, DV = 0.5, DT = 1.0;
  // How strongly the image shifts F and k at full influence. It is lopsided on
  // purpose: dark cells get a gentle push towards a denser pattern (it should
  // still read as a pattern), light cells a strong push towards no pattern, so
  // a white background stays bare fabric.
  const DARK_F = 0.006, DARK_K = 0.002, LIGHT_F = 0.008, LIGHT_K = 0.016;
  // feed / kill for one cell: s runs from -1 (white, full influence) to +1 (black)
  const shifted = (F, k, s) => (s >= 0 ? [F + s * DARK_F, k - s * DARK_K] : [F + s * LIGHT_F, k - s * LIGHT_K]);
  // Neighbouring spots / stripes sit about 16 cells apart with these presets
  // (measured, and checked in the tests). The grid is sized so that distance
  // equals the chosen pattern scale in mm.
  const CELLS_PER_PERIOD = 16;

  function rng(seed) {
    let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
    return () => ((s = (s * 16807) % 2147483647) / 2147483647);
  }

  // Simulation grid for a design of widthMm × heightMm and a pattern scale in mm,
  // capped so the GPU (and the JS fallback) stay fast.
  function gridFor(widthMm, heightMm, scaleMm, maxCells) {
    let cell = Math.max(0.02, scaleMm / CELLS_PER_PERIOD);
    const cap = maxCells || 600000;
    if ((widthMm / cell) * (heightMm / cell) > cap) cell = Math.sqrt((widthMm * heightMm) / cap);
    return { cell, w: Math.max(8, Math.round(widthMm / cell)), h: Math.max(8, Math.round(heightMm / cell)) };
  }

  // Darkness (0 white … 1 black) and printable mask at simulation resolution,
  // averaged from the fine raster. tone: lightness 0..1 per fine pixel.
  function sample(tone, mask, fw, fh, w, h) {
    const dark = new Float32Array(w * h), ok = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor((y * fh) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * fh) / h));
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor((x * fw) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * fw) / w));
        let s = 0, m = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = yy * fw + xx; s += tone[i]; m += mask ? mask[i] : 1; n++; }
        dark[y * w + x] = 1 - s / n;
        ok[y * w + x] = m / n >= 0.5 ? 1 : 0;
      }
    }
    return { dark, ok };
  }

  // Starting state: U = 1 everywhere, V = 1 in small random squares, about one
  // per pattern period squared, so the pattern grows from many places at once.
  function seedState(w, h, seed, ok) {
    const U = new Float32Array(w * h).fill(1), V = new Float32Array(w * h);
    const rand = rng(seed), patches = Math.max(4, Math.round((w * h) / (CELLS_PER_PERIOD * CELLS_PER_PERIOD) / 2));
    for (let n = 0; n < patches; n++) {
      const cx = Math.floor(rand() * w), cy = Math.floor(rand() * h), r = 1 + Math.floor(rand() * 2);
      for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h || (ok && !ok[y * w + x])) continue;
        U[y * w + x] = 0.5; V[y * w + x] = 0.25 + rand() * 0.25;
      }
    }
    return { U, V };
  }

  // Can this browser run the GPU backend? (WebGL2 + float render targets)
  let gpuOk = null;
  function gpuAvailable() {
    if (gpuOk !== null) return gpuOk;
    gpuOk = false;
    try {
      if (typeof document !== "undefined") {
        const gl = document.createElement("canvas").getContext("webgl2");
        gpuOk = !!(gl && gl.getExtension("EXT_color_buffer_float"));
        const lose = gl && gl.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext();
      }
    } catch (e) { gpuOk = false; }
    return gpuOk;
  }

  // ---------- JavaScript backend ----------
  function cpuSim(o) {
    const { w, h } = o;
    let { U, V } = seedState(w, h, o.seed, o.ok);
    let U2 = new Float32Array(w * h), V2 = new Float32Array(w * h);
    const Fl = new Float32Array(w * h), Kl = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const [f, k] = shifted(o.F, o.k, o.influence * (o.dark[i] - 0.5) * 2);
      Fl[i] = f; Kl[i] = k;
    }
    let iter = 0;
    return {
      backend: "cpu",
      get iteration() { return iter; },
      step(n) {
        for (let t = 0; t < n; t++) {
          for (let y = 0; y < h; y++) {
            const ym = y > 0 ? y - 1 : 0, yp = y < h - 1 ? y + 1 : h - 1;
            for (let x = 0; x < w; x++) {
              const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : w - 1, i = y * w + x;
              const a = ym * w, b = y * w, c = yp * w;
              // 9-point Laplacian: sides 0.2, corners 0.05, centre -1
              const lu = 0.2 * (U[a + x] + U[c + x] + U[b + xm] + U[b + xp]) + 0.05 * (U[a + xm] + U[a + xp] + U[c + xm] + U[c + xp]) - U[i];
              const lv = 0.2 * (V[a + x] + V[c + x] + V[b + xm] + V[b + xp]) + 0.05 * (V[a + xm] + V[a + xp] + V[c + xm] + V[c + xp]) - V[i];
              const u = U[i], v = V[i], uvv = u * v * v;
              let nu = u + DT * (DU * lu - uvv + Fl[i] * (1 - u));
              let nv = v + DT * (DV * lv + uvv - (Fl[i] + Kl[i]) * v);
              if (o.ok && !o.ok[i]) nv = 0;
              U2[i] = nu < 0 ? 0 : nu > 1 ? 1 : nu;
              V2[i] = nv < 0 ? 0 : nv > 1 ? 1 : nv;
            }
          }
          let tU = U; U = U2; U2 = tU;
          let tV = V; V = V2; V2 = tV;
          iter++;
        }
      },
      read() { return V.slice(); },
      destroy() {},
    };
  }

  // ---------- WebGL2 backend ----------
  const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
  const STEP_FS = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D state, image;
uniform vec2 px;
uniform float F, K, infl;
vec2 at(vec2 d) { return texture(state, uv + d * px).rg; }
void main() {
  vec2 c = at(vec2(0.0));
  vec2 lap = 0.2 * (at(vec2(1.0, 0.0)) + at(vec2(-1.0, 0.0)) + at(vec2(0.0, 1.0)) + at(vec2(0.0, -1.0)))
           + 0.05 * (at(vec2(1.0, 1.0)) + at(vec2(-1.0, 1.0)) + at(vec2(1.0, -1.0)) + at(vec2(-1.0, -1.0))) - c;
  vec2 im = texture(image, uv).rg;            // r: darkness, g: printable
  float s = infl * (im.r - 0.5) * 2.0;
  float f = s >= 0.0 ? F + s * ${DARK_F} : F + s * ${LIGHT_F};
  float k = s >= 0.0 ? K - s * ${DARK_K} : K - s * ${LIGHT_K};
  float uvv = c.r * c.g * c.g;
  float u = c.r + ${DT.toFixed(1)} * (${DU.toFixed(1)} * lap.r - uvv + f * (1.0 - c.r));
  float v = c.g + ${DT.toFixed(1)} * (${DV.toFixed(1)} * lap.g + uvv - (f + k) * c.g);
  if (im.g < 0.5) v = 0.0;
  o = vec4(clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0), 0.0, 1.0);
}`;

  function glSim(o) {
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { antialias: false, depth: false, preserveDrawingBuffer: false });
    if (!gl || !gl.getExtension("EXT_color_buffer_float")) return null;
    const { w, h } = o;
    canvas.width = w; canvas.height = h;
    const compile = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, STEP_FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const tex = (data) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
      return t;
    };
    // Rows go bottom-up in GL; we keep the same row order as the JS arrays and
    // only ever read back with the same convention, so no flip is needed.
    const { U, V } = seedState(w, h, o.seed, o.ok);
    const st = new Float32Array(w * h * 4), im = new Float32Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      st[i * 4] = U[i]; st[i * 4 + 1] = V[i]; st[i * 4 + 3] = 1;
      im[i * 4] = o.dark[i]; im[i * 4 + 1] = o.ok ? o.ok[i] : 1; im[i * 4 + 3] = 1;
    }
    const states = [tex(st), tex(null)], image = tex(im);
    const fbs = states.map((t) => {
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return fb;
    });
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
    const u = (n) => gl.getUniformLocation(prog, n);
    gl.uniform1i(u("state"), 0); gl.uniform1i(u("image"), 1);
    gl.uniform2f(u("px"), 1 / w, 1 / h);
    gl.uniform1f(u("F"), o.F); gl.uniform1f(u("K"), o.k); gl.uniform1f(u("infl"), o.influence);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, image);
    gl.viewport(0, 0, w, h);
    let cur = 0, iter = 0;
    const out = new Float32Array(w * h * 4);
    return {
      backend: "webgl",
      get iteration() { return iter; },
      step(n) {
        gl.useProgram(prog);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, image);
        for (let t = 0; t < n; t++) {
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, states[cur]);
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbs[1 - cur]);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          cur = 1 - cur; iter++;
        }
      },
      read() {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbs[cur]);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, out);
        const V = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) V[i] = out[i * 4 + 1];
        return V;
      },
      destroy() {
        states.concat([image]).forEach((t) => gl.deleteTexture(t));
        fbs.forEach((f) => gl.deleteFramebuffer(f));
        gl.deleteProgram(prog); gl.deleteBuffer(buf);
        const lose = gl.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext();
      },
    };
  }

  // o: {w, h, dark, ok, F, k, influence, seed, backend?: "cpu"}
  function createSim(o) {
    let sim = null;
    if (o.backend !== "cpu") { try { sim = glSim(o); } catch (e) { sim = null; } }
    return sim || cpuSim(o);
  }

  // Concentration (simulation grid) → height levels on the fine grid.
  // V is upsampled bilinearly, normalised to its own high end, and printed where
  // it is above one half (below, with invert). Above that, the range is split
  // into `levels` equal bands: the cores of spots and stripes stand tallest.
  function toLevels(V, w, h, fw, fh, s, mask) {
    const sorted = Float32Array.from(V).sort();
    const top = Math.max(1e-4, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.995))]);
    const N = Math.max(1, Math.min(5, s.levels));
    const lv = new Uint8Array(fw * fh);
    for (let y = 0; y < fh; y++) {
      const sy = Math.min(h - 1.0001, Math.max(0, ((y + 0.5) * h) / fh - 0.5)), y0 = Math.floor(sy), ty = sy - y0;
      for (let x = 0; x < fw; x++) {
        const i = y * fw + x;
        if (mask && !mask[i]) continue;
        const sx = Math.min(w - 1.0001, Math.max(0, ((x + 0.5) * w) / fw - 0.5)), x0 = Math.floor(sx), tx = sx - x0;
        const a = V[y0 * w + x0], b = V[y0 * w + x0 + 1], c = V[(y0 + 1) * w + x0], d = V[(y0 + 1) * w + x0 + 1];
        let v = ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty) / top;
        v = Math.min(1, Math.max(0, v));
        if (s.invert) v = 1 - v;
        if (v <= 0.5) continue;
        lv[i] = Math.min(N, 1 + Math.floor(((v - 0.5) / 0.5) * N));
      }
    }
    return lv;
  }

  DH.turing = { PRESETS, gridFor, sample, createSim, toLevels, gpuAvailable, CELLS_PER_PERIOD };
})(globalThis.DH = globalThis.DH || {});
