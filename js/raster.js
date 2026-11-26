// Raster helpers: the working grid for the halftone, and a grayscale/alpha copy
// of the source image on that grid.
(function (DH) {
  "use strict";

  // Working grid for a print of widthMm × heightMm. Pixel size never goes
  // below 0.08 mm and the grid stays under ~1.5 million pixels.
  function gridFor(widthMm, heightMm) {
    const p = Math.max(0.08, Math.sqrt((widthMm * heightMm) / 1.5e6));
    return { p, w: Math.max(8, Math.round(widthMm / p)), h: Math.max(8, Math.round(heightMm / p)) };
  }

  // imageData: {data: RGBA bytes, width, height} already resampled to the grid.
  function toGray(imageData) {
    const n = imageData.width * imageData.height, d = imageData.data;
    const gray = new Float32Array(n), alpha = new Uint8Array(n), rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = d[i * 4 + 3] / 255;
      const l = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
      gray[i] = l * a + (1 - a); // transparent pixels read as white
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(d[i * 4 + c] * a + 255 * (1 - a));
      alpha[i] = a >= 0.5 ? 1 : 0;
    }
    return { gray, alpha, rgb, w: imageData.width, h: imageData.height };
  }

  DH.raster = { gridFor, toGray };
})(globalThis.DH = globalThis.DH || {});
