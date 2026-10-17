// Minimal Memory64 feature probe: a valid module containing one i64-indexed
// memory (flags 0x04 = address64, no maximum). Engines without Memory64
// reject it at validate time, so this discriminates without reserving any
// address space. Note this probes *support*, not capacity: the 8 GiB
// reservation itself can still fail on constrained devices, which is why the
// worker attempts the preferred module and falls back on instantiation error.
export function detectMemory64Support() {
  if (typeof WebAssembly === 'undefined' || typeof WebAssembly.validate !== 'function') return false;
  try {
    return WebAssembly.validate(new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x04, 0x00,
    ]));
  } catch {
    return false;
  }
}

export function detectBrowserCapabilities() {
  return {
    wasm: typeof WebAssembly !== 'undefined',
    bigint: typeof BigInt !== 'undefined',
    memory64: detectMemory64Support(),
    workers: typeof Worker !== 'undefined',
    webgpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
    opfs: typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory,
    audioWorklet: typeof AudioWorkletNode !== 'undefined',
    gamepad: typeof navigator !== 'undefined' && 'getGamepads' in navigator,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
  };
}

export function requiredCapabilities(capabilities) {
  return ['wasm', 'workers'];
}

export function formatCapabilities(capabilities) {
  return Object.entries(capabilities)
    .map(([name, available]) => `${name}: ${available ? 'yes' : 'no'}`)
    .join(', ');
}
