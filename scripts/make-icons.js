// Draws the app icons as PNGs, with no image library involved.
//
// The manifest wants PNG, the repository has no build tooling, and pulling in a
// canvas dependency for six flat rectangles would be the tail wagging the dog.
// Node ships zlib, which is the only hard part of writing a PNG — the rest is
// three chunks and a CRC.
//
//   node scripts/make-icons.js
//
// Regenerate whenever the icon changes; the files are committed.

const fs = require("fs");
const zlib = require("zlib");
const nodePath = require("path");

const ROOT = nodePath.resolve(__dirname, "..");
const OUT = nodePath.join(ROOT, "icons");

// ── PNG writing ─────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// rgba: a size*size*4 buffer
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  // 10..12 stay 0: deflate, adaptive filtering, no interlace

  // One filter byte per scanline, filter type 0 (none)
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const src = y * size * 4;
    const dst = y * (size * 4 + 1);
    raw[dst] = 0;
    rgba.copy(raw, dst + 1, src, src + size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── The icon ────────────────────────────────────────────────
const C = {
  bg:       [0x00, 0x00, 0x00, 0xff],
  hull:     [0xff, 0xff, 0x55, 0xff],
  dome:     [0x7c, 0xc6, 0xfe, 0xff],
  stripe:   [0x00, 0x00, 0x00, 0xff],
  gear:     [0x95, 0x95, 0x95, 0xff],
  flame:    [0xff, 0x88, 0x44, 0xff],
  star:     [0xff, 0xff, 0xff, 0xff],
};

// Fixed positions rather than random, so the icon is byte-identical on every
// regeneration and a rebuild does not show up as a spurious diff.
const STARS = [
  [0.10, 0.14], [0.24, 0.30], [0.82, 0.18], [0.90, 0.44],
  [0.16, 0.72], [0.70, 0.80], [0.38, 0.10], [0.58, 0.88],
];

// The taxi in a 32x20 design grid, drawn as filled rectangles
const SHAPES = [
  { r: [2,  6, 28, 11], c: "hull"   },
  { r: [10, 2, 12,  5], c: "dome"   },
  { r: [2, 12, 28,  2], c: "stripe" },
  { r: [5, 17,  3,  3], c: "gear"   },
  { r: [24, 17, 3,  3], c: "gear"   },
  { r: [14, 17, 4,  3], c: "flame"  },
];

const GRID_W = 32, GRID_H = 22;

function render(size, { padding = 0.12 } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const put = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = rgb[0]; buf[i+1] = rgb[1]; buf[i+2] = rgb[2]; buf[i+3] = rgb[3];
  };

  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(x, y, C.bg);

  const starSize = Math.max(1, Math.round(size / 128));
  for (const [sx, sy] of STARS) {
    const px = Math.round(sx * size), py = Math.round(sy * size);
    for (let dy = 0; dy < starSize; dy++)
      for (let dx = 0; dx < starSize; dx++) put(px + dx, py + dy, C.star);
  }

  // Fit the design grid into the padded area, keeping whole pixels so the
  // result stays crisp at every size rather than half-covering edge pixels.
  const avail = size * (1 - padding * 2);
  const scale = Math.max(1, Math.floor(Math.min(avail / GRID_W, avail / GRID_H)));
  const originX = Math.round((size - GRID_W * scale) / 2);
  const originY = Math.round((size - GRID_H * scale) / 2);

  for (const { r: [rx, ry, rw, rh], c } of SHAPES) {
    const rgb = C[c];
    for (let y = 0; y < rh * scale; y++)
      for (let x = 0; x < rw * scale; x++)
        put(originX + rx * scale + x, originY + ry * scale + y, rgb);
  }

  return png(size, buf);
}

const TARGETS = [
  { file: "icon-192.png", size: 192, opts: { padding: 0.10 } },
  { file: "icon-512.png", size: 512, opts: { padding: 0.10 } },
  // Maskable icons are cropped to a circle by the launcher, so the artwork has
  // to sit inside the safe zone with a lot more room around it.
  { file: "icon-maskable-512.png", size: 512, opts: { padding: 0.22 } },
];

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const t of TARGETS) {
    const data = render(t.size, t.opts);
    fs.writeFileSync(nodePath.join(OUT, t.file), data);
    console.log(`wrote icons/${t.file} (${t.size}x${t.size}, ${data.length} bytes)`);
  }
}

module.exports = { render, TARGETS, OUT };
