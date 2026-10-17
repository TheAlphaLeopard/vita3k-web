// Browser operations run on the coordinator; calling pthreads wait through
// Emscripten's proxy queue while promises leave this event loop available.
export function installThreadBridge(module, logger = console.error) {
  const bytes = (pointer, length) => module.vita3kHostBytes(pointer, length);
  const text = (pointer, length) => new TextDecoder().decode(new Uint8Array(bytes(pointer, length)));
  // Calls still in flight after 2 s are logged: a guest thread waits on each.
  const inFlight = new Map();
  let nextCall = 0;
  setInterval(() => {
    const now = performance.now();
    for (const [id, { operation, started, args }] of inFlight)
      if (now - started > 2000) logger(`[thread-bridge] ${operation} pending ${((now - started) / 1000).toFixed(1)}s args=${args.slice(0, 4).join(",")} (call ${id})`);
    const pool = module.vita3kPoolStats?.();
    if (pool) logger(`[thread-bridge] pool idle=${pool.idle} busy=${pool.busy} misses=${pool.misses} calls in flight=${inFlight.size}`);
  }, 5000);
  // GXM operations run one after another, in the order guest threads issued
  // them: a posted scene may still wait for GPU capacity when the next
  // present or readback arrives.
  let gxmChain = Promise.resolve();
  const inOrder = (work) => {
    const result = gxmChain.then(work);
    gxmChain = result.catch(() => {});
    return result;
  };
  // Posted scene (gxm_webgpu_bridge.cpp, post_scene): copy it out of shared
  // memory now and free its slot, so the guest thread builds the next scene
  // while this one waits its turn and for GPU capacity.
  const submitPosted = (a) => {
    const view = bytes(a[2], a[3]);
    const data = new Uint8Array(view);
    const words = new Uint32Array(new Uint32Array(view.buffer, Number(module.vita3kHostOffset(a[0], a[1] * 4)), a[1]));
    const flag = bytes(a[4], 4);
    const busy = new Int32Array(flag.buffer, flag.byteOffset, 1);
    Atomics.store(busy, 0, 0);
    Atomics.notify(busy, 0);
    return inOrder(async () => {
      const gxm = module.vita3kGxm;
      if (!gxm) return 0;
      while (!gxm.trySubmitScene(words, data)) await gxm.waitForCapacity();
      return 0;
    }).catch((error) => { logger(`[thread-bridge] posted scene rejected: ${error?.name ?? 'Error'}: ${error?.message ?? error}\n${error?.stack ?? ''}`); return -1; });
  };
  module.vita3kThreadCall = async (operation, a) => {
    const id = ++nextCall;
    inFlight.set(id, { operation, started: performance.now(), args: a });
    try {
      if (operation === 'gxm-submit-async') return await submitPosted(a);
      return await (operation.startsWith('gxm-') ? inOrder(() => dispatch(operation, a)) : dispatch(operation, a));
    } finally { inFlight.delete(id); }
  };
  const dispatch = async (operation, a) => {
    switch (operation) {
      case 'gxm-init': {
        if (module.vita3kNullGpu) return 0;
        const scene = await import('./gxm_scene.js');
        await scene.init({
          submissionProtocol: 1,
          compilerURL: new URL('shaders/gxp_compiler.mjs', import.meta.url).href,
          nagaURL: new URL('shaders/naga.wasm', import.meta.url).href,
          wasiShimURL: new URL('shaders/wasi/index.js', import.meta.url).href,
          logger,
        });
        module.vita3kGxm = scene;
        globalThis.vita3kGxmReady?.(scene);
        return 0;
      }
      case 'gxm-program':
        await module.vita3kGxm?.registerProgram(a[0], new Uint8Array(bytes(a[1], a[2])), a[3] !== 0);
        return 0;
      case 'gxm-submit': {
        if (!module.vita3kGxm) return 0;
        const shared = bytes(a[2], a[3]);
        const words = new Uint32Array(shared.buffer, a[0], a[1]);
        const data = new Uint8Array(shared);
        return module.vita3kGxm.trySubmitScene(words, data) ? 0 : 1;
      }
      case 'gxm-capacity':
        await module.vita3kGxm?.waitForCapacity();
        return 0;
      case 'gxm-read': {
        if (!module.vita3kGxm) return 0;
        const [address, dest, width, height, pixelBytes] = a;
        await module.vita3kGxm.readTarget(address, width, height, pixelBytes, (mapped, stride) => {
          const row = width * pixelBytes;
          const output = bytes(dest, height * row);
          for (let y = 0; y < height; ++y)
            output.set(mapped.subarray(y * stride, y * stride + row), y * row);
        });
        return 0;
      }
      case 'gxm-present': {
        if (!module.vita3kGxm) return 0;
        const configured = module.VITA3K_FRAME_READBACK;
        const every = configured !== undefined ? Number(configured) : (globalThis.vita3kHasCanvas ? 0 : 1);
        const result = module.vita3kGxm.presentTarget(a[0], (...frame) => globalThis.vita3kWebOnGpuFrame?.(...frame), every);
        return result === null ? 2 : result ? 1 : 0;
      }
      case 'audio':
        globalThis.vita3kWebOnAudio?.(a[0], a[1], a[2], bytes(a[3], a[4]), a[5]);
        return 0;
      case 'audio-ring': {
        // The page plays the ring straight from shared memory (audio_ring_worklet.js).
        const header = bytes(a[0], 32);
        globalThis.vita3kWebOnAudioRing?.({ buffer: header.buffer, offset: header.byteOffset, capacity: a[1],
          channels: a[2], freq: a[3], generation: a[4], port: a[5] });
        return 0;
      }
      case 'frame':
        globalThis.vita3kWebOnFrame?.(a[0], a[1], a[2], bytes(a[3], a[1] * a[2] * 4));
        return 0;
      case 'dialog':
        globalThis.vita3kWebOnDialog?.(JSON.parse(text(a[0], a[1])));
        return 0;
      case 'ime':
        globalThis.vita3kWebOnIme?.(JSON.parse(text(a[0], a[1])));
        return 0;
      case 'ime-take': {
        const input = globalThis.vita3kWebImeInputs?.shift();
        if (!input) return 0;
        const value = String(input.text ?? '');
        const length = Math.min(value.length, a[2]);
        const header = bytes(a[0], 16);
        const fields = new DataView(header.buffer, header.byteOffset, 16);
        fields.setUint32(0, input.id >>> 0, true);
        fields.setUint32(4, input.kind >>> 0, true);
        fields.setUint32(8, (input.caret ?? length) >>> 0, true);
        fields.setUint32(12, length, true);
        const output = bytes(a[1], length * 2);
        const units = new DataView(output.buffer, output.byteOffset, output.byteLength);
        for (let i = 0; i < length; ++i) units.setUint16(i * 2, value.charCodeAt(i), true);
        return 1;
      }
      case 'exit':
        globalThis.vita3kWebOnExit?.(a[0] | 0);
        return 0;
      default:
        throw new Error(`unknown coordinator operation: ${operation}`);
    }
  };
}
