// M5 storage bridge. Files are addressed by logical browser paths.
export function createWebStorage(root = '/vita3k') {
  const normalize = (path) => `${root.replace(/\/$/, '')}/${String(path).replace(/^\/+/, '')}`;
  return Object.freeze({
    root,
    url(path) { return normalize(path); },
    async read(path, init) {
      const response = await fetch(normalize(path), init);
      if (!response.ok) throw new Error(`storage read failed (${response.status}): ${path}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async write(path, bytes) {
      if (!(bytes instanceof Uint8Array)) throw new TypeError('storage.write expects Uint8Array');
      throw new Error('storage.write requires an application-provided upload endpoint');
    },
  });
}
