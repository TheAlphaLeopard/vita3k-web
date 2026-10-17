// Browser-only production GXP -> USSE/SPIR-V Wasm -> Naga WASI/WGSL adapter.
// No fetches to a compilation server, native executable, or shader lookup table.
// One instance is synchronous/non-reentrant during compilation; use a Worker for
// untrusted inputs/time limits. The native GXP decoder is not a hardened parser.
export async function createGXPShaderAdapter({ compilerURL, nagaURL, wasiShimURL }) {
  const [{ default: createCompiler }, shim, nagaBytes] = await Promise.all([
    import(compilerURL), import(wasiShimURL), fetch(nagaURL).then(r => {
      if (!r.ok) throw new Error(`Naga fetch failed: ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  const compiler = await createCompiler();
  const naga = await WebAssembly.compile(nagaBytes);
  const { WASI, File, OpenFile, PreopenDirectory } = shim;
  const decoder = new TextDecoder();
  return {
    async translate(gxp, { textureFormats } = {}) {
      if (!(gxp instanceof Uint8Array) || gxp.byteLength < 156 || gxp.byteLength > 16*1024*1024)
        throw new TypeError('Expected GXP bytes (156 bytes to 16 MiB)');
      if (textureFormats !== undefined && (!(textureFormats instanceof Uint32Array) || textureFormats.length !== 32))
        throw new TypeError('textureFormats must be Uint32Array(32): vertex then fragment');
      const ptr = compiler._malloc(gxp.length);
      const hints = textureFormats ? compiler._malloc(128) : 0;
      if (!ptr || (textureFormats && !hints)) {
        if (ptr) compiler._free(ptr);
        throw new Error('Shader compiler allocation failed');
      }
      let spirv;
      try {
        compiler.HEAPU8.set(gxp, ptr);
        if (hints) compiler.HEAPU32.set(textureFormats, hints/4);
        if (compiler._gxp_compile(ptr, gxp.length, hints))
          throw new Error(compiler.UTF8ToString(compiler._gxp_error()));
        const start = compiler._gxp_output_data(), length = compiler._gxp_output_size();
        spirv = compiler.HEAPU8.slice(start, start+length);
      } finally { compiler._free(ptr); if (hints) compiler._free(hints); }
      // Fresh, isolated in-memory filesystem and Naga instance per invocation.
      // No host filesystem, environment, or inherited WASI descriptors exposed.
      const result = new File([]), stdout = new File([]), stderr = new File([]);
      const wasi = new WASI(['naga', '--keep-coordinate-space', 'input.spv', 'output.wgsl'], [], [
        new OpenFile(new File([])), new OpenFile(stdout), new OpenFile(stderr),
        new PreopenDirectory('.', new Map([['input.spv', new File(spirv)], ['output.wgsl', result]])),
      ]);
      const instance = await WebAssembly.instantiate(naga, { wasi_snapshot_preview1: wasi.wasiImport });
      const exit = wasi.start(instance);
      const wgsl = decoder.decode(result.data);
      if (exit !== 0 || !wgsl.trim()) throw new Error(`Naga failed (${exit}): ${decoder.decode(stderr.data)}${decoder.decode(stdout.data)}`);
      return { spirv, wgsl, translation: 'Vita3K USSE Wasm -> SPIR-V -> Naga WASI WGSL' };
    },
  };
}
