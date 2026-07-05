/**
 * Generates the PWA icons as PNGs with zero dependencies (raw PNG encoding
 * via node:zlib). Navy field with a white check mark — institutional, no
 * gradients. Run automatically by `npm run build`.
 */
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixelAt) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      const off = y * (size * 4 + 1) + 1 + x * 4;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const NAVY = [22, 40, 63, 255];
const NAVY_EDGE = [31, 58, 95, 255];
const WHITE = [255, 255, 255, 255];

/** Distance from point p to segment a-b, in icon units. */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function makeIcon(size) {
  // Check mark geometry in unit space.
  const a = [0.28, 0.52];
  const b = [0.45, 0.68];
  const c = [0.74, 0.34];
  const stroke = 0.065;
  return encodePng(size, (x, y) => {
    const u = x / size;
    const v = y / size;
    const border = Math.min(u, v, 1 - u, 1 - v);
    const d = Math.min(
      segDist(u, v, a[0], a[1], b[0], b[1]),
      segDist(u, v, b[0], b[1], c[0], c[1])
    );
    if (d < stroke) return WHITE;
    if (border < 0.04) return NAVY_EDGE;
    return NAVY;
  });
}

const outDir = path.join(process.cwd(), "public", "icons");
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), makeIcon(size));
}
console.log("PWA icons written to public/icons/");
