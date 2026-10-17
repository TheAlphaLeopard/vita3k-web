// Vita3K web shell — ivory/black front end over the notwindstone web port.
// The engine (vita_session.js, library.js, worker.js, wasm64/*) is untouched;
// this module only drives it: boot decisions, library UI, input, honest errors.

import * as library from './library.js';
import { resolveTarget, createSession, webgpuProblem, webgpuAdapterProblem, WORKER_OPTIONS } from './vita_session.js';
import { keyMap, createTouchControls, createGamepadInput, SCE_CTRL } from './pad_input.js';

const params = new URLSearchParams(location.search);
const $ = (selector) => document.querySelector(selector);
const mib = (bytes) => (bytes / 1048576).toFixed(1);

// --- elements ---------------------------------------------------------------

const els = {
  status: $('#status'), fps: $('#fps'), notice: $('#notice'),
  welcome: $('#welcome'), wTitle: $('#w-title'), wSub: $('#w-sub'),
  launch: $('#launch'), launchPhase: $('#launch-phase'), launchBar: $('#launch-bar'), launchFill: $('#launch-fill'), launchDetail: $('#launch-detail'),
  run: $('#run'), stop: $('#stop'), mute: $('#mute'),
  touchToggle: $('#touch-toggle'), touchMode: $('#touch-mode'), fullscreen: $('#fullscreen'),
  display: $('#screen-area'), gpuScreen: $('#gpu-screen'), screen: $('#screen'),
  chips: $('#chips'), upload: $('#upload'), uploadFile: $('#upload-file'),
  upFirmware: $('#up-firmware'), firmwareFile: $('#firmware-file'), firmwareState: $('#firmware-state'),
  savesDownload: $('#saves-download'), savesUpload: $('#saves-upload'), savesFile: $('#saves-file'),
  storageState: $('#storage-state'), playerNotice: $('#player-notice'),
  wall: $('#wall'), wallDismiss: $('#wall-dismiss'),
  logbox: $('#logbox'), log: $('#log'), capNote: $('#cap-note'),
  dialogBox: $('#dialog'), dialogMessage: $('#dialog-message'), dialogProgress: $('#dialog-progress'),
  dialogButtons: $('#dialog-buttons'), dialogHint: $('#dialog-hint'),
  imeBox: $('#ime'), imeText: $('#ime-text'), imeEnter: $('#ime-enter'), imeClose: $('#ime-close'),
  touchRoot: $('#touch-controls'),
};

// --- settings ----------------------------------------------------------------

const settings = {
  backend: 'jit',
  memory: ['w64', 'w32'].includes(params.get('memory')) ? params.get('memory') : 'auto',
  inlineMutex: params.get('inlineMutex') === '0' ? '0' : '1',
  present: params.get('present') === 'readback' ? 'readback' : 'canvas',
  fastVblank: params.get('fastvblank') === '1',
  patches: params.get('patches') ?? undefined,
  ...(params.has('buildAot') ? { buildAot: params.get('buildAot') } : {}),
  ...(params.has('muted') ? { muted: params.get('muted') === '1' } : {}),
};
for (const name of WORKER_OPTIONS) if (params.has(name)) settings[name] = params.get(name);

// --- log / status helpers ------------------------------------------------------

const logLines = [];
let logDirty = false;
const log = (text) => {
  logLines.push(String(text));
  if (logLines.length > 300) logLines.splice(0, logLines.length - 300);
  logDirty = true;
  onLogLine(String(text));
};
const status = (text) => { els.status.textContent = text; };
const notice = (message) => {
  els.notice.textContent = message || '';
  els.playerNotice.textContent = message || '';
  els.playerNotice.hidden = !message;
};

// The SceLibc wall: these stubs are baked into the current runtime build.
const WALL_RE = /Unimplemented (sprintf|vsprintf|strcmp|memcmp|strstr|strchr|powf) import/;
let wallShown = false;
function onLogLine(text) {
  if (wallShown) return;
  if (WALL_RE.test(text)) {
    wallShown = true;
    els.wall.hidden = false;
    log('SceLibc wall: the game needs functions this build stubs — see the panel above.');
  }
  if (/\*\*\* system break \*\*\*/.test(text) || /File Pak Load Error/.test(text)) {
    status('the game stopped');
  }
}

// --- session --------------------------------------------------------------------

let target = null;
let dialog = null;
let ime = null;

const session = createSession({
  settings,
  // A canvas hands its control to one worker only: every run gets a new one.
  canvas: () => {
    const element = document.createElement('canvas');
    element.setAttribute('aria-label', 'Game video');
    element.id = 'gpu-screen';
    element.width = 960; element.height = 544;
    els.gpuScreen.replaceWith(element);
    els.gpuScreen = element;
    return element;
  },
  pixels: els.screen,
});

session.on('log', log);
session.on('notice', notice);
session.on('status', status);
session.on('pixel-frame', () => { els.screen.hidden = false; });
session.on('first-frame', hideWelcome);
session.on('frame', hideWelcome);
session.on('launch', (state) => {
  els.launch.hidden = !state;
  if (!state) return;
  els.launchPhase.textContent = state.phase;
  els.launchDetail.textContent = state.detail;
  const measured = Number.isFinite(state.fraction);
  els.launchBar.hidden = !measured;
  if (measured) els.launchFill.style.width = Math.round(Math.min(1, Math.max(0, state.fraction)) * 100) + '%';
});
session.on('stopped', () => {
  dialog = null; els.dialogBox.hidden = true;
  ime = null; els.imeBox.hidden = true;
  els.run.disabled = false; els.stop.disabled = true;
  touch.clear(); gamepads.clear();
  updateTouchVisibility();
  if (!session.stats().frames) {
    els.wTitle.textContent = 'Ready when you are.';
    els.wSub.textContent = 'Press Play to launch the game.';
  }
  els.fps.hidden = true;
});

function hideWelcome() {
  els.welcome.hidden = true;
}
function showWelcome(titleText, subText) {
  els.welcome.hidden = false;
  els.wTitle.textContent = titleText;
  els.wSub.textContent = subText;
}

// --- input ----------------------------------------------------------------------

const pad = session.pad;
const touch = createTouchControls(els.touchRoot, pad, { enabled: () => !dialog && !ime, onGesture: session.ensureAudio });
const gamepads = createGamepadInput(pad, {
  enabled: () => !dialog && !ime,
  onPress: (button) => { if (session.running && dialog && !ime) dialogButton(button); },
  onGesture: session.ensureAudio,
  onConnect: (gamepad, connected) => {
    log(`gamepad ${connected ? 'connected' : 'disconnected'}: ${gamepad.id} (${gamepad.mapping || 'no standard mapping'})`);
    updateTouchVisibility();
  },
});

function clearInputs() { touch.clear(); gamepads.clear(); pad.clear(); }
function onKey(event) {
  if (event.type === 'keyup') pad.release('key:' + event.code);
  if (ime) {
    if (event.type === 'keydown' && event.code === 'Escape') { event.preventDefault(); sendIme(2); }
    return;
  }
  if (!session.running || !(event.code in keyMap)) return;
  if (dialog) {
    if (event.code === 'Enter') return; // activate the focused dialog button
    event.preventDefault();
    if (event.type === 'keydown' && !event.repeat) dialogButton(keyMap[event.code].buttons ?? 0);
    return;
  }
  if (event.target.closest?.('input, textarea, select, button, summary, a, [contenteditable="true"]')) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();
  if (event.type === 'keydown' && !event.repeat) { session.ensureAudio(); pad.set('key:' + event.code, keyMap[event.code]); }
}
addEventListener('keydown', onKey);
addEventListener('keyup', onKey);
addEventListener('blur', clearInputs);
addEventListener('pagehide', clearInputs);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearInputs(); });
addEventListener('resize', clearInputs);

// --- touch + preferences -----------------------------------------------------------

const coarsePointer = matchMedia('(any-pointer: coarse)');
const readPreference = (key, fallback) => { try { return localStorage.getItem('v3k.' + key) ?? fallback; } catch { return fallback; } };
const writePreference = (key, value) => { try { localStorage.setItem('v3k.' + key, value); } catch { /* private browsing */ } };

els.touchMode.value = readPreference('touch', 'auto') || 'auto';
function wantsTouch() {
  return els.touchMode.value === 'on'
    || (els.touchMode.value === 'auto' && !gamepads.connected() && (coarsePointer.matches || navigator.maxTouchPoints > 0));
}
function updateTouchVisibility() {
  touch.clear();
  const visible = wantsTouch() && !dialog && !ime && session.active;
  els.touchRoot.hidden = !visible;
  els.touchToggle.setAttribute('aria-pressed', String(wantsTouch()));
}
els.touchToggle.onclick = () => {
  els.touchMode.value = wantsTouch() ? 'off' : 'on';
  writePreference('touch', els.touchMode.value);
  updateTouchVisibility();
};
els.touchMode.onchange = () => { writePreference('touch', els.touchMode.value); updateTouchVisibility(); };

// --- mute / fullscreen ----------------------------------------------------------------

els.mute.onclick = () => {
  session.setMuted(!session.muted);
  els.mute.textContent = session.muted ? 'Sound off' : 'Sound on';
  els.mute.setAttribute('aria-pressed', String(session.muted));
};
els.fullscreen.onclick = async () => {
  try {
    if (document.fullscreenElement) { await document.exitFullscreen(); return; }
    if (document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
    } else {
      document.body.classList.toggle('expanded'); // fallback expanded player
    }
  } catch (error) { notice('Fullscreen: ' + error.message); }
};

// --- guest dialog + ime -------------------------------------------------------------

function renderDialogButtons() {
  els.dialogButtons.replaceChildren(...dialog.buttons.map((label, index) => {
    const element = document.createElement('button');
    element.textContent = label;
    element.className = index === dialog.selected ? 'selected' : '';
    element.onclick = () => session.pressDialog(dialog.id, dialog.enter, index);
    return element;
  }));
}
session.on('dialog', (message) => {
  if (message.state === 'close') {
    log(`dialog ${message.id} closed: buttonId=${message.buttonId} result=${message.result}`);
    if (dialog?.id === message.id) { dialog = null; els.dialogBox.hidden = true; updateTouchVisibility(); els.display.focus({ preventScroll: true }); }
    return;
  }
  if (message.state === 'open') {
    log(`dialog ${message.id}: ${JSON.stringify(message.message)} [${message.buttons.join(', ')}]`);
    clearInputs();
    dialog = { id: message.id, selected: 0 };
  }
  if (!dialog || dialog.id !== message.id) return;
  dialog.buttons = message.buttons;
  dialog.enter = message.enterButton === 'circle' ? SCE_CTRL.circle : SCE_CTRL.cross;
  dialog.selected = Math.min(dialog.selected, Math.max(0, message.buttons.length - 1));
  els.dialogMessage.textContent = message.message;
  els.dialogProgress.hidden = message.progress === null;
  if (message.progress !== null) els.dialogProgress.value = message.progress;
  renderDialogButtons();
  els.dialogHint.textContent = message.buttons.length
    ? (message.enterButton === 'circle' ? 'C (circle) selects · X (cross) backs out' : 'X (cross) selects · C (circle) backs out') : '';
  els.dialogBox.hidden = false;
  updateTouchVisibility();
  if (message.state === 'open') els.dialogBox.querySelector('button')?.focus({ preventScroll: true });
});
function dialogButton(button) {
  if (button === SCE_CTRL.left || button === SCE_CTRL.right) {
    const last = Math.max(0, dialog.buttons.length - 1);
    dialog.selected = Math.max(0, Math.min(last, dialog.selected + (button === SCE_CTRL.right ? 1 : -1)));
    renderDialogButtons();
    els.dialogBox.querySelector('button.selected')?.focus({ preventScroll: true });
  } else if (button === SCE_CTRL.cross || button === SCE_CTRL.circle) {
    session.pressDialog(dialog.id, button, dialog.selected);
  }
}

const sendIme = (kind) => session.sendIme(ime.id, kind, els.imeText.value, els.imeText.selectionStart ?? els.imeText.value.length);
session.on('ime', (message) => {
  if (message.state === 'close') {
    log(`ime ${message.id} closed`);
    if (ime?.id === message.id) { ime = null; els.imeBox.hidden = true; els.imeText.blur(); updateTouchVisibility(); els.display.focus({ preventScroll: true }); }
    return;
  }
  log(`ime ${message.id}: ${JSON.stringify(message.text)} max=${message.maxLength}`);
  clearInputs();
  ime = { id: message.id };
  els.imeText.value = message.text;
  els.imeText.maxLength = message.maxLength;
  els.imeEnter.textContent = message.enterLabel || 'Enter';
  els.imeBox.hidden = false;
  updateTouchVisibility();
  els.imeText.focus();
  els.imeText.setSelectionRange(message.caret, message.caret);
});
els.imeText.addEventListener('input', () => { if (ime) sendIme(0); });
els.imeText.addEventListener('keyup', (event) => { if (ime && event.key.startsWith('Arrow')) sendIme(0); });
els.imeBox.addEventListener('submit', (event) => { event.preventDefault(); if (ime) { sendIme(0); sendIme(1); } });
els.imeClose.onclick = () => { if (ime) sendIme(2); };

// --- run / stop ---------------------------------------------------------------------

async function run() {
  if (!target?.title) { notice('No game to run yet — upload one below.'); return; }
  notice('');
  els.run.disabled = true;
  showWelcome('Starting ' + (currentName || target.title) + '…', 'The first launch can take a little while.');
  els.display.focus({ preventScroll: true });
  els.screen.hidden = true;
  els.gpuScreen.hidden = settings.present === 'readback';
  try {
    await session.start(target);
    els.stop.disabled = false;
    updateTouchVisibility();
  } catch (error) {
    log('ERROR ' + (error?.message ?? error));
    status('launch failed');
    notice(String(error?.message ?? error));
    showWelcome('Launch failed', String(error?.message ?? error));
    session.stop(null);
    els.run.disabled = false; els.stop.disabled = true;
  }
}
els.run.onclick = () => run();
els.stop.onclick = () => session.stop('Stopped');
els.wallDismiss.onclick = () => { els.wall.hidden = true; };

// Diagnostics once a second.
setInterval(() => {
  if (session.active) {
    const s = session.stats();
    if (s.fps) { els.fps.hidden = false; els.fps.textContent = Math.round(s.fps) + ' FPS'; }
    if (logDirty) {
      els.log.textContent = logLines.join('\n');
      logDirty = false;
      els.log.scrollTop = els.log.scrollHeight;
    }
  }
}, 500);

// --- library UI ----------------------------------------------------------------

let currentName = '';
let packages = [];

async function refreshLibrary() {
  packages = await library.listPackages();
  els.chips.replaceChildren(...packages.slice(0, 24).map((pkg) => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.type = 'button';
    chip.dataset.title = pkg.title;
    const name = document.createElement('span');
    name.textContent = pkg.title;
    const meta = document.createElement('span');
    meta.className = 'chip-meta';
    meta.textContent = pkg.files + ' files · ' + mib(pkg.bytes) + ' MiB';
    chip.append(name, meta);
    library.titleInfo(pkg.title, pkg.app).then((info) => {
      name.textContent = info.name || pkg.title;
      if (chip.dataset.title === target?.title) currentName = info.name || pkg.title;
      if (info.icon) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = URL.createObjectURL(info.icon);
        chip.prepend(img);
      }
    }).catch(() => {});
    chip.onclick = () => bootTitle(pkg.title, pkg.app);
    return chip;
  }));
  markActiveChip();
  await refreshFirmwareStatus();
  refreshStorageEstimate();
}

function markActiveChip() {
  for (const chip of els.chips.children) chip.classList.toggle('active', chip.dataset.title === target?.title);
}

async function refreshFirmwareStatus() {
  const firmware = await library.firmwareStatus();
  const parts = [firmware.system ? 'system software' : null, firmware.fonts ? 'fonts' : null].filter(Boolean);
  els.firmwareState.textContent = firmware.files
    ? 'stored: ' + parts.join(' + ') + ' (' + firmware.files + ' files · ' + mib(firmware.bytes) + ' MiB)'
      + (firmware.system && !firmware.fonts ? ' · font package missing' : '')
    : 'not stored yet — games that draw text need it (Sony .PUP or a zip of os0 + vs0 + sa0)';
}

async function refreshStorageEstimate() {
  try {
    const estimate = await library.storageEstimate();
    if (estimate) els.storageState.textContent = 'storage: ' + mib(estimate.usage ?? 0) + ' MiB used of ' + mib(estimate.quota ?? 0) + ' MiB';
  } catch { /* not supported */ }
}

// --- imports ---------------------------------------------------------------------

function importProgressLine(update) {
  const what = { load: 'reading', prepare: 'preparing', inflate: 'inflating', unpack: 'unpacking', decrypt: 'decrypting', install: 'installing', store: 'storing' }[update.phase] || update.phase;
  const size = update.total ? ' · ' + Math.round((update.bytes / update.total) * 100) + '%' : ' · ' + mib(update.bytes) + ' MiB';
  status(what + ' ' + (update.path || '') + size);
  els.launch.hidden = false;
  els.launchPhase.textContent = what + (update.path ? ': ' + update.path : '');
  els.launchDetail.textContent = size;
  if (update.total) {
    els.launchBar.hidden = false;
    els.launchFill.style.width = Math.round((update.bytes / update.total) * 100) + '%';
  }
}

async function importWithOptions(file, expect) {
  const kind = library.fileKind(file.name);
  if (!kind) throw new Error(file.name + ' is not a .vpk/.zip/.pkg/.pup file');
  return library.importFile(file, {
    expect,
    zrif: async () => askZrif(file.name),
    onProgress: importProgressLine,
  });
}

async function importFromPicker(file, expect) {
  els.run.disabled = true;
  try {
    const result = await importWithOptions(file, expect);
    if (result.kind === 'firmware') {
      notice('Firmware' + (result.version ? ' ' + result.version : '') + ' ready: ' + result.files + ' files · ' + mib(result.bytes) + ' MiB.');
      await refreshFirmwareStatus();
    } else {
      notice('Package ready: ' + result.files + ' files · ' + mib(result.bytes) + ' MiB. Press Play.');
      currentName = result.title;
      await refreshLibrary();
      target = await resolveTarget({ title: result.title, app: result.app });
      markActiveChip();
      if (params.get('autorun') !== '0') await run();
      else showWelcome((result.title) + ' is ready.', 'Press Play to launch.');
    }
  } catch (error) {
    log('import failed: ' + (error?.message ?? error));
    status('import failed');
    notice(String(error?.message ?? error));
    showWelcome('Import failed', String(error?.message ?? error));
  } finally {
    els.run.disabled = false;
    els.launch.hidden = true;
    els.launchBar.hidden = true;
  }
}

els.upload.onclick = () => els.uploadFile.click();
els.uploadFile.onchange = () => { const file = els.uploadFile.files[0]; if (file) importFromPicker(file, 'game'); els.uploadFile.value = ''; };
els.upFirmware.onclick = () => els.firmwareFile.click();
els.firmwareFile.onchange = () => { const file = els.firmwareFile.files[0]; if (file) importFromPicker(file, 'firmware'); els.firmwareFile.value = ''; };

// zRIF prompt for .pkg files (NoPayStation lists them).
function askZrif(fileName) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'zrif-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:var(--ivory);z-index:60;display:grid;place-items:center;padding:24px;';
    overlay.innerHTML = '<div style="max-width:640px;width:100%;display:grid;gap:12px">'
      + '<h2 style="font-size:16px;text-transform:uppercase;letter-spacing:.06em">zRIF license for ' + fileName + '</h2>'
      + '<p style="font-size:13px;color:var(--muted)">A .pkg (PSN download) needs its license — NoPayStation lists it as zRIF. Paste it below.</p>'
      + '<textarea id="zrif-text" rows="5" style="border:2px solid var(--ink);padding:10px;font-family:monospace;font-size:12px;background:var(--ivory);color:var(--ink)"></textarea>'
      + '<div style="display:flex;gap:8px"><button id="zrif-ok" class="primary">Import</button><button id="zrif-cancel" type="button">Cancel</button></div>'
      + '</div>';
    document.body.append(overlay);
    const text = overlay.querySelector('#zrif-text');
    text.focus();
    overlay.querySelector('#zrif-ok').onclick = () => { const value = text.value.trim(); overlay.remove(); resolve(value || null); };
    overlay.querySelector('#zrif-cancel').onclick = () => { overlay.remove(); resolve(null); };
  });
}

// --- saves -----------------------------------------------------------------------

function currentTitle() { return target?.title || packages[0]?.title || ''; }

els.savesDownload.onclick = async () => {
  const title = currentTitle();
  if (!title) { notice('No game selected — saves are per game.'); return; }
  try {
    const blob = await library.savesZip(title);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = title + '-saves.zip';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    notice('Saves exported for ' + title + '.');
  } catch (error) { notice('Saves export: ' + error.message); }
};
els.savesUpload.onclick = () => els.savesFile.click();
els.savesFile.onchange = async () => {
  const file = els.savesFile.files[0];
  els.savesFile.value = '';
  const title = currentTitle();
  if (!file || !title) return;
  try {
    await library.restoreSaves(title, file, { confirmReplace: async () => confirm('Replace the saves stored for ' + title + '?') });
    notice('Saves restored for ' + title + '. They reach the game at launch.');
  } catch (error) { notice('Saves import: ' + error.message); }
};

// --- url / local rom imports --------------------------------------------------------

async function importFromUrl(urlText, { silentHint = false } = {}) {
  els.run.disabled = true;
  let resolved;
  try { resolved = new URL(urlText, location.href); } catch { resolved = null; }
  if (!resolved || !/^https?:$/.test(resolved.protocol)) {
    notice('That is not a http(s) URL: ' + urlText);
    els.run.disabled = false;
    return;
  }
  let name = decodeURIComponent(resolved.pathname.split('/').pop() || '');
  if (!/\.(vpk|zip|pkg|pup)$/i.test(name)) name += '.vpk';
  showWelcome('Fetching ' + name, resolved.host === location.host ? 'downloading…' : 'downloading (the host must allow cross-origin requests)…');
  try {
    const response = await fetch(resolved, { mode: 'cors' });
    if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + resolved.pathname);
    if (!response.body) throw new Error('this browser cannot stream the download');
    const total = Number(response.headers.get('content-length')) || 0;
    // Stream to OPFS so a multi-GB download never sits in memory.
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('v3k-url-download', { create: true });
    const writer = await handle.createWritable();
    let got = 0; let lastPaint = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(value);
      got += value.byteLength;
      const now = performance.now();
      if (now - lastPaint > 150) {
        lastPaint = now;
        const size = total ? Math.round((got / total) * 100) + '%' : mib(got) + ' MiB';
        showWelcome('Fetching ' + name, 'downloaded ' + size);
        status('downloading ' + name + ' · ' + size);
      }
    }
    await writer.close();
    const file = await handle.getFile();
    const named = new File([file], name, { type: file.type || 'application/zip' });
    await importFromPicker(named, /\.(pup)$/i.test(name) ? 'firmware' : 'game');
    try { await handle.remove(); } catch { /* best effort */ }
    if (silentHint) log('downloaded ' + name + ' from ' + resolved.href);
  } catch (error) {
    log('download failed: ' + (error?.message ?? error));
    status('download failed');
    notice(String(error?.message ?? error));
    showWelcome('Download failed', String(error?.message ?? error));
    els.run.disabled = false;
  }
}

const LOCAL_ROM_NAMES = ['rom.vpk', 'rom.zip'];
async function probeLocalRom() {
  for (const name of LOCAL_ROM_NAMES) {
    try {
      const url = new URL(name, location.href).href;
      const response = await fetch(url, { method: 'HEAD' });
      const type = (response.headers.get('content-type') || '');
      if (response.ok && !type.includes('text/html')) return url;
    } catch { /* next candidate */ }
  }
  return null;
}

// --- boot decisions -------------------------------------------------------------------

async function bootTitle(title, app) {
  if (!title) return;
  try { localStorage.setItem('v3k.lastTitle', title); } catch { /* private browsing */ }
  target = await resolveTarget({ title, app: app || title });
  markActiveChip();
  currentName = title;
  library.titleInfo(title, app || title).then((info) => {
    currentName = info.name || title;
    if (session.active) return;
    document.title = 'Vita3K — ' + currentName;
  }).catch(() => {});
  document.title = 'Vita3K — ' + title;
  await run();
}

const autorun = params.get('autorun') !== '0';

(async () => {
  // Capability notes before anything can fail silently.
  const webgpuBlocked = webgpuProblem();
  if (webgpuBlocked) { log('warning: ' + webgpuBlocked); notice(webgpuBlocked); }
  else webgpuAdapterProblem().then((problem) => { if (problem) { log('warning: ' + problem); notice(problem); } });
  if (!library.storageSupported()) {
    const message = 'this browser has no persistent storage (OPFS) — games cannot be imported. Use a current Chrome, Edge or Firefox.';
    log('warning: ' + message); notice(message);
    showWelcome('Storage unavailable', message);
    els.capNote.textContent = 'OPFS missing';
  } else if (!self.crossOriginIsolated) {
    els.capNote.textContent = 'not cross-origin isolated — the threaded runtime is off (coi.js handles this on static hosts)';
  }

  await refreshLibrary();

  if (!autorun) {
    status('ready');
    showWelcome('Autorun is off (?autorun=0).', 'Pick a game below or press Play.');
    els.run.disabled = !target && !packages.length;
    return;
  }

  // 1. explicit ?url=
  if (params.get('url')) { importFromUrl(params.get('url')); return; }

  // 2. a rom.vpk / rom.zip next to this page
  const romUrl = await probeLocalRom();
  if (romUrl) { log('found ' + romUrl.split('/').pop() + ' — importing'); importFromUrl(romUrl, { silentHint: true }); return; }

  // 3. explicit ?title=
  if (params.get('title')) { bootTitle(params.get('title'), params.get('app') || params.get('title')); return; }

  // 4. what the browser already holds (last played wins)
  if (packages.length) {
    let last = null;
    try { last = localStorage.getItem('v3k.lastTitle'); } catch { /* private browsing */ }
    const pick = packages.find((pkg) => pkg.title === last) || packages[0];
    log('booting stored title ' + pick.title + (packages.length > 1 ? ' (' + packages.length + ' games stored)' : ''));
    bootTitle(pick.title, pick.app);
    return;
  }

  // 5. nothing yet
  status('ready');
  showWelcome('Ready when you are.', 'Upload a game (.vpk / .zip / .pkg) below — and firmware for commercial games.');
  els.run.disabled = true;
})();

// Shift+click a chip removes that game (with confirm), keeping the strip tidy.
els.chips.addEventListener('click', async (event) => {
  const chip = event.target.closest('.chip');
  if (!chip || !event.shiftKey) return;
  const title = chip.dataset.title;
  if (!confirm('Remove ' + title + ' from this browser? (Saves stay)')) return;
  await library.removeTitle(title);
  await refreshLibrary();
  notice(title + ' removed.');
});

