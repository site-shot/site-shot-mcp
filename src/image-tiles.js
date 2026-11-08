import { deflateSync, inflateSync } from "node:zlib";

// A full-page capture is one image as tall as the page: 1024 x 10381 px for the Site-Shot
// homepage, up to 20,000 px by default. Claude refuses images over 8000 px on a side and
// downscales anything with a long edge over about 2000-2600 px, so at that size the text in a
// full page is a blur. Cutting the one PNG the API returned into tiles keeps every line at its
// native resolution, and costs no second capture.

/** Tallest tile returned. Claude Code also caps every image at 2000 px once a request holds many. */
export const TILE_MAX_HEIGHT = 2000;
/** Consecutive tiles share this many rows, so a line of text cut by one edge is whole in the other. */
export const TILE_OVERLAP = 48;
/**
 * Pixels all tiles of one result may hold together: about 18,000 tokens at the usual estimate of
 * width x height / 750 per image. Claude Code flags a tool result over 25,000 tokens as truncated
 * (MAX_MCP_OUTPUT_TOKENS) even when nothing was cut; measured with 2.1.283, ten 1280 px tiles drew
 * that notice. Tiles past this budget are left out, and the note says which rows.
 */
export const TILE_PIXEL_BUDGET = 13_500_000;
/** Above this, an image is said to be too large for many clients to show at full resolution. */
export const CLIENT_MAX_SIDE = 2000;
// Decoding needs the whole inflated pixel buffer in memory. 1024 x 20000 RGBA is about 82 MB;
// past this cap the image goes back whole, with a note, rather than risk the server's memory.
const MAX_RAW_BYTES = 256 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Chunks that change how pixels are read. Each tile carries them so it decodes like the original.
const COPIED_CHUNKS = new Set(["PLTE", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "pHYs"]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Width and height of a PNG, JPEG or WebP, or null when the bytes are none of those. */
export function imageSize(buf) {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIGNATURE) && buf.toString("latin1", 12, 16) === "IHDR") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      // SOF0-SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) share the range but do not.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
  }
  if (buf.length >= 30 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    const kind = buf.toString("latin1", 12, 16);
    if (kind === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (kind === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { width: 1 + (b & 0x3fff), height: 1 + ((b >>> 14) & 0x3fff) };
    }
    if (kind === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Tile start rows, top to bottom, for an image `height` px tall. Every tile is `maxHeight` tall:
 * the last one is moved up to end on the bottom row, so it overlaps its neighbour a little more.
 */
export function tileStarts(height, maxHeight = TILE_MAX_HEIGHT, overlap = TILE_OVERLAP) {
  const starts = [0];
  while (starts[starts.length - 1] + maxHeight < height) {
    starts.push(Math.min(starts[starts.length - 1] + maxHeight - overlap, height - maxHeight));
  }
  return starts;
}

/**
 * Cut a PNG into horizontal tiles no taller than `maxHeight`, from the top, stopping before the
 * tiles together would hold more than `maxPixels` (always at least one tile).
 * Returns [{ y, height, data }] (data is a complete PNG), or null when the PNG is one this
 * does not handle (interlaced, malformed, too large to decode) and must go back whole.
 */
export function tilePng(buf, { maxHeight = TILE_MAX_HEIGHT, overlap = TILE_OVERLAP, maxPixels = TILE_PIXEL_BUDGET } = {}) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let ihdr;
  const copied = [];
  const idat = [];
  for (let pos = 8; pos + 12 <= buf.length; ) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    if (pos + 12 + len > buf.length) return null;
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") ihdr = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    else if (COPIED_CHUNKS.has(type) && idat.length === 0) copied.push([type, data]);
    pos += 12 + len;
  }
  if (!ihdr || ihdr.length !== 13 || idat.length === 0) return null;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const channels = CHANNELS[ihdr[9]];
  if (!channels || ihdr[10] !== 0 || ihdr[11] !== 0 || ihdr[12] !== 0) return null; // interlaced or unknown
  if (width === 0 || height === 0) return null;
  const bitsPerPixel = channels * bitDepth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const stride = rowBytes + 1;
  const expected = stride * height;
  if (expected > MAX_RAW_BYTES) return null;

  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch {
    return null;
  }
  if (raw.length !== expected) return null;

  const all = tileStarts(height, maxHeight, overlap);
  if (all.length === 1) return null;
  const starts = all.slice(0, Math.max(1, Math.floor(maxPixels / (width * maxHeight))));

  // One pass undoes the row filters, keeping only the rows a tile starts on. Every other row of a
  // tile is copied filtered, exactly as the API encoded it: its filter refers to the row above,
  // which is in the same tile. A tile's first row has no row above, so it goes in unfiltered.
  const firstRows = new Map();
  const startSet = new Set(starts);
  const last = starts[starts.length - 1];
  let prev = Buffer.alloc(rowBytes);
  let cur = Buffer.alloc(rowBytes);
  for (let y = 0; y <= last; y++) {
    const off = y * stride;
    const filter = raw[off];
    const line = raw.subarray(off + 1, off + stride);
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      let v;
      switch (filter) {
        case 0: v = line[i]; break;
        case 1: v = line[i] + a; break;
        case 2: v = line[i] + b; break;
        case 3: v = line[i] + ((a + b) >> 1); break;
        case 4: v = line[i] + paeth(a, b, i >= bpp ? prev[i - bpp] : 0); break;
        default: return null;
      }
      cur[i] = v & 0xff;
    }
    if (startSet.has(y)) firstRows.set(y, Buffer.from(cur));
    [prev, cur] = [cur, prev];
  }

  return starts.map((y) => {
    const h = Math.min(maxHeight, height - y);
    const body = Buffer.concat([
      Buffer.from([0]),
      firstRows.get(y),
      raw.subarray((y + 1) * stride, (y + h) * stride),
    ]);
    const header = Buffer.from(ihdr);
    header.writeUInt32BE(h, 4);
    const png = Buffer.concat([
      PNG_SIGNATURE,
      chunk("IHDR", header),
      ...copied.map(([type, data]) => chunk(type, data)),
      chunk("IDAT", deflateSync(body)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    return { y, height: h, data: png };
  });
}
