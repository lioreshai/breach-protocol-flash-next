/* Minimal PNG writer (RGB8, no deps) so the headless harness can show its framebuffer. */
const zlib = require('zlib'), fs = require('fs');
const T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = T[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const n = data.length, out = Buffer.alloc(12 + n), head = Buffer.alloc(4);
  head.writeUInt32BE(n, 0);
  head.copy(out, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + n), 8 + n);
  return out;
}
/* rgba: Uint8Array(w*h*4). Nearest-neighbour upscale by `scale`. */
function writePNG(path, w, h, rgba, scale = 1) {
  const W = w * scale, H = h * scale;
  const raw = Buffer.alloc(H * (W * 3 + 1));
  let o = 0;
  for (let y = 0; y < H; y++) {
    raw[o++] = 0;
    const sy = (y / scale) | 0, row = sy * w;
    for (let x = 0; x < W; x++) {
      const i = (row + ((x / scale) | 0)) * 4;
      raw[o++] = rgba[i]; raw[o++] = rgba[i + 1]; raw[o++] = rgba[i + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))];
  fs.writeFileSync(path, Buffer.concat(png));
  return W + 'x' + H;
}
/* Uint32Array of packed ABGR (the game's framebuffer / texture layout) -> RGBA */
function toRGBA(u32) {
  const n = u32.length, o = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) { const c = u32[i]; o[i * 4] = c & 255; o[i * 4 + 1] = (c >> 8) & 255; o[i * 4 + 2] = (c >> 16) & 255; o[i * 4 + 3] = (c >>> 24) === 0 ? 0 : 255; }
  return o;
}
module.exports = { writePNG, toRGBA };
