// Turns Sony's distribution formats into a title's or the firmware's
// persistent content, as desktop Vita3K's installers do. The module
// (dist/decrypt, browser/decrypt/decrypt.cpp) works one file per call so that
// each output file streams into browser storage (OPFS) through a synchronous
// access handle opened between calls: memory stays bounded by one SELF,
// whatever the game's size.
//
// In: { type: 'decrypt', archive: File, key, appRoot: 'ux0/app/<id>/',
//       files: [{ path, size, entry }] }  an encrypted (NoNpDrm) dump in a zip
//     { type: 'pkg', archive: File, zrif }  a .pkg (PSN download) and its license
//     { type: 'pup', archive: File }        a firmware .PUP
// Out: { type: 'progress', done, total, phase, path } … then (phase: 'load',
//      'prepare', 'inflate', 'unpack', 'decrypt', 'install' or 'store')
//      { type: 'done', title, app, files: [{ path, size }], bytes, decrypted, selfs }
//      ('pup': { type: 'done', version, roots, files, bytes, skipped }) or
//      { type: 'error', message }
import { zipEntrySource } from './zip.js';
import { cacheWorkerFSReads } from './workerfs_read_cache.js';
import { cacheClear, cacheGetFile, cacheKeyFor, cacheOpenSync, cacheReadManifest, cacheRemovePath, cacheWriteFile,
  cacheWriteManifest, cacheWriteStream, cacheWriteZipEntry, FIRMWARE_KEY } from './content_cache.js';

const SELF = /(^|\/)eboot\.bin$|\.(suprx|skprx|self)$/i;
const TEMP_KEY = '_decrypt/_input'; // inflated or unpacked inputs
// What firmware storage keeps from a .PUP: pd0 (pre-installed content) is
// not something games load.
const FIRMWARE_ROOTS = ['os0', 'vs0', 'sa0'];

let modulePromise = null;
function loadModule() {
  modulePromise ??= import('./decrypt/vita3k_decrypt.mjs').then(({ default: create }) =>
    create({ print: () => {}, printErr: (text) => console.warn('[decrypt]', text) }));
  return modulePromise;
}

onmessage = async ({ data }) => {
  let key = data?.key ?? null;
  try {
    postMessage({ type: 'progress', done: 0, total: 0, phase: 'load', path: 'decryption support' });
    const M = await loadModule();
    const tools = moduleTools(M);
    let result;
    if (data?.type === 'decrypt') result = await decryptZip(tools, data);
    else if (data?.type === 'pkg') result = await installPkg(tools, data, (k) => { key = k; });
    else if (data?.type === 'pup') result = await installPup(tools, data);
    else return;
    postMessage({ type: 'done', ...result });
  } catch (error) {
    if (key) try { await cacheClear(key); } catch {}
    postMessage({ type: 'error', message: String(error?.message ?? error) });
  } finally {
    try { await cacheClear(TEMP_KEY); } catch {}
  }
};

function moduleTools(M) {
  const clearReadCache = cacheWorkerFSReads(M.WORKERFS);
  const call = (name, ...args) => M.ccall(name, 'number', args.map((a) => typeof a === 'string' ? 'string' : 'number'), args);
  const text = (name, ...args) => M.UTF8ToString(M['_' + name](...args));
  const check = (result) => { if (result < 0) throw new Error(text('vd_error')); return result; };
  const remount = (dir, type, options) => {
    clearReadCache();
    try { M.FS.unmount(dir); } catch {}
    try { M.FS.rmdir(dir); } catch {}
    try { M.FS.mkdir(dir); } catch {} // kept when files remain in it
    if (type) M.FS.mount(type, options, dir);
  };
  let done = 0, total = 0;
  const progress = {
    reset(bytes) { done = 0; total = bytes; },
    report(path, bytes = 0, phase = 'decrypt') { done += bytes; postMessage({ type: 'progress', done, total, phase, path }); },
  };
  return { M, FS: M.FS, call, text, check, remount, progress };
}

const dirOf = (path) => path.slice(0, path.lastIndexOf('/')) || '/';

// Runs write(path) — module code writing one file at the MEMFS path — with
// that file's writes going straight to storage; returns the stored size.
async function writeToStorage({ FS }, path, key, relPath, write) {
  const access = await cacheOpenSync(key, relPath);
  try {
    FS.mkdirTree(dirOf(path));
    FS.writeFile(path, new Uint8Array(0));
    const node = FS.lookupPath(path).node;
    node.stream_ops = {
      llseek(stream, offset, whence) {
        const position = whence === 1 ? stream.position + offset : whence === 2 ? access.getSize() + offset : offset;
        if (position < 0) throw new FS.ErrnoError(28);
        return position;
      },
      read: (stream, buffer, offset, length, position) => access.read(buffer.subarray(offset, offset + length), { at: position }),
      write: (stream, buffer, offset, length, position) => access.write(buffer.subarray(offset, offset + length), { at: position }),
    };
    write(path);
    access.flush();
    return access.getSize();
  } finally {
    access.close();
    try { FS.unlink(path); } catch {}
  }
}

// An encrypted dump's app folder (inputs: Map of path relative to it ->
// Blob) decrypted into key under appRoot. Returns what it stored.
async function decryptApp(tools, inputs, key, appRoot) {
  const { M, FS, call, text, check, remount, progress } = tools;
  progress.report('encrypted game files', 0, 'prepare');
  remount('/src', M.WORKERFS, { blobs: [...inputs].map(([name, data]) => ({ name, data })) });
  remount('/out');
  remount('/self');
  const stored = [];
  let bytes = 0, decrypted = 0, selfs = 0;
  const store = (relative, size) => { stored.push({ path: appRoot + relative, size }); bytes += size; };
  try {
    const count = check(call('vd_open', '/src', '/src/sce_sys/package/work.bin'));
    for (let index = 0; index < count; ++index) {
      const [kind, sizeText, relative] = text('vd_entry', index).split('\t');
      const size = Number(sizeText);
      if (kind === 'dir') continue;
      progress.report(relative);
      if (kind === 'empty') {
        await cacheWriteFile(key, appRoot + relative, new Uint8Array(0));
        store(relative, 0);
        continue;
      }
      if (SELF.test(relative)) {
        // SELFs are small: decrypt (or copy) into memory, then the SELF layer.
        const plain = '/self/plain', elf = '/self/elf';
        if (kind === 'copy') FS.writeFile(plain, new Uint8Array(await inputs.get(relative).arrayBuffer()));
        else {
          FS.mkdirTree(dirOf('/out/' + relative));
          check(call('vd_run', index, '/out'));
          FS.rename('/out/' + relative, plain);
        }
        const result = check(call('vd_decrypt_self', plain, elf));
        const out = FS.readFile(result ? elf : plain);
        await cacheWriteFile(key, appRoot + relative, out);
        store(relative, out.byteLength);
        selfs += result;
        for (const path of [plain, elf]) try { FS.unlink(path); } catch {}
      } else if (kind === 'copy') {
        store(relative, await cacheWriteStream(key, appRoot + relative, inputs.get(relative).stream()));
      } else {
        store(relative, await writeToStorage(tools, '/out/' + relative, key, appRoot + relative,
          () => check(call('vd_run', index, '/out'))));
        decrypted += 1;
      }
      progress.report(relative, size);
    }
  } finally {
    call('vd_close');
    remount('/src');
  }
  return { stored, bytes, decrypted, selfs };
}

async function decryptZip(tools, { archive, key, appRoot, files }) {
  tools.progress.reset(files.reduce((sum, file) => sum + file.size, 0));
  tools.progress.report(archive.name || 'the archive', 0, 'prepare');
  await cacheClear(key);
  await cacheClear(TEMP_KEY);
  // Input: the app folder, read lazily from the archive (WORKERFS reads Blobs
  // synchronously). Deflated entries are inflated into storage first.
  const inputs = new Map();
  for (const file of files.filter((file) => file.path.startsWith(appRoot))) {
    const relative = file.path.slice(appRoot.length);
    tools.progress.report(relative, 0, 'prepare');
    let source = await zipEntrySource(archive, file.entry);
    if (!(source instanceof Blob)) {
      tools.progress.report(relative, 0, 'inflate');
      await cacheWriteStream(TEMP_KEY, relative, source);
      source = await cacheGetFile(TEMP_KEY, relative);
    }
    inputs.set(relative, source);
  }
  const app = await decryptApp(tools, inputs, key, appRoot);
  // The archive's other files (trophy data, firmware it carries) as they are.
  for (const file of files.filter((file) => !file.path.startsWith(appRoot))) {
    tools.progress.report(file.path, 0, 'store');
    const size = await cacheWriteZipEntry(key, file.path, archive, file.entry);
    app.stored.push({ path: file.path, size });
    app.bytes += size;
    tools.progress.report(file.path, file.size, 'store');
  }
  await cacheWriteManifest(key, app.stored);
  return { files: app.stored, bytes: app.bytes, decrypted: app.decrypted, selfs: app.selfs };
}

// A .pkg: its outer AES layer into temporary storage, its zRIF as the
// license, then the encrypted dump that leaves, as decryptZip.
async function installPkg(tools, { archive, zrif }, useKey) {
  const { FS, call, text, check, remount, progress } = tools;
  remount('/pkg', tools.M.WORKERFS, { blobs: [{ name: 'game.pkg', data: archive }] });
  try {
    const count = check(call('vd_pkg_open', '/pkg/game.pkg'));
    const [type, title, contentId, category] = text('vd_pkg_info').split('\t');
    if (type !== 'app')
      throw new Error(`this .pkg is ${type === 'patch' ? 'an update' : type === 'dlc' ? 'DLC' : `a ${type}`} for ${title || contentId}: only games are supported for now`);
    if (!/^[A-Za-z0-9_-]{3,24}$/.test(title)) throw new Error('the .pkg names no title id');
    const key = cacheKeyFor(title, title);
    useKey(key);
    const entries = Array.from({ length: count }, (_, index) => {
      const [kind, size, name] = text('vd_pkg_entry', index).split('\t');
      return { index, kind, size: Number(size), name };
    });
    progress.reset(entries.reduce((sum, entry) => sum + entry.size, 0) * 2);
    await cacheClear(key);
    await cacheClear(TEMP_KEY);
    const inputs = new Map();
    for (const entry of entries.filter((entry) => entry.kind === 'file')) {
      progress.report(entry.name, 0, 'unpack');
      await writeToStorage(tools, '/pkgout/' + entry.name, TEMP_KEY, entry.name,
        (path) => check(call('vd_pkg_extract', entry.index, path)));
      inputs.set(entry.name, await cacheGetFile(TEMP_KEY, entry.name));
      progress.report(entry.name, entry.size, 'unpack');
    }
    // The license the dump would carry as sce_sys/package/work.bin.
    remount('/license');
    check(call('vd_zrif_to_rif', zrif.trim(), '/license/work.bin'));
    inputs.set('sce_sys/package/work.bin', new Blob([FS.readFile('/license/work.bin')]));
    const appRoot = `ux0/app/${title}/`;
    const app = await decryptApp(tools, inputs, key, appRoot);
    await cacheWriteManifest(key, app.stored);
    return { title, app: title, contentId, category, files: app.stored, bytes: app.bytes, decrypted: app.decrypted, selfs: app.selfs };
  } finally {
    call('vd_pkg_close');
    remount('/pkg');
  }
}

// A firmware .PUP (system software, font package or pre-install) installed
// into memory, then each firmware folder it provides moved into the
// firmware's storage, replacing that folder only.
async function installPup(tools, { archive }) {
  const { FS, call, text, check, remount, progress } = tools;
  remount('/pup', tools.M.WORKERFS, { blobs: [{ name: 'firmware.PUP', data: archive }] });
  remount('/fw');
  progress.reset(archive.size);
  progress.report(archive.name || 'the firmware', 0, 'install');
  try {
    check(call('vd_install_pup', '/pup/firmware.PUP', '/fw'));
    const version = text('vd_result');
    const files = [];
    const walk = (dir, relative) => {
      for (const name of FS.readdir(dir)) {
        if (name === '.' || name === '..') continue;
        const path = `${dir}/${name}`, rel = relative ? `${relative}/${name}` : name;
        if (FS.isDir(FS.stat(path).mode)) walk(path, rel);
        else files.push(rel);
      }
    };
    walk('/fw', '');
    const present = [...new Set(files.map((path) => path.split('/')[0]))];
    const roots = present.filter((root) => FIRMWARE_ROOTS.includes(root));
    const skipped = present.filter((root) => !FIRMWARE_ROOTS.includes(root));
    if (!roots.length)
      throw new Error(skipped.length ? `this .PUP only holds ${skipped.join(', ')} (pre-installed content), which games do not need`
        : 'this .PUP installed nothing');
    if (roots.includes('os0') !== roots.includes('vs0')) throw new Error('this .PUP holds only half of the system software');
    const previous = (await cacheReadManifest(FIRMWARE_KEY))?.files ?? [];
    for (const root of roots) await cacheRemovePath(FIRMWARE_KEY, root);
    const stored = previous.filter((file) => !roots.includes(file.path.split('/')[0]));
    let bytes = 0;
    progress.reset(0);
    for (const path of files.filter((path) => roots.includes(path.split('/')[0]))) {
      const contents = FS.readFile('/fw/' + path);
      await cacheWriteFile(FIRMWARE_KEY, path, contents);
      FS.unlink('/fw/' + path);
      stored.push({ path, size: contents.byteLength });
      bytes += contents.byteLength;
      progress.report(path, contents.byteLength, 'store');
    }
    await cacheWriteManifest(FIRMWARE_KEY, stored);
    return { version, roots, files: stored.length, bytes, skipped };
  } finally {
    remount('/fw');
    remount('/pup');
  }
}
