// Game content in persistent browser storage (OPFS). A package (.zip the user
// picks) defines its own title: its `ux0/app/<id>/` directory names the title
// and every file it ships is stored under that title's namespace, so an
// upload alone makes a game bootable — no server-side staging. Files the
// package lacks (firmware above all) come from the server and are cached the
// same way on first use. Runs on the page and in the worker; every read
// degrades to a miss and every call reports failure with a message.
import { listZipEntries, extractZipEntry, normalizeEntryPath, zipEntryStream } from './zip.js';

export function contentCacheSupported() {
  try {
    return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
  } catch {
    return false;
  }
}

const sanitize = (value) =>
  String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || '_';
export function cacheKeyFor(title, app) {
  return `${sanitize(title)}/${sanitize(app)}`;
}
// Firmware (os0/vs0) uploaded on its own is stored once under this key and
// shared by every title; it is not a title (no title id has a leading _).
export const FIRMWARE_TITLE = '_firmware';
export const FIRMWARE_KEY = cacheKeyFor(FIRMWARE_TITLE, FIRMWARE_TITLE);
// System software (os0 + vs0) and the font package (sa0).
const FIRMWARE_ROOTS = new Set(['os0', 'vs0', 'sa0']);

const contentParts = (key) => ['vita3k-content', ...key.split('/')];
const metaParts = (key) => ['vita3k-meta', ...key.split('/')];

async function openDir(create, ...parts) {
  let dir = await navigator.storage.getDirectory();
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}

export async function cacheReadManifest(key) {
  try {
    const dir = await openDir(false, ...metaParts(key));
    const handle = await dir.getFileHandle('manifest.json');
    const json = JSON.parse(await (await handle.getFile()).text());
    if (!json || !Array.isArray(json.files)) return null;
    if (!json.files.every((f) => typeof f?.path === 'string' && Number.isSafeInteger(f?.size))) return null;
    return json;
  } catch {
    return null;
  }
}

export async function cacheWriteManifest(key, files) {
  const dir = await openDir(true, ...metaParts(key));
  const handle = await dir.getFileHandle('manifest.json', { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(JSON.stringify({ files }));
  } finally {
    await writable.close();
  }
}

export async function cacheReadFile(key, relPath) {
  try {
    const segments = relPath.split('/');
    const dir = await openDir(false, ...contentParts(key), ...segments.slice(0, -1));
    const handle = await dir.getFileHandle(segments[segments.length - 1]);
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  } catch {
    return null;
  }
}

export async function cacheWriteFile(key, relPath, bytes) {
  const segments = relPath.split('/');
  const dir = await openDir(true, ...contentParts(key), ...segments.slice(0, -1));
  const handle = await dir.getFileHandle(segments[segments.length - 1], { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (error) {
    try { await writable.close(); } catch {}
    try { await dir.removeEntry(segments[segments.length - 1]); } catch {}
    throw error;
  }
}

// A file of a title's content written from a ReadableStream (bounded memory).
export async function cacheWriteStream(key, relPath, stream) {
  const segments = relPath.split('/');
  const dir = await openDir(true, ...contentParts(key), ...segments.slice(0, -1));
  const handle = await dir.getFileHandle(segments[segments.length - 1], { create: true });
  const writable = await handle.createWritable();
  await stream.pipeTo(writable);
  return (await handle.getFile()).size;
}
// One zip entry into a title's content, streamed (memory stays bounded
// whatever the file's size) and checked; returns its size. onBytes(n) as it goes.
export async function cacheWriteZipEntry(key, relPath, archive, entry, onBytes) {
  return cacheWriteStream(key, relPath, await zipEntryStream(archive, entry, onBytes));
}
// A stored file as a File (a Blob read lazily), or null.
export async function cacheGetFile(key, relPath) {
  try {
    const segments = relPath.split('/');
    const dir = await openDir(false, ...contentParts(key), ...segments.slice(0, -1));
    return await (await dir.getFileHandle(segments[segments.length - 1])).getFile();
  } catch {
    return null;
  }
}
// A synchronous access handle on a new, empty file of a title's content:
// dedicated Workers only (decrypt_worker.js writes decrypted files through it).
export async function cacheOpenSync(key, relPath) {
  const segments = relPath.split('/');
  const dir = await openDir(true, ...contentParts(key), ...segments.slice(0, -1));
  const handle = await dir.getFileHandle(segments[segments.length - 1], { create: true });
  const access = await handle.createSyncAccessHandle();
  access.truncate(0);
  return access;
}

// One file or folder of a title's content (its manifest is the caller's).
export async function cacheRemovePath(key, relPath) {
  const segments = relPath.split('/');
  try {
    const dir = await openDir(false, ...contentParts(key), ...segments.slice(0, -1));
    await dir.removeEntry(segments[segments.length - 1], { recursive: true });
  } catch {}
}

export async function cacheClear(key) {
  for (const parts of [contentParts(key), metaParts(key)]) {
    try {
      const parent = await openDir(false, ...parts.slice(0, -1));
      await parent.removeEntry(parts[parts.length - 1], { recursive: true });
    } catch {}
  }
}

// A server-staged title's downloaded copy lives under <title>/<app>.server,
// apart from an uploaded package of the same title at <title>/<app>.
export const SERVER_SUFFIX = '.server';
// Whether a manifest is a server copy stored before that split: every file
// carries the server's version (package files never do).
export function isServerManifest(manifest) {
  return Array.isArray(manifest?.files) && manifest.files.length > 0
    && manifest.files.every((file) => file.version !== undefined);
}

// Packages this browser holds: [{ title, app, files, bytes }]. Server copies
// (see SERVER_SUFFIX) are a cache, not packages.
export async function listCachedTitles() {
  const out = [];
  try {
    const root = await openDir(false, 'vita3k-meta');
    for await (const [title, handle] of root.entries()) {
      if (handle.kind !== 'directory' || title === FIRMWARE_TITLE) continue;
      for await (const [app, appHandle] of handle.entries()) {
        if (appHandle.kind !== 'directory' || app.endsWith(SERVER_SUFFIX)) continue;
        let files = 0, bytes = 0;
        try {
          const manifest = JSON.parse(await (await (await appHandle.getFileHandle('manifest.json')).getFile()).text());
          if (isServerManifest(manifest)) continue;
          files = manifest.files.length;
          bytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
        } catch {}
        if (files) out.push({ title, app, files, bytes });
      }
    }
  } catch {}
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

// Which needed paths does a stored manifest cover (path, size and, for server
// files, version)? Returns a Map<path, size>; anything absent is fetched (and
// then stored).
export function cacheIndexFor(manifestFiles, needed) {
  const index = new Map();
  if (!Array.isArray(manifestFiles) || !Array.isArray(needed)) return index;
  const have = new Map(manifestFiles.map((f) => [f?.path, f]));
  for (const file of needed) {
    const stored = typeof file?.path === 'string' ? have.get(file.path) : undefined;
    if (!stored || stored.size !== file.size)
      continue;
    // A server file carries a version (its modification time): a stored copy
    // of the same size but another (or no) version is stale, e.g. a title
    // restaged on the server. Package files have no version.
    if (file.version !== undefined && stored.version !== file.version)
      continue;
    index.set(file.path, file.size);
  }
  return index;
}

// Vita device roots: a path starting with one of these is already absolute
// in the guest's filesystem and must not be re-rooted under ux0.
const DEVICE_ROOTS = new Set(['ux0', 'os0', 'vs0', 'ur0', 'vd0', 'tm0', 'sa0', 'pd0', 'app0', 'ux0:']);

// Which title a package holds and what it ships, normalized into the Vita
// tree. The app directory may sit at `ux0/app/<id>/…` or `app/<id>/…`,
// optionally under wrapper folders (`MyGame/ux0/app/<id>/…`), which is how
// most dumps and homebrew zips are archived. Everything under the same device
// root is kept when it belongs to this title (its app directory, its trophy
// data) or is firmware the package happens to include.
// Returns { title, app, files: [{ path, size, entry }] }.
export async function packageContents(blob) {
  if (!blob || !Number.isSafeInteger(blob.size) || blob.size === 0)
    throw new Error('empty package file');
  const entries = await listZipEntries(blob);
  const files = [];
  for (const entry of entries) {
    if (entry.dir) continue;
    const path = normalizeEntryPath(entry.name);
    if (path === null) continue;
    files.push({ entry, path });
  }
  if (!files.length) throw new Error('package contains no usable files');
  // Candidate device roots: each `app/<id>` occurrence fixes a strip depth
  // (one level shallower when it is already under ux0/). The depth whose
  // `app/<id>` pair covers the most files wins; ties keep the first.
  const candidates = new Map(); // depth -> { ids: Map<id, count>, hits }
  for (const file of files) {
    const segments = file.path.split('/');
    const appAt = segments.indexOf('app');
    if (appAt < 0 || appAt + 1 >= segments.length) continue;
    // vs0/app/<id> are the firmware's own system apps, not a game.
    if (appAt >= 1 && FIRMWARE_ROOTS.has(segments[appAt - 1])) continue;
    const id = segments[appAt + 1];
    if (!/^[A-Za-z0-9_-]{3,24}$/.test(id)) continue;
    const depth = appAt >= 1 && segments[appAt - 1] === 'ux0' ? appAt - 1 : appAt;
    let candidate = candidates.get(depth);
    if (!candidate) candidates.set(depth, candidate = { depth, ids: new Map(), hits: 0 });
    candidate.ids.set(id, (candidate.ids.get(id) ?? 0) + 1);
    candidate.hits++;
  }
  let best = null;
  for (const candidate of candidates.values()) {
    const [title, hits] = [...candidate.ids.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!best || hits > best.hits) best = { ...candidate, title, hits };
  }
  if (!best) return firmwareContents(files) ?? barePackageContents(blob, files);
  const shipped = [];
  for (const file of files) {
    const segments = file.path.split('/');
    if (segments.length <= best.depth) continue;
    // The strip depth lands on a device root when the archive holds the
    // whole Vita tree (os0/… next to ux0/…), and on a bare ux0 tree when it
    // holds only the app partition: the latter needs the ux0/ prefix.
    const rest = segments.slice(best.depth).join('/');
    const rooted = DEVICE_ROOTS.has(segments[best.depth]);
    const path = rooted ? rest : 'ux0/' + rest;
    const isTitle = path.startsWith(`ux0/app/${best.title}/`) || path.startsWith('ux0/user/');
    // Anything outside ux0 (firmware the package happens to carry) ships as
    // is; inside ux0 only this title's own files are kept.
    if (rooted ? false : !isTitle) continue;
    shipped.push({ path, size: file.entry.size, entry: file.entry });
  }
  if (!shipped.length) throw new Error(`package has no files for ${best.title}`);
  return { title: best.title, app: best.title, files: shipped };
}

// An archive of firmware alone: os0/ and vs0/ and/or the font package's
// sa0/ (an installed firmware's folders, e.g. from desktop Vita3K's data
// directory), optionally under wrapper folders. Returns null when it holds
// no firmware.
function firmwareContents(files) {
  let depth = -1;
  for (const file of files) {
    const at = file.path.split('/').findIndex((segment) => FIRMWARE_ROOTS.has(segment));
    if (at >= 0 && (depth < 0 || at < depth)) depth = at;
  }
  if (depth < 0) return null;
  const shipped = [];
  for (const file of files) {
    const segments = file.path.split('/');
    if (segments.length <= depth + 1 || !FIRMWARE_ROOTS.has(segments[depth])) continue;
    shipped.push({ path: segments.slice(depth).join('/'), size: file.entry.size, entry: file.entry });
  }
  if (shipped.some((file) => file.path.startsWith('vs0/')) !== shipped.some((file) => file.path.startsWith('os0/')))
    throw new Error('the system software needs both its os0/ and vs0/ folders');
  return { title: FIRMWARE_TITLE, app: FIRMWARE_TITLE, firmware: true, files: shipped };
}

// Vita param.sfo ('PSF\0'): its string parameters (TITLE, TITLE_ID,
// CATEGORY, …) as an object, or null when the data is not a readable SFO.
export function readSfo(bytes) {
  try {
    if (bytes.length < 20) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0x46535000) return null; // '\0PSF'
    const keyStart = view.getUint32(8, true);
    const dataStart = view.getUint32(12, true);
    const count = view.getUint32(16, true);
    if (count > 256 || keyStart >= bytes.length || dataStart >= bytes.length) return null;
    const decoder = new TextDecoder();
    const params = {};
    for (let i = 0; i < count; i++) {
      const at = 20 + i * 16;
      if (at + 16 > bytes.length) return null;
      const keyOffset = view.getUint16(at, true);
      const format = view.getUint16(at + 2, true);
      const length = view.getUint32(at + 4, true);
      const dataOffset = view.getUint32(at + 12, true);
      let end = keyStart + keyOffset;
      while (end < bytes.length && bytes[end] !== 0) end++;
      const key = decoder.decode(bytes.subarray(keyStart + keyOffset, end));
      if (dataStart + dataOffset + length > bytes.length) return null;
      const raw = bytes.subarray(dataStart + dataOffset, dataStart + dataOffset + length);
      if (format === 0x0404) params[key] = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0, true);
      else {
        const zero = raw.indexOf(0);
        params[key] = decoder.decode(zero < 0 ? raw : raw.subarray(0, zero));
      }
    }
    return params;
  } catch {
    return null;
  }
}
// The TITLE_ID of archives that hold the app directory itself (the bare .vpk
// layout: eboot.bin and sce_sys/param.sfo at the root, no app/<id> folder).
function readSfoTitleId(bytes) {
  const id = readSfo(bytes)?.TITLE_ID;
  return typeof id === 'string' && /^[A-Za-z0-9_-]{3,24}$/.test(id) ? id : null;
}

// Fallback for archives with no app/<id> directory: the root (or a wrapper
// folder) is the app directory itself. The title id comes from its
// sce_sys/param.sfo, and every file under that root is stored as the
// title's ux0/app/<id>/ tree.
async function barePackageContents(blob, files) {
  let sfo = null;
  for (const file of files) {
    const segments = file.path.split('/');
    const at = segments.indexOf('sce_sys');
    if (at < 0 || segments[at + 1] !== 'param.sfo') continue;
    if (!sfo || at < sfo.depth) sfo = { file, depth: at };
  }
  if (!sfo) {
    const top = [...new Set(files.map((f) => f.path.split('/')[0]))].slice(0, 8);
    throw new Error(`no game found in the package (zip holds e.g. ${top.join(', ')}): ` +
      'expected an app/ or ux0/app/ directory, or a .vpk with sce_sys/param.sfo');
  }
  const title = readSfoTitleId(await extractZipEntry(blob, sfo.file.entry));
  if (!title) throw new Error('cannot read the title id from sce_sys/param.sfo');
  const root = sfo.file.path.split('/').slice(0, sfo.depth);
  const shipped = [];
  for (const file of files) {
    const segments = file.path.split('/');
    if (segments.length <= sfo.depth) continue;
    if (!root.every((segment, i) => segments[i] === segment)) continue;
    shipped.push({ path: `ux0/app/${title}/` + segments.slice(sfo.depth).join('/'), size: file.entry.size, entry: file.entry });
  }
  if (!shipped.length) throw new Error(`package has no files for ${title}`);
  return { title, app: title, files: shipped };
}

// Store a package under its own title's key. onProgress(done, total, path,
// doneBytes, totalBytes). Returns { title, app, files, bytes }. Firmware
// replaces only the folders it holds (os0/vs0, sa0) and keeps the others.
export async function unpackPackageToCache(blob, key, onProgress) {
  const contents = await packageContents(blob);
  const totalBytes = contents.files.reduce((sum, file) => sum + file.size, 0);
  let kept = [];
  if (contents.firmware) {
    const roots = new Set(contents.files.map((file) => file.path.split('/')[0]));
    kept = ((await cacheReadManifest(key))?.files ?? []).filter((file) => !roots.has(file.path.split('/')[0]));
    for (const root of roots) await cacheRemovePath(key, root);
  } else {
    await cacheClear(key);
  }
  const stored = [];
  let bytes = 0;
  try {
    for (const file of contents.files) {
      // Streamed: one entry can be larger than a page may hold (Persona 4
      // Golden's data.cpk is 1.8 GiB).
      await cacheWriteZipEntry(key, file.path, blob, file.entry, (chunk) => {
        bytes += chunk;
        onProgress?.(stored.length, contents.files.length, file.path, bytes, totalBytes);
      });
      stored.push({ path: file.path, size: file.size });
      onProgress?.(stored.length, contents.files.length, file.path, bytes, totalBytes);
    }
  } catch (error) {
    // Keep what unpacked cleanly so a re-upload only has to finish the tail.
    if (stored.length || kept.length) {
      try { await cacheWriteManifest(key, [...kept, ...stored]); } catch {}
    } else {
      try { await cacheClear(key); } catch {}
    }
    throw error;
  }
  await cacheWriteManifest(key, [...kept, ...stored]);
  return { title: contents.title, app: contents.app, files: stored.length, bytes };
}

// Game saves per title (save_sync.js), apart from staged content: clearing a
// title's cached files never touches its saves. Paths are relative to the
// title's ux0:user/00/savedata/<title>/ directory.
const saveParts = (title) => ['vita3k-saves', sanitize(title)];

export async function readSaves(title) {
  const out = [];
  const walk = async (dir, prefix) => {
    for await (const [name, handle] of dir.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') await walk(handle, path);
      else out.push({ path, bytes: new Uint8Array(await (await handle.getFile()).arrayBuffer()) });
    }
  };
  try {
    await walk(await openDir(false, ...saveParts(title)), '');
  } catch {}
  return out;
}

export async function writeSave(title, relPath, bytes) {
  const segments = relPath.split('/');
  const dir = await openDir(true, ...saveParts(title), ...segments.slice(0, -1));
  const handle = await dir.getFileHandle(segments[segments.length - 1], { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
  } finally {
    await writable.close();
  }
}

// Every save of a title (before a restore replaces them).
export async function clearSaves(title) {
  const parts = saveParts(title);
  try {
    const parent = await openDir(false, ...parts.slice(0, -1));
    await parent.removeEntry(parts[parts.length - 1], { recursive: true });
  } catch {}
}

// Which files of a saves archive are a title's saves: [{ entry, path }] with
// paths relative to its savedata folder. Accepts the Download button's zip
// (ux0/user/00/savedata/<title>/…), any archive holding a savedata/<title>/ or
// <title>/ folder (desktop Vita3K's, zipped), or a save folder's bare contents.
// Throws when the archive holds another title's saves or looks like a game.
export function savesInArchive(entries, title) {
  const files = entries.filter((entry) => !entry.dir)
    .map((entry) => ({ entry, segments: normalizeEntryPath(entry.name)?.split('/') }))
    .filter((file) => file.segments);
  const under = (match) => files.flatMap(({ entry, segments }) => {
    const at = segments.findIndex(match);
    return at < 0 ? [] : [{ entry, path: segments.slice(at + 1).join('/') }];
  }).filter((file) => file.path);
  let saves = under((segment, i, all) => segment === title && all[i - 1] === 'savedata');
  if (!saves.length) saves = under((segment) => segment === title);
  if (saves.length) return saves;
  const others = new Set(files.flatMap(({ segments }) => {
    const at = segments.indexOf('savedata');
    return at >= 0 && segments[at + 1] ? [segments[at + 1]] : [];
  }));
  if (others.size) throw new Error(`this archive holds saves for ${[...others].join(', ')}, not ${title}`);
  if (files.some(({ segments }) => /^(eboot\.bin|sce_pfs|sce_module|os0|vs0|app)$/i.test(segments[0])))
    throw new Error('this looks like a game or firmware archive, not saves');
  const bytes = files.reduce((sum, { entry }) => sum + entry.size, 0);
  if (bytes > 256 * 1048576) throw new Error('too large for saves (over 256 MiB)');
  return files.map(({ entry, segments }) => ({ entry, path: segments.join('/') }));
}

export async function removeSave(title, relPath) {
  const segments = relPath.split('/');
  try {
    const dir = await openDir(false, ...saveParts(title), ...segments.slice(0, -1));
    await dir.removeEntry(segments[segments.length - 1]);
  } catch {}
}
