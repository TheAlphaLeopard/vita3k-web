// M4 worker lifecycle shell. The generated Emscripten module is loaded here.
import { createWebStorage } from './storage.js';
// Persistent content cache (OPFS) lives on the page: the worker asks for
// bytes ('stage-need' -> 'stage-data') and hands downloads back for
// storing ('stage-store'). OPFS I/O stays in one place (the page, where it
// is proven to work) and this worker keeps zero new imports, so it loads
// from any server generation.
let stageResponder = null;

// Module directory of each memory model, relative to this Worker. The build
// stages a flavour's modules into its directory by reading this line
// (browser/CMakeLists.txt), so keep it a one-line literal.
const moduleDirectories = { w64: 'wasm64/', w32: '' };

const storage = createWebStorage('./');
const post = (message, transfer) => self.postMessage({ ...message, timestamp: performance.now() }, transfer || []);
let module = null;
let threaded = false;
let lifecycle = 'starting';

// Host hooks called from Wasm (see browser/src/vita_runtime.cpp). With
// ASYNCIFY the run call may suspend; the final exit code therefore arrives
// through vita3kWebOnExit instead of the call's return value.
globalThis.vita3kWebOnExit = (code) => {
  post({ type: 'vita-exit', exitCode: code, ok: code >= 0 });
};
// The view is only valid synchronously; copy it before yielding. The data is
// TIGHT RGBA produced in Wasm from the real sceDisplaySetFrameBuf state.
globalThis.vita3kWebOnFrame = (generation, width, height, view) => {
  const data = new Uint8Array(view).buffer;
  post({ type: 'vita-frame', generation, width, height, pixelFormat: 'A8B8G8R8', data }, [data]);
};
// GXM frames presented from the GPU (browser/web/gxm_scene.js). Pixels are
// present only on read-back frames; the canvas (when attached) already shows
// every frame.
globalThis.vita3kWebOnGpuFrame = (generation, width, height, pixels) => {
  if (!pixels) { post({ type: 'vita-present', generation, width, height }); return; }
  const data = pixels.buffer;
  post({ type: 'vita-frame', generation, width, height, pixelFormat: 'A8B8G8R8', data }, [data]);
};
// sceMsgDialog shown to the page (browser/src/msg_dialog_bridge.cpp):
// { id, state: 'open' | 'update', message, buttons, progress, enterButton } or
// { id, state: 'close', buttonId, result }. The page answers with 'dialog-press'.
globalThis.vita3kWebOnDialog = (dialog) => post({ type: 'vita-dialog', dialog });
// SceIme text field shown to the page (browser/src/ime_bridge.cpp):
// { id, state: 'open', text, caret, maxLength, type, option, enterLabel } or
// { id, state: 'close' }. The page reports its field with 'ime-input'.
globalThis.vita3kWebOnIme = (ime) => post({ type: 'vita-ime', ime });
// A canvas transferred by the page ('attach-canvas'); bound once the GXM
// device exists.
let pendingCanvas = null;
globalThis.vita3kGxmReady = (scene) => {
  if (pendingCanvas) { scene.attachCanvas(pendingCanvas); pendingCanvas = null; }
};
// Optional PVR EGL/GLES HLE uses a WebGL context, not the GXM WebGPU device.
// A canvas gets exactly one context kind; only the active renderer claims it.
globalThis.vita3kGlesReady = (bridge) => {
  if (pendingCanvas) { bridge.attachCanvas(pendingCanvas); pendingCanvas = null; }
};
// GXM WebGPU device loss (browser/web/gxm_scene.js): the renderer can no
// longer present, but emulation continues, so the page must say so and offer
// a restart. Wired by default: scene.init falls back to this global hook
// when the embedder passes no onDeviceLost of its own.
globalThis.vita3kWebOnGxmDevice = (info) => {
  post({ type: 'vita-gxm-device', device: info ?? null });
};
// GPU back-pressure (browser/web/gxm_scene.js): the renderer is dropping
// scenes because the GPU queue is saturated — the page can suggest a lower
// render scale instead of letting the driver wedge the whole display.
globalThis.vita3kWebOnGxmThrottle = (detail) => {
  post({ type: 'vita-gxm-throttle', throttle: detail ?? null });
};
// PCM tap (see browser/src/hle_audio_null.cpp): one copied buffer per
// sceAudioOutOutput call. Transfer the copy; the Wasm scratch is reused by
// the next call, so the page must not retain the view.
globalThis.vita3kWebOnAudio = (freq, channels, frames, view, port = 0) => {
  const data = new Uint8Array(view).buffer;
  post({ type: 'vita-audio', freq, channels, frames, data, port }, [data]);
};

// Threaded runtime: a port's PCM ring in shared memory (hle_audio_null.cpp).
// The page plays it with audio_ring_worklet.js; nothing is copied per chunk.
globalThis.vita3kWebOnAudioRing = (ring) => post({ type: 'vita-audio-ring', ...ring });

const transition = (state) => {
  lifecycle = state;
  post({ type: 'lifecycle', state });
};

try {
  transition('loading');
  const workerParams = new URL(self.location.href).searchParams;
  const jit = workerParams.get('backend') === 'jit';
  let moduleName = jit ? 'vita3k_web_jit' : 'vita3k_web';
  // Memory-model selection: Memory64 is the preferred configuration, wasm32
  // the fallback. ?memory=w64 forces the direct build (fails loudly when
  // unsupported); ?memory=w32 forces the sparse reference; default (auto)
  // probes for Memory64 support, attempts the preferred module first, and
  // falls back to wasm32 on any load/instantiation error (which also covers
  // a failed 8 GiB reservation on constrained devices). See MEMORY64.md.
  const memoryParam = (workerParams.get('memory') || 'auto').toLowerCase();
  const forceW64 = memoryParam === 'w64' || memoryParam === 'wasm64' || memoryParam === 'memory64';
  const forceW32 = memoryParam === 'w32' || memoryParam === 'wasm32';
  const probeMemory64 = () => {
    if (typeof WebAssembly === 'undefined' || typeof WebAssembly.validate !== 'function') return false;
    try {
      return WebAssembly.validate(new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x04, 0x00,
      ]));
    } catch {
      return false;
    }
  };
  const attempts = forceW64 ? ['w64'] : forceW32 ? ['w32'] : (probeMemory64() ? ['w64', 'w32'] : ['w32']);
  // Opt-in while validation continues; keep the single-Worker fallback.
  const threadsRequested = workerParams.get('threads') === '1';
  if (threadsRequested && jit && !forceW32 && workerParams.get('gles') !== '1'
      && globalThis.crossOriginIsolated && typeof SharedArrayBuffer === 'function' && probeMemory64())
    attempts.unshift('mt');
  else if (threadsRequested)
    post({type: 'log', message: 'threaded runtime unavailable; using the single-Worker runtime'});
  let memoryFallback = false;
  for (const attempt of attempts) {
    moduleName = attempt === 'mt' ? 'vita3k_web_jit_mt' : jit ? 'vita3k_web_jit' : 'vita3k_web';
    const base = `./${moduleDirectories[attempt === 'mt' ? 'w64' : attempt]}`;
    const moduleUrl = new URL(`${base}${moduleName}.js`, self.location.href).href;
    try {
      const { default: createModule } = await import(moduleUrl);
      if (typeof createModule !== 'function') throw new TypeError('Emscripten module factory is not callable');
      // Fetch the .wasm next to the glue with progress first: Emscripten
      // would fetch it silently, leaving "loading runtime" blind. Handing
      // it over via wasmBinary skips its fetch; on any failure fall back
      // to the loader's own fetch.
      let wasmBinary;
      try {
        const wasmName = `${moduleName}.wasm`;
        const { payload, total } = await fetchBytesWithProgress(
          new URL(`${base}${wasmName}`, self.location.href).href,
          (received, expected) => post({ type: 'stage-progress', phase: 'runtime', path: wasmName,
            pathBytes: received, pathSize: expected || undefined,
            bytes: received, totalBytes: expected || undefined }));
        post({ type: 'stage-progress', phase: 'runtime', path: wasmName,
          pathBytes: payload.byteLength, pathSize: payload.byteLength,
          bytes: payload.byteLength, totalBytes: payload.byteLength });
        wasmBinary = payload.buffer;
      } catch {
        wasmBinary = undefined;
      }
      module = await createModule({
        ...(wasmBinary ? { wasmBinary } : {}),
        locateFile: (file) => new URL(`${base}${file}`, self.location.href).href,
        print: (message) => post({ type: 'log', message }),
        printErr: (message) => post({ type: 'log', message }),
        // Matched diagnostic baseline; the native option also disables the
        // kernel table/bookkeeping, not just generated probes.
        VITA3K_JIT_INLINE_MUTEX: workerParams.get('inlineMutex') === '0' ? '0' : '1',
        // Chained-usage LRU stamping: '1' records per-slot usage from the
        // in-Wasm dispatcher for the region-cache eviction policy.
        VITA3K_WASMJIT_STAMP_LRU: workerParams.get('stampLru') === '1' ? '1' : '0',
        // Code-page write observer: default ON (load-bearing for code-page
        // invalidation). '0' only for the isolation diagnostic; see
        // write_observer_enabled().
        VITA3K_WASMJIT_WRITE_OBSERVER: workerParams.get('writeObserver') === '0' ? '0' : '1',
        // Region-cache size: unset keeps the built-in default (currently
        // 4096); a number overrides it for cache-size A/B runs.
        VITA3K_WASMJIT_REGION_CACHE: workerParams.get('regionCache') || undefined,
        // GPU-presented frames read back to the page every N frames (0 = never).
        VITA3K_FRAME_READBACK: workerParams.get('readback') ?? undefined,
        // Per-NID HLE wall time in the progress report (vita_app.cpp).
        VITA3K_HLE_PROFILE: workerParams.get('hleProfile') === '1' ? '1' : undefined,
        // Opt-in PVR user-library adapter (Balatro/LÖVE GLES2, not a raw GPU driver).
        VITA3K_GLES_BRIDGE: workerParams.get('gles') === '1' ? '1' : undefined,
        // First-boot AOT prototype: with no supplied image, translate from
        // static roots at load and run from it (vita_app.cpp). Seedless, so
        // dynamically discovered code stays on the lazy JIT fallback.
        VITA3K_AOT_BUILD_AT_LOAD: (workerParams.get('buildAot') === '1' || workerParams.get('buildAot') === 'only') ? '1' : undefined,
        // Emulated guest CPU cores (vita_app.cpp); unset keeps the default.
        VITA3K_GUEST_CORES: workerParams.get('cores') ?? undefined,
        // Vita3K's fps-hack: display waits use one vblank (vita_app.cpp).
        VITA3K_FPS_HACK: workerParams.get('fpsHack') === '1' ? '1' : undefined,
        // ?asyncScene=0: consume GXM command lists on the submitting guest thread
        // (threaded runtime; THREADS.md). ?hleIntrinsics=0: plain HLE stubs.
        VITA3K_ASYNC_SCENES: workerParams.get('asyncScene') === '0' ? '0' : undefined,
        VITA3K_HLE_INTRINSICS: workerParams.get('hleIntrinsics') === '0' ? '0' : undefined,
        // ?strictImports=1: a call into a system function this build lacks
        // ends the run; otherwise it returns 0, as on desktop (vita_app.cpp).
        VITA3K_STRICT_IMPORTS: workerParams.get('strictImports') === '1' ? '1' : undefined,
        // Internal render resolution multiplier (gxm_webgpu_bridge.cpp); unset = 2.
        VITA3K_RESOLUTION_SCALE: workerParams.get('scale') ?? undefined,
        // Check cached textures and vertex streams against guest memory and
        // report changes the write tracking missed (gxm_webgpu_bridge.cpp).
        VITA3K_TEXTURE_VERIFY: workerParams.get('textureVerify') === '1' ? '1' : undefined,
        // Read rendered surfaces back into guest memory after each scene
        // (gxm_webgpu_bridge.cpp); off by default, it stalls on the GPU.
        VITA3K_SURFACE_SYNC: workerParams.get('surfaceSync') === '1' ? '1' : undefined,
        // Trace passes, draws, texture binds and presents after N frames
        // (gxm_webgpu_bridge.cpp VITA3K_GXM_TRACE).
        VITA3K_GXM_TRACE: workerParams.get('gxmTrace') ?? undefined,
        VITA3K_GXM_TRACE_LINES: workerParams.get('gxmTraceLines') ?? undefined,
        // Print every guest thread's PC each N dispatches (vita_app.cpp).
        VITA3K_BENCH_PC_SAMPLE: workerParams.get('pcSample') ?? undefined,
      });
      threaded = attempt === 'mt';
      if (threaded) {
        const { installThreadBridge } = await import('./thread_bridge.js');
        installThreadBridge(module, message => post({ type: 'log', message }));
        module.vita3kStartPoolRefill?.();
      }
      break;
    } catch (error) {
      if (attempt === attempts[attempts.length - 1]) throw error;
      memoryFallback = true;
      post({ type: 'log', message: `memory model ${attempt} unavailable (${error?.message || error}), falling back` });
    }
  }
  transition('ready');
  post({ type: 'ready', diagnostics: { module: moduleName, backend: jit ? 'jit' : 'interpreter',
    memoryRequested: memoryParam, memoryFallback, threaded, inlineMutex: jit && !threaded && workerParams.get('inlineMutex') !== '0',
    memoryModel: module['vita3kMemoryModel'], hostPointerBits: module['vita3kHostPointerBits'], wasm: true, worker: true } });
} catch (error) {
  lifecycle = 'error';
  post({ type: 'error', state: lifecycle, message: String(error) });
}

// Staged download with live byte counts: the page's launch status shows the
// file being fetched and how many bytes have arrived (report() is throttled in
// the caller), so a slow link reports progress instead of one name per file.
// Fetch a URL with live byte counts for the launch status (runtime module,
// AOT image). Returns { payload, total } (total 0 when the server omits
// content-length); the caller reports progress, this only measures.
async function fetchBytesWithProgress(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const payload = await readStagedFile(response, (received) => onProgress(received, total));
  return { payload, total };
}
async function readStagedFile(response, onProgress) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const payload = new Uint8Array(await response.arrayBuffer());
    onProgress(payload.byteLength);
    return payload;
  }
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    chunks.push(value);
    received += value.byteLength;
    onProgress(received);
  }
  const payload = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { payload.set(chunk, offset); offset += chunk.byteLength; }
  return payload;
}

  // Files at least this large are not copied into MEMFS: a retail title's
  // archives (Persona 4 Golden's data.cpk is 1.8 GiB) would not fit below the
  // runtime heap's 4 GiB bound. They become lazy nodes read on demand.
  const LAZY_STAGE_BYTES = 8 << 20;
  const LAZY_CHUNK = 4 << 20;
  const LAZY_CACHE_CHUNKS = 96; // per file, least recently used evicted
  const lazyStats = { chunks: 0, ms: 0 };
  // A MEMFS file node whose reads fetch LAZY_CHUNK-aligned byte ranges of
  // `url` with synchronous XHR (allowed in workers; the emulator's file reads
  // are synchronous) and copy them out in bulk. Emscripten's createLazyFile
  // copies byte by byte through a getter, too slow for multi-MiB reads.
  const stageLazyFile = (fs, target, url, size) => {
    const slash = target.lastIndexOf('/');
    const node = fs.createFile(target.slice(0, slash) || '/', target.slice(slash + 1), {}, true, false);
    const chunks = new Map();
    const chunk = (index) => {
      let bytes = chunks.get(index);
      if (bytes) {
        chunks.delete(index);
        chunks.set(index, bytes);
        return bytes;
      }
      const from = index * LAZY_CHUNK;
      const to = Math.min(from + LAZY_CHUNK, size) - 1;
      const fetchStarted = performance.now();
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.responseType = 'arraybuffer';
      xhr.setRequestHeader('Range', `bytes=${from}-${to}`);
      xhr.send(null);
      if (xhr.status !== 206 && !(xhr.status === 200 && from === 0 && to === size - 1))
        throw new Error(`lazy read of ${url} [${from}, ${to}] failed: HTTP ${xhr.status}`);
      bytes = new Uint8Array(xhr.response);
      lazyStats.chunks += 1; lazyStats.ms += performance.now() - fetchStarted;
      if (lazyStats.chunks % 25 === 0)
        post({ type: 'log', message: `[vita3k-web] lazy reads: ${lazyStats.chunks} chunks of ${LAZY_CHUNK >> 20} MiB, ${Math.round(lazyStats.ms)} ms` });
      if (bytes.byteLength !== to - from + 1)
        throw new Error(`lazy read of ${url} [${from}, ${to}] returned ${bytes.byteLength} bytes`);
      chunks.set(index, bytes);
      if (chunks.size > LAZY_CACHE_CHUNKS) chunks.delete(chunks.keys().next().value);
      return bytes;
    };
    Object.defineProperty(node, 'usedBytes', { get: () => size });
    node.stream_ops = {
      ...node.stream_ops,
      read(stream, buffer, offset, length, position) {
        position = Number(position);
        if (position >= size) return 0;
        const total = Math.min(length, size - position);
        for (let done = 0; done < total;) {
          const at = position + done;
          const bytes = chunk(Math.floor(at / LAZY_CHUNK));
          const begin = at % LAZY_CHUNK;
          const count = Math.min(total - done, bytes.byteLength - begin);
          buffer.set(bytes.subarray(begin, begin + count), offset + done);
          done += count;
        }
        return total;
      },
      write() { throw new fs.ErrnoError(63 /* EPERM: staged content is read-only */); },
      mmap() { throw new fs.ErrnoError(19 /* ENODEV */); },
    };
  };

  // Ask the page (OPFS owner) for staged-file bytes. Sequential: staging
  // awaits each answer. A 30 s safety timeout falls back to the network.
  const requestCachedBytes = (path, size) => new Promise((resolve) => {
    const answer = (data) => {
      clearTimeout(timer);
      if (stageResponder !== answer) return;
      stageResponder = null;
      if (data && data.path === path && data.bytes instanceof ArrayBuffer && data.bytes.byteLength === size)
        resolve(new Uint8Array(data.bytes));
      else resolve(null);
    };
    const timer = setTimeout(() => {
      if (stageResponder === answer) { stageResponder = null; resolve(null); }
    }, 30000);
    stageResponder = answer;
    post({ type: 'stage-need', path, size });
  });
self.onmessage = async ({ data }) => {
  if (!data || lifecycle === 'error') return;
  switch (data.type) {
  case 'stage-data': {
    // answer() clears stageResponder itself after its identity guard, so it
    // must still be set here (clearing first would fail the guard and hang).
    const answer = stageResponder;
    if (typeof answer === 'function') answer(data);
    break;
  }
  case 'status':
    post({ type: 'status', state: lifecycle });
    break;
  case 'pause':
    if (lifecycle === 'ready') transition('paused');
    break;
  case 'resume':
    if (lifecycle === 'paused') transition('ready');
    break;
  case 'run-vita':
  case 'run-guest': {
    const vita = data.type === 'run-vita';
    const resultType = vita ? 'vita-exit' : 'guest-exit';
    try {
      const path = data.path || 'guest.elf';
      let input;
      if (data.bytes instanceof Uint8Array) {
        input = data.bytes;
      } else if (data.bytes instanceof ArrayBuffer) {
        input = new Uint8Array(data.bytes);
      } else if (data.file instanceof Blob) {
        input = new Uint8Array(await data.file.arrayBuffer());
      } else {
        input = await storage.read(path);
      }
      if (input.byteLength === 0 || input.byteLength > 0xffffffff)
        throw new RangeError('ELF input size is outside the 32-bit file transport');
      const allocation = module['vita3kHostPointer'](module._vita3k_web_alloc_input(input.byteLength));
      if (!allocation) throw new Error('unable to allocate ELF input buffer');
      try {
        module['vita3kHostBytes'](allocation, input.byteLength).set(input);
        if (vita) {
          // Completion is always reported via the vita3kWebOnExit hook (the
          // call may suspend across ASYNCIFY yields, losing its return value).
          // The input buffer is intentionally not freed here: freeing while
          // the guest run is suspended would mutate the Wasm heap under a
          // suspended stack. One input buffer per worker run is bounded.
          module._vita3k_web_set_trace?.(data.trace ? 1 : 0);
          module._vita3k_web_set_fast_vblank?.(data.fastVblank ? 1 : 0);
          // R2: promoted flags are the production default (Module prop
          // absent). The JIT env hook reads these props first (before
          // process.env), once per process. Set before first run.
          // '' default -> P; 'p' -> P; 'k' -> K; 'pk' -> PK; 'a' -> A.
          module['VITA3K_WASMJIT_PROMOTE_FLAGS'] = (data.promote === 'k' || data.promote === 'a') ? '0' : '1';
          module['VITA3K_WASMJIT_PROMOTE_ACCOUNTING'] = (data.promote === 'k' || data.promote === 'pk') ? '1' : '0';
          module._vita3k_web_run_vita(allocation, input.byteLength);
        } else {
          const exitCode = module._vita3k_web_run_elf_probe(allocation, input.byteLength);
          post({ type: resultType, path, size: input.byteLength, exitCode, ok: exitCode >= 0 });
          module._vita3k_web_free_input(allocation);
        }
      } catch (error) {
        module._vita3k_web_free_input(allocation);
        throw error;
      }
    } catch (error) {
      post({ type: resultType, exitCode: -1, ok: false, message: String(error) });
    }
    break;
  }
  case 'stage-files': {
    // MEMFS staging for the retail-app path. The browser build has no
    // NODERAWFS, so content is uploaded into the Emscripten filesystem before
    // vita3k_web_run_app resolves guest device paths under `<root>`. Every
    // entry is fetched and sized by this side; the caller only names the
    // logical paths and their URLs.
    try {
      const fs = module?.FS;
      if (!fs) throw new Error('filesystem runtime is not exported by this module');
      const root = typeof data.root === 'string' && data.root.startsWith('/') ? data.root : '/vita';
      const list = Array.isArray(data.files) ? data.files : [];
      const sizeOf = (entry) => (Number.isSafeInteger(entry?.size) && entry.size >= 0 ? entry.size : 0);
      const totalBytes = list.reduce((sum, entry) => sum + sizeOf(entry), 0);
      // Persistent content cache: the page owns OPFS (upload fills it and
      // it mirrors each boot's manifest). The worker asks per file
      // ('stage-need' -> 'stage-data') and hands downloads back for storing
      // ('stage-store'), so this side needs no storage imports at all.
      const useContentCache = data.useContentCache === true;
      let files = 0, bytes = 0, cachedFiles = 0, cachedBytes = 0;
      let lastReport = 0;
      // { path, index (1-based file being fetched), total, bytes (finished),
      //   totalBytes, pathBytes, pathSize, source: 'cache' | 'network' } —
      // at most every 120 ms, plus the forced first/last report of each file.
      const report = (path, pathSize, pathBytes, force, source) => {
        const now = performance.now();
        if (!force && now - lastReport < 120) return;
        lastReport = now;
        post({ type: 'stage-progress', path, index: files + 1, total: list.length,
          bytes, totalBytes, pathBytes, pathSize, source });
      };
      for (const entry of list) {
        const path = String(entry?.path ?? '');
        if (!path || path.startsWith('/') || path.split('/').includes('..'))
          throw new RangeError(`unsafe staged path: ${path}`);
        if (entry.url && sizeOf(entry) >= LAZY_STAGE_BYTES) {
          const target = `${root}/${path}`;
          const directory = target.slice(0, target.lastIndexOf('/'));
          if (directory) fs.mkdirTree(directory);
          stageLazyFile(fs, target, new URL(entry.url, self.location.href).href, sizeOf(entry));
          report(path, sizeOf(entry), sizeOf(entry), true, 'lazy');
          files += 1; bytes += sizeOf(entry);
          continue;
        }
        let payload = null;
        if (useContentCache) payload = await requestCachedBytes(path, sizeOf(entry));
        if (payload) {
          cachedFiles += 1; cachedBytes += payload.byteLength;
          report(path, sizeOf(entry), payload.byteLength, true, 'cache');
        } else {
          report(path, sizeOf(entry), 0, true, 'network');
          // No URL: the file exists only in the page's persistent storage
          // (an uploaded package), so a miss there is a real failure.
          if (!entry.url) throw new Error(`not in persistent storage: ${path} (re-upload the package)`);
          const response = await fetch(entry.url, { credentials: 'same-origin' });
          if (!response.ok) throw new Error(`staged fetch failed (${response.status}): ${path}`);
          payload = await readStagedFile(response,
            (received) => report(path, sizeOf(entry), received, false, 'network'));
          if (Number.isSafeInteger(entry.size) && entry.size >= 0 && payload.byteLength !== entry.size)
            throw new Error(`staged size mismatch for ${path}: ${payload.byteLength} != ${entry.size}`);
          if (useContentCache) {
            const copy = payload.slice();
            post({ type: 'stage-store', path, bytes: copy.buffer }, [copy.buffer]);
          }
        }
        const target = `${root}/${path}`;
        const directory = target.slice(0, target.lastIndexOf('/'));
        if (directory) fs.mkdirTree(directory);
        fs.writeFile(target, payload);
        files += 1; bytes += payload.byteLength;
      }
      if (useContentCache)
        post({ type: 'log', message: `[vita3k-web] staged ${files} files (${cachedFiles} from content cache)` });
      post({ type: 'staged', root, files, bytes, cachedFiles, cachedBytes });
    } catch (error) {
      post({ type: 'error', message: `stage-files failed: ${error}` });
    }
    break;
  }
  case 'input':
    // SCE_CTRL_* button mask and stick axes in [-1, 1] (vita_app.cpp vita3k_web_set_pad).
    module?._vita3k_web_set_pad?.(data.buttons >>> 0, ...(data.axes ?? [0, 0, 0, 0]));
    break;
  case 'touch':
    // A front touchscreen finger (vita_app.cpp vita3k_web_touch).
    module?._vita3k_web_touch?.(data.finger | 0, data.phase | 0, +data.x, +data.y);
    break;
  case 'dialog-press':
    // SCE_CTRL_CROSS / SCE_CTRL_CIRCLE pressed on dialog `id` with button
    // `selected` highlighted; the runtime applies it at the next HLE call.
    module?._vita3k_web_msg_dialog_press?.(data.id >>> 0, data.button >>> 0, data.selected >>> 0);
    break;
  case 'ime-input':
    // { id, kind: 0 text (whole field + caret) | 1 enter | 2 close, text, caret },
    // taken in order by the runtime after the next HLE call.
    (globalThis.vita3kWebImeInputs ??= []).push(data.input);
    module?._vita3k_web_ime_input_ready?.();
    break;
  case 'attach-canvas': {
    globalThis.vita3kHasCanvas = true;
    const scene = module?.['vita3kGles'] || module?.['vita3kGxm'];
    if (scene) scene.attachCanvas(data.canvas); else pendingCanvas = data.canvas;
    break;
  }
  case 'run-app': {
    // Retail-app launch (vita_app.cpp): the guest sees <vitaFs>/ux0/... and
    // the module owns module loading, license setup and the main thread.
    try {
      if (!module?._vita3k_web_set_app_paths || !module?._vita3k_web_run_app)
        throw new Error('retail-app entry points are not exported by this module');
      // Pointers are i64 under Memory64: exported parameter wrappers only
      // accept BigInt there, so route every address through the host-pointer
      // helper (which returns BigInt for Memory64 and a Number otherwise).
      const hostPointer = (value) => typeof module['vita3kHostPointer'] === 'function'
        ? module['vita3kHostPointer'](value) : value;
      // Optional ahead-of-time module for this title (AOT.md). Compiled here,
      // off the guest's critical path; the runtime verifies it against the
      // loaded code and falls back to the lazy JIT when it does not match.
      // buildAot=only skips the download entirely (slow link? just build it
      // on-device via VITA3K_AOT_BUILD_AT_LOAD instead of fetching 100+ MB).
      if (new URL(self.location.href).searchParams.get('buildAot') === 'only' && data.aotUrl) {
        post({ type: 'log', message: '[vita3k-web] buildAot=only: skipping AOT download, building on this device' });
        data.aotUrl = null;
      }
      // The threaded runtime imports shared memory: only its own image links.
      if (typeof module._vita3k_web_start_app === 'function') {
        if (data.aotUrl && !data.aotMtUrl)
          post({ type: 'log', message: '[vita3k-web] no threaded AOT image for this title; using the lazy JIT' });
        data.aotUrl = data.aotMtUrl ?? null;
      }
      if (data.aotUrl) {
        const started = performance.now();
        // Buffer with progress instead of compileStreaming: the download
        // (tens of MB on a phone link) is the slow, reportable part, while
        // compile() itself exposes no progress events.
        const { payload, total } = await fetchBytesWithProgress(data.aotUrl,
          (received, expected) => post({ type: 'stage-progress', phase: 'aot', path: data.aotUrl,
            pathBytes: received, pathSize: expected || undefined }));
        post({ type: 'stage-progress', phase: 'aot', path: data.aotUrl,
          pathBytes: payload.byteLength, pathSize: payload.byteLength });
        const compiledAt = performance.now();
        post({ type: 'stage-progress', phase: 'aot-compiling', path: data.aotUrl,
          pathBytes: payload.byteLength, pathSize: total || payload.byteLength });
        module['vita3kAotModule'] = await WebAssembly.compile(payload);
        const compileMs = Math.round(performance.now() - compiledAt);
        post({ type: 'log', message: `[vita3k-web] AOT module compiled in ` +
          `${compileMs} ms (downloaded ${Math.round((compiledAt - started) / 100) / 10}s)` });
        post({ type: 'aot-compiled', path: data.aotUrl,
          bytes: payload.byteLength, downloadMs: Math.round(compiledAt - started), compileMs });
      }
      module._vita3k_web_set_trace?.(data.trace ? 1 : 0);
      module._vita3k_web_set_fast_vblank?.(data.fastVblank ? 1 : 0);
      module.ccall('vita3k_web_set_app_paths', null, ['string', 'string', 'string'],
        [data.vitaFs || '/vita', data.title, data.app || data.title]);
      if (data.licenseKey instanceof Uint8Array) {
        if (data.licenseKey.byteLength !== 16) throw new RangeError('license key must be 16 bytes');
        const allocation = module._malloc(16);
        module.HEAPU8.set(data.licenseKey, allocation);
        module._vita3k_web_set_license_key(hostPointer(allocation));
        module._free(hostPointer(allocation));
      } else {
        module._vita3k_web_set_license_key(hostPointer(0));
      }
      // Saves the page kept from earlier sessions replace the staged ones;
      // changed saves go back to the page (save_sync.js).
      if (module.FS && data.title) {
        const { applySaves, watchSaves } = await import('./save_sync.js');
        const saveDir = `${data.vitaFs || '/vita'}/ux0/user/00/savedata/${data.title}`;
        const restored = applySaves(module.FS, saveDir, data.saves);
        if (restored) post({ type: 'log', message: `[vita3k-web] restored ${restored} saved file(s) from this browser` });
        watchSaves(module.FS, saveDir, ({ files, removed }) => {
          post({ type: 'vita-saves', title: data.title, files, removed }, files.map((file) => file.bytes.buffer));
        });
      }
      if (threaded) {
        module.vita3kConfigureWorkers();
        if (module._vita3k_web_start_app() !== 0) throw new Error('application already started');
      } else {
        module._vita3k_web_run_app();
      }
    } catch (error) {
      post({ type: 'vita-exit', exitCode: -1, ok: false, message: String(error.stack || error) });
    }
    break;
  }
  case 'shutdown':
    if (module?._vita3k_web_shutdown) module._vita3k_web_shutdown();
    transition('stopped');
    self.close();
    break;
  default:
    post({ type: 'error', message: `Unknown worker command: ${data.type}` });
  }
};
