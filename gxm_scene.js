// SPDX-License-Identifier: GPL-2.0-or-later
// GXM scene consumer (GXS1 stream, produced by browser/src/gxm_webgpu_bridge.cpp).
//
// Render targets stay on the GPU for their whole life, keyed by the guest color
// surface (address, format, size). A scene is one synchronous call: every draw
// is encoded into one render pass and submitted without waiting; guest memory
// receives rendered pixels only through opt-in surface sync (readTarget).
// Textures over a render target's texels sample it (or a copy of the
// rectangle they cover); others arrive as RGBA8 mip chains the producer
// decoded and caches by content. Transfers into a target arrive as texel
// writes (WRITE_TEXELS). Presentation
// draws the displayed target into an OffscreenCanvas when the page attached
// one, and posts sampled frames for headless observers.
//
// The asynchronous calls suspend guest execution: init() at
// sceGxmInitialize, registerProgram() when a draw first uses a shader program,
// waitForCapacity() on a full GPU queue, and readTarget() when surface sync is on.
import { createGXPShaderAdapter } from './gxp_shader_adapter.js';
import { GpuQueue } from './gpu_queue.js';

let device, compiler, unclippedDepth = false, fragmentUnits = 16;
const traceShaders = (() => { try { return new URL(self.location.href).searchParams.has('gxmTrace'); } catch { return false; } })();
const programs = new Map();  // id -> { wgsl, fragment, module }
const targets = new Map();   // guest color address -> target
const textures = new Map();  // producer texture id -> { texture, view }
const pipelines = new Map(); // pipeline words hash -> [{ words, pipeline }]
const samplers = new Map();
const bufferGroups = new Map(); // vs uniform size -> fs uniform size -> group
const textureGroups = new Map(); // unit words hash -> [{ words, group }]
const streamOffsets = new Uint32Array(16), streamSizes = new Uint32Array(16);
const dynamicOffsets = new Uint32Array(4);
const depthScratch = new Map(); // `${w}x${h}` -> transient on-chip depth texture
const depthSurfaces = new Map(); // `${depth}:${stencil}` guest addresses -> kept depth/stencil texture
let layouts, sceneBuffer, sceneBufferSize = 0;
let canvas, canvasContext, canvasFormat, blitPipeline, blitSampler;
let presentGeneration = 0;
// Device generation: 'active' until device.lost resolves. After loss every
// WebGPU call on this device fails, so the scene layer stops submitting and
// presenting (counted, not silent) and the page is told to offer a restart.
// Emulation/audio never touch WebGPU, which is why a lost device looks like
// a frozen frame with a live game behind it.
let deviceState = 'active';
let deviceInfo = {};
let deviceLostInfo = null;
let notifyDeviceLost = null;
let gpuQueue;
// Bound ALL submissions, including presentation/readback. A full queue makes
// the C++ producer suspend and retry, preserving persistent targets, texture
// uploads and inter-scene dependencies. Arbitrary scene drops corrupt them.
const maxInFlight = (() => {
  try {
    const raw = new URL(self.location.href).searchParams.get('maxInFlight');
    if (raw === null) return 6;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 && raw.trim() !== '' ? value : 6;
  } catch {
    return 6; // 0 disables the valve
  }
})();
let throttleReportedAt = -Infinity;
// Flight recorder: last 256 frame-lifecycle events. Submits continuing
// while presents/completions stop is a queue/backend stall signature;
// queue-error/lost entries identify failures that stop further submission.
const flight = [];
function record(ev, detail) {
  flight.push({ t: Math.round(performance.now()), ev, detail: detail ?? '' });
  if (flight.length > 256) flight.splice(0, flight.length - 256);
}
const stagingBuffers = [], transientTextures = []; // per-submission texel writes, destroyed after submit
const stats = { scenes: 0, draws: 0, pipelines: 0, textureUploads: 0, presents: 0, bindGroups: 0, submitMs: 0, uploadMs: 0, sceneBytes: 0, surfaceSyncs: 0, droppedScenes: 0, presentFailures: 0, stateSkips: 0, throttledScenes: 0, throttledPresents: 0, colorSnapshots: 0, drawParts: 0 };
// Redundant state-change filter (reset per pass): every WebGPU call from a
// worker crosses into the browser/GPU process, so re-emitting unchanged
// bindings, buffers, viewport, scissor or stencil reference each draw costs
// real IPC time on a phone CPU. Skipping identical state is a no-op visually.
const lastGroups = [null, null, null, null];
const lastDyn = [-1, -1, -1, -1];
const lastVB = new Int32Array(16), lastVBSize = new Int32Array(16);
const lastViewport = new Float32Array(4), lastScissor = new Int32Array(4);
let lastPipeline = null, lastIndexFormat = null, lastIndexOffset = -1, lastIndexBytes = -1, lastStencil = -1;
function resetPassState() {
  lastPipeline = null;
  lastGroups[0] = lastGroups[1] = lastGroups[2] = lastGroups[3] = null;
  lastDyn[0] = lastDyn[1] = lastDyn[2] = lastDyn[3] = -1;
  lastVB.fill(-1); lastVBSize.fill(-1);
  lastViewport.fill(-1); lastScissor.fill(-1);
  lastIndexFormat = null; lastIndexOffset = -1; lastIndexBytes = -1; lastStencil = -1;
}
let log = message => console.warn(message);
let statsReportedAt = 0;
const warned = new Set();
const warnOnce = message => {
  if (warned.has(message)) return;
  warned.add(message);
  log(`[gxm-scene] ${message}`);
};

export async function init({ compilerURL, nagaURL, wasiShimURL, logger, onDeviceLost, submissionProtocol }) {
  if (logger) log = logger;
  // Old Wasm cannot wait/retry busy scenes. Fail at startup rather than
  // silently mix renderer versions and acknowledge missing guest writes.
  if (submissionProtocol !== 1)
    throw new Error('Renderer/runtime mismatch: rebuild vita3k_web_dist for lossless GPU back-pressure');
  if (device) return;
  if (!globalThis.navigator?.gpu)
    throw new Error(globalThis.isSecureContext
      ? 'WebGPU unavailable: navigator.gpu is missing in this browser context'
      : 'WebGPU unavailable: this origin is not a secure context (use https:// or http://localhost)');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter unavailable');
  const info = adapter.info ?? {};
  deviceInfo = { vendor: info.vendor ?? '', architecture: info.architecture ?? '',
    device: info.device ?? '', description: info.description ?? '' };
  log(`[gxm-scene] adapter: ${info.vendor} ${info.architecture} ${info.device} ${info.description}`);
  // GXM has no depth clipping to [0, w]: Persona 4 Golden's 2D draws sit at
  // z = w after the viewport transform, which rounding pushes just outside
  // WebGPU's clip volume. With depth-clip-control the depth is clamped to
  // the viewport range instead of culling the primitive.
  unclippedDepth = adapter.features.has('depth-clip-control');
  // The fragment stage samples 16 GXM texture units plus the snapshot of the
  // target a program reads its color from: 17 sampled textures, one over the
  // default limit. Without a larger limit unit 15 is left out.
  fragmentUnits = adapter.limits.maxSampledTexturesPerShaderStage >= 17 ? 16 : 15;
  device = await adapter.requestDevice({
    ...(unclippedDepth ? { requiredFeatures: ['depth-clip-control'] } : {}),
    ...(fragmentUnits === 16 ? { requiredLimits: { maxSampledTexturesPerShaderStage: 17 } } : {}),
  });
  if (fragmentUnits < 16) log('[gxm-scene] 16 sampled textures per stage: fragment texture unit 15 is unavailable');
  if (!unclippedDepth) log('[gxm-scene] depth-clip-control unavailable: primitives on the far plane may be clipped');
  // The bridge may pass this explicitly; otherwise fall back to the worker's
  // global hook (same pattern as vita3kGxmReady/vita3kWebOnGpuFrame).
  notifyDeviceLost = onDeviceLost ?? ((detail) => globalThis.vita3kWebOnGxmDevice?.(detail));
  gpuQueue = new GpuQueue(device.queue, { maxInFlight, onEvent: record, onFailure: error => {
    if (deviceState !== 'active') return;
    deviceState = 'error';
    deviceLostInfo = { reason: 'queue-error', message: error.message };
    log(`[gxm-device] queue error: ${error.message}`);
    try { notifyDeviceLost?.({ ...deviceLostInfo, adapter: deviceInfo }); } catch {}
  } });
  log(`[gxm-scene] lossless back-pressure: maxInFlight=${maxInFlight} submissions`);
  device.lost.then((lost) => {
    deviceState = 'lost';
    deviceLostInfo = { reason: lost?.reason ?? 'unknown', message: lost?.message ?? '' };
    gpuQueue.fail(new Error(`WebGPU device lost: ${deviceLostInfo.reason} ${deviceLostInfo.message}`));
    record('lost', `${deviceLostInfo.reason} ${deviceLostInfo.message}`);
    log(`[gxm-device] lost reason=${deviceLostInfo.reason} message=${deviceLostInfo.message}`);
    try { notifyDeviceLost?.({ ...deviceLostInfo, adapter: deviceInfo }); } catch {}
  });
  device.addEventListener('uncapturederror', event =>
    warnOnce(`WebGPU validation: ${event.error?.message ?? event.error}`));
  compiler = await createGXPShaderAdapter({ compilerURL, nagaURL, wasiShimURL });
  const bufferEntry = (binding, visibility, type) =>
    ({ binding, visibility, buffer: { type, hasDynamicOffset: true } });
  const textureGroup = (visibility, units = 16) => device.createBindGroupLayout({ entries:
    Array.from({ length: units * 2 }, (_, i) => i % 2 === 0
      ? { binding: i, visibility, texture: { sampleType: 'float' } }
      : { binding: i, visibility, sampler: { type: 'filtering' } }) });
  const empty = device.createBindGroupLayout({ entries: [] });
  layouts = {
    buffers: device.createBindGroupLayout({ entries: [
      bufferEntry(0, GPUShaderStage.VERTEX, 'uniform'),
      bufferEntry(1, GPUShaderStage.FRAGMENT, 'uniform'),
      bufferEntry(2, GPUShaderStage.VERTEX, 'read-only-storage'),
      bufferEntry(3, GPUShaderStage.FRAGMENT, 'read-only-storage'),
    ] }),
    empty,
    vertexTextures: textureGroup(GPUShaderStage.VERTEX),
    fragmentTextures: textureGroup(GPUShaderStage.FRAGMENT, fragmentUnits),
  };
  // Group 1: the snapshot of the target a fragment program reads its current
  // color from (the browser compiler's sampled_fragcolor feature).
  layouts.fragColor = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }] });
  layouts.pipeline = device.createPipelineLayout({ bindGroupLayouts:
    [layouts.buffers, layouts.fragColor, layouts.vertexTextures, layouts.fragmentTextures] });
  // Unbound texture slots of a 16-unit group still need valid resources.
  layouts.dummyView = device.createTexture({ size: [1, 1], format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING }).createView();
}

// Translation of one GXP (vertex or fragment) into WGSL. `id` is the
// producer's program id; the same GXP bytes always get the same id.
export async function registerProgram(id, gxp, fragment) {
  if (programs.has(id)) return;
  if (deviceState !== 'active') throw new Error('WebGPU device lost; restart the run');
  const textureFormats = new Uint32Array(32).fill(0x0c000000); // RGBA8 after producer decode
  const { wgsl } = await compiler.translate(gxp, { textureFormats });
  // ?gxmTrace=N (gxm_webgpu_bridge.cpp): also print each translated program.
  if (traceShaders) log(`[gxm-trace] program ${id} ${fragment ? 'fragment' : 'vertex'} WGSL:\n${wgsl}`);
  const module = device.createShaderModule({ code: wgsl });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter(message => message.type === 'error');
  if (errors.length) throw new Error(`GXP ${id} WGSL: ${errors.map(m => m.message).join('\n')}`);
  // A program that reads the current color gets a snapshot of the target
  // before each of its draws (DRAW below).
  programs.set(id, { module, fragment, readsColor: fragment && wgsl.includes('fragColorSnapshot') });
}

export function attachCanvas(offscreen) {
  canvas = offscreen;
  canvasContext = canvas.getContext('webgpu');
  canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  try {
    canvasContext.configure({ device, format: canvasFormat, alphaMode: 'opaque' });
  } catch (error) {
    log(`[gxm-device] canvas configure failed: ${error?.message ?? error}`);
    throw error;
  }
}

// GXM color formats the consumer renders to (base format | swizzle). The
// shaders write components in memory order, so a target's texels have the
// guest surface's bytes (rgba8unorm, rgb10a2unorm and rgba16float match the
// U8x4, U2U10U10U10 and F16x4 surfaces bit for bit).
const colorFormats = new Map([
  [0x00000000, 'rgba8unorm'],  // U8U8U8U8_ABGR
  [0x10000000, 'rgba8unorm'],  // U8U8U8U8 variants (swizzle handled by the shader)
  [0x60800000, 'rgb10a2unorm'], // U2U10U10U10_ABGR
  [0x61800000, 'rgb10a2unorm'],
  [0x01000000, 'rgba16float'], // F16F16F16F16
]);
const texelBytes = { rgba8unorm: 4, rgb10a2unorm: 4, rgba16float: 8 };
function colorFormat(guest) {
  const format = colorFormats.get(guest >>> 0) ?? colorFormats.get((guest & 0xf1800000) >>> 0);
  if (!format) throw new Error(`unsupported GXM color format ${(guest >>> 0).toString(16)}`);
  return format;
}

// A target is `scale` times its guest surface size in each dimension (texel
// writes, region copies and read-back use surface coordinates) and
// `renderScale` times its render pixels (viewport, scissor): the two differ
// for a downscaled surface, which renders at twice its size and is
// box-filtered into guest memory. Both come from the producer (BEGIN_PASS).
// Its depth surfaces and snapshot share its GPU size.
function targetFor(address, format, width, height, scale, renderScale) {
  let target = targets.get(address);
  if (target && target.width === width && target.height === height && target.guestFormat === format
      && target.scale === scale && target.renderScale === renderScale)
    return target;
  target?.texture.destroy();
  target?.snapshot?.texture.destroy();
  target?.fragColor?.texture.destroy();
  target?.resolved?.texture.destroy();
  target?.guestCopy?.destroy();
  const gpuFormat = colorFormat(format);
  const gpuWidth = width * scale, gpuHeight = height * scale;
  const texture = device.createTexture({ size: [gpuWidth, gpuHeight], format: gpuFormat,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST });
  target = { address, width, height, scale, renderScale, gpuWidth, gpuHeight, guestFormat: format, gpuFormat, texture,
    view: texture.createView(), depth: null, fresh: true };
  // A downscaled surface is sampled as its guest texels: the render
  // box-filtered to renderScale per surface texel after each pass.
  if (scale !== renderScale) {
    const resolved = device.createTexture({ size: [width * renderScale, height * renderScale], format: gpuFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    target.resolved = { texture: resolved, view: resolved.createView() };
  }
  targets.set(address, target);
  // Cached texture groups may reference the replaced target's views.
  textureGroups.clear();
  return target;
}

const depthFormats = new Map([
  [0x02444000, 'depth16unorm'], [0x00044000, 'depth32float'],
  [0x01266000, 'depth24plus-stencil8'], [0x00000000, 'depth24plus-stencil8'],
]);
// mode 1: on-chip only (no guest surface), a transient buffer shared by
// same-sized scenes; mode 2: a guest depth/stencil surface, kept on the GPU
// under its own data addresses so any color target can load it later.
function depthAttachmentFor(target, mode, format, depthAddress, stencilAddress) {
  const gpuFormat = depthFormats.get(format >>> 0) ?? 'depth24plus-stencil8';
  if (mode === 1) {
    const key = `${target.gpuWidth}x${target.gpuHeight}:${gpuFormat}`;
    let scratch = depthScratch.get(key);
    if (!scratch) {
      const texture = device.createTexture({ size: [target.gpuWidth, target.gpuHeight], format: gpuFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT });
      scratch = { view: texture.createView(), format: gpuFormat, fresh: true };
      depthScratch.set(key, scratch);
    }
    return scratch;
  }
  const key = `${depthAddress >>> 0}:${stencilAddress >>> 0}`;
  let surface = depthSurfaces.get(key);
  if (!surface || surface.format !== gpuFormat || surface.width !== target.gpuWidth || surface.height !== target.gpuHeight) {
    surface?.texture.destroy();
    const texture = device.createTexture({ size: [target.gpuWidth, target.gpuHeight], format: gpuFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT });
    surface = { texture, view: texture.createView(), format: gpuFormat, width: target.gpuWidth, height: target.gpuHeight, fresh: true };
    depthSurfaces.set(key, surface);
  }
  return surface;
}

// --- GXM state translation --------------------------------------------------
const blendOps = ['add', 'add', 'subtract', 'reverse-subtract', 'min', 'max'];
const blendFactors = ['zero', 'one', 'src', 'one-minus-src', 'src-alpha', 'one-minus-src-alpha',
  'dst', 'one-minus-dst', 'dst-alpha', 'one-minus-dst-alpha', 'src-alpha-saturate', 'dst-alpha'];
const compareFuncs = ['never', 'less', 'equal', 'less-equal', 'greater', 'not-equal', 'greater-equal', 'always'];
const stencilOps = ['keep', 'zero', 'replace', 'increment-clamp', 'decrement-clamp', 'invert',
  'increment-wrap', 'decrement-wrap'];
// SceGxmAttributeFormat x components -> WebGPU vertex format
const vertexFormats = {
  0: { 2: 'uint8x2', 4: 'uint8x4' }, 1: { 2: 'sint8x2', 4: 'sint8x4' },
  2: { 2: 'uint16x2', 4: 'uint16x4' }, 3: { 2: 'sint16x2', 4: 'sint16x4' },
  4: { 2: 'unorm8x2', 4: 'unorm8x4' }, 5: { 2: 'snorm8x2', 4: 'snorm8x4' },
  6: { 2: 'unorm16x2', 4: 'unorm16x4' }, 7: { 2: 'snorm16x2', 4: 'snorm16x4' },
  8: { 2: 'float16x2', 4: 'float16x4' },
  9: { 1: 'float32', 2: 'float32x2', 3: 'float32x3', 4: 'float32x4' },
};
const filters = ['nearest', 'linear'];
const addressModes = ['repeat', 'mirror-repeat', 'clamp-to-edge', 'clamp-to-edge', 'clamp-to-edge',
  'clamp-to-edge', 'repeat', 'clamp-to-edge'];
function samplerFor(min, mag, mip, u, v, lodMax) {
  const key = (min & 1) | (mag & 1) << 1 | (mip & 1) << 2 | (u & 7) << 3 | (v & 7) << 6 | (lodMax & 0xffff) << 9;
  let sampler = samplers.get(key);
  if (!sampler) {
    sampler = device.createSampler({ minFilter: filters[min & 1], magFilter: filters[mag & 1],
      mipmapFilter: filters[mip & 1], addressModeU: addressModes[u & 7], addressModeV: addressModes[v & 7],
      lodMinClamp: 0, lodMaxClamp: lodMax });
    samplers.set(key, sampler);
  }
  return sampler;
}

// The draw loop runs ~20k times a second, so decoding a draw allocates
// nothing: its pipeline words (everything but per-draw offsets, viewport,
// scissor and stencil reference) go to a scratch array and are looked up
// by hash, compared word for word; a descriptor object is built only on a miss.
const topologies = ['triangle-list', 'triangle-strip', 'line-list', 'line-strip', 'point-list'];
const pipelineWords = new Uint32Array(256);
let pipelineLength = 0;
const formatIds = new Map();
function formatId(format) {
  let id = formatIds.get(format);
  if (id === undefined) formatIds.set(format, id = formatIds.size + 1);
  return id;
}
function hashWords(words, length, seed) {
  let hash = seed | 0;
  for (let i = 0; i < length; ++i) hash = Math.imul(hash ^ words[i], 16777619);
  return hash & 0x3fffffff;
}
function sameWords(stored, words, length) {
  if (stored.length !== length) return false;
  for (let i = 0; i < length; ++i) if (stored[i] !== words[i]) return false;
  return true;
}
function cachedPipeline(target, depth) {
  pipelineWords[pipelineLength++] = formatId(target.gpuFormat);
  pipelineWords[pipelineLength++] = depth ? formatId(depth.format) : 0;
  const key = hashWords(pipelineWords, pipelineLength, 0x811c9dc5);
  let bucket = pipelines.get(key);
  if (bucket) {
    for (let i = 0; i < bucket.length; ++i)
      if (sameWords(bucket[i].words, pipelineWords, pipelineLength)) return bucket[i].pipeline;
  } else pipelines.set(key, bucket = []);
  const pipeline = createPipeline(describePipeline(), target, depth);
  bucket.push({ words: pipelineWords.slice(0, pipelineLength), pipeline });
  return pipeline;
}
function describePipeline() {
  const w = pipelineWords;
  const d = { vs: w[0], fs: w[1], cull: w[2], topology: topologies[w[3]], blend: Array.from(w.subarray(4, 11)),
    fragmentDisabled: w[11] !== 0, depthFunc: w[12], depthWrite: w[13] !== 0,
    stencilFront: Array.from(w.subarray(14, 18)), stencilBack: Array.from(w.subarray(18, 22)),
    stencilReadMask: w[22], stencilWriteMask: w[23], streams: [], attributes: [] };
  let i = 24;
  for (let n = w[i++]; n > 0; --n) d.streams.push({ stride: w[i++] });
  for (let n = w[i++]; n > 0; --n)
    d.attributes.push({ location: w[i++], stream: w[i++], offset: w[i++], format: w[i++], components: w[i++] });
  d.indexSize = w[i++];
  return d;
}

function createPipeline(d, target, depth) {
  const vertex = programs.get(d.vs), fragment = programs.get(d.fs);
  if (!vertex || !fragment) throw new Error(`draw with unregistered program ${d.vs}/${d.fs}`);
  const buffers = d.streams.map(stream => ({ arrayStride: stream.stride, stepMode: 'vertex', attributes: [] }));
  for (const a of d.attributes) {
    const format = vertexFormats[a.format]?.[a.components];
    if (!format) throw new Error(`unsupported vertex attribute ${a.format}x${a.components}`);
    buffers[a.stream].attributes.push({ shaderLocation: a.location, offset: a.offset, format });
  }
  // Conversion can move every attribute out of an original stream. Keep
  // its slot number for the other streams, but require no fetch from it.
  for (let i = 0; i < buffers.length; ++i)
    if (buffers[i].attributes.length === 0) buffers[i] = null;
  const colorMask = d.blend[0];
  const writeMask = (colorMask & 2 ? 1 : 0) | (colorMask & 4 ? 2 : 0) | (colorMask & 8 ? 4 : 0) | (colorMask & 1 ? 8 : 0);
  const [, colorFunc, alphaFunc, colorSrc, colorDst, alphaSrc, alphaDst] = d.blend;
  const blend = colorFunc || alphaFunc ? {
    color: { operation: blendOps[colorFunc], srcFactor: blendFactors[colorSrc], dstFactor: blendFactors[colorDst] },
    alpha: { operation: blendOps[alphaFunc], srcFactor: blendFactors[alphaSrc], dstFactor: blendFactors[alphaDst] },
  } : undefined;
  const face = s => ({ compare: compareFuncs[s[0]], failOp: stencilOps[s[1]],
    depthFailOp: stencilOps[s[2]], passOp: stencilOps[s[3]] });
  const hasStencil = depth && depth.format === 'depth24plus-stencil8';
  if (traceShaders) log(`[gxm-trace] pipeline vs=${d.vs} fs=${d.fs} mask=${colorMask} fragmentDisabled=${d.fragmentDisabled} blend=${JSON.stringify(d.blend)} depth=${depth?.format} func=${d.depthFunc} write=${d.depthWrite} cull=${d.cull} topology=${d.topology} stencil=${JSON.stringify(d.stencil ?? null)}`);
  const descriptor = {
    layout: layouts.pipeline,
    vertex: { module: vertex.module, entryPoint: 'main_vs', buffers },
    fragment: { module: fragment.module, entryPoint: 'main_fs',
      targets: [{ format: target.gpuFormat, writeMask: d.fragmentDisabled ? 0 : writeMask, ...(blend ? { blend } : {}) }] },
    primitive: { topology: d.topology, cullMode: ['none', 'back', 'front'][d.cull] ?? 'none',
      ...(unclippedDepth ? { unclippedDepth: true } : {}),
      frontFace: 'ccw', ...(d.topology.endsWith('strip') ? { stripIndexFormat: d.indexSize === 2 ? 'uint16' : 'uint32' } : {}) },
    ...(depth ? { depthStencil: { format: depth.format, depthWriteEnabled: d.depthWrite,
      depthCompare: compareFuncs[d.depthFunc],
      ...(hasStencil ? { stencilFront: face(d.stencilFront), stencilBack: face(d.stencilBack),
        stencilReadMask: d.stencilReadMask, stencilWriteMask: d.stencilWriteMask } : {}) } } : {}),
  };
  const pipeline = device.createRenderPipeline(descriptor);
  ++stats.pipelines;
  return pipeline;
}

function ensureSceneBuffer(size) {
  if (size <= sceneBufferSize) return;
  // Powers of two, up to the device's buffer limit (256 MiB by default).
  const limit = device.limits.maxBufferSize;
  if (size > limit) throw new RangeError(`scene of ${size} bytes exceeds the GPU buffer limit (${limit})`);
  sceneBuffer?.destroy();
  sceneBufferSize = Math.min(limit, Math.max(1 << 20, 2 ** Math.ceil(Math.log2(size))));
  sceneBuffer = device.createBuffer({ size: sceneBufferSize, usage: GPUBufferUsage.VERTEX
    | GPUBufferUsage.INDEX | GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  bufferGroups.clear();
}

function bufferGroupFor(vsSize, fsSize) {
  let bySize = bufferGroups.get(vsSize);
  if (!bySize) bufferGroups.set(vsSize, bySize = new Map());
  let group = bySize.get(fsSize);
  if (!group) {
    ++stats.bindGroups;
    group = device.createBindGroup({ layout: layouts.buffers, entries: [
      { binding: 0, resource: { buffer: sceneBuffer, size: 48 } },
      { binding: 1, resource: { buffer: sceneBuffer, size: 32 } },
      { binding: 2, resource: { buffer: sceneBuffer, size: Math.max(16, vsSize) } },
      { binding: 3, resource: { buffer: sceneBuffer, size: Math.max(16, fsSize) } },
    ] });
    bySize.set(fsSize, group);
  }
  return group;
}

// What textures sample of a target: its texture, or a downscaled surface's
// filtered image; `renderScale` texels per surface texel either way.
function sampled(target) {
  return target.resolved ?? target;
}
function resolveTarget(encoder, target) {
  const factor = target.scale / target.renderScale;
  const pipeline = downscalePipeline(target.gpuFormat, factor);
  target.resolveGroup ??= device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: target.view }] });
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.resolved.view, loadOp: 'clear', storeOp: 'store' }] });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, target.resolveGroup);
  pass.draw(3);
  pass.end();
}
function textureView(id) {
  if (id & 0x80000000) {
    // Render target sampled as a texture: the id carries the guest address;
    // bit 30 selects the snapshot taken when its own pass began.
    const target = targets.get((id & 0x3fffffff) * 4);
    if (!target) { warnOnce('texture aliases a render target that was never rendered'); return layouts.dummyView; }
    if (id & 0x40000000) return target.snapshot.view;
    return sampled(target).view;
  }
  return textures.get(id)?.view ?? layouts.dummyView;
}

// Texture units of the draw being decoded: per unit the 8 stream words
// unit, id, min, mag, mip, u, v, lodMax; fragment and vertex stages apart.
const unitWords = [new Uint32Array(16 * 8), new Uint32Array(16 * 8)];
const unitCounts = [0, 0];
// Groups are cached by their words; render-target aliases stay valid until
// the target is recreated (targetFor clears the cache), textures until one
// is replaced (TEXTURE, REGION).
function textureGroupFor(stage) {
  const layout = stage ? layouts.vertexTextures : layouts.fragmentTextures;
  const words = unitWords[stage], length = unitCounts[stage] * 8;
  const key = hashWords(words, length, stage + 1);
  let bucket = textureGroups.get(key);
  if (bucket) {
    for (let i = 0; i < bucket.length; ++i)
      if (sameWords(bucket[i].words, words, length)) return bucket[i].group;
  }
  const entries = [];
  for (let unit = 0, units = stage === 0 ? fragmentUnits : 16; unit < units; ++unit) {
    let at = -1;
    for (let i = 0; i < length; i += 8) if ((words[i] & 15) === unit) at = i;
    entries.push({ binding: unit * 2, resource: at >= 0 ? textureView(words[at + 1]) : layouts.dummyView });
    entries.push({ binding: unit * 2 + 1, resource: at >= 0
      ? samplerFor(words[at + 2], words[at + 3], words[at + 4], words[at + 5], words[at + 6], words[at + 7])
      : samplerFor(0, 0, 0, 2, 2, 0) });
  }
  ++stats.bindGroups;
  const group = device.createBindGroup({ layout, entries });
  if (!bucket) textureGroups.set(key, bucket = []);
  bucket.push({ words: words.slice(0, length), group });
  return group;
}
const emptyGroupCache = {};
function emptyGroup() {
  return emptyGroupCache.group ??= device.createBindGroup({ layout: layouts.fragColor,
    entries: [{ binding: 0, resource: layouts.dummyView }] });
}

// WRITE_TEXELS: the guest texels are uploaded at surface size and drawn
// into the target at its scale (nearest), discarding texels the mask leaves
// out. Transfers are rare; the per-write objects are released after submit.
const texelWritePipelines = new Map(); // gpu format -> pipeline
function texelWritePipeline(format) {
  let pipeline = texelWritePipelines.get(format);
  if (!pipeline) {
    const module = device.createShaderModule({ code: `
      struct Rect { origin: vec2u, scale: u32, masked: u32 };
      @group(0) @binding(0) var<uniform> rect: Rect;
      @group(0) @binding(1) var texels: texture_2d<f32>;
      @group(0) @binding(2) var mask: texture_2d<f32>;
      @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
        let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
        return vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
      }
      @fragment fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
        let texel = vec2u(position.xy) / rect.scale - rect.origin;
        if (rect.masked != 0u && textureLoad(mask, texel, 0).r < 0.5) { discard; }
        return textureLoad(texels, texel, 0);
      }` });
    pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] }, primitive: { topology: 'triangle-list' } });
    texelWritePipelines.set(format, pipeline);
  }
  return pipeline;
}
function writeTexels(encoder, target, x, y, width, height, data, dataOffset, maskOffset) {
  const bytes = texelBytes[target.gpuFormat];
  if (!bytes) throw new Error(`texel write into a ${target.gpuFormat} render target`);
  const upload = (format, texel, offset) => {
    const texture = device.createTexture({ size: [width, height], format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture }, data.subarray(offset, offset + width * height * texel),
      { bytesPerRow: width * texel }, [width, height]);
    transientTextures.push(texture);
    return texture;
  };
  const texels = upload(target.gpuFormat, bytes, dataOffset);
  const masked = maskOffset !== 0xffffffff;
  const mask = masked ? upload('r8unorm', 1, maskOffset) : texels;
  const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
  new Uint32Array(uniform.getMappedRange()).set([x, y, target.scale, masked ? 1 : 0]);
  uniform.unmap();
  stagingBuffers.push(uniform);
  const pipeline = texelWritePipeline(target.gpuFormat);
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.view,
    loadOp: target.fresh ? 'clear' : 'load', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: uniform } },
    { binding: 1, resource: texels.createView() },
    { binding: 2, resource: mask.createView() },
  ] }));
  const s = target.scale;
  pass.setViewport(0, 0, target.gpuWidth, target.gpuHeight, 0, 1);
  pass.setScissorRect(x * s, y * s, width * s, height * s);
  pass.draw(3);
  pass.end();
  target.fresh = false;
  if (target.resolved) resolveTarget(encoder, target);
}

function capacityFor(kind) {
  if (gpuQueue.hasCapacity()) return true;
  if (kind === 'scene') ++stats.throttledScenes;
  if (kind === 'present') ++stats.throttledPresents;
  const now = performance.now();
  if (now - throttleReportedAt >= 5000) {
    throttleReportedAt = now;
    const queue = gpuQueue.snapshot();
    record('waiting', `${kind} in-flight=${queue.inFlight}`);
    log(`[gxm-scene] GPU back-pressure: ${queue.inFlight} submissions queued (max ${maxInFlight}); waiting, preserving scene data`);
    try {
      globalThis.vita3kWebOnGxmThrottle?.({ ...queue, throttledScenes: stats.throttledScenes });
    } catch {}
  }
  return false;
}

// Only the full-queue path crosses Asyncify. The C++ writer stays alive until
// the exact same stream is accepted; a busy call performs NO GPU writes.
export function waitForCapacity() { return gpuQueue.waitForCapacity(); }

// words: Uint32Array view of the command stream; data: Uint8Array payload.
export function trySubmitScene(words, data) {
  if (!capacityFor('scene')) return false;
  const started = performance.now();
  try {
    encodeScene(words, data);
    return true;
  } finally {
    const now = performance.now();
    stats.submitMs += now - started;
    if (now - statsReportedAt >= 5000) {
      statsReportedAt = now;
      log(`[gxm-scene] stats ${JSON.stringify({ ...stats, submitMs: Math.round(stats.submitMs),
        device: deviceState, ...gpuQueue.snapshot(),
        adapter: `${deviceInfo.vendor} ${deviceInfo.architecture}`.trim(),
        targets: targets.size, textures: textures.size, pipelinesCached: pipelines.size, groupsCached: textureGroups.size })}`);
    }
  }
}

// Splits a draw whose fragment program reads the current color (see DRAW)
// into parts whose triangles do not overlap one another, in draw order.
// Returns the part count; part k is triangles partStarts[k] up to
// partStarts[k + 1]. Positions: the lowest-location float attribute with two
// or more components, read from the scene payload. Only flat draws (one z for
// every vertex) split: any projection maps a plane to the screen keeping
// which triangles overlap, which a 3D mesh's x, y do not tell. Persona 4
// Golden's menus layer translucent quads in one draw.
const partStarts = new Uint32Array(65);
const partTriangles = new Float32Array(6 * 256);
const kMaxPartTriangles = 4096;
function drawParts(data, indexOffset, indexSize, indexCount, streamOffsets) {
  const w = pipelineWords;
  const topology = w[3], cull = w[2];
  // Strip parts must begin at even triangles to keep their winding.
  if (topology > 1 || (topology === 1 && cull !== 0)) return 1;
  const triangles = topology === 0 ? Math.floor(indexCount / 3) : indexCount - 2;
  if (triangles < 2 || triangles > kMaxPartTriangles) return 1;
  let i = 24;
  const streamCount = w[i++], strides = i;
  i += streamCount;
  let position = -1, location = Infinity;
  for (let n = w[i++]; n > 0; --n, i += 5)
    if (w[i + 3] === 9 /* F32 */ && w[i + 4] >= 2 && w[i] < location) { location = w[i]; position = i; }
  if (position < 0) return 1;
  const stream = w[position + 1], stride = w[strides + stream], base = streamOffsets[stream] + w[position + 2];
  const flat = w[position + 4] < 3;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const index = k => indexSize === 2 ? view.getUint16(indexOffset + k * 2, true) : view.getUint32(indexOffset + k * 4, true);
  let parts = 0, inPart = 0, z = NaN;
  partStarts[0] = 0;
  for (let t = 0; t < triangles; ++t) {
    const k = topology === 0 ? t * 3 : t;
    if (inPart === partTriangles.length / 6) {
      // A full part ends here (strips: at an even triangle).
      if (parts + 1 >= partStarts.length - 1) return 1;
      const keep = topology === 1 && (t & 1) ? 1 : 0;
      partStarts[++parts] = t - keep;
      partTriangles.copyWithin(0, (inPart - keep) * 6, inPart * 6);
      inPart = keep;
    }
    const at = inPart * 6;
    for (let v = 0; v < 3; ++v) {
      const offset = base + index(k + v) * stride;
      partTriangles[at + v * 2] = view.getFloat32(offset, true);
      partTriangles[at + v * 2 + 1] = view.getFloat32(offset + 4, true);
      if (flat) continue;
      const vz = view.getFloat32(offset + 8, true);
      if (t === 0 && v === 0) z = vz;
      else if (vz !== z) return 1;
    }
    let overlaps = false;
    for (let other = 0; other < inPart && !overlaps; ++other)
      overlaps = trianglesOverlap(partTriangles, at, other * 6);
    if (overlaps && topology === 1 && (t & 1)) {
      // An odd strip triangle starts no part: the new part begins one
      // triangle early, so that triangle must not overlap this one.
      if (inPart < 2 || trianglesOverlap(partTriangles, at - 6, at)) return 1;
      if (parts + 1 >= partStarts.length - 1) return 1;
      partStarts[++parts] = t - 1;
      partTriangles.copyWithin(0, at - 6, at + 6);
      inPart = 2;
      continue;
    }
    if (overlaps) {
      if (parts + 1 >= partStarts.length - 1) return 1;
      partStarts[++parts] = t;
      partTriangles.copyWithin(0, at, at + 6);
      inPart = 0;
    }
    ++inPart;
  }
  partStarts[++parts] = triangles;
  return parts;
}
// Whether two triangles (x, y triples at a and b) share interior area:
// separating axis test on their six edge normals. Shared edges, degenerate
// triangles and anything not finite do not overlap.
function trianglesOverlap(t, a, b) {
  for (let side = 0; side < 2; ++side) {
    const s = side ? b : a;
    for (let e = 0; e < 3; ++e) {
      const x0 = t[s + e * 2], y0 = t[s + e * 2 + 1];
      const x1 = t[s + ((e + 1) % 3) * 2], y1 = t[s + ((e + 1) % 3) * 2 + 1];
      const nx = y0 - y1, ny = x1 - x0;
      const length = Math.hypot(nx, ny);
      if (!(length > 1e-6)) return false;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (let v = 0; v < 3; ++v) {
        const pa = t[a + v * 2] * nx + t[a + v * 2 + 1] * ny, pb = t[b + v * 2] * nx + t[b + v * 2 + 1] * ny;
        minA = Math.min(minA, pa); maxA = Math.max(maxA, pa); minB = Math.min(minB, pb); maxB = Math.max(maxB, pb);
      }
      const epsilon = 1e-3 * length; // a thousandth of a unit along the normal
      if (!(maxA > minB + epsilon && maxB > minA + epsilon)) return false;
    }
  }
  return true;
}

function encodeScene(words, data) {
  ensureSceneBuffer(data.byteLength + 4096);
  const uploadStart = performance.now();
  device.queue.writeBuffer(sceneBuffer, 0, data);
  stats.uploadMs += performance.now() - uploadStart;
  stats.sceneBytes += data.byteLength;
  // State filter, rebound per pass below (pass is recreated by BEGIN_PASS).
  const setGroup = (index, group) => {
    if (lastGroups[index] !== group) { pass.setBindGroup(index, group); lastGroups[index] = group; }
    else ++stats.stateSkips;
  };
  const setGroupDyn = (group) => {
    if (lastGroups[0] !== group || lastDyn[0] !== dynamicOffsets[0] || lastDyn[1] !== dynamicOffsets[1]
        || lastDyn[2] !== dynamicOffsets[2] || lastDyn[3] !== dynamicOffsets[3]) {
      pass.setBindGroup(0, group, dynamicOffsets, 0, 4);
      lastGroups[0] = group;
      lastDyn[0] = dynamicOffsets[0]; lastDyn[1] = dynamicOffsets[1];
      lastDyn[2] = dynamicOffsets[2]; lastDyn[3] = dynamicOffsets[3];
    } else ++stats.stateSkips;
  };
  const floats = new Float32Array(words.buffer, words.byteOffset, words.length);
  let cursor = 0;
  const word = () => words[cursor++];
  if (word() !== 0x31535847) throw new Error('unknown GXM scene stream');
  const encoder = device.createCommandEncoder();
  let pass = null, target = null, depth = null, passSplits = false;
  while (cursor < words.length) {
    const command = word();
    switch (command) {
    case 1: { // BEGIN_PASS
      const address = word(), format = word(), width = word(), height = word();
      const depthMode = word(), depthFormat = word(), depthLoad = word(), depthStore = word();
      const clearDepth = floats[cursor++], clearStencil = word();
      const depthAddress = word(), stencilAddress = word(), snapshot = word(), scale = word(), renderScale = word();
      target = targetFor(address, format, width, height, scale, renderScale);
      passSplits = (snapshot & 2) !== 0;
      if (snapshot & 1) {
        // A draw samples this target: give it the contents from before the pass.
        const width = target.width * target.renderScale, height = target.height * target.renderScale;
        if (!target.snapshot) {
          const texture = device.createTexture({ size: [width, height], format: target.gpuFormat,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
          target.snapshot = { texture, view: texture.createView() };
          textureGroups.clear();
        }
        encoder.copyTextureToTexture({ texture: sampled(target).texture }, { texture: target.snapshot.texture },
          [width, height]);
      }
      depth = depthMode ? depthAttachmentFor(target, depthMode, depthFormat, depthAddress, stencilAddress) : null;
      // Guest depth contents exist only once this surface was stored.
      const depthKept = depth && depthMode === 2 && !depth.fresh;
      const stencil = depth && depth.format === 'depth24plus-stencil8';
      pass = encoder.beginRenderPass({
        colorAttachments: [{ view: target.view, loadOp: target.fresh ? 'clear' : 'load', storeOp: 'store',
          clearValue: [0, 0, 0, 1] }],
        ...(depth ? { depthStencilAttachment: { view: depth.view,
          depthLoadOp: depthLoad && depthKept ? 'load' : 'clear',
          depthClearValue: clearDepth, depthStoreOp: depthStore || depthMode === 2 || passSplits ? 'store' : 'discard',
          ...(stencil ? { stencilLoadOp: depthLoad && depthKept ? 'load' : 'clear',
            stencilClearValue: clearStencil, stencilStoreOp: depthStore || depthMode === 2 || passSplits ? 'store' : 'discard' } : {}) } } : {}),
      });
      target.fresh = false;
      if (depth && depthMode === 2) depth.fresh = false; // mode 2 always stores
      resetPassState();
      break;
    }
    case 2: { // DRAW
      pipelineLength = 0;
      // vs fs cull topology blend[7] fragmentDisabled depthFunc depthWrite
      // stencilFront[4] stencilBack[4] stencilReadMask stencilWriteMask
      for (let i = 0; i < 24; ++i) pipelineWords[pipelineLength++] = word();
      const stencilRef = word();
      const streamCount = word();
      pipelineWords[pipelineLength++] = streamCount;
      for (let i = 0; i < streamCount; ++i) {
        pipelineWords[pipelineLength++] = word(); // stride
        streamOffsets[i] = word();
        streamSizes[i] = word();
      }
      const attributeCount = word();
      pipelineWords[pipelineLength++] = attributeCount;
      for (let i = 0; i < attributeCount * 5; ++i) pipelineWords[pipelineLength++] = word();
      const indexSize = word();
      pipelineWords[pipelineLength++] = indexSize;
      const indexCount = word(), indexOffset = word();
      const vx = floats[cursor++], vy = floats[cursor++], vw = floats[cursor++], vh = floats[cursor++];
      const sx = word(), sy = word(), sw = word(), sh = word();
      const vsInfo = word(), fsInfo = word(), vsUniforms = word(), vsUniformSize = word(),
        fsUniforms = word(), fsUniformSize = word();
      unitCounts[0] = unitCounts[1] = 0;
      for (let n = word(); n > 0; --n) {
        const stage = words[cursor] & 16 ? 1 : 0, at = unitCounts[stage]++ * 8;
        for (let i = 0; i < 8; ++i) unitWords[stage][at + i] = word();
      }
      if (!pass) throw new Error('draw outside a pass');
      // Programmable blending: a fragment program that reads the current
      // color samples a copy of the target taken here, so the pass ends,
      // the target is copied and the pass resumes with everything loaded.
      // Where the draw's own triangles overlap, it is drawn in parts, each
      // with a new copy: a later triangle blends over an earlier one.
      const readsColor = programs.get(pipelineWords[1])?.readsColor;
      const strip = pipelineWords[3] === 1;
      const parts = readsColor ? drawParts(data, indexOffset, indexSize, indexCount, streamOffsets) : 1;
      for (let part = 0; part < parts; ++part) {
      if (readsColor) {
        pass.end();
        if (!target.fragColor) {
          const texture = device.createTexture({ size: [target.gpuWidth, target.gpuHeight], format: target.gpuFormat,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
          target.fragColor = { texture, group: device.createBindGroup({ layout: layouts.fragColor,
            entries: [{ binding: 0, resource: texture.createView() }] }) };
        }
        encoder.copyTextureToTexture({ texture: target.texture }, { texture: target.fragColor.texture },
          [target.gpuWidth, target.gpuHeight]);
        const stencil = depth && depth.format === 'depth24plus-stencil8';
        pass = encoder.beginRenderPass({
          colorAttachments: [{ view: target.view, loadOp: 'load', storeOp: 'store' }],
          ...(depth ? { depthStencilAttachment: { view: depth.view, depthLoadOp: 'load', depthStoreOp: 'store',
            ...(stencil ? { stencilLoadOp: 'load', stencilStoreOp: 'store' } : {}) } } : {}),
        });
        resetPassState();
        ++stats.colorSnapshots;
      }
      const pipeline = cachedPipeline(target, depth);
      if (pipeline !== lastPipeline) { pass.setPipeline(pipeline); lastPipeline = pipeline; }
      else ++stats.stateSkips;
      dynamicOffsets[0] = vsInfo; dynamicOffsets[1] = fsInfo; dynamicOffsets[2] = vsUniforms; dynamicOffsets[3] = fsUniforms;
      setGroupDyn(bufferGroupFor(vsUniformSize, fsUniformSize));
      setGroup(1, readsColor ? target.fragColor.group : emptyGroup());
      setGroup(2, textureGroupFor(1));
      setGroup(3, textureGroupFor(0));
      for (let i = 0; i < streamCount; ++i) {
        if (lastVB[i] !== streamOffsets[i] || lastVBSize[i] !== streamSizes[i]) {
          pass.setVertexBuffer(i, sceneBuffer, streamOffsets[i], streamSizes[i]);
          lastVB[i] = streamOffsets[i]; lastVBSize[i] = streamSizes[i];
        } else ++stats.stateSkips;
      }
      const indexFormat = indexSize === 2 ? 'uint16' : 'uint32';
      const indexBytes = indexCount * indexSize;
      if (lastIndexFormat !== indexFormat || lastIndexOffset !== indexOffset || lastIndexBytes !== indexBytes) {
        pass.setIndexBuffer(sceneBuffer, indexFormat, indexOffset, indexBytes);
        lastIndexFormat = indexFormat; lastIndexOffset = indexOffset; lastIndexBytes = indexBytes;
      } else ++stats.stateSkips;
      const scale = target.renderScale; // viewport and scissor are render pixels
      const vpx = vx * scale, vpy = vy * scale, vpw = Math.max(vw, 0) * scale, vph = Math.max(vh, 0) * scale;
      if (lastViewport[0] !== vpx || lastViewport[1] !== vpy || lastViewport[2] !== vpw || lastViewport[3] !== vph) {
        pass.setViewport(vpx, vpy, vpw, vph, 0, 1);
        lastViewport[0] = vpx; lastViewport[1] = vpy; lastViewport[2] = vpw; lastViewport[3] = vph;
      } else ++stats.stateSkips;
      const scx = sx * scale, scy = sy * scale, scw = sw * scale, sch = sh * scale;
      if (lastScissor[0] !== scx || lastScissor[1] !== scy || lastScissor[2] !== scw || lastScissor[3] !== sch) {
        pass.setScissorRect(scx, scy, scw, sch);
        lastScissor[0] = scx; lastScissor[1] = scy; lastScissor[2] = scw; lastScissor[3] = sch;
      } else ++stats.stateSkips;
      if (lastStencil !== stencilRef) { pass.setStencilReference(stencilRef); lastStencil = stencilRef; }
      else ++stats.stateSkips;
      if (parts === 1) pass.drawIndexed(indexCount);
      else {
        const first = partStarts[part], end = partStarts[part + 1];
        if (strip) pass.drawIndexed(end - first + 2, 1, first);
        else pass.drawIndexed((end - first) * 3, 1, first * 3);
      }
      }
      if (parts > 1) stats.drawParts += parts;
      ++stats.draws;
      break;
    }
    case 3: { // TEXTURE: id, width, height, levels (bit 16: RGBA float16 texels), then per level offset,size
      const id = word(), width = word(), height = word(), levelsWord = word();
      const levels = levelsWord & 0xffff;
      const format = levelsWord & 0x10000 ? 'rgba16float' : 'rgba8unorm';
      const texelBytes = format === 'rgba16float' ? 8 : 4;
      let entry = textures.get(id);
      if (!entry || entry.width !== width || entry.height !== height || entry.levels !== levels || entry.format !== format) {
        entry?.texture.destroy();
        const texture = device.createTexture({ size: [width, height], format, mipLevelCount: levels,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        entry = { texture, view: texture.createView(), width, height, levels, format };
        textures.set(id, entry);
        // Texture groups referencing a destroyed texture must be rebuilt.
        textureGroups.clear();
      }
      for (let level = 0; level < levels; ++level) {
        const offset = word(), size = word();
        const w = Math.max(1, width >> level), h = Math.max(1, height >> level);
        device.queue.writeTexture({ texture: entry.texture, mipLevel: level },
          data.subarray(offset, offset + size), { bytesPerRow: w * texelBytes }, [w, h]);
      }
      ++stats.textureUploads;
      break;
    }
    case 6: // REGION: id, target address, x, y, width, height (outside any pass)
    case 8: { // REGION_OPAQUE: the same, with alpha read as 1 (a 1BGR texture over RGBA8)
      const opaque = command === 8;
      const id = word(), address = word(), x = word(), y = word(), width = word(), height = word();
      const source = targets.get(address);
      if (!source) { warnOnce('region of a render target that was never rendered'); break; }
      const scale = source.renderScale;
      const w = width * scale, h = height * scale;
      let entry = textures.get(id);
      if (!entry || entry.width !== w || entry.height !== h || entry.format !== source.gpuFormat) {
        entry?.texture.destroy();
        const texture = device.createTexture({ size: [w, h], format: source.gpuFormat,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
        entry = { texture, view: texture.createView(), width: w, height: h, levels: 1, format: source.gpuFormat };
        textures.set(id, entry);
        textureGroups.clear();
      }
      // A texture larger than the target (same pitch) keeps its texels past
      // the surface undefined: copy the part inside it.
      const cw = Math.min(width, source.width - x) * scale, ch = Math.min(height, source.height - y) * scale;
      if (cw > 0 && ch > 0)
        encoder.copyTextureToTexture({ texture: sampled(source).texture, origin: { x: x * scale, y: y * scale } },
          { texture: entry.texture }, [cw, ch]);
      if (opaque) forceOpaque(encoder, entry);
      break;
    }
    case 4: // END_PASS
      pass.end(); pass = null;
      if (target.resolved) resolveTarget(encoder, target);
      break;
    case 7: { // WRITE_TEXELS: address, x, y, width, height, data offset, mask offset
      // Guest texels of a rendered target that a transfer wrote, in the
      // target's texel format, row by row; the mask (one byte per texel,
      // 0xffffffff = none) selects the texels to replace.
      const address = word(), x = word(), y = word(), width = word(), height = word();
      const dataOffset = word(), maskOffset = word();
      const written = targets.get(address);
      if (written) writeTexels(encoder, written, x, y, width, height, data, dataOffset, maskOffset);
      break;
    }
    default:
      throw new Error(`unknown GXM scene command ${command}`);
    }
  }
  if (pass) pass.end();
  gpuQueue.submit([encoder.finish()]);
  for (const buffer of stagingBuffers.splice(0)) buffer.destroy();
  for (const texture of transientTextures.splice(0)) texture.destroy();
  ++stats.scenes;
}

export function hasTarget(address) { return targets.has(address); }

// Sets a texture's alpha to 1 and keeps its color (REGION_OPAQUE): one draw
// whose pipeline writes only the alpha channel.
const opaquePipelines = new Map();
function forceOpaque(encoder, entry) {
  let pipeline = opaquePipelines.get(entry.format);
  if (!pipeline) {
    const module = device.createShaderModule({ code: `
      @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
        let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
        return vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
      }
      @fragment fn fs() -> @location(0) vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }` });
    pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: entry.format, writeMask: GPUColorWrite.ALPHA }] },
      primitive: { topology: 'triangle-list' } });
    opaquePipelines.set(entry.format, pipeline);
  }
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: entry.view, loadOp: 'load', storeOp: 'store' }] });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
}
function blit(encoder, target, viewTarget, format) {
  if (!blitPipeline || blitPipeline.format !== format) {
    const module = device.createShaderModule({ code: `
      @group(0) @binding(0) var image: texture_2d<f32>;
      @group(0) @binding(1) var linearSampler: sampler;
      struct Out { @builtin(position) position: vec4f, @location(0) uv: vec2f };
      @vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
        let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
        return Out(vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0), uv);
      }
      @fragment fn fs(input: Out) -> @location(0) vec4f {
        return vec4f(textureSample(image, linearSampler, input.uv).rgb, 1.0);
      }` });
    blitPipeline = device.createRenderPipeline({ layout: 'auto',
      vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' } });
    blitPipeline.format = format;
    blitSampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  }
  // One group per target and blit pipeline, not one per presented frame.
  if (target.blitGroup?.pipeline !== blitPipeline)
    target.blitGroup = { pipeline: blitPipeline, group: device.createBindGroup({ layout: blitPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: target.view }, { binding: 1, resource: blitSampler }] }) };
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: viewTarget, loadOp: 'clear', storeOp: 'store' }] });
  pass.setPipeline(blitPipeline);
  pass.setBindGroup(0, target.blitGroup.group);
  pass.draw(3);
  pass.end();
}

// Present the render target at `address`. Returns false when no GPU target
// exists there (the caller then presents guest memory instead), or null when
// busy (the caller waits and retries WITHOUT falling back to stale CPU pixels).
// `onFrame(generation, width, height, pixels|null)` receives every presented
// frame; pixels are read back only every `readbackEvery` frames.
export function presentTarget(address, onFrame, readbackEvery) {
  const target = targets.get(address);
  if (!target) return false;
  const generation = presentGeneration + 1;
  const readback = readbackEvery > 0 && generation % readbackEvery === 1 % readbackEvery;
  if (!capacityFor('present')) return null;
  // Shown at its render scale: a downscaled surface's double-size render is
  // filtered to it (the linear blit samples each 2x2 block at its center).
  const width = target.width * target.renderScale, height = target.height * target.renderScale;
  let copy, buffer, bytesPerRow;
  try {
    // Canvas blit, optional RGBA conversion and copy share one submission.
    const encoder = canvasContext || readback ? device.createCommandEncoder() : null;
    if (canvasContext) {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width; canvas.height = height;
      }
      blit(encoder, target, canvasContext.getCurrentTexture().createView(), canvasFormat);
    }
    if (readback) {
      copy = device.createTexture({ size: [width, height], format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      blit(encoder, target, copy.createView(), 'rgba8unorm');
      bytesPerRow = Math.ceil(width * 4 / 256) * 256;
      buffer = device.createBuffer({ size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      encoder.copyTextureToBuffer({ texture: copy }, { buffer, bytesPerRow }, [width, height]);
    }
    if (encoder) gpuQueue.submit([encoder.finish()]);
  } catch (error) {
    buffer?.destroy(); copy?.destroy();
    ++stats.presentFailures;
    record('present-failed', String(error?.message ?? error));
    throw error;
  }
  presentGeneration = generation;
  ++stats.presents;
  record('present', `${width}x${height}`);
  if (readback) {
    buffer.mapAsync(GPUMapMode.READ).then(() => {
      const mapped = new Uint8Array(buffer.getMappedRange());
      const pixels = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; ++y)
        pixels.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
      buffer.destroy(); copy.destroy();
      onFrame(generation, width, height, pixels);
    }, error => {
      buffer.destroy(); copy.destroy();
      warnOnce(`frame readback failed: ${error}`);
    });
  } else {
    onFrame(generation, width, height, null);
  }
  return true;
}

// Surface sync (producer: VITA3K_SURFACE_SYNC=1). The target's texels already
// have the guest's texel bytes (see colorFormats), so a scaled target (and a
// downscaled surface's double-size render) is only box-filtered back to its
// guest size, in its own format. `write(mapped, bytesPerRow)` receives the
// rows while the copy is mapped; the producer stores them in the surface's
// memory layout.
const downscalePipelines = new Map(); // `${format}:${scale}` -> pipeline
const readbackBuffers = new Map();    // size -> idle MAP_READ buffer
function downscalePipeline(format, scale) {
  const key = `${format}:${scale}`;
  let pipeline = downscalePipelines.get(key);
  if (!pipeline) {
    const module = device.createShaderModule({ code: `
      @group(0) @binding(0) var image: texture_2d<f32>;
      @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
        let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
        return vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
      }
      @fragment fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
        let base = vec2u(position.xy) * ${scale}u;
        var sum = vec4f(0.0);
        for (var y = 0u; y < ${scale}u; y++) {
          for (var x = 0u; x < ${scale}u; x++) { sum += textureLoad(image, base + vec2u(x, y), 0); }
        }
        return sum / ${scale * scale}.0;
      }` });
    pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] }, primitive: { topology: 'triangle-list' } });
    downscalePipelines.set(key, pipeline);
  }
  return pipeline;
}
export async function readTarget(address, width, height, pixelBytes, write) {
  // This entry already suspends through Asyncify for mapAsync. Acquire before
  // creating resources or issuing any queue work, just like scene/present.
  await waitForCapacity();
  const target = targets.get(address);
  if (!target || target.width !== width || target.height !== height)
    throw new Error(`no ${width}x${height} render target at ${address.toString(16)}`);
  if (texelBytes[target.gpuFormat] !== pixelBytes)
    throw new Error(`${target.gpuFormat} target read back as ${pixelBytes}-byte guest pixels`);
  const encoder = device.createCommandEncoder();
  let source = target.texture;
  if (target.scale !== 1) {
    target.guestCopy ??= device.createTexture({ size: [width, height], format: target.gpuFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    source = target.guestCopy;
    const pipeline = downscalePipeline(target.gpuFormat, target.scale);
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: source.createView(), loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: target.view }] }));
    pass.draw(3);
    pass.end();
  }
  const bytesPerRow = Math.ceil(width * pixelBytes / 256) * 256;
  const size = bytesPerRow * height;
  const buffer = readbackBuffers.get(size) ?? device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  readbackBuffers.delete(size);
  encoder.copyTextureToBuffer({ texture: source }, { buffer, bytesPerRow }, [width, height]);
  gpuQueue.submit([encoder.finish()]);
  try {
    await buffer.mapAsync(GPUMapMode.READ);
    write(new Uint8Array(buffer.getMappedRange()), bytesPerRow);
    buffer.unmap();
    readbackBuffers.set(size, buffer);
  } catch (error) {
    buffer.destroy();
    throw error;
  }
  ++stats.surfaceSyncs;
}

export function sceneStats() {
  return { ...stats, device: deviceState, ...gpuQueue?.snapshot(),
    lostReason: deviceLostInfo?.reason ?? null,
    targets: targets.size, textures: textures.size, pipelines: pipelines.size };
}
