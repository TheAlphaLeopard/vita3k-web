// A running game, without any UI: configuration, staging (from the server
// and browser storage), the runtime worker, audio, saves, the guest's
// dialogs and keyboard, and the pad. The player page (player.js) and the app
// (browser/app) render it.
//
//   const target = await resolveTarget({ title, app, source });
//   const session = createSession({ settings, canvas: () => freshCanvas });
//   session.on('status' | 'launch' | 'frame' | 'notice' | 'log' | 'dialog' |
//              'ime' | 'running' | 'stopped' | 'exit', handler);
//   await session.start(target);  session.pad.set(...);  session.stop();
import * as cache from './content_cache.js';
import { createPadState } from './pad_input.js';

const sanitizeSegment = (value) => String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || '_';
const storageSupported = () => {
  try { return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'; } catch { return false; }
};
const mib = (bytes) => (bytes / 1048576).toFixed(1);
// The site's files (worker.js, player-config.json, stage/…) sit next to this
// module, wherever the page that loads it lives.
const siteUrl = (path) => new URL(path, import.meta.url).href;

// Worker options a session passes through from its settings (worker.js).
export const WORKER_OPTIONS = ['fpsHack', 'scale', 'surfaceSync', 'maxInFlight', 'cores', 'hleProfile', 'gles',
  'readback', 'stampLru', 'writeObserver', 'regionCache', 'textureVerify', 'threads', 'asyncScene', 'hleIntrinsics', 'strictImports'];

// What to boot: the server's configuration (player-config.json) for a title,
// or, on a static host ({"static": true}), what this browser holds.
//   source: 'package' boots this browser's package of a title the server
//   also stages (only firmware and patches come from the server then).
// Resolves { title, app, fromServer, stagedTitles, isStatic, aotUrl, aotMtUrl, query }.
export async function resolveTarget({ title = '', app = '', source = null } = {}) {
  const query = new URLSearchParams();
  if (title) query.set('title', title);
  if (app) query.set('app', app);
  const queryText = query.size ? '?' + query : '';
  const response = await fetch(siteUrl('./player-config.json' + queryText));
  if (!response.ok) throw new Error(await response.text() || `Player configuration: HTTP ${response.status}`);
  let config = await response.json();
  if (config.static) {
    let stored = [];
    try { stored = storageSupported() ? await cache.listCachedTitles() : []; } catch {}
    const chosen = title || stored[0]?.title || '';
    config = { ...config, title: chosen, app: app || chosen, staged: false, aot: false, aotUrl: null, aotMtUrl: null, titles: [] };
  }
  if (source === 'package' && config.staged) config = { ...config, staged: false, aot: false, aotUrl: null, aotMtUrl: null };
  const aotUrl = typeof config.aotUrl === 'string' && config.aotUrl ? config.aotUrl : (config.aot ? '/aot.wasm' : null);
  return { title: config.title || '', app: config.app || config.title || '', fromServer: config.staged !== false,
    stagedTitles: Array.isArray(config.titles) ? config.titles : [], isStatic: Boolean(config.static),
    aotUrl, aotMtUrl: config.aotMtUrl || null, query: queryText };
}

// Whether WebGPU is usable: null, or why not.
export function webgpuProblem() {
  if ('gpu' in navigator) return null;
  if (isSecureContext)
    return 'navigator.gpu is missing: this browser does not expose WebGPU (Chrome: --enable-unsafe-webgpu or chrome://flags; Firefox: dom.webgpu.enabled).';
  return 'navigator.gpu is missing because ' + location.origin + ' is not a secure context. Open this page over https:// or as http://localhost:' + location.port + '/.';
}
// WebGPU can still come without an adapter, or with only the CPU fallback
// (SwiftShader), on which games run at a few frames per second.
export async function webgpuAdapterProblem() {
  if (webgpuProblem()) return webgpuProblem();
  try {
    const adapter = await navigator.gpu.requestAdapter();
    const info = adapter?.info ?? {};
    const flags = 'Chrome on Linux needs --enable-unsafe-webgpu --enable-features=Vulkan, and --disable-gpu-sandbox on NixOS.';
    if (!adapter) return 'WebGPU has no adapter: the browser blocks this GPU. ' + flags;
    if (adapter.isFallbackAdapter || info.isFallbackAdapter || /swiftshader/i.test(info.architecture + ' ' + info.description))
      return 'WebGPU runs on the CPU (' + info.vendor + ' ' + info.architecture + '), so games will be very slow. ' + flags;
    return null;
  } catch (error) {
    return 'WebGPU adapter check failed: ' + error.message;
  }
}

// settings: { memory: 'auto' | 'w64' | 'w32',
//   buildAot, present: 'canvas' | 'readback', fastVblank, patches,
//   inlineMutex, and any of WORKER_OPTIONS } (strings or numbers).
// canvas(): a fresh <canvas> in the page for the run's GPU frames (a canvas
// can hand its control to a worker once). pixels: an optional 2D canvas for
// pixel frames (present: 'readback').
export function createSession({ settings = {}, canvas, pixels = null } = {}) {
  const listeners = new Map();
  const emit = (type, data) => { for (const handler of listeners.get(type) ?? []) handler(data); };
  const log = (text) => emit('log', String(text));
  const notice = (text) => emit('notice', text);
  const status = (text) => emit('status', text);
  const launch = (phase, detail, fraction) => emit('launch', phase ? { phase, detail: detail || '', fraction } : null);

  // Games run on the JIT: the interpreter module (vita3k_web) is for the
  // development pages, and cannot boot the firmware's modules.
  const backend = 'jit';
  const memory = ['w64', 'w32'].includes(settings.memory) ? settings.memory : 'auto';
  const presentToCanvas = settings.present !== 'readback';

  let worker = null, running = false, target = null, cacheKey = '';
  let frames = 0, gpuFrames = 0, pixelFrames = 0, firstFrameAt = 0, startedAt = 0, launchStartedAt = 0;
  let lastPresentAt = 0, presentedOnce = false, watchdogWarned = false;
  let fps = 0, fpsSince = 0, fpsFrames = 0;
  let stageCacheActive = false, stageNeeded = null, stageCacheIndex = null, stageKeys = new Map();
  let stageTotals = { files: 0, bytes: 0 };
  const stageSources = { storage: 0, downloaded: 0 };
  let saveChain = Promise.resolve();
  // The graphics queue backing up is said once per run; later ones are logged.
  let throttleNoticed = false;
  // So is the first call into a system function the build lacks (it returns
  // 0, as on desktop); the log names every one.
  let missingNoticed = false;
  const elapsed = () => (launchStartedAt ? Math.max(0, Math.round((performance.now() - launchStartedAt) / 1000)) : 0) + 's';

  // --- Audio --------------------------------------------------------------
  // Guest PCM (int16 interleaved) arrives as transferred buffers and is
  // chained per guest port on the context clock; the threaded runtime instead
  // plays each port's shared ring in an AudioWorklet (audio_ring_worklet.js).
  let audioCtx = null, audioGain = null, muted = Boolean(settings.muted);
  const audioNext = new Map(), audioSources = new Set(), audioRings = new Map();
  let audioWorkletReady = null;
  const audio = { chunks: 0, bytes: 0, peak: 0, logged: false };
  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = new AC();
      audioGain = audioCtx.createGain();
      audioGain.gain.value = muted ? 0 : 1;
      audioGain.connect(audioCtx.destination);
      audioNext.clear();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch((error) => notice('Tap Sound on to enable audio: ' + error.message));
  }
  function playAudioPCM(freq, channels, frameCount, buffer, port = 0) {
    if (!audioCtx || !buffer) return;
    const pcm = new Int16Array(buffer);
    if (frameCount <= 0 || channels < 1 || channels > 2 || pcm.length < frameCount * channels) return;
    audio.chunks += 1; audio.bytes += pcm.length * 2;
    const n = Math.min(pcm.length, frameCount * channels);
    for (let i = 0; i < n; i++) { const v = Math.abs(pcm[i]); if (v > audio.peak) audio.peak = v; }
    if (audio.chunks % 100 === 0) log('audio: chunks=' + audio.chunks + ' peak=' + audio.peak + '/32768 ctx=' + audioCtx.state);
    if (!audio.logged) {
      audio.logged = true;
      log(`audio: first chunk ch=${channels} freq=${freq} frames=${frameCount} ctx=${audioCtx.state} at=${((performance.now() - startedAt) / 1000).toFixed(1)}s`);
    }
    const data = audioCtx.createBuffer(channels, frameCount, freq > 0 ? freq : 48000);
    for (let ch = 0; ch < channels; ch++) {
      const out = data.getChannelData(ch);
      if (channels === 1) for (let i = 0; i < frameCount; i++) out[i] = pcm[i] / 32768;
      else for (let i = 0; i < frameCount; i++) out[i] = pcm[i * 2 + ch] / 32768;
    }
    const source = audioCtx.createBufferSource();
    source.buffer = data;
    source.connect(audioGain);
    audioSources.add(source);
    source.onended = () => { audioSources.delete(source); source.disconnect(); };
    const now = audioCtx.currentTime;
    let next = audioNext.get(port) ?? 0;
    // A stream that ran dry (or a first chunk) restarts slightly ahead.
    if (next < now || next > now + 1.0) next = now + 0.04;
    source.start(next);
    audioNext.set(port, next + data.duration);
  }
  async function playAudioRing(ring) {
    ensureAudio();
    if (!audioCtx?.audioWorklet) { log('audio: no AudioWorklet in this browser; threaded audio is silent'); return; }
    audioWorkletReady ??= audioCtx.audioWorklet.addModule(siteUrl('./audio_ring_worklet.js'));
    try { await audioWorkletReady; } catch (error) { log('audio: ring worklet failed: ' + error.message); return; }
    stopAudioRing(ring.port);
    const node = new AudioWorkletNode(audioCtx, 'vita3k-audio-ring', { numberOfInputs: 0, outputChannelCount: [2],
      processorOptions: { buffer: ring.buffer, offset: ring.offset, generation: ring.generation } });
    node.connect(audioGain);
    audioRings.set(ring.port, node);
    node.port.onmessage = ({ data }) => log(`audio: ring port=${ring.port} played=${data.played} frames underruns=${data.underruns} peak=${data.peak}/32768`);
    log(`audio: ring port=${ring.port} ${ring.channels}ch ${ring.freq} Hz capacity=${ring.capacity} frames ctx=${audioCtx.state}`);
  }
  function stopAudioRing(port) {
    const node = audioRings.get(port);
    if (!node) return;
    node.port.postMessage('stop');
    node.disconnect();
    audioRings.delete(port);
  }
  function setMuted(value) {
    muted = Boolean(value);
    ensureAudio();
    if (audioGain) audioGain.gain.value = muted ? 0 : 1;
  }
  function beep() {
    ensureAudio();
    if (!audioCtx) { log('audio: no AudioContext in this browser'); return; }
    const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
    osc.frequency.value = 660; gain.gain.value = 0.2;
    osc.connect(gain); gain.connect(audioGain);
    osc.start(); osc.stop(audioCtx.currentTime + 0.25);
  }

  // --- Input -------------------------------------------------------------
  // Sources (keys, touches, gamepads) share one pad state; it reaches the
  // guest only while it runs, and in full the moment it starts.
  const pad = createPadState((state) => { if (running && worker) worker.postMessage({ type: 'input', ...state }); });
  // Front touchscreen: one finger event (phase 0 down, 1 move, 2 up), x and y
  // in [0, 1] across the game picture.
  function touch(finger, phase, x, y) {
    if (running && worker) worker.postMessage({ type: 'touch', finger, phase, x, y });
  }

  // --- Stats and watchdog --------------------------------------------------
  function stats() {
    return { frames, gpuFrames, pixelFrames, fps, running, elapsed: startedAt ? (performance.now() - startedAt) / 1000 : 0,
      firstFrame: firstFrameAt / 1000, audio: audioCtx ? { ...audio, state: audioCtx.state } : null };
  }
  function countFrame() {
    const now = performance.now();
    lastPresentAt = now; presentedOnce = true; watchdogWarned = false;
    frames += 1;
    if (!firstFrameAt) { firstFrameAt = now - startedAt; fpsSince = now; fpsFrames = 0; launch(null); emit('first-frame'); }
    fpsFrames += 1;
    if (now - fpsSince >= 1000) { fps = fpsFrames * 1000 / (now - fpsSince); fpsSince = now; fpsFrames = 0; }
    emit('frame', stats());
  }
  // A run whose worker stays alive but stops presenting is the frozen-frame
  // failure (device loss, wedged queue); armed after the first frame.
  const watchdog = setInterval(() => {
    if (running && presentedOnce && !watchdogWarned && performance.now() - lastPresentAt > 15000) {
      watchdogWarned = true;
      const idle = Math.round((performance.now() - lastPresentAt) / 1000);
      log(`watchdog: no presented frames for ${idle}s while the run continues (device loss or wedged queue?)`);
      notice(`No new frames for ${idle}s — the graphics device may be stuck. Stop and start the game again.`);
    }
  }, 1000);

  // --- Lifecycle -----------------------------------------------------------
  function stop(reason = 'Stopped') {
    pad.clear();
    worker?.terminate(); worker = null;
    const wasRunning = running;
    running = false;
    for (const source of audioSources) { try { source.stop(); } catch {} source.disconnect(); }
    audioSources.clear(); audioNext.clear();
    for (const port of [...audioRings.keys()]) stopAudioRing(port);
    launch(null);
    if (reason) status(reason);
    emit('stopped', { wasRunning, frames });
  }
  function dispose() {
    stop(null);
    clearInterval(watchdog);
    audioCtx?.close().catch(() => {});
    listeners.clear();
  }

  async function start(chosen) {
    if (!chosen?.title) throw new Error('no game chosen: import a game first');
    stop(null);
    target = chosen;
    frames = 0; gpuFrames = 0; pixelFrames = 0; fps = 0; firstFrameAt = 0;
    lastPresentAt = 0; presentedOnce = false; watchdogWarned = false; throttleNoticed = false; missingNoticed = false;
    startedAt = launchStartedAt = performance.now();
    stageTotals = { files: 0, bytes: 0 };
    Object.assign(audio, { chunks: 0, bytes: 0, peak: 0, logged: false });
    // Storage: an uploaded package at <title>/<app>, the server's copy of a
    // staged title at <title>/<app>.server (one stored before that split
    // stays in use at the package key).
    const packageKey = `${sanitizeSegment(target.title)}/${sanitizeSegment(target.app)}`;
    cacheKey = packageKey;
    if (target.fromServer && storageSupported()) {
      const serverKey = packageKey + cache.SERVER_SUFFIX;
      cacheKey = (await cache.cacheReadManifest(serverKey)) || !cache.isServerManifest(await cache.cacheReadManifest(packageKey))
        ? serverKey : packageKey;
    }
    launch('Loading the WebAssembly runtime…', `${backend === 'jit' ? 'JIT' : 'interpreter'} backend`, undefined);
    status('loading module…');
    const problem = webgpuProblem();
    if (problem) log('warning: ' + problem);
    ensureAudio();
    // Uploaded games need no server-built image or recorded execution
    // seeds: build from their loaded code at launch, unless told otherwise.
    const buildAot = settings.buildAot ?? (backend === 'jit' && !target.fromServer ? '1' : null);
    const workerParams = new URLSearchParams({ backend, memory, inlineMutex: String(settings.inlineMutex ?? '1') });
    if (buildAot !== null && buildAot !== undefined) workerParams.set('buildAot', String(buildAot));
    for (const name of WORKER_OPTIONS)
      if (settings[name] !== undefined && settings[name] !== null && settings[name] !== '') workerParams.set(name, String(settings[name]));
    const current = worker = new Worker(siteUrl(`./worker.js?${workerParams}`), { type: 'module' });
    emit('started', { title: target.title, buildAot });
    worker.onerror = (event) => {
      if (worker !== current) return;
      log('worker error: ' + event.message); notice(event.message); stop('Worker error');
    };
    worker.onmessage = async ({ data }) => {
      if (worker !== current || !data || typeof data !== 'object') return;
      try {
        await onMessage(current, data, buildAot);
      } catch (error) {
        if (worker !== current) return;
        log('ERROR ' + (error?.message ?? error)); notice(String(error?.message ?? error)); stop('Launch failed');
      }
    };
  }

  function attachCanvas() {
    const element = canvas?.();
    if (!element) throw new Error('no canvas for the game');
    const offscreen = element.transferControlToOffscreen();
    worker.postMessage({ type: 'attach-canvas', canvas: offscreen }, [offscreen]);
  }

  async function onMessage(current, data, buildAot) {
    switch (data.type) {
      case 'lifecycle': log('lifecycle: ' + data.state); break;
      case 'ready': {
        status('staging content…');
        launch('Reading the file manifest…', `${data.diagnostics?.backend || backend} · ${data.diagnostics?.memoryModel || memory}`, undefined);
        log(`ready (backend=${data.diagnostics?.backend} memory=${data.diagnostics?.memoryModel} inlineMutex=${data.diagnostics?.inlineMutex})`);
        if (presentToCanvas) attachCanvas();
        // The server scopes its manifest to this title (firmware, its patch,
        // and the app directory when it stages it). The title's own files may
        // instead live in browser storage (an uploaded package).
        const response = await fetch(siteUrl('./manifest.json' + target.query));
        if (!response.ok) throw new Error('manifest: HTTP ' + response.status);
        const appPrefix = `ux0/app/${target.app}/`;
        // A package boot of a server-staged title takes firmware and patches
        // from the server, not its copy of the game.
        const serverFiles = (await response.json())
          .filter((file) => settings.patches !== '0' && settings.patches !== false || !file.path.startsWith('patch/'))
          .filter((file) => target.fromServer || !(file.path.startsWith(appPrefix) || file.path.startsWith('ux0/user/')));
        if (worker !== current) return;
        const storage = storageSupported();
        const storedManifest = storage ? await cache.cacheReadManifest(cacheKey) : null;
        const serverPaths = new Set(serverFiles.map((file) => file.path));
        // When the server stages this title's app directory, that directory
        // is the server's: a stored copy adds nothing to it.
        const serverHasApp = serverFiles.some((file) => file.path.startsWith(appPrefix));
        const storedOnly = target.fromServer ? [] : (storedManifest?.files ?? []).filter((file) => !serverPaths.has(file.path)
          && !(serverHasApp && file.path.startsWith(appPrefix)));
        // Firmware uploaded on its own fills what neither the server nor the
        // package has, read from its shared key. A title manifest written
        // before that was fixed also lists the firmware files it borrowed:
        // the same path and size as the firmware's own come from its key.
        const firmwareFiles = (storage ? await cache.cacheReadManifest(cache.FIRMWARE_KEY) : null)?.files ?? [];
        const firmwareSizes = new Map(firmwareFiles.map((file) => [file.path, file.size]));
        const ownFiles = storedOnly.filter((file) => firmwareSizes.get(file.path) !== file.size);
        const known = new Set([...serverPaths, ...ownFiles.map((file) => file.path)]);
        const firmwareOnly = firmwareFiles.filter((file) => !known.has(file.path));
        stageKeys = new Map(firmwareOnly.map((file) => [file.path, cache.FIRMWARE_KEY]));
        const staged = [...serverFiles, ...ownFiles, ...firmwareOnly];
        if (!staged.some((file) => file.path.startsWith('os0/')))
          notice('No firmware: import it (Sony\'s system software .PUP) first.');
        if (!staged.length) notice(`No content for ${target.title}: import its package first.`);
        stageTotals = { files: staged.length, bytes: staged.reduce((sum, file) => sum + (file.size || 0), 0) };
        stageNeeded = staged.map((file) => ({ path: file.path, size: file.size,
          ...(Number.isSafeInteger(file.version) ? { version: file.version } : {}) }));
        stageCacheActive = storage;
        stageCacheIndex = stageCacheActive ? cache.cacheIndexFor(storedManifest?.files, stageNeeded) : null;
        if (stageCacheIndex) for (const [path, size] of cache.cacheIndexFor(firmwareOnly, stageNeeded)) stageCacheIndex.set(path, size);
        log(`[vita3k-web] ${staged.length} files to stage (${ownFiles.length} from the package, ${firmwareOnly.length} firmware, ` +
          `${stageCacheIndex?.size ?? 0} in storage)`);
        emit('cache', stageCacheActive ? `${stageCacheIndex.size} of ${stageNeeded.length} files in storage`
          + (ownFiles.length ? `, ${ownFiles.length} package-only` : '') : 'unsupported');
        stageSources.storage = 0; stageSources.downloaded = 0;
        const toFetch = stageTotals.files - (stageCacheIndex?.size ?? 0);
        const fetchBytes = staged.filter((file) => !stageCacheIndex?.has(file.path)).reduce((sum, file) => sum + (file.size || 0), 0);
        launch('Staging game files…', `${toFetch} of ${stageTotals.files} files to download` +
          (toFetch ? ` (${mib(fetchBytes)} MiB); ${stageCacheIndex?.size ?? 0} from storage` : ''), stageTotals.bytes ? 0 : undefined);
        worker.postMessage({ type: 'stage-files', root: '/vita', useContentCache: (stageCacheIndex?.size ?? 0) > 0,
          files: staged.map((file) => ({ ...file, url: serverPaths.has(file.path) ? siteUrl(`./stage/${file.path}`) : null })) });
        break;
      }
      case 'stage-progress': {
        // 'runtime' is the runtime .wasm, 'aot' the AOT download and
        // 'aot-compiling' its device-side compile (no progress events).
        if (data.phase === 'runtime' || data.phase === 'aot' || data.phase === 'aot-compiling') {
          const name = String(data.path || '').replace(/^.*\//, '') || 'WebAssembly runtime';
          const done = data.pathBytes || 0, total = data.pathSize || 0;
          if (data.phase === 'aot-compiling') launch('Compiling the AOT module…', `${name} · ${mib(done)} MiB · compiling on this device…`, 1);
          else {
            const percent = total > 0 && done > 0 ? Math.min(99, Math.floor(done / total * 100)) : null;
            launch(`${data.phase === 'aot' ? 'Downloading' : 'Loading'} ${name}` + (percent === null ? '' : ` — ${percent}%`),
              `${mib(done)}/${total ? mib(total) + ' ' : ''}MiB · ${elapsed()}`, total ? done / total : undefined);
          }
          break;
        }
        if (data.total) stageTotals.files = data.total;
        if (data.totalBytes) stageTotals.bytes = data.totalBytes;
        const bytes = data.bytes || 0;
        const percent = data.pathSize >= 1048576 && data.pathBytes > 0 ? Math.min(99, Math.floor(data.pathBytes / data.pathSize * 100)) : null;
        if (data.source === 'cache') stageSources.storage += 1;
        else if (data.path) stageSources.downloaded += 1;
        const phase = data.source === 'cache' && data.path ? `Reading ${data.path} from storage`
          : (data.path ? `Downloading ${data.path}` : 'Staging game files…');
        const parts = [];
        if (stageTotals.files) parts.push(`${Math.min(data.index || 0, stageTotals.files)}/${stageTotals.files} files`);
        if (stageTotals.bytes) parts.push(`${mib(bytes)}/${mib(stageTotals.bytes)} MiB`, `${Math.floor(Math.min(1, bytes / stageTotals.bytes) * 100)}%`);
        if (stageSources.storage) parts.push(`${stageSources.storage} from storage`);
        if (stageSources.downloaded) parts.push(`${stageSources.downloaded} downloaded`);
        parts.push(elapsed());
        launch(phase + (percent === null ? '' : ` — ${percent}%`), parts.join(' · '), stageTotals.bytes ? bytes / stageTotals.bytes : undefined);
        break;
      }
      case 'stage-need': {
        // Storage read-through for the worker's staging loop: a miss answers
        // null and the worker downloads instead.
        let bytes = null;
        if (stageCacheActive && stageCacheIndex?.get(data.path) === data.size
            && Number.isSafeInteger(data.size) && data.size >= 0 && typeof data.path === 'string') {
          try {
            const hit = await cache.cacheReadFile(stageKeys.get(data.path) ?? cacheKey, data.path);
            if (hit && hit.byteLength === data.size) bytes = hit;
          } catch { bytes = null; }
        }
        if (worker !== current) return;
        worker.postMessage({ type: 'stage-data', path: data.path, bytes: bytes ? bytes.buffer : null }, bytes ? [bytes.buffer] : []);
        break;
      }
      case 'stage-store':
        if (stageCacheActive && typeof data.path === 'string' && data.bytes instanceof ArrayBuffer) {
          try { await cache.cacheWriteFile(cacheKey, data.path, new Uint8Array(data.bytes)); } catch {
            stageCacheActive = false;
            log('[vita3k-web] content cache write failed; continuing without cache');
          }
        }
        break;
      case 'aot-compiled':
        launch('Launching the game…', `${mib(data.bytes || 0)} MiB AOT ready` +
          ` (download ${(data.downloadMs / 1000).toFixed(1)}s, compile ${(data.compileMs / 1000).toFixed(1)}s) · ${elapsed()}`, 1);
        break;
      case 'staged': {
        status('running');
        launch('Launching the game…', `${data.files} files` + (data.cachedFiles ? ` (${data.cachedFiles} from storage)` : '') +
          ` · ${mib(data.bytes)} MiB staged · ${elapsed()}`, 1);
        // What this title's key holds: not the firmware read from its own key.
        if (stageCacheActive && stageNeeded)
          cache.cacheWriteManifest(cacheKey, stageNeeded.filter((file) => !stageKeys.has(file.path))).catch(() => {});
        log(`staged ${data.files} files (${mib(data.bytes)} MiB) — launching`);
        // Saves this browser kept for the title replace the staged ones.
        const saves = storageSupported() ? await cache.readSaves(target.title).catch(() => []) : [];
        if (worker !== current) return;
        if (saves.length) log(`restoring ${saves.length} saved file(s) from this browser`);
        worker.postMessage({ type: 'run-app', vitaFs: data.root, title: target.title, app: target.app,
          fastVblank: Boolean(settings.fastVblank), saves,
          ...(target.aotUrl ? { aotUrl: target.aotUrl } : {}), ...(target.aotMtUrl ? { aotMtUrl: target.aotMtUrl } : {}) },
        saves.map((file) => file.bytes.buffer));
        running = true;
        pad.flush(true);
        emit('running', { title: target.title });
        break;
      }
      case 'vita-present': gpuFrames += 1; countFrame(); break;
      case 'vita-frame': {
        if (pixels) {
          const view = new Uint8Array(data.data);
          if (pixels.width !== data.width || pixels.height !== data.height) { pixels.width = data.width; pixels.height = data.height; }
          pixels.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(view.buffer, view.byteOffset, view.byteLength),
            data.width, data.height), 0, 0);
        }
        pixelFrames += 1;
        countFrame();
        emit('pixel-frame');
        break;
      }
      case 'vita-audio': playAudioPCM(data.freq, data.channels, data.frames, data.data, data.port ?? 0); break;
      case 'vita-audio-ring': playAudioRing(data); break;
      case 'vita-saves': {
        // The game saved: keep the files in this browser, one batch after another.
        const batch = data;
        saveChain = saveChain.then(async () => {
          if (!storageSupported()) { log('saves: no persistent storage in this browser; the save lasts until reload'); return; }
          try {
            for (const file of batch.files) await cache.writeSave(batch.title, file.path, new Uint8Array(file.bytes));
            for (const path of batch.removed) await cache.removeSave(batch.title, path);
            log(`saves: stored ${batch.files.length} file(s)${batch.removed.length ? `, removed ${batch.removed.length}` : ''} for ${batch.title}`);
            emit('saved', { title: batch.title, files: batch.files.length });
          } catch (error) {
            log('saves: storing failed: ' + (error?.message || error));
            notice('Could not store the save in this browser: ' + (error?.message || error));
          }
        });
        break;
      }
      case 'vita-dialog':
        // A dialog takes the pad, as the Vita's does.
        if (data.dialog?.state === 'open') pad.clear();
        emit('dialog', data.dialog);
        break;
      case 'vita-ime':
        if (data.ime?.state !== 'close') pad.clear();
        emit('ime', data.ime);
        break;
      case 'vita-gxm-throttle': {
        const info = data.throttle ?? {};
        log(`[gxm-throttle] Waiting: ${info.inFlight} submissions queued (max ${info.maxInFlight}); ${info.throttledScenes} scene retries`);
        if (!throttleNoticed) notice('Rendering is waiting for graphics work to finish. A lower resolution may help.');
        throttleNoticed = true;
        break;
      }
      case 'vita-gxm-device': {
        const info = data.device ?? {};
        log(`[gxm-device] lost reason=${info.reason ?? 'unknown'} message=${info.message ?? ''}`);
        const text = info.reason === 'queue-error' ? 'Graphics queue stalled' : 'Graphics device lost';
        status(text);
        notice(`${text} (${info.reason ?? 'unknown'}). Stop and start the game again.`);
        break;
      }
      case 'vita-exit':
        log('exit: ' + JSON.stringify(data));
        emit('exit', data);
        stop(`exit ${data.exitCode} (${data.ok ? 'ok' : 'failed'})`);
        break;
      case 'log':
        log(data.message);
        // A rejected AOT image otherwise fails silently onto the JIT.
        if (typeof data.message === 'string' && data.message.includes('AOT REJECTED'))
          notice(`AOT module rejected (${data.message.replace(/^.*AOT REJECTED:\s*/, '')}). Running on the JIT fallback.`);
        if (!missingNoticed && typeof data.message === 'string' && data.message.startsWith('[vita3k-web] missing function ')) {
          missingNoticed = true;
          const name = data.message.slice('[vita3k-web] missing function '.length).split(' ')[0];
          notice(`This game uses system functions the web build lacks (first: ${name}); they return 0. If it misbehaves, the logs name each one.`);
        }
        break;
      case 'error': log('ERROR ' + data.message); notice(data.message); stop('Runtime error'); break;
      default: break;
    }
  }

  return {
    on(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
      return () => listeners.get(type)?.delete(handler);
    },
    start, stop, dispose, stats, pad, touch, ensureAudio, setMuted, beep,
    get running() { return running; },
    get active() { return worker !== null; },
    get target() { return target; },
    get muted() { return muted; },
    // Answers to the guest's dialog and on-screen keyboard (ime_bridge.cpp:
    // kind 0 the field's text and caret, 1 enter, 2 close).
    pressDialog(id, button, selected) { worker?.postMessage({ type: 'dialog-press', id, button, selected }); },
    sendIme(id, kind, text, caret) { worker?.postMessage({ type: 'ime-input', input: { id, kind, text, caret } }); },
  };
}
