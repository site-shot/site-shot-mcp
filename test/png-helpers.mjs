// A PNG encoder and decoder for the tests only, written apart from src/image-tiles.js so that a
// tiling bug cannot hide behind the same bug in the check. The encoder cycles through all five
// row filters, as real encoders mix them, because a tile's first row is where a filter that
// looks at the row above would read the wrong data.
import { deflateSync, inflateSync } from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function predictor(filter, a, b, c) {
  if (filter === 1) return a;
  if (filter === 2) return b;
  if (filter === 3) return (a + b) >> 1;
  if (filter === 4) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  }
  return 0;
}

/** RGBA PNG whose pixel (x, y) is pixel(x, y) -> [r, g, b, a]; row y uses filter y % 5. */
export function encodePng(width, height, pixel) {
  const bpp = 4;
  const rowBytes = width * bpp;
  const rows = [];
  let prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(rowBytes);
    for (let x = 0; x < width; x++) Buffer.from(pixel(x, y)).copy(row, x * bpp);
    const filter = y % 5;
    const out = Buffer.alloc(rowBytes + 1);
    out[0] = filter;
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const c = i >= bpp ? prev[i - bpp] : 0;
      out[i + 1] = (row[i] - predictor(filter, a, prev[i], c)) & 0xff;
    }
    rows.push(out);
    prev = row;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Decode a non-interlaced 8-bit RGBA PNG into { width, height, rows: Buffer[] }, checking CRCs. */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let pos = 8;
  let width, height;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (crc(buf.subarray(pos + 4, pos + 8 + len)) !== buf.readUInt32BE(pos + 8 + len)) throw new Error(`bad CRC in ${type}`);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error("test decoder reads 8-bit RGBA only");
    }
    if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rowBytes = width * 4;
  if (raw.length !== height * (rowBytes + 1)) throw new Error("wrong pixel data length");
  const rows = [];
  let prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const off = y * (rowBytes + 1);
    const filter = raw[off];
    if (filter > 4) throw new Error(`bad filter ${filter}`);
    const row = Buffer.alloc(rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= 4 ? row[i - 4] : 0;
      const c = i >= 4 ? prev[i - 4] : 0;
      row[i] = (raw[off + 1 + i] + predictor(filter, a, prev[i], c)) & 0xff;
    }
    rows.push(row);
    prev = row;
  }
  return { width, height, rows };
}
