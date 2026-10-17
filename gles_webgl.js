// SPDX-License-Identifier: GPL-2.0-or-later
// PVR PSP2 EGL/GLES2 user-library HLE. This is a real WebGL renderer, not an
// implementation (or a success stub) of PVRSRV/SGX kernel command submission.
export function createGlesBridge({ memory, logger = console.log, onFrame = () => {} }) {
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const api = Object.create(null), strings = new Map(), reverse = new WeakMap();
  const objects = Object.fromEntries(['Buffer', 'Texture', 'Framebuffer', 'Renderbuffer', 'Shader', 'Program', 'VertexArray']
    .map(type => [type, new Map()]));
  const locations = new Map(), locationNames = new Map(), extensions = new Map();
  const bufferContents = new WeakMap(), vertexStates = new Map([[0, new Map()]]), clientUploads = new Map();
  let currentVao = 0, indexUpload = null;
  const vertexState = () => vertexStates.get(currentVao);
  let canvas = null, attached = false, gl = null, nextObject = 1, nextLocation = 1;
  let initialized = false, context = 0, current = 0, drawSurface = 0, readSurface = 0;
  let nextSurface = 2, eglError = 0x3000, localGlError = 0, generation = 0, interval = 1, lastSwap = 0;
  const surfaces = new Map();
  const badEgl = code => { eglError = code; return 0; };
  class GlError extends Error { constructor(code) { super('GLES error'); this.code = code; } }
  const invalid = (code = 0x0501) => { throw new GlError(code); };
  const length = (n, size = 1) => {
    const result = n * size;
    if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(result) || result > 128 * 1024 * 1024) invalid();
    return result;
  };
  const bytes = (address, size) => size ? memory.read(address >>> 0, size) : new Uint8Array();
  const typed = (Type, address, count) => {
    const data = bytes(address, length(count, Type.BYTES_PER_ELEMENT));
    return new Type(data.buffer, data.byteOffset, data.byteLength / Type.BYTES_PER_ELEMENT);
  };
  const store = (address, values, Type = Int32Array) => {
    if (!address) throw new RangeError('null GLES output pointer');
    const data = Type.from(Array.isArray(values) || ArrayBuffer.isView(values) ? values : [values]);
    memory.write(address >>> 0, new Uint8Array(data.buffer));
  };
  function cstring(address, limit = 1024 * 1024) {
    if (!address) throw new RangeError('null GLES string pointer');
    const parts = [];
    let size = 0;
    while (size < limit) {
      // Do not read across a guest page merely to search for a terminator.
      const count = Math.min(64, limit - size, 4096 - ((address + size) & 4095));
      const part = bytes(address + size, count), end = part.indexOf(0);
      if (end >= 0) { parts.push(part.subarray(0, end)); size += end; break; }
      parts.push(part); size += count;
    }
    if (size >= limit) throw new RangeError('unterminated GLES string');
    const text = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { text.set(part, offset); offset += part.length; }
    return decoder.decode(text);
  }
  const string = text => {
    text = String(text ?? '');
    if (!strings.has(text)) {
      const data = encoder.encode(text + '\0'), address = memory.alloc(data.length);
      memory.write(address, data); strings.set(text, address);
    }
    return strings.get(text);
  };
  const outString = (text, capacity, outLength, dest) => {
    capacity |= 0;
    if (capacity < 0) invalid();
    const data = encoder.encode(text || ''), copied = Math.min(data.length, Math.max(0, capacity - 1));
    if (capacity) {
      const out = new Uint8Array(copied + 1); out.set(data.subarray(0, copied));
      memory.write(dest >>> 0, out);
    }
    if (outLength) store(outLength, copied);
  };
  const object = (type, id, allowZero = false) => {
    if (!id && allowZero) return null;
    const value = objects[type].get(id >>> 0);
    if (!value) invalid(0x0501);
    return value;
  };
  const idOf = value => value && typeof value === 'object' && !ArrayBuffer.isView(value)
    ? (reverse.get(value) || 0) : value;
  const create = (type, value, explicit) => {
    if (!value) return 0;
    const id = explicit ?? nextObject++;
    nextObject = Math.max(nextObject, id + 1);
    objects[type].set(id, value); reverse.set(value, id);
    return id;
  };
  const binding = (type, id) => {
    if (!id) return null;
    if (!objects[type].has(id)) create(type, gl['create' + type](), id);
    return object(type, id);
  };
  const requireGL = () => {
    if (!gl || !current) throw new Error('GLES command without a current EGL context');
    if (gl.isContextLost()) throw new Error('WebGL graphics context lost; Stop and Play to recover');
  };
  const attrs = address => {
    const result = new Map();
    if (address) for (let i = 0; i < 128; ++i) {
      const key = typed(Int32Array, address + i * 8, 1)[0];
      if (key === 0x3038) return result;
      result.set(key, typed(Int32Array, address + i * 8 + 4, 1)[0]);
    }
    if (address) throw new RangeError('unterminated EGL attribute list');
    return result;
  };
  const validDisplay = dpy => dpy === 1 && initialized;
  const config = new Map([
    [0x3020, 32], [0x3021, 8], [0x3022, 8], [0x3023, 8], [0x3024, 8], [0x3025, 24], [0x3026, 8],
    [0x3027, 0x3038], [0x3028, 1], [0x3029, 0], [0x302A, 4096], [0x302B, 16777216], [0x302C, 4096],
    [0x302D, 0], [0x302E, 0], [0x302F, 0], [0x3031, 0], [0x3032, 0], [0x3033, 5], [0x3034, 0x3038],
    [0x3035, 0], [0x3036, 0], [0x3037, 0], [0x3039, 0], [0x303A, 0], [0x303B, 0], [0x303C, 1],
    [0x303D, 0], [0x303E, 0], [0x303F, 0x308E], [0x3040, 4], [0x3042, 4],
  ]);
  const extensionCandidates = ['OES_element_index_uint', 'OES_standard_derivatives', 'OES_texture_float',
    'OES_texture_float_linear', 'OES_texture_half_float', 'OES_texture_half_float_linear',
    'OES_vertex_array_object', 'EXT_texture_filter_anisotropic', 'EXT_blend_minmax',
    'EXT_shader_texture_lod', 'WEBGL_depth_texture'];
  const extensionString = () => [...extensions.keys()].map(name => name === 'WEBGL_depth_texture'
    ? 'GL_OES_depth_texture' : 'GL_' + name).concat('GL_OES_packed_depth_stencil').join(' ');
  function createContext() {
    canvas ??= new OffscreenCanvas(960, 544);
    if (!gl) {
      gl = canvas.getContext('webgl', { alpha: true, depth: true, stencil: true, antialias: false,
        premultipliedAlpha: false, preserveDrawingBuffer: true });
      if (!gl) throw new Error('WebGL 1 is unavailable for the GLES2 adapter');
      for (const name of extensionCandidates) {
        const extension = gl.getExtension(name);
        if (extension) extensions.set(name, extension);
      }
      logger('[gles-webgl] OpenGL ES 2.0 via ' + gl.getParameter(gl.RENDERER));
    }
  }
  api.eglGetDisplay = native => native === 0 ? 1 : badEgl(0x300C);
  api.eglInitialize = (dpy, major, minor) => {
    if (dpy !== 1) return badEgl(0x3008);
    initialized = true;
    if (major) store(major, 1); if (minor) store(minor, 4);
    return 1;
  };
  api.eglGetError = () => { const error = eglError; eglError = 0x3000; return error; };
  api.eglBindAPI = value => value === 0x30A0 ? 1 : badEgl(0x300C);
  api.eglQueryAPI = () => 0x30A0;
  api.eglQueryString = (dpy, name) => {
    if (!validDisplay(dpy)) return badEgl(0x3008);
    const value = { 0x3053: 'Vita3K WebGL', 0x3054: '1.4 Vita3K', 0x3055: '', 0x308D: 'OpenGL_ES' }[name];
    return value === undefined ? badEgl(0x300C) : string(value);
  };
  api.eglGetConfigs = (dpy, dest, capacity, count) => api.eglChooseConfig(dpy, 0, dest, capacity, count);
  api.eglChooseConfig = (dpy, list, dest, capacity, count) => {
    if (!validDisplay(dpy)) return badEgl(0x3008);
    if (!count || (capacity | 0) < 0) return badEgl(0x300C);
    let matches = true;
    for (const [key, value] of attrs(list)) {
      if (!config.has(key)) return badEgl(0x3004);
      if (value === -1) continue; // EGL_DONT_CARE
      if ([0x3033, 0x3040, 0x3042].includes(key)) matches &&= (config.get(key) & value) === value;
      else if ([0x3020, 0x3021, 0x3022, 0x3023, 0x3024, 0x3025, 0x3026, 0x3031, 0x3032].includes(key))
        matches &&= config.get(key) >= value;
      else matches &&= config.get(key) === value;
    }
    const returned = matches && (!dest || capacity > 0) ? 1 : 0;
    if (dest && returned) store(dest, 1);
    store(count, returned); return 1;
  };
  api.eglGetConfigAttrib = (dpy, id, key, dest) => {
    if (!validDisplay(dpy)) return badEgl(0x3008);
    if (id !== 1) return badEgl(0x3005);
    if (!config.has(key)) return badEgl(0x3004);
    store(dest, config.get(key)); return 1;
  };
  function surface(dpy, id, width, height) {
    if (!validDisplay(dpy)) return badEgl(0x3008);
    if (id !== 1) return badEgl(0x3005);
    if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return badEgl(0x300C);
    const handle = nextSurface++;
    surfaces.set(handle, { width, height }); return handle;
  }
  api.eglCreateWindowSurface = (dpy, id, native, list) => {
    attrs(list);
    if (!native) return badEgl(0x300B);
    const [type, size] = typed(Uint32Array, native, 2);
    const dimensions = [[960, 544], [480, 272], [640, 368], [720, 408], [1280, 725], [1920, 1088]][size];
    if (type !== 1 || !dimensions) return badEgl(0x300B);
    return surface(dpy, id, ...dimensions);
  };
  api.eglCreatePbufferSurface = (dpy, id, list) => {
    const values = attrs(list);
    return surface(dpy, id, values.get(0x3057) ?? 1, values.get(0x3056) ?? 1);
  };
  api.eglCreateContext = (dpy, id, share, list) => {
    if (!validDisplay(dpy)) return badEgl(0x3008);
    if (id !== 1) return badEgl(0x3005);
    const values = attrs(list);
    if ((values.get(0x3098) ?? 1) !== 2 || share) return badEgl(0x3009);
    if (context) return badEgl(0x3002); // one context, no misleading sharing support
    createContext(); context = 1; return context;
  };
  api.eglMakeCurrent = (dpy, draw, read, ctx) => {
    if (!validDisplay(dpy)) return badEgl(0x3008);
    if (!ctx && !draw && !read) { current = drawSurface = readSurface = 0; return 1; }
    if (!ctx || ctx !== context) return badEgl(0x3006);
    if (!surfaces.has(draw) || !surfaces.has(read)) return badEgl(0x300D);
    if (draw !== read) return badEgl(0x3009);
    const { width, height } = surfaces.get(draw);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; gl.viewport(0, 0, width, height); }
    current = ctx; drawSurface = draw; readSurface = read; return 1;
  };
  api.eglGetCurrentContext = () => current;
  api.eglGetCurrentDisplay = () => current ? 1 : 0;
  api.eglGetCurrentSurface = which => which === 0x3059 ? drawSurface : which === 0x305A ? readSurface : badEgl(0x300C);
  api.eglQuerySurface = (dpy, id, key, dest) => {
    if (!validDisplay(dpy)) return badEgl(0x3008);
    const s = surfaces.get(id); if (!s) return badEgl(0x300D);
    const value = { 0x3057: s.width, 0x3056: s.height, 0x3028: 1, 0x3093: 0x3095, 0x3086: 0x3084 }[key];
    if (value === undefined) return badEgl(0x3004);
    store(dest, value); return 1;
  };
  api.eglQueryContext = (dpy, id, key, dest) => {
    if (!validDisplay(dpy)) return badEgl(0x3008);
    if (!id || id !== context) return badEgl(0x3006);
    const value = { 0x3028: 1, 0x3098: 2, 0x3097: 0x30A0, 0x3086: 0x3084 }[key];
    if (value === undefined) return badEgl(0x3004);
    store(dest, value); return 1;
  };
  api.eglSwapInterval = (dpy, value) => {
    if (!validDisplay(dpy)) return badEgl(0x3008);
    interval = Math.min(1, Math.max(0, value | 0)); return 1;
  };
  api.eglDestroySurface = (dpy, id) => {
    if (!validDisplay(dpy)) return badEgl(0x3008);
    if (!surfaces.delete(id)) return badEgl(0x300D);
    if (drawSurface === id) drawSurface = 0; if (readSurface === id) readSurface = 0;
    return 1;
  };
  api.eglDestroyContext = (dpy, id) => {
    if (!validDisplay(dpy)) return badEgl(0x3008);
    if (!context || id !== context) return badEgl(0x3006);
    current = context = 0; return 1;
  };
  api.eglTerminate = dpy => {
    if (dpy !== 1) return badEgl(0x3008);
    initialized = false; current = context = drawSurface = readSurface = 0; surfaces.clear(); return 1;
  };
  api.eglReleaseThread = () => { current = drawSurface = readSurface = 0; return 1; };
  api.eglWaitGL = api.eglWaitClient = () => { if (gl) gl.finish(); return 1; };
  api.eglWaitNative = engine => engine === 0x305B ? 1 : badEgl(0x300C);

  // Scalar-only core calls. Integer sign matters for offsets, sizes and refs;
  // small enum/bitfield values retain the same bits after |0.
  const scalar = (name, method, signed = []) => { api[name] = (...args) => {
    for (const index of signed) args[index] |= 0;
    return gl[method](...args);
  }; };
  const simple = ['ActiveTexture', 'BlendColor', 'BlendEquation', 'BlendEquationSeparate', 'BlendFunc',
    'BlendFuncSeparate', 'Clear', 'ColorMask', 'CullFace', 'DepthFunc', 'DepthMask', 'Disable',
    'DisableVertexAttribArray', 'Enable', 'EnableVertexAttribArray', 'Finish', 'Flush', 'FrontFace',
    'GenerateMipmap', 'Hint', 'LineWidth', 'PolygonOffset', 'SampleCoverage', 'StencilMask', 'StencilMaskSeparate'];
  for (const suffix of simple) scalar('gl' + suffix, suffix[0].toLowerCase() + suffix.slice(1));
  scalar('glClearColor', 'clearColor'); scalar('glClearDepthf', 'clearDepth'); scalar('glDepthRangef', 'depthRange');
  scalar('glClearStencil', 'clearStencil', [0]); scalar('glScissor', 'scissor', [0, 1, 2, 3]);
  scalar('glViewport', 'viewport', [0, 1, 2, 3]); scalar('glStencilFunc', 'stencilFunc', [1]);
  scalar('glStencilFuncSeparate', 'stencilFuncSeparate', [2]);
  scalar('glStencilOp', 'stencilOp'); scalar('glStencilOpSeparate', 'stencilOpSeparate');
  scalar('glPixelStorei', 'pixelStorei', [1]);
  scalar('glCopyTexImage2D', 'copyTexImage2D', [1, 3, 4, 5, 6, 7]);
  scalar('glCopyTexSubImage2D', 'copyTexSubImage2D', [1, 2, 3, 4, 5, 6, 7]);
  api.glCheckFramebufferStatus = target => gl.checkFramebufferStatus(target);
  api.glGetError = () => { const error = localGlError; localGlError = 0; return error || gl.getError(); };
  api.glIsEnabled = cap => +gl.isEnabled(cap);
  for (const type of ['Buffer', 'Texture', 'Framebuffer', 'Renderbuffer']) {
    api['glGen' + type + 's'] = (count, dest) => {
      const ids = Array.from({ length: length(count) }, () => create(type, gl['create' + type]()));
      if (ids.length) store(dest, ids, Uint32Array);
    };
    api['glDelete' + type + 's'] = (count, src) => {
      for (const id of typed(Uint32Array, src, count)) {
        const value = objects[type].get(id);
        if (value) { gl['delete' + type](value); objects[type].delete(id); }
      }
    };
    api['glBind' + type] = (target, id) => gl['bind' + type](target, binding(type, id));
    api['glIs' + type] = id => objects[type].has(id) ? +gl['is' + type](objects[type].get(id)) : 0;
  }
  const boundBuffer = target => gl.getParameter(target === gl.ARRAY_BUFFER ? gl.ARRAY_BUFFER_BINDING : gl.ELEMENT_ARRAY_BUFFER_BINDING);
  api.glBufferData = (target, size, data, usage) => {
    const sizeBytes = length(size), copy = data ? bytes(data, sizeBytes) : new Uint8Array(sizeBytes);
    gl.bufferData(target, data ? copy : sizeBytes, usage);
    const buffer = boundBuffer(target);
    if (buffer) bufferContents.set(buffer, copy);
  };
  api.glBufferSubData = (target, offset, size, data) => {
    const begin = length(offset), copy = bytes(data, length(size));
    gl.bufferSubData(target, begin, copy);
    const shadow = bufferContents.get(boundBuffer(target));
    if (shadow && begin + copy.length <= shadow.length) shadow.set(copy, begin);
  };
  api.glFramebufferTexture2D = (target, attachment, textarget, texture, level) =>
    gl.framebufferTexture2D(target, attachment, textarget, object('Texture', texture, true), level | 0);
  api.glFramebufferRenderbuffer = (target, attachment, rtarget, renderbuffer) =>
    gl.framebufferRenderbuffer(target, attachment, rtarget, object('Renderbuffer', renderbuffer, true));
  api.glRenderbufferStorage = (target, format, width, height) =>
    gl.renderbufferStorage(target, format === 0x88F0 ? gl.DEPTH_STENCIL : format, width | 0, height | 0);
  function pixels(format, type, width, height, address, pack = false) {
    width = length(width); height = length(height);
    const components = { 0x1906: 1, 0x1909: 1, 0x190A: 2, 0x1907: 3, 0x1908: 4, 0x1902: 1, 0x84F9: 1 }[format];
    const Type = { 0x1401: Uint8Array, 0x1403: Uint16Array, 0x1405: Uint32Array, 0x1406: Float32Array,
      0x8D61: Uint16Array, 0x8033: Uint16Array, 0x8034: Uint16Array, 0x8363: Uint16Array, 0x84FA: Uint32Array }[type];
    if (!components || !Type) invalid(0x0500);
    const packed = [0x8033, 0x8034, 0x8363, 0x84FA].includes(type);
    const row = width * Type.BYTES_PER_ELEMENT * (packed ? 1 : components);
    const alignment = gl.getParameter(pack ? gl.PACK_ALIGNMENT : gl.UNPACK_ALIGNMENT);
    const size = height && width ? Math.ceil(row / alignment) * alignment * (height - 1) + row : 0;
    length(size);
    const data = bytes(address, size);
    return new Type(data.buffer, data.byteOffset, size / Type.BYTES_PER_ELEMENT);
  }
  api.glTexImage2D = (target, level, internal, width, height, border, format, type, data) => {
    const view = data ? pixels(format, type, width, height, data) : null;
    gl.texImage2D(target, level | 0, internal, width | 0, height | 0, border | 0, format, type, view);
  };
  api.glTexSubImage2D = (target, level, x, y, width, height, format, type, data) =>
    gl.texSubImage2D(target, level | 0, x | 0, y | 0, width | 0, height | 0, format, type, pixels(format, type, width, height, data));
  api.glCompressedTexImage2D = (target, level, format, width, height, border, size, data) =>
    gl.compressedTexImage2D(target, level | 0, format, width | 0, height | 0, border | 0, bytes(data, length(size)));
  api.glCompressedTexSubImage2D = (target, level, x, y, width, height, format, size, data) =>
    gl.compressedTexSubImage2D(target, level | 0, x | 0, y | 0, width | 0, height | 0, format, bytes(data, length(size)));
  api.glReadPixels = (x, y, width, height, format, type, dest) => {
    const view = pixels(format, type, width, height, dest, true);
    gl.readPixels(x | 0, y | 0, width | 0, height | 0, format, type, view);
    if (view.byteLength) memory.write(dest, new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  };
  api.glTexParameterf = (target, pname, value) => gl.texParameterf(target, pname, value);
  api.glTexParameteri = (target, pname, value) => gl.texParameteri(target, pname, value | 0);
  api.glTexParameterfv = (target, pname, ptr) => gl.texParameterf(target, pname, typed(Float32Array, ptr, 1)[0]);
  api.glTexParameteriv = (target, pname, ptr) => gl.texParameteri(target, pname, typed(Int32Array, ptr, 1)[0]);

  api.glCreateShader = type => create('Shader', gl.createShader(type));
  api.glCreateProgram = () => create('Program', gl.createProgram());
  for (const type of ['Shader', 'Program']) {
    api['glDelete' + type] = id => {
      if (!id) return;
      gl['delete' + type](object(type, id)); objects[type].delete(id);
    };
    api['glIs' + type] = id => objects[type].has(id) ? +gl['is' + type](objects[type].get(id)) : 0;
  }
  api.glAttachShader = (p, s) => gl.attachShader(object('Program', p), object('Shader', s));
  api.glDetachShader = (p, s) => gl.detachShader(object('Program', p), object('Shader', s));
  api.glBindAttribLocation = (p, index, name) => gl.bindAttribLocation(object('Program', p), index, cstring(name));
  api.glGetAttribLocation = (p, name) => gl.getAttribLocation(object('Program', p), cstring(name));
  const shaderSources = new WeakMap();
  const precisionHighp = source => {
    // GLSL ES 1.00: raise the default float precision of a fragment shader.
    // Replaces an existing default declaration (not per-declaration
    // qualifiers), or inserts one before the first non-preprocessor line.
    // Returns null when the source already defaults to highp float.
    const lines = source.split('\n');
    const declaration = /^[ \t]*precision[ \t]+\w+[ \t]+float[ \t]*;/;
    for (let i = 0; i < lines.length; ++i) {
      if (declaration.test(lines[i])) {
        if (/precision[ \t]+highp[ \t]+float/.test(lines[i])) return null;
        lines[i] = lines[i].replace(/precision[ \t]+\w+[ \t]+float/, 'precision highp float');
        return lines.join('\n');
      }
    }
    for (let i = 0; i < lines.length; ++i) {
      if (lines[i] && !lines[i].startsWith('#')) {
        lines.splice(i, 0, 'precision highp float;');
        return lines.join('\n');
      }
    }
    return null;
  };
  api.glShaderSource = (shader, count, pointers, lengths) => {
    if (length(count) > 1024) invalid();
    const ps = typed(Uint32Array, pointers, count), sizes = lengths ? typed(Int32Array, lengths, count) : null;
    const source = Array.from(ps, (p, i) => sizes && sizes[i] >= 0 ? decoder.decode(bytes(p, length(sizes[i]))) : cstring(p)).join('');
    gl.shaderSource(object('Shader', shader), source);
    shaderSources.set(object('Shader', shader), source);
  };
  api.glCompileShader = shader => {
    const s = object('Shader', shader); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      logger('[gles-webgl] shader compile: ' + (gl.getShaderInfoLog(s) || '').slice(0, 4000));
  };
  api.glLinkProgram = program => {
    const p = object('Program', program); gl.linkProgram(p);
    for (const [id, value] of locations) if (value.program === program) locations.delete(id);
    locationNames.delete(program);
    if (gl.getProgramParameter(p, gl.LINK_STATUS)) return;
    // Real GLES2 drivers (SGX 543MP on the Vita, among others) do not enforce
    // the GLSL ES 1.00 cross-stage uniform precision match that ANGLE's
    // validator does. Guest games ship vertex shaders with highp-default
    // uniforms that the fragment stage sees as mediump ('Uniform dissolve is
    // not linkable between attached shaders' in Balatro). Match the hardware
    // behaviour: retry once with the fragment shader's default float precision
    // raised to highp. If the fragment stage cannot, this is a genuine error.
    const log = (gl.getProgramInfoLog(p) || '');
    if (!/precisions? of uniform/i.test(log) && !/not linkable/i.test(log)) {
      logger('[gles-webgl] program link: ' + log.slice(0, 4000));
      return;
    }
    const fragment = gl.getAttachedShaders(p).find(s => gl.getShaderParameter(s, gl.SHADER_TYPE) === gl.FRAGMENT_SHADER);
    const source = fragment && shaderSources.get(fragment);
    if (!fragment || source === undefined) {
      logger('[gles-webgl] program link: ' + log.slice(0, 4000));
      return;
    }
    const highpAvailable = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT).precision > 0;
    const upgraded = highpAvailable ? precisionHighp(source) : null;
    if (upgraded === null) {
      logger('[gles-webgl] program link: ' + log.slice(0, 4000));
      return;
    }
    gl.shaderSource(fragment, upgraded);
    shaderSources.set(fragment, upgraded);
    gl.compileShader(fragment);
    if (!gl.getShaderParameter(fragment, gl.COMPILE_STATUS)) {
      logger('[gles-webgl] program link (highp retry): ' + (gl.getShaderInfoLog(fragment) || '').slice(0, 4000));
      return;
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) logger('[gles-webgl] program link (highp retry): ' + (gl.getProgramInfoLog(p) || '').slice(0, 4000));
  };
  api.glUseProgram = program => gl.useProgram(object('Program', program, true));
  api.glValidateProgram = program => gl.validateProgram(object('Program', program));
  api.glGetShaderInfoLog = (s, size, written, dest) => outString(gl.getShaderInfoLog(object('Shader', s)), size, written, dest);
  api.glGetProgramInfoLog = (p, size, written, dest) => outString(gl.getProgramInfoLog(object('Program', p)), size, written, dest);
  api.glGetShaderSource = (s, size, written, dest) => outString(gl.getShaderSource(object('Shader', s)), size, written, dest);
  api.glGetShaderiv = (shader, pname, dest) => {
    const s = object('Shader', shader);
    const value = pname === 0x8B84 ? encoder.encode(gl.getShaderInfoLog(s) || '').length + 1
      : pname === 0x8B88 ? encoder.encode(gl.getShaderSource(s) || '').length + 1 : gl.getShaderParameter(s, pname);
    store(dest, Number(value));
  };
  api.glGetProgramiv = (program, pname, dest) => {
    const p = object('Program', program);
    let value;
    if (pname === 0x8B84) value = encoder.encode(gl.getProgramInfoLog(p) || '').length + 1;
    else if (pname === 0x8B87 || pname === 0x8B8A) {
      const uniform = pname === 0x8B87, count = gl.getProgramParameter(p, uniform ? gl.ACTIVE_UNIFORMS : gl.ACTIVE_ATTRIBUTES);
      value = 0;
      for (let i = 0; i < count; ++i) value = Math.max(value,
        encoder.encode((uniform ? gl.getActiveUniform(p, i) : gl.getActiveAttrib(p, i)).name).length + 1);
    } else value = gl.getProgramParameter(p, pname);
    store(dest, Number(value));
  };
  for (const kind of ['Attrib', 'Uniform']) api['glGetActive' + kind] = (p, index, capacity, written, size, type, name) => {
    const value = gl['getActive' + kind](object('Program', p), index);
    if (!value) return;
    store(size, value.size); store(type, value.type); outString(value.name, capacity, written, name);
  };
  api.glGetAttachedShaders = (p, capacity, count, shaders) => {
    const values = gl.getAttachedShaders(object('Program', p)).slice(0, length(capacity)).map(idOf);
    if (count) store(count, values.length); if (values.length) store(shaders, values);
  };
  api.glGetShaderPrecisionFormat = (type, precision, range, bits) => {
    const result = gl.getShaderPrecisionFormat(type, precision);
    if (result) { store(range, [result.rangeMin, result.rangeMax]); store(bits, result.precision); }
  };
  api.glGetUniformLocation = (program, namePtr) => {
    const p = object('Program', program), name = cstring(namePtr);
    let names = locationNames.get(program);
    if (!names) locationNames.set(program, names = new Map());
    if (names.has(name)) return names.get(name);
    const value = gl.getUniformLocation(p, name);
    if (value === null) return -1;
    const id = nextLocation++; locations.set(id, { value, program }); names.set(name, id); return id;
  };
  const location = id => {
    if ((id | 0) === -1) return null;
    if (!locations.has(id)) invalid(0x0502);
    return locations.get(id).value;
  };
  for (let n = 1; n <= 4; ++n) for (const type of ['f', 'i']) {
    api[`glUniform${n}${type}`] = (id, ...args) => gl[`uniform${n}${type}`](location(id),
      ...args.map(value => type === 'i' ? value | 0 : value));
    api[`glUniform${n}${type}v`] = (id, count, address) => {
      if ((id | 0) === -1 || count === 0) return;
      gl[`uniform${n}${type}v`](location(id), typed(type === 'i' ? Int32Array : Float32Array, address, length(count, n)));
    };
  }
  for (let n = 2; n <= 4; ++n) api[`glUniformMatrix${n}fv`] = (id, count, transpose, address) => {
    if (transpose) invalid();
    if ((id | 0) === -1 || count === 0) return;
    gl[`uniformMatrix${n}fv`](location(id), false, typed(Float32Array, address, length(count, n * n)));
  };
  for (let n = 1; n <= 4; ++n) {
    api[`glVertexAttrib${n}f`] = (index, ...args) => gl[`vertexAttrib${n}f`](index, ...args);
    api[`glVertexAttrib${n}fv`] = (index, address) => gl[`vertexAttrib${n}fv`](index, typed(Float32Array, address, n));
  }
  const componentBytes = type => ({ 0x1400: 1, 0x1401: 1, 0x1402: 2, 0x1403: 2, 0x1406: 4 })[type];
  api.glVertexAttribPointer = (index, size, type, normalized, stride, pointer) => {
    size |= 0; stride |= 0;
    if (!componentBytes(type)) invalid(0x0500);
    if (size < 1 || size > 4 || stride < 0 || stride > 255 || index >= gl.getParameter(gl.MAX_VERTEX_ATTRIBS)) invalid();
    if (pointer % componentBytes(type) || stride % componentBytes(type)) invalid(0x0502);
    const buffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    vertexState().set(index, { size, type, normalized: !!normalized, stride, pointer, client: !buffer });
    if (buffer) gl.vertexAttribPointer(index, size, type, !!normalized, stride, pointer);
  };
  const clientAttributes = () => [...vertexState()].filter(([index, value]) => value.client
    && gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_ENABLED));
  function uploadClientAttributes(attributes, maxIndex) {
    if (maxIndex < 0) return;
    const saved = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    try {
      for (const [index, a] of attributes) {
        const element = a.size * componentBytes(a.type), stride = a.stride || element;
        const size = length(maxIndex * stride + element);
        let buffer = clientUploads.get(index);
        if (!buffer) { buffer = gl.createBuffer(); clientUploads.set(index, buffer); }
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, bytes(a.pointer, size), gl.STREAM_DRAW);
        gl.vertexAttribPointer(index, a.size, a.type, a.normalized, a.stride, 0);
      }
    } finally { gl.bindBuffer(gl.ARRAY_BUFFER, saved); }
  }
  api.glDrawArrays = (mode, first, count) => {
    first = length(first); count = length(count);
    if (count) uploadClientAttributes(clientAttributes(), first + count - 1);
    gl.drawArrays(mode, first, count);
  };
  api.glDrawElements = (mode, count, type, offset) => {
    count = length(count);
    const Type = { 0x1401: Uint8Array, 0x1403: Uint16Array, 0x1405: Uint32Array }[type];
    if (!Type) invalid(0x0500);
    if (offset % Type.BYTES_PER_ELEMENT) invalid(0x0502);
    const saved = gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING), attributes = clientAttributes();
    const size = length(count, Type.BYTES_PER_ELEMENT);
    let indices;
    if (!saved) indices = bytes(offset, size);
    else if (attributes.length) {
      const shadow = bufferContents.get(saved);
      if (!shadow || offset + size > shadow.length) invalid(0x0502);
      indices = shadow.subarray(offset, offset + size);
    }
    if (attributes.length && count) {
      const values = new Type(indices.buffer, indices.byteOffset, count);
      let maxIndex = 0;
      for (const value of values) maxIndex = Math.max(maxIndex, value);
      uploadClientAttributes(attributes, maxIndex);
    }
    try {
      if (!saved) {
        indexUpload ??= gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexUpload);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STREAM_DRAW);
      }
      gl.drawElements(mode, count, type, saved ? offset : 0);
    } finally { if (!saved) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null); }
  };
  const query = pname => {
    if (pname === 0x8DFA) return 1; // SHADER_COMPILER (WebGL always has one)
    if (pname === 0x8DF9 || pname === 0x87FE) return 0; // no binary shader/program formats
    if (pname === 0x8DF8 || pname === 0x87FF) return [];
    return idOf(gl.getParameter(pname));
  };
  api.glGetIntegerv = (pname, dest) => store(dest, query(pname) ?? 0);
  api.glGetFloatv = (pname, dest) => store(dest, query(pname) ?? 0, Float32Array);
  api.glGetBooleanv = (pname, dest) => {
    const value = query(pname), values = ArrayBuffer.isView(value) ? Array.from(value) : [value];
    store(dest, values.map(v => +!!v), Uint8Array);
  };
  api.glGetBufferParameteriv = (target, pname, dest) => store(dest, gl.getBufferParameter(target, pname));
  api.glGetFramebufferAttachmentParameteriv = (target, attachment, pname, dest) =>
    store(dest, idOf(gl.getFramebufferAttachmentParameter(target, attachment, pname)));
  api.glGetRenderbufferParameteriv = (target, pname, dest) => store(dest, gl.getRenderbufferParameter(target, pname));
  api.glGetTexParameteriv = (target, pname, dest) => store(dest, gl.getTexParameter(target, pname));
  api.glGetTexParameterfv = (target, pname, dest) => store(dest, gl.getTexParameter(target, pname), Float32Array);
  api.glGetUniformiv = (p, loc, dest) => store(dest, gl.getUniform(object('Program', p), location(loc)));
  api.glGetUniformfv = (p, loc, dest) => store(dest, gl.getUniform(object('Program', p), location(loc)), Float32Array);
  const vertexParameter = (index, pname) => {
    const a = vertexState().get(index);
    if (a?.client) {
      const value = { 0x889F: 0, 0x8623: a.size, 0x8624: a.stride, 0x8625: a.type, 0x886A: +a.normalized }[pname];
      if (value !== undefined) return value;
    }
    return idOf(gl.getVertexAttrib(index, pname));
  };
  api.glGetVertexAttribiv = (index, pname, dest) => store(dest, vertexParameter(index, pname));
  api.glGetVertexAttribfv = (index, pname, dest) => store(dest, vertexParameter(index, pname), Float32Array);
  api.glGetVertexAttribPointerv = (index, pname, dest) => {
    if (pname !== 0x8645) invalid(0x0500);
    store(dest, vertexState().get(index)?.pointer ?? gl.getVertexAttribOffset(index, pname));
  };
  api.glGetString = pname => {
    if (pname === 0x1F02) return string('OpenGL ES 2.0 Vita3K WebGL');
    if (pname === 0x8B8C) return string('OpenGL ES GLSL ES 1.00 Vita3K WebGL');
    if (pname === 0x1F03) return string(extensionString());
    if (pname === 0x1F00 || pname === 0x1F01) return string(gl.getParameter(pname));
    invalid(0x0500);
  };
  api.glReleaseShaderCompiler = () => {}; // optional resource-release hint
  api.glShaderBinary = () => invalid(0x0500); // no supported binary formats
  const vao = () => extensions.get('OES_vertex_array_object');
  api.glBindVertexArrayOES = id => {
    vao().bindVertexArrayOES(object('VertexArray', id, true));
    currentVao = id;
    if (!vertexStates.has(id)) vertexStates.set(id, new Map());
  };
  api.glGenVertexArraysOES = (count, dest) => {
    const ids = Array.from({ length: length(count) }, () => create('VertexArray', vao().createVertexArrayOES()));
    if (ids.length) store(dest, ids);
  };
  api.glDeleteVertexArraysOES = (count, src) => {
    for (const id of typed(Uint32Array, src, count)) if (objects.VertexArray.has(id)) {
      vao().deleteVertexArrayOES(objects.VertexArray.get(id)); objects.VertexArray.delete(id);
      vertexStates.delete(id);
      if (currentVao === id) currentVao = 0;
    }
  };
  api.glIsVertexArrayOES = id => objects.VertexArray.has(id) ? +vao().isVertexArrayOES(objects.VertexArray.get(id)) : 0;
  const supports = name => Object.hasOwn(api, name) && (!name.includes('VertexArray') || !!vao());
  return {
    attachCanvas(value) {
      if (gl && value !== canvas) throw new Error('Cannot move an initialized WebGL context to another canvas');
      canvas = value; attached = true;
    },
    supports,
    call(name, args = []) {
      if (!supports(name)) throw new Error('Unsupported GLES entry point: ' + name);
      try {
        if (name.startsWith('gl')) requireGL();
        return api[name](...args) ?? 0;
      } catch (error) {
        if (!(error instanceof GlError)) throw error;
        localGlError ||= error.code; return 0;
      }
    },
    async swapBuffers() {
      requireGL();
      if (!drawSurface || !surfaces.has(drawSurface)) throw new Error('EGL swap without a live window surface');
      gl.flush();
      let pixels = null;
      if (!attached) {
        const { width, height } = canvas, row = width * 4;
        const raw = new Uint8Array(row * height); pixels = new Uint8Array(raw.length);
        const fbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        for (let y = 0; y < height; ++y) pixels.set(raw.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
      }
      onFrame(++generation, canvas.width, canvas.height, pixels);
      const delay = Math.max(0, interval * 1000 / 60 - (performance.now() - lastSwap));
      await new Promise(resolve => setTimeout(resolve, delay));
      lastSwap = performance.now();
    },
  };
}
