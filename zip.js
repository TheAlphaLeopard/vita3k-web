// Minimal ZIP reader for game packages: stored + deflated entries, no
// dependencies. Works on the page, in the worker, and in Node 18+ (Blob,
// DecompressionStream, TextDecoder are available in all three).
const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LF_SIG = 0x04034b50;

function crc32(bytes) {
  return (crc32Update(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}
// Running CRC-32: start from 0xffffffff, finish with ^ 0xffffffff.
function crc32Update(crc, bytes) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}
export function zipCrc32(bytes) { return crc32(bytes); }

const nameDecoder = new TextDecoder('utf-8');

// A path is usable when it is relative, has no dot segments, and is not a
// directory or a macOS metadata file. Returns the normalized path or null.
export function normalizeEntryPath(name) {
  if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null;
  if (name.endsWith('/')) return null;
  const segments = name.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  if (segments[0] === '__MACOSX') return null;
  if (segments[segments.length - 1] === '.DS_Store') return null;
  return segments.join('/');
}

// Central directory listing: [{ name, method, crc, compSize, size,
// localOffset, dir }]. Throws on non-zip data, multi-disk archives, ZIP64
// and encrypted entries (all rejected with a message, never misread).
export async function listZipEntries(blob) {
  if (!blob || !Number.isSafeInteger(blob.size) || blob.size < 22)
    throw new Error('not a zip archive (too small)');
  const tailSize = Math.min(blob.size, 65557 + 22);
  const tail = new Uint8Array(await blob.slice(blob.size - tailSize).arrayBuffer());
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tailView.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive (end-of-central-directory not found)');
  const eocdBase = blob.size - tailSize + eocd;
  if (tailView.getUint16(eocd + 4, true) !== 0 || tailView.getUint16(eocd + 6, true) !== 0)
    throw new Error('multi-disk zip archives are not supported');
  const entries = tailView.getUint16(eocd + 10, true);
  const cdSize = tailView.getUint32(eocd + 12, true);
  const cdOffset = tailView.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff)
    throw new Error('ZIP64 archives are not supported');
  if (cdOffset + cdSize > eocdBase)
    throw new Error('zip central directory runs past the end of the archive');
  const cd = new Uint8Array(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  if (cd.byteLength !== cdSize) throw new Error('zip archive is truncated');
  const cdView = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const out = [];
  let at = 0;
  for (let i = 0; i < entries; i++) {
    if (cdView.getUint32(at, true) !== CD_SIG)
      throw new Error(`zip central directory entry ${i} is corrupt`);
    const flags = cdView.getUint16(at + 8, true);
    const method = cdView.getUint16(at + 10, true);
    const crc = cdView.getUint32(at + 16, true);
    const compSize = cdView.getUint32(at + 20, true);
    const size = cdView.getUint32(at + 24, true);
    const nameLen = cdView.getUint16(at + 28, true);
    const extraLen = cdView.getUint16(at + 30, true);
    const commentLen = cdView.getUint16(at + 32, true);
    const localOffset = cdView.getUint32(at + 42, true);
    const name = nameDecoder.decode(cd.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) throw new Error(`encrypted zip entry is not supported: ${name}`);
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff)
      throw new Error('ZIP64 archives are not supported');
    out.push({ name, method, crc: crc >>> 0, compSize, size, localOffset, dir: name.endsWith('/') });
  }
  return out;
}

// Where one entry's (possibly compressed) data starts in the archive.
export async function zipEntryDataOffset(blob, entry) {
  if (entry.dir) throw new Error(`cannot extract directory: ${entry.name}`);
  if (entry.method !== 0 && entry.method !== 8)
    throw new Error(`unsupported zip method ${entry.method}: ${entry.name}`);
  const head = new Uint8Array(await blob.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
  if (head.byteLength !== 30) throw new Error(`zip archive is truncated at ${entry.name}`);
  const headView = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (headView.getUint32(0, true) !== LF_SIG)
    throw new Error(`zip local header missing for ${entry.name}`);
  return entry.localOffset + 30 + headView.getUint16(26, true) + headView.getUint16(28, true);
}

// One entry's bytes without reading them: a Blob slice of the archive for a
// stored entry, an inflating ReadableStream for a deflated one (no CRC check).
export async function zipEntrySource(blob, entry) {
  const dataOffset = await zipEntryDataOffset(blob, entry);
  const raw = blob.slice(dataOffset, dataOffset + entry.compSize);
  return entry.method === 0 ? raw : raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
}

// One entry's bytes as a ReadableStream, inflated and checked: the stream
// errors at its end on a size or CRC mismatch. onBytes(n) sees each chunk.
export async function zipEntryStream(blob, entry, onBytes) {
  const source = await zipEntrySource(blob, entry);
  let crc = 0xffffffff, size = 0;
  return (source instanceof Blob ? source.stream() : source).pipeThrough(new TransformStream({
    transform(chunk, controller) {
      crc = crc32Update(crc, chunk);
      size += chunk.byteLength;
      onBytes?.(chunk.byteLength);
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (size !== entry.size)
        controller.error(new Error(`size mismatch unpacking ${entry.name}: ${size} != ${entry.size}`));
      else if (((crc ^ 0xffffffff) >>> 0) !== entry.crc)
        controller.error(new Error(`CRC mismatch unpacking ${entry.name}: file is corrupt`));
    },
  }));
}

// Raw bytes of one entry, CRC-checked. Only stored (0) and deflated (8).
export async function extractZipEntry(blob, entry) {
  const dataOffset = await zipEntryDataOffset(blob, entry);
  const raw = new Uint8Array(await blob.slice(dataOffset, dataOffset + entry.compSize).arrayBuffer());
  if (raw.byteLength !== entry.compSize)
    throw new Error(`zip archive is truncated at ${entry.name}`);
  let bytes;
  if (entry.method === 0) {
    bytes = raw;
  } else {
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (bytes.byteLength !== entry.size)
    throw new Error(`size mismatch unpacking ${entry.name}: ${bytes.byteLength} != ${entry.size}`);
  if (crc32(bytes) !== entry.crc)
    throw new Error(`CRC mismatch unpacking ${entry.name}: file is corrupt`);
  return bytes;
}

// A store-only (uncompressed) zip of [{ path, bytes }], for downloads such as
// exported saves. Paths use '/' and no leading slash.
export function createZip(files) {
  const encoder = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const { path, bytes } of files) {
    const name = encoder.encode(path);
    const crc = crc32(bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true);
    local.setUint32(14, crc, true); local.setUint32(18, bytes.length, true); local.setUint32(22, bytes.length, true);
    local.setUint16(26, name.length, true);
    parts.push(local, name, bytes);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true);
    entry.setUint32(16, crc, true); entry.setUint32(20, bytes.length, true); entry.setUint32(24, bytes.length, true);
    entry.setUint16(28, name.length, true); entry.setUint32(42, offset, true);
    central.push(entry, name);
    offset += 30 + name.length + bytes.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
