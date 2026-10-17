// Host controls share one pad state. Sources are independent: releasing a
// finger must not release the same button still held by a key/another finger.
export const SCE_CTRL = Object.freeze({ select: 0x1, start: 0x8, up: 0x10, right: 0x20,
  down: 0x40, left: 0x80, l: 0x100, r: 0x200, triangle: 0x1000, circle: 0x2000,
  cross: 0x4000, square: 0x8000 });
export const keyMap = Object.freeze({
  ArrowUp: { buttons: SCE_CTRL.up, axes: [0, -1, 0, 0] },
  ArrowDown: { buttons: SCE_CTRL.down, axes: [0, 1, 0, 0] },
  ArrowLeft: { buttons: SCE_CTRL.left, axes: [-1, 0, 0, 0] },
  ArrowRight: { buttons: SCE_CTRL.right, axes: [1, 0, 0, 0] },
  KeyX: { buttons: SCE_CTRL.cross }, KeyC: { buttons: SCE_CTRL.circle },
  KeyZ: { buttons: SCE_CTRL.square }, KeyV: { buttons: SCE_CTRL.triangle },
  KeyQ: { buttons: SCE_CTRL.l }, KeyE: { buttons: SCE_CTRL.r },
  Enter: { buttons: SCE_CTRL.start }, ShiftRight: { buttons: SCE_CTRL.select },
  KeyI: { axes: [0, 0, 0, -1] }, KeyK: { axes: [0, 0, 0, 1] },
  KeyJ: { axes: [0, 0, -1, 0] }, KeyL: { axes: [0, 0, 1, 0] },
});

export function createPadState(send) {
  const sources = new Map();
  let last = '';
  function flush(force = false) {
    let buttons = 0;
    const axes = [0, 0, 0, 0];
    for (const state of sources.values()) {
      buttons |= state.buttons || 0;
      state.axes?.forEach((value, index) => { axes[index] += value; });
    }
    const state = { buttons, axes: axes.map((n) => Math.max(-1, Math.min(1, n))) };
    const signature = JSON.stringify(state);
    if (force || signature !== last) { last = signature; send(state); }
  }
  return {
    set(id, state) { sources.set(id, state); flush(); },
    release(id) { if (sources.delete(id)) flush(); },
    clear() { sources.clear(); flush(true); },
    flush,
  };
}

// Pointer capture keeps a held control alive outside its bounds, and ensures
// release/cancel reaches us. One pointer owns a stick; buttons allow many.
export function createTouchControls(root, pad, { enabled = () => true, onGesture = () => {} } = {}) {
  const pointers = new Map();
  const activations = new Set();
  let activationId = 0;
  const source = (id) => `pointer:${id}`;
  function paint() {
    let buttons = 0;
    for (const p of pointers.values()) buttons |= p.state.buttons || 0;
    for (const button of root.querySelectorAll('[data-button], [data-direction]')) {
      button.classList.toggle('pressed', Boolean(buttons & SCE_CTRL[button.dataset.button || button.dataset.direction]));
    }
  }
  function update(event, pointer, initial = false) {
    const { element, kind } = pointer;
    const rect = element.getBoundingClientRect();
    const dx = event.clientX - rect.left - rect.width / 2;
    const dy = event.clientY - rect.top - rect.height / 2;
    if (kind === 'stick') {
      const radius = rect.width * .36;
      const distance = Math.hypot(dx, dy);
      const magnitude = Math.max(0, Math.min(1, (distance / radius - .12) / .88));
      const axes = [0, 0, 0, 0];
      const axis = Number(element.dataset.stick);
      axes[axis] = distance ? dx / distance * magnitude : 0;
      axes[axis + 1] = distance ? dy / distance * magnitude : 0;
      pointer.state = { axes };
      const travel = Math.min(distance, radius);
      element.firstElementChild.style.transform = `translate(${distance ? dx / distance * travel : 0}px, ${distance ? dy / distance * travel : 0}px)`;
      element.classList.add('active');
    } else if (kind === 'dpad') {
      let buttons = 0;
      const direction = initial && event.target.closest('[data-direction]')?.dataset.direction;
      if (direction) buttons = SCE_CTRL[direction];
      else if (Math.hypot(dx, dy) > rect.width * .12) {
        // Angular sectors overlap, so one thumb can press a diagonal.
        if (Math.abs(dx) > Math.abs(dy) * .45) buttons |= dx < 0 ? SCE_CTRL.left : SCE_CTRL.right;
        if (Math.abs(dy) > Math.abs(dx) * .45) buttons |= dy < 0 ? SCE_CTRL.up : SCE_CTRL.down;
      }
      pointer.state = { buttons, axes: [Number(Boolean(buttons & SCE_CTRL.right)) - Number(Boolean(buttons & SCE_CTRL.left)),
        Number(Boolean(buttons & SCE_CTRL.down)) - Number(Boolean(buttons & SCE_CTRL.up)), 0, 0] };
    } else pointer.state = { buttons: SCE_CTRL[element.dataset.button] };
    pad.set(source(event.pointerId), pointer.state);
    paint();
  }
  function release(id) {
    const pointer = pointers.get(id);
    if (!pointer) return;
    pointers.delete(id);
    pad.release(source(id));
    if (pointer.kind === 'stick') {
      pointer.element.classList.remove('active');
      pointer.element.firstElementChild.style.transform = '';
    }
    if (pointer.element.hasPointerCapture(id)) pointer.element.releasePointerCapture(id);
    paint();
  }
  root.addEventListener('pointerdown', (event) => {
    if (!enabled() || event.button !== 0) return;
    const element = event.target.closest('[data-stick], [data-dpad], [data-button]');
    if (!element) return;
    event.preventDefault();
    onGesture();
    const kind = element.hasAttribute('data-stick') ? 'stick' : element.hasAttribute('data-dpad') ? 'dpad' : 'button';
    if (kind === 'stick' && [...pointers.values()].some((p) => p.element === element)) return;
    const pointer = { element, kind, state: {} };
    pointers.set(event.pointerId, pointer);
    element.setPointerCapture(event.pointerId);
    update(event, pointer, true);
  });
  root.addEventListener('pointermove', (event) => {
    const pointer = pointers.get(event.pointerId);
    if (!pointer) return;
    event.preventDefault();
    update(event, pointer);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
    root.addEventListener(type, (event) => release(event.pointerId));
  // Keyboard/assistive activation has no pointer events. Give it a short
  // press; ordinary touch/mouse clicks were already handled above.
  root.addEventListener('click', (event) => {
    if (event.detail !== 0 || !enabled()) return;
    const button = event.target.closest('[data-button], [data-direction]');
    if (!button) return;
    onGesture();
    const name = button.dataset.button || button.dataset.direction;
    const id = `activation:${++activationId}`;
    activations.add(id);
    pad.set(id, { buttons: SCE_CTRL[name], axes: [Number(name === 'right') - Number(name === 'left'),
      Number(name === 'down') - Number(name === 'up'), 0, 0] });
    setTimeout(() => { activations.delete(id); pad.release(id); }, 120);
  });
  root.addEventListener('contextmenu', (event) => event.preventDefault());
  return { clear() {
    for (const id of [...pointers.keys()]) release(id);
    for (const id of activations) pad.release(id);
    activations.clear();
  } };
}

// Gamepads (the Gamepad API's standard mapping: Xbox-style face buttons by
// position, so the bottom one is cross). Polled once per animation frame
// while any pad is connected; each pad is its own pad-state source.
const gamepadButtons = [
  [0, SCE_CTRL.cross], [1, SCE_CTRL.circle], [2, SCE_CTRL.square], [3, SCE_CTRL.triangle],
  [4, SCE_CTRL.l], [5, SCE_CTRL.r], [6, SCE_CTRL.l], [7, SCE_CTRL.r],
  [8, SCE_CTRL.select], [9, SCE_CTRL.start],
  [12, SCE_CTRL.up], [13, SCE_CTRL.down], [14, SCE_CTRL.left], [15, SCE_CTRL.right],
];
const kStickDeadZone = .2;
function stickAxes(x = 0, y = 0) {
  const magnitude = Math.hypot(x, y);
  if (magnitude < kStickDeadZone) return [0, 0];
  const scale = Math.min(1, (magnitude - kStickDeadZone) / (1 - kStickDeadZone)) / magnitude;
  return [x * scale, y * scale];
}
export function readGamepad(gamepad) {
  let buttons = 0;
  for (const [index, button] of gamepadButtons)
    if (gamepad.buttons[index]?.pressed) buttons |= button;
  // Without the standard mapping many pads report their D-pad as a hat on
  // axes 6 and 7 instead of buttons 12-15.
  if (gamepad.mapping !== 'standard' && gamepad.axes.length >= 8) {
    if (gamepad.axes[6] < -.5) buttons |= SCE_CTRL.left;
    if (gamepad.axes[6] > .5) buttons |= SCE_CTRL.right;
    if (gamepad.axes[7] < -.5) buttons |= SCE_CTRL.up;
    if (gamepad.axes[7] > .5) buttons |= SCE_CTRL.down;
  }
  return { buttons, axes: [...stickAxes(gamepad.axes[0], gamepad.axes[1]), ...stickAxes(gamepad.axes[2], gamepad.axes[3])] };
}

// enabled(): whether pads drive the guest; otherwise onPress(button) gets
// each newly pressed button (dialogs). onConnect(gamepad, connected) reports
// plugging in and out.
export function createGamepadInput(pad, { enabled = () => true, onPress = () => {}, onGesture = () => {}, onConnect = () => {} } = {}) {
  const held = new Map(); // gamepad index -> buttons last frame
  // Buttons held while the guest did not take the pad (a dialog answered
  // with cross) reach it only once released and pressed again.
  const suppressed = new Map();
  let frame = 0;
  const source = (index) => `gamepad:${index}`;
  function poll() {
    frame = 0;
    const gamepads = navigator.getGamepads?.() ?? [];
    let any = false;
    for (const gamepad of gamepads) {
      if (!gamepad?.connected) continue;
      any = true;
      const state = readGamepad(gamepad);
      const before = held.get(gamepad.index) ?? 0;
      held.set(gamepad.index, state.buttons);
      const pressed = state.buttons & ~before;
      if (pressed) onGesture();
      if (enabled()) {
        const mask = (suppressed.get(gamepad.index) ?? 0) & state.buttons;
        suppressed.set(gamepad.index, mask);
        pad.set(source(gamepad.index), { buttons: state.buttons & ~mask, axes: state.axes });
      } else {
        suppressed.set(gamepad.index, state.buttons);
        pad.release(source(gamepad.index));
        for (let bit = 1; bit <= pressed; bit <<= 1)
          if (pressed & bit) onPress(bit);
      }
    }
    if (any) frame = requestAnimationFrame(poll);
  }
  function start() { if (!frame) frame = requestAnimationFrame(poll); }
  addEventListener('gamepadconnected', (event) => { onConnect(event.gamepad, true); start(); });
  addEventListener('gamepaddisconnected', (event) => {
    held.delete(event.gamepad.index);
    suppressed.delete(event.gamepad.index);
    pad.release(source(event.gamepad.index));
    onConnect(event.gamepad, false);
  });
  // Pads connected before this page loaded show up once a button is pressed.
  if ((navigator.getGamepads?.() ?? []).some(Boolean)) start();
  return {
    connected() { return (navigator.getGamepads?.() ?? []).some((gamepad) => gamepad?.connected); },
    clear() { for (const index of held.keys()) pad.release(source(index)); },
  };
}
