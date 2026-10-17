// The player page (player.html): one game, its controls and diagnostics.
// The game itself runs in vita_session.js and the library (imports, saves,
// firmware) is library.js; both are shared with the app (browser/app).
import { SCE_CTRL, keyMap, createTouchControls, createGamepadInput } from './pad_input.js';
import * as library from './library.js';
import { resolveTarget, createSession, webgpuProblem, webgpuAdapterProblem, WORKER_OPTIONS } from './vita_session.js';

const params = new URLSearchParams(location.search);
const $ = (selector) => document.querySelector(selector);
// ?title=<id>&app=<dir> boots another title (a server-staged one, or a
// package this browser holds); ?source=package prefers the package of a
// title the server also stages.
let target;
try {
  target = await resolveTarget({ title: params.get('title') || '', app: params.get('app') || '', source: params.get('source') });
} catch (error) {
  $('#status').textContent = 'Unable to load player';
  const warning = $('#warning');
  warning.textContent = error.message; warning.style.display = 'block';
  throw error;
}
const { title: TITLE, app: APP, fromServer, stagedTitles } = target;
// Session settings from the query: the memory model and the
// worker.js switches (WORKER_OPTIONS).
const settings = {
  backend: 'jit',
  memory: ['w64', 'w32'].includes(params.get('memory')) ? params.get('memory') : 'auto',
  inlineMutex: params.get('inlineMutex') === '0' ? '0' : '1',
  present: params.get('present') === 'readback' ? 'readback' : 'canvas',
  fastVblank: params.get('fastvblank') === '1',
  patches: params.get('patches') ?? undefined,
  ...(params.has('buildAot') ? { buildAot: params.get('buildAot') } : {}),
};
for (const name of WORKER_OPTIONS) if (params.has(name)) settings[name] = params.get(name);

const status = $('#status'), stats = $('#stats'), logBox = $('#log'), runButton = $('#run'), stopButton = $('#stop');
const warningBox = $('#warning'), display = $('#display'), shell = $('#player-shell');
const welcome = $('#welcome'), fpsLabel = $('#fps'), screen = $('#screen');
const mib = (bytes) => (bytes / 1048576).toFixed(1);
function notice(message) {
  const element = $('#player-notice');
  element.textContent = message; element.hidden = !message;
}
function warn(message) { warningBox.textContent = message; warningBox.style.display = 'block'; }

// Logs keep their last 200 lines and update in batches.
const logLines = [];
let logDirty = false;
const log = (text) => {
  logLines.push(String(text));
  if (logLines.length > 200) logLines.splice(0, logLines.length - 200);
  logDirty = true;
};

const session = createSession({
  settings,
  // A canvas hands its control to one worker only: every run gets a new one.
  canvas: () => {
    const element = document.createElement('canvas');
    element.setAttribute('aria-label', 'Game video');
    element.id = 'gpu-screen'; element.width = 960; element.height = 544;
    $('#gpu-screen').replaceWith(element);
    return element;
  },
  pixels: screen,
});
session.on('log', log);
session.on('notice', notice);
session.on('status', (text) => { status.textContent = text; });
session.on('cache', (verdict) => { document.body.dataset.cacheVerdict = verdict; });
session.on('pixel-frame', () => { screen.hidden = false; });
session.on('first-frame', () => { welcome.hidden = true; });
session.on('frame', () => { welcome.hidden = true; });
session.on('running', () => {});
session.on('stopped', () => {
  dialog = null; dialogBox.hidden = true;
  ime = null; imeBox.hidden = true;
  runButton.disabled = false; stopButton.disabled = true;
  touch.clear(); gamepads.clear();
  updateTouchVisibility();
  if (!session.stats().frames) {
    welcome.querySelector('h2').textContent = 'Ready when you are.';
    welcome.querySelector('p').textContent = 'Press Play to launch the game.';
  }
});
// Launch status under the "Starting your game…" overlay: the phase, a
// byte-progress bar and counts while content is staged into the worker.
const launchStatus = $('#launch-status'), launchBar = $('#launch-bar');
session.on('launch', (state) => {
  launchStatus.hidden = !state;
  if (!state) return;
  $('#launch-phase').textContent = state.phase;
  $('#launch-detail').textContent = state.detail;
  const measured = Number.isFinite(state.fraction);
  launchBar.hidden = !measured;
  if (measured) $('#launch-fill').style.width = Math.round(Math.min(1, Math.max(0, state.fraction)) * 100) + '%';
});

$('#game-title').textContent = TITLE === 'PCSE00268' ? 'Limbo' : TITLE || 'No game yet';
document.title = 'Vita3K Web — ' + $('#game-title').textContent;
const buildAotShown = settings.buildAot ?? (settings.backend === 'jit' && !fromServer ? '1' : null);
$('#runtime-info').textContent = TITLE + ' · ' + settings.backend.toUpperCase() + ' · ' + settings.memory +
  (target.aotUrl ? ' · AOT' : buildAotShown === '1' || buildAotShown === 'only' ? ' · AOT at launch' : '') +
  (fromServer ? '' : ' · package');
// WebGPU is exposed only in a secure context, and may come without a usable
// adapter: say so before the run instead of letting the first draw fail.
const webgpuBlocked = webgpuProblem();
if (webgpuBlocked) warn(webgpuBlocked);
else webgpuAdapterProblem().then((problem) => { if (problem) warn(problem); });

// Diagnostics refresh twice a second.
setInterval(() => {
  if (session.active) showStats();
  if (logDirty) {
    logBox.textContent = logLines.join('\n'); logDirty = false;
    if ($('#diagnostics').open) logBox.scrollTop = logBox.scrollHeight;
  }
}, 500);
function showStats() {
  const s = session.stats();
  fpsLabel.textContent = s.frames ? s.fps.toFixed(0) + ' FPS' : '— FPS';
  const audio = s.audio ? ` audio=chunks=${s.audio.chunks} ${mib(s.audio.bytes)}MiB peak=${s.audio.peak} ctx=${s.audio.state}` : ' audio=off';
  stats.textContent = s.frames
    ? `frames=${s.frames} (gpu=${s.gpuFrames} pixels=${s.pixelFrames}) fps=${s.fps.toFixed(1)} elapsed=${s.elapsed.toFixed(1)}s first=${s.firstFrame.toFixed(1)}s${audio}`
    : `elapsed=${s.elapsed.toFixed(1)}s${audio}`;
}

// --- Guest dialogs and keyboard ---------------------------------------------
let dialog = null;
const dialogBox = $('#dialog');
function renderDialogButtons() {
  $('#dialog-buttons').replaceChildren(...dialog.buttons.map((label, index) => {
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
    if (dialog?.id === message.id) { dialog = null; dialogBox.hidden = true; updateTouchVisibility(); display.focus({ preventScroll: true }); }
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
  $('#dialog-message').textContent = message.message;
  const progress = $('#dialog-progress');
  progress.hidden = message.progress === null;
  if (message.progress !== null) progress.value = message.progress;
  renderDialogButtons();
  $('#dialog-hint').textContent = message.buttons.length
    ? (message.enterButton === 'circle' ? 'C (circle) selects · X (cross) backs out' : 'X (cross) selects · C (circle) backs out') : '';
  dialogBox.hidden = false;
  updateTouchVisibility();
  if (message.state === 'open') dialogBox.querySelector('button')?.focus({ preventScroll: true });
});
function dialogButton(button) {
  if (button === SCE_CTRL.left || button === SCE_CTRL.right) {
    const last = Math.max(0, dialog.buttons.length - 1);
    dialog.selected = Math.max(0, Math.min(last, dialog.selected + (button === SCE_CTRL.right ? 1 : -1)));
    renderDialogButtons();
    dialogBox.querySelector('button.selected')?.focus({ preventScroll: true });
  } else if (button === SCE_CTRL.cross || button === SCE_CTRL.circle) {
    session.pressDialog(dialog.id, button, dialog.selected);
  }
}
let ime = null;
const imeBox = $('#ime'), imeText = $('#ime-text');
const sendIme = (kind) => session.sendIme(ime.id, kind, imeText.value, imeText.selectionStart ?? imeText.value.length);
session.on('ime', (message) => {
  if (message.state === 'close') {
    log(`ime ${message.id} closed`);
    if (ime?.id === message.id) { ime = null; imeBox.hidden = true; imeText.blur(); updateTouchVisibility(); display.focus({ preventScroll: true }); }
    return;
  }
  log(`ime ${message.id}: ${JSON.stringify(message.text)} max=${message.maxLength}`);
  // The keyboard takes the keys, as the Vita's does.
  clearInputs();
  ime = { id: message.id };
  imeText.value = message.text;
  imeText.maxLength = message.maxLength;
  $('#ime-enter').textContent = message.enterLabel || 'Enter';
  imeBox.hidden = false;
  updateTouchVisibility();
  imeText.focus();
  imeText.setSelectionRange(message.caret, message.caret);
});
imeText.addEventListener('input', () => { if (ime) sendIme(0); });
imeText.addEventListener('keyup', (event) => { if (ime && event.key.startsWith('Arrow')) sendIme(0); });
imeBox.addEventListener('submit', (event) => { event.preventDefault(); if (ime) { sendIme(0); sendIme(1); } });
$('#ime-close').onclick = () => { if (ime) sendIme(2); };

// --- Input --------------------------------------------------------------------
const pad = session.pad;
const touchRoot = $('#touch-controls');
// Touch controls and gamepads take presses while the game loads too: what is
// held when it starts reaches it at once.
const touch = createTouchControls(touchRoot, pad, { enabled: () => !dialog && !ime, onGesture: session.ensureAudio });
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

const touchToggle = $('#touch-toggle'), touchMode = $('#touch-mode');
const coarsePointer = matchMedia('(any-pointer: coarse)');
function readPreference(key, fallback) {
  try { return localStorage.getItem('vita3k.' + key) ?? fallback; } catch { return fallback; }
}
function writePreference(key, value) {
  try { localStorage.setItem('vita3k.' + key, value); } catch { /* private browsing */ }
}
touchMode.value = readPreference('touch', 'auto') || 'auto';
// auto: touch screens show the controls, unless a gamepad is connected.
function wantsTouch() { return touchMode.value === 'on' || (touchMode.value === 'auto' && !gamepads.connected() && (coarsePointer.matches || navigator.maxTouchPoints > 0)); }
function updateTouchVisibility() {
  touch.clear();
  const visible = wantsTouch() && !dialog && !ime;
  touchRoot.hidden = !visible;
  display.classList.toggle('touch-visible', visible);
  touchToggle.setAttribute('aria-pressed', String(wantsTouch()));
}
touchMode.onchange = () => { writePreference('touch', touchMode.value); updateTouchVisibility(); };
touchToggle.onclick = () => { touchMode.value = wantsTouch() ? 'off' : 'on'; touchMode.onchange(); };
coarsePointer.addEventListener('change', updateTouchVisibility);
for (const [id, property, fallback] of [['touch-opacity', '--control-opacity', 65], ['touch-size', '--preferred-control-scale', 100]]) {
  const input = document.getElementById(id);
  const stored = Number(readPreference(id, fallback));
  input.value = Number.isFinite(stored) ? Math.max(Number(input.min), Math.min(Number(input.max), stored)) : fallback;
  const apply = () => { touch.clear(); document.documentElement.style.setProperty(property, Number(input.value) / 100); };
  input.oninput = apply;
  input.onchange = () => writePreference(id, input.value);
  apply();
}
updateTouchVisibility();

const muteButton = $('#mute');
muteButton.onclick = () => {
  session.setMuted(!session.muted);
  const muted = session.muted;
  muteButton.textContent = muted ? 'Sound off' : 'Sound on';
  muteButton.setAttribute('aria-pressed', String(muted));
  muteButton.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
};
const fullscreenButton = $('#fullscreen');
function updateFullscreen() {
  clearInputs();
  const expanded = Boolean(document.fullscreenElement) || shell.classList.contains('expanded');
  fullscreenButton.textContent = expanded ? 'Exit full' : 'Fullscreen';
  fullscreenButton.setAttribute('aria-label', expanded ? 'Exit fullscreen' : 'Enter fullscreen');
}
fullscreenButton.onclick = async () => {
  notice(''); clearInputs();
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (shell.classList.contains('expanded')) { shell.classList.remove('expanded'); document.body.classList.remove('player-expanded'); }
    else if (shell.requestFullscreen && document.fullscreenEnabled) await shell.requestFullscreen();
    else { shell.classList.add('expanded'); document.body.classList.add('player-expanded'); }
  } catch (error) { notice('Fullscreen is unavailable: ' + error.message); }
  updateFullscreen();
};
document.addEventListener('fullscreenchange', updateFullscreen);
addEventListener('keydown', (event) => {
  if (event.code === 'Escape' && shell.classList.contains('expanded')) {
    shell.classList.remove('expanded'); document.body.classList.remove('player-expanded'); updateFullscreen();
  }
});

// --- Library: imports, saves, firmware, titles ------------------------------
// Uploads are serialized against runs: a run is active exactly while Stop
// is enabled.
const uploadButton = $('#upload'), uploadInput = $('#upload-file');
const firmwareButton = $('#upload-firmware'), firmwareInput = $('#firmware-file');
if (!library.storageSupported()) {
  $('#upload-row').hidden = true; $('#firmware-row').hidden = true;
} else {
  for (const [button, input] of [[uploadButton, uploadInput], [firmwareButton, firmwareInput]]) {
    button.onclick = () => {
      if (session.active) { notice('Stop the game before uploading.'); return; }
      input.click();
    };
    input.onchange = () => {
      const file = input.files?.[0];
      input.value = '';
      if (file) importFile(file, input === firmwareInput ? 'firmware' : 'game');
    };
  }
}
async function importFile(file, expect) {
  const wasDisabled = runButton.disabled;
  runButton.disabled = true; uploadButton.disabled = true; firmwareButton.disabled = true;
  const started = performance.now();
  let lastNotice = 0;
  const throttled = (text) => {
    const now = performance.now();
    if (now - lastNotice < 200) return;
    lastNotice = now;
    notice(text);
  };
  const verbs = { load: 'Loading', prepare: 'Preparing', inflate: 'Inflating', unpack: 'Unpacking', decrypt: 'Decrypting', install: 'Installing', store: 'Storing' };
  try {
    const result = await library.importFile(file, {
      expect,
      zrif: (name) => prompt(`${name} needs its license: paste its zRIF (a long string that starts with KO5i, as NoPayStation lists it).`),
      onProgress: ({ phase, path, bytes, total }) =>
        throttled(`${verbs[phase] ?? phase} ${path} — ${mib(bytes)}${total ? '/' + mib(total) : ''} MiB`),
    });
    const secs = Math.round((performance.now() - started) / 1000);
    if (result.kind === 'firmware') {
      log(`firmware${result.version ? ' ' + result.version : ''} stored from ${file.name}: ${result.roots ? result.roots.join(', ') + ', ' : ''}` +
        `${result.files} files · ${mib(result.bytes)} MiB in ${secs}s`);
      notice(`Firmware${result.version ? ' ' + result.version : ''} ready: ${result.files} files · ${mib(result.bytes)} MiB.` +
        (TITLE ? ' Press Play.' : ' Now upload a game.'));
      await refreshFirmwareStatus();
      return;
    }
    log(`package stored: ${result.title} — ${result.files} files · ${mib(result.bytes)} MiB in ${secs}s` +
      (result.decrypted ? ' (decrypted)' : ''));
    // A static host's first game: reload into it.
    if (!TITLE) { location.search = new URLSearchParams({ ...Object.fromEntries(params), title: result.title }).toString(); return; }
    await refreshTitlePicker();
    titlePicker.value = `package:${result.title}`;
    notice(result.title === TITLE && !fromServer
      ? `Package ready: ${result.files} files · ${mib(result.bytes)} MiB. Press Play.`
      : `Package ready: ${result.title} — ${result.files} files · ${mib(result.bytes)} MiB. Pick it in Title, then Play.`);
  } catch (error) {
    log('package upload failed: ' + (error?.message ?? error));
    notice('Upload failed: ' + (error?.message ?? error));
  } finally {
    runButton.disabled = wasDisabled; uploadButton.disabled = false; firmwareButton.disabled = false;
  }
}
async function refreshFirmwareStatus() {
  const firmware = await library.firmwareStatus();
  const parts = [firmware.system ? 'system software' : null, firmware.fonts ? 'fonts' : null].filter(Boolean);
  $('#firmware-state').textContent = firmware.files
    ? `stored: ${parts.join(' + ')} (${firmware.files} files)${firmware.system && !firmware.fonts ? ' · font package missing' : ''}`
    : target.isStatic ? 'needed' : 'from the server';
}
refreshFirmwareStatus();

// Saves of the title as a .zip laid out like the Vita filesystem, and back.
$('#download-saves').onclick = async () => {
  if (!library.storageSupported()) { notice('This browser has no persistent storage, so there are no saves to download.'); return; }
  const zip = await library.savesZip(TITLE);
  if (!zip) { notice(`No saves for ${TITLE} in this browser yet.`); return; }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(zip);
  link.download = `${TITLE}-saves.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  log(`saves: downloaded for ${TITLE}`);
};
const savesInput = $('#saves-file');
$('#upload-saves').onclick = () => {
  if (!TITLE) { notice('Upload a game first: saves belong to a title.'); return; }
  if (session.active) { notice('Stop the game before restoring saves.'); return; }
  if (!library.storageSupported()) { notice('This browser has no persistent storage for saves.'); return; }
  savesInput.click();
};
savesInput.onchange = async () => {
  const file = savesInput.files?.[0];
  savesInput.value = '';
  if (!file) return;
  try {
    const count = await library.restoreSaves(TITLE, file, { confirmReplace: (existing, incoming) =>
      confirm(`Replace the ${existing} save file(s) of ${TITLE} in this browser with ${incoming} from ${file.name}?`) });
    if (!count) return;
    log(`saves: restored ${count} file(s) for ${TITLE} from ${file.name}`);
    notice(`Restored ${count} save file(s) for ${TITLE}. Press Play.`);
  } catch (error) {
    log('saves upload failed: ' + (error?.message ?? error));
    notice('Saves upload failed: ' + (error?.message ?? error));
  }
};

// Title picker: the server's staged titles plus this browser's packages; a
// title both staged and uploaded is listed twice (value <source>:<id>).
const titlePicker = $('#title-picker');
const currentChoice = `${fromServer ? 'server' : 'package'}:${TITLE}`;
async function refreshTitlePicker() {
  const showTitles = (uploaded) => {
    const choices = new Map();
    for (const id of stagedTitles) choices.set(`server:${id}`, `${id} · server`);
    for (const entry of uploaded) choices.set(`package:${entry.title}`, `${entry.title} · package (${entry.files})`);
    if (TITLE && !choices.has(currentChoice)) choices.set(currentChoice, `${TITLE} · ${fromServer ? 'server' : 'package'}`);
    titlePicker.replaceChildren(...[...choices].sort(([a], [b]) =>
      a.slice(a.indexOf(':') + 1).localeCompare(b.slice(b.indexOf(':') + 1)) || b.localeCompare(a)).map(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }));
    titlePicker.value = currentChoice;
    titlePicker.disabled = false;
  };
  showTitles([]);
  showTitles(await library.listPackages());
}
titlePicker.onchange = () => {
  const next = new URLSearchParams(location.search.replace(/^\?/, ''));
  const [source, id] = titlePicker.value.split(':');
  next.set('title', id);
  next.delete('app');
  if (source === 'package' && stagedTitles.includes(id)) next.set('source', 'package');
  else next.delete('source');
  location.search = next.toString();
};
refreshTitlePicker();

// --- Run -------------------------------------------------------------------
$('#beep').onclick = () => { session.beep(); log('audio: beep'); };
async function run() {
  if (!TITLE) { notice('Upload the firmware and a game package first (below the player).'); return; }
  notice('');
  logBox.textContent = ''; logLines.length = 0; logDirty = false;
  welcome.hidden = false;
  welcome.querySelector('h2').textContent = 'Starting your game…';
  welcome.querySelector('p').textContent = 'The first launch can take a little while.';
  display.focus({ preventScroll: true });
  screen.hidden = true;
  $('#gpu-screen').hidden = settings.present === 'readback';
  if (webgpuBlocked) log('warning: ' + webgpuBlocked);
  await session.start(target);
  runButton.disabled = true; stopButton.disabled = false;
}
runButton.disabled = false;
runButton.onclick = () => run().catch((error) => { log('ERROR ' + error.message); status.textContent = 'Launch failed'; notice(error.message); session.stop(null); });
stopButton.onclick = () => session.stop('Stopped');
if (params.get('auto') === '1') runButton.click();
