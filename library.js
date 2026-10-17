// The games, firmware and saves this browser holds, without any UI: the
// player page (player.js) and the app (browser/app) share it. Everything
// lives in persistent browser storage (OPFS, content_cache.js); imports that
// need decrypting run in decrypt_worker.js.
import * as cache from './content_cache.js';
import { createZip, listZipEntries, extractZipEntry } from './zip.js';

export const FIRMWARE_KEY = cache.FIRMWARE_KEY;

export function storageSupported() {
  try {
    return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
  } catch {
    return false;
  }
}

const sanitizeSegment = (value) => String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || '_';
export const packageKeyFor = (title, app = title) => `${sanitizeSegment(title)}/${sanitizeSegment(app)}`;

// Uploaded games: [{ title, app, files, bytes }].
export async function listPackages() {
  if (!storageSupported()) return [];
  try { return await cache.listCachedTitles(); } catch { return []; }
}

// A stored game's name and icon, from its param.sfo and sce_sys/icon0.png:
// { title, name, version, icon: Blob | null }. Reads the uploaded package,
// else the server copy this browser cached; name falls back to the id.
export async function titleInfo(title, app = title) {
  const info = { title, name: title, version: '', icon: null };
  if (!storageSupported()) return info;
  for (const key of [packageKeyFor(title, app), packageKeyFor(title, app) + cache.SERVER_SUFFIX]) {
    const sfo = await cache.cacheReadFile(key, `ux0/app/${app}/sce_sys/param.sfo`);
    if (!sfo) continue;
    const params = cache.readSfo(sfo) ?? {};
    if (typeof params.TITLE === 'string' && params.TITLE.trim()) info.name = params.TITLE.replace(/\s+/g, ' ').trim();
    if (typeof params.APP_VER === 'string') info.version = params.APP_VER.replace(/^0+(?=\d)/, '');
    info.icon = await cache.cacheGetFile(key, `ux0/app/${app}/sce_sys/icon0.png`);
    break;
  }
  return info;
}

// Removes an uploaded game (and this browser's copy of a server game);
// its saves stay unless withSaves.
export async function removeTitle(title, app = title, { withSaves = false } = {}) {
  await cache.cacheClear(packageKeyFor(title, app));
  await cache.cacheClear(packageKeyFor(title, app) + cache.SERVER_SUFFIX);
  if (withSaves) await cache.clearSaves(title);
}

// The firmware this browser holds: { files, bytes, system, fonts }.
export async function firmwareStatus() {
  const files = (storageSupported() ? await cache.cacheReadManifest(FIRMWARE_KEY) : null)?.files ?? [];
  const roots = new Set(files.map((file) => file.path.split('/')[0]));
  return { files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0),
    system: roots.has('vs0') && roots.has('os0'), fonts: roots.has('sa0') };
}

export async function removeFirmware() {
  await cache.cacheClear(FIRMWARE_KEY);
}

// What a file is, from its name: 'pup' (firmware), 'pkg' (a PSN download),
// 'zip' (.zip/.vpk: a game, an encrypted dump or firmware folders) or null.
export function fileKind(name) {
  return /\.pup$/i.test(name) ? 'pup' : /\.pkg$/i.test(name) ? 'pkg' : /\.(zip|vpk)$/i.test(name) ? 'zip' : null;
}

// Imports a game or firmware file into storage.
//   expect: 'game' | 'firmware' | undefined (either)
//   zrif(fileName): resolves to a .pkg's zRIF license (asked when needed)
//   onProgress({ phase, path, bytes, total }): phase 'load', 'prepare',
//   'inflate', 'unpack', 'decrypt', 'install' or 'store' (what happens to path)
// Resolves { kind: 'firmware', version?, roots?, files, bytes } or
// { kind: 'game', title, app, files, bytes, decrypted? }.
export async function importFile(file, { expect, zrif, onProgress = () => {} } = {}) {
  if (!storageSupported()) throw new Error('this browser has no persistent storage (OPFS)');
  const kind = fileKind(file.name);
  if (!kind) throw new Error('games come as .zip/.vpk or .pkg files, firmware as .PUP files or a .zip of its folders');
  if (expect === 'game' && kind === 'pup') throw new Error('this is a firmware file, not a game');
  if (expect === 'firmware' && kind === 'pkg') throw new Error('this is a game package, not firmware');
  let result;
  if (kind === 'pup') {
    // Sony's firmware files (system software, font package): installed and
    // decrypted here, as desktop Vita3K does.
    const done = await runDecryptWorker({ type: 'pup', archive: file },
      (bytes, path, phase) => onProgress({ phase, path, bytes, total: 0 }));
    result = { kind: 'firmware', version: done.version, roots: done.roots, skipped: done.skipped, files: done.files, bytes: done.bytes };
  } else if (kind === 'pkg') {
    // A PSN download: its license comes separately, as a zRIF string.
    const license = (await zrif?.(file.name))?.trim();
    if (!license) throw new Error('a .pkg needs its zRIF license');
    const done = await runDecryptWorker({ type: 'pkg', archive: file, zrif: license },
      (bytes, path, phase) => onProgress({ phase, path, bytes, total: 0 }));
    result = { kind: 'game', title: done.title, app: done.app, files: done.files.length, bytes: done.bytes, decrypted: true };
  } else {
    // The package names its own title (its ux0/app/<id> directory), so an
    // upload is all a game needs besides firmware.
    const contents = await cache.packageContents(file);
    if (expect === 'firmware' && !contents.firmware)
      throw new Error(`this is a game package (${contents.title}), not firmware`);
    if (expect === 'game' && contents.firmware) throw new Error('this archive holds firmware, not a game');
    const key = packageKeyFor(contents.title, contents.app);
    const total = contents.files.reduce((sum, entry) => sum + entry.size, 0);
    // An encrypted dump (NoNpDrm: a PFS image and its license) is decrypted
    // into storage as it unpacks.
    const appRoot = `ux0/app/${contents.app}/`;
    const encrypted = !contents.firmware && contents.files.some((entry) => entry.path === appRoot + 'sce_pfs/files.db')
      && contents.files.some((entry) => entry.path === appRoot + 'sce_sys/package/work.bin');
    if (encrypted) {
      const done = await runDecryptWorker({ type: 'decrypt', archive: file, key, appRoot,
        files: contents.files.map(({ path, size, entry }) => ({ path, size, entry })) },
      (bytes, path, phase) => onProgress({ phase, path, bytes, total }));
      result = { kind: 'game', title: contents.title, app: contents.app, files: done.files.length, bytes: done.bytes, decrypted: true };
    } else {
      const done = await cache.unpackPackageToCache(file, key, (count, files, path, bytes) =>
        onProgress({ phase: 'unpack', path, bytes, total }));
      result = contents.firmware
        ? { kind: 'firmware', files: done.files, bytes: done.bytes }
        : { kind: 'game', title: contents.title, app: contents.app, files: done.files, bytes: done.bytes };
    }
  }
  try { await navigator.storage.persist?.(); } catch {}
  return result;
}

// One job of decrypt_worker.js (an encrypted dump, a .pkg or a firmware
// .PUP); resolves with its result. onProgress(bytes done, path, phase).
export function runDecryptWorker(message, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./decrypt_worker.js', import.meta.url), { type: 'module' });
    worker.onerror = (event) => { worker.terminate(); reject(new Error('decryption worker: ' + event.message)); };
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') { onProgress(data.done, data.path, data.phase); return; }
      worker.terminate();
      if (data.type === 'error') reject(new Error(data.message));
      else resolve(data);
    };
    worker.postMessage(message);
  });
}

// --- Saves -------------------------------------------------------------------
// Per title, apart from game content (save_sync.js keeps them in step with
// the running game). Paths are relative to ux0:user/00/savedata/<title>/.

export async function listSaves(title) {
  if (!storageSupported()) return [];
  return cache.readSaves(title).catch(() => []);
}

// A title's saves as a .zip laid out like the Vita filesystem
// (ux0/user/00/savedata/<title>/…), or null when it has none.
export async function savesZip(title) {
  const saves = await listSaves(title);
  if (!saves.length) return null;
  return createZip(saves.map(({ path, bytes }) => ({ path: `ux0/user/00/savedata/${title}/${path}`, bytes })));
}

// Restores a title's saves from a .zip (savesZip's, or a save folder zipped),
// replacing the ones it has; confirmReplace(existing, incoming) may decline.
// Resolves the number restored, or 0 when declined.
export async function restoreSaves(title, file, { confirmReplace } = {}) {
  if (!storageSupported()) throw new Error('this browser has no persistent storage for saves');
  const saves = cache.savesInArchive(await listZipEntries(file), title);
  const existing = await listSaves(title);
  if (existing.length && confirmReplace && !(await confirmReplace(existing.length, saves.length))) return 0;
  await cache.clearSaves(title);
  for (const save of saves) await cache.writeSave(title, save.path, await extractZipEntry(file, save.entry));
  return saves.length;
}

export async function removeSaves(title) {
  await cache.clearSaves(title);
}

// Storage use and quota of this site: { usage, quota } in bytes, or null.
export async function storageEstimate() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}
