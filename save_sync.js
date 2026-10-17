// Game saves outlive the page: the runtime writes them into the Worker's
// MEMFS (ux0:user/00/savedata/<title>/), which a reload discards. The Worker
// applies the saves the page stored before the game starts, then watches the
// save directory and sends every file that changed (once its size and time
// held still for one check, so a half-written file never leaves) and every
// file that disappeared. The page keeps them in OPFS (content_cache.js).

const safePath = (path) => typeof path === 'string' && path && !path.startsWith('/')
  && !path.split('/').some((part) => part === '' || part === '.' || part === '..');

// Write stored saves over whatever staging put in `dir`.
export function applySaves(FS, dir, files) {
  let count = 0;
  for (const { path, bytes } of files || []) {
    if (!safePath(path) || !(bytes instanceof Uint8Array)) continue;
    const target = `${dir}/${path}`;
    FS.mkdirTree(target.slice(0, target.lastIndexOf('/')));
    FS.writeFile(target, bytes);
    ++count;
  }
  return count;
}

function listFiles(FS, dir) {
  const out = new Map();
  const walk = (relative) => {
    let names;
    try { names = FS.readdir(relative ? `${dir}/${relative}` : dir); } catch { return; }
    for (const name of names) {
      if (name === '.' || name === '..') continue;
      const path = relative ? `${relative}/${name}` : name;
      let stat;
      try { stat = FS.stat(`${dir}/${path}`); } catch { continue; }
      if (FS.isDir(stat.mode)) walk(path);
      else out.set(path, `${stat.size}:${+stat.mtime}`);
    }
  };
  walk('');
  return out;
}

// Calls onChange({ files: [{ path, bytes }], removed: [path] }) after saves
// settle. Files present when watching starts count as already stored.
export function watchSaves(FS, dir, onChange, intervalMs = 2000) {
  let stored = listFiles(FS, dir); // path -> signature the page holds
  let previous = new Map(stored);
  const timer = setInterval(() => {
    const current = listFiles(FS, dir);
    const files = [], removed = [];
    for (const [path, signature] of current) {
      if (stored.get(path) === signature || previous.get(path) !== signature) continue;
      try {
        files.push({ path, bytes: FS.readFile(`${dir}/${path}`) });
        stored.set(path, signature);
      } catch {}
    }
    for (const path of [...stored.keys()]) {
      if (current.has(path)) continue;
      removed.push(path);
      stored.delete(path);
    }
    previous = current;
    if (files.length || removed.length) onChange({ files, removed });
  }, intervalMs);
  return () => clearInterval(timer);
}
