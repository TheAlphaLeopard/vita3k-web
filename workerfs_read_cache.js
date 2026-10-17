// WORKERFS turns each C/C++ read into a synchronous browser Blob read.
// PFS setup and decryption issue thousands of small reads; read ahead so
// these usually hit memory instead. Keep at most 16 files' last 256 KiB
// block (4 MiB total), regardless of the size of the game or its files.
export function cacheWorkerFSReads(workerFS) {
  const blockSize = 256 * 1024, maxFiles = 16;
  const blocks = new Map(); // node -> { start, bytes }, least recently used first
  const read = workerFS.stream_ops.read;
  workerFS.stream_ops.read = (stream, buffer, offset, length, position) => {
    const node = stream.node;
    const wanted = Math.max(0, Math.min(length, node.size - position));
    let copied = 0;
    while (copied < wanted) {
      const at = position + copied;
      let block = blocks.get(node);
      if (!block || at < block.start || at >= block.start + block.bytes.length) {
        blocks.delete(node);
        if (blocks.size >= maxFiles) blocks.delete(blocks.keys().next().value);
        const start = Math.floor(at / blockSize) * blockSize;
        const bytes = new Uint8Array(Math.min(blockSize, node.size - start));
        const size = read(stream, bytes, 0, bytes.length, start);
        block = { start, bytes: bytes.subarray(0, size) };
        // Preserve short reads/EOF without looping on an unreadable block.
        if (at >= start + size) break;
      }
      blocks.delete(node);
      blocks.set(node, block);
      const from = at - block.start;
      const count = Math.min(wanted - copied, block.bytes.length - from);
      buffer.set(block.bytes.subarray(from, from + count), offset + copied);
      copied += count;
    }
    return copied;
  };
  // Unmounted nodes must not retain their archive Blobs in the cache.
  return () => blocks.clear();
}
