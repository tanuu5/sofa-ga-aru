// キーボード・マウス・タッチ・ゲームパッド
import { detectPadType } from './glyphs.js';

// 標準配置（standard mapping）のボタン番号
export const PAD = {
  south: 0,
  east: 1,
  west: 2,
  north: 3,
  l1: 4,
  r1: 5,
  l2: 6,
  r2: 7,
  select: 8,
  start: 9,
  l3: 10,
  r3: 11,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
};

// スティックの円形デッドゾーン
function radial(x, y, dead) {
  const l = Math.hypot(x, y);
  if (l < dead) return [0, 0];
  const k = Math.min(1, (l - dead) / (1 - dead)) / l;
  return [x * k, y * k];
}

const curve = (v) => Math.sign(v) * Math.pow(Math.abs(v), 1.7);

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.lookDX = 0;
    this.lookDY = 0;
    this.interact = false;
    this.standPressed = false;
    this.pausePressed = false;
    this.escPressed = false;
    this.locked = false;
    this.enabled = false;
    this.onLockChange = null;
    this.onDeviceChange = null;
    this.onPadChange = null;
    this.isTouch = window.matchMedia('(pointer: coarse)').matches && 'ontouchstart' in window;
    this.device = this.isTouch ? 'touch' : 'kbm';
    this.touchMove = { x: 0, z: 0 };
    this.touchIds = { move: null, look: null };
    this.touchLast = { x: 0, y: 0 };
    this.joyOrigin = { x: 0, y: 0 };
    // ゲームパッド
    this.gp = null;
    this.padId = '';
    this.padType = 'type2';
    this.pad = { x: 0, z: 0, run: false };
    this.padDown = new Uint8Array(17);
    this.padEdge = new Uint8Array(17);
    this.runToggle = false;
    // メニュー操作（押した瞬間と、押し続けたときの繰り返し）
    this.nav = { up: false, down: false, left: false, right: false, confirm: false, back: false };
    this.navHold = { up: -1, down: -1, left: -1, right: -1 };

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      this.setDevice('kbm');
      if (e.code === 'Escape') this.escPressed = true;
      if (!this.enabled) return;
      if (e.code === 'KeyE' || e.code === 'Space' || e.code === 'Enter') this.interact = true;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    // ポインターロックが使えない環境では、ドラッグで見回す
    this.noLock = false;
    this.dragging = false;
    document.addEventListener('mousemove', (e) => {
      const dx = e.movementX || 0;
      const dy = e.movementY || 0;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.setDevice('kbm');
      if (!this.locked && !(this.noLock && this.dragging && this.enabled)) return;
      // ポインターロック直後の大きな跳ねを無視
      if (Math.abs(dx) > 400 || Math.abs(dy) > 400) return;
      this.lookDX += dx;
      this.lookDY += dy;
    });
    document.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this.setDevice('kbm');
      if (!this.enabled) return;
      if (this.locked) this.interact = true;
      else if (e.target === this.canvas && !this.isTouch) {
        // ゲームパッドで始めたあとにマウスへ持ち替えたときや、Esc 直後にロックが外れたとき
        if (this.noLock) this.dragging = true;
        this.requestLock();
      }
    });
    document.addEventListener('mouseup', () => {
      this.dragging = false;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (this.locked) this.noLock = false;
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    document.addEventListener('pointerlockerror', () => {
      this.noLock = true;
    });
    window.addEventListener('gamepaddisconnected', () => {
      this.gp = null;
      if (this.device === 'pad') this.setDevice(this.isTouch ? 'touch' : 'kbm');
    });

    if (this.isTouch) this.initTouch();
  }

  setDevice(d) {
    if (this.device === d) return;
    this.device = d;
    if (this.onDeviceChange) this.onDeviceChange(d);
  }

  requestLock() {
    if (this.isTouch) return;
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => this.canvas.requestPointerLock());
    } catch (err) {
      void err;
      this.canvas.requestPointerLock();
    }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  initTouch() {
    const layer = document.getElementById('touch');
    const joy = document.getElementById('joy');
    const knob = document.getElementById('knob');
    const R = 56;
    const start = (e) => {
      this.setDevice('touch');
      if (!this.enabled) return;
      for (const t of e.changedTouches) {
        if (t.target.closest && t.target.closest('button')) continue;
        if (t.clientX < window.innerWidth * 0.45 && this.touchIds.move === null) {
          this.touchIds.move = t.identifier;
          this.joyOrigin = { x: t.clientX, y: t.clientY };
          joy.style.left = `${t.clientX}px`;
          joy.style.top = `${t.clientY}px`;
          joy.classList.add('on');
          knob.style.transform = 'translate(-50%, -50%)';
        } else if (this.touchIds.look === null) {
          this.touchIds.look = t.identifier;
          this.touchLast = { x: t.clientX, y: t.clientY };
        }
      }
      e.preventDefault();
    };
    const move = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.touchIds.move) {
          let dx = t.clientX - this.joyOrigin.x;
          let dy = t.clientY - this.joyOrigin.y;
          const l = Math.hypot(dx, dy);
          if (l > R) {
            dx = (dx / l) * R;
            dy = (dy / l) * R;
          }
          knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
          this.touchMove.x = dx / R;
          this.touchMove.z = -dy / R;
        } else if (t.identifier === this.touchIds.look) {
          this.lookDX += (t.clientX - this.touchLast.x) * 1.6;
          this.lookDY += (t.clientY - this.touchLast.y) * 1.6;
          this.touchLast = { x: t.clientX, y: t.clientY };
        }
      }
      e.preventDefault();
    };
    const end = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.touchIds.move) {
          this.touchIds.move = null;
          this.touchMove.x = this.touchMove.z = 0;
          joy.classList.remove('on');
        } else if (t.identifier === this.touchIds.look) {
          this.touchIds.look = null;
        }
      }
    };
    layer.addEventListener('touchstart', start, { passive: false });
    layer.addEventListener('touchmove', move, { passive: false });
    layer.addEventListener('touchend', end);
    layer.addEventListener('touchcancel', end);
    const act = document.getElementById('act');
    act.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.setDevice('touch');
      if (this.enabled) this.interact = true;
    });
    const pb = document.getElementById('pauseBtn');
    pb.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.pausePressed = true;
    });
  }

  // 毎フレーム、ゲームパッドの状態を読む（dt は実時間）
  poll(dt) {
    const nav = this.nav;
    nav.up = nav.down = nav.left = nav.right = nav.confirm = nav.back = false;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    for (const p of pads) {
      if (!p || !p.connected) continue;
      if (!gp || p.timestamp > gp.timestamp) gp = p;
    }
    this.gp = gp;
    if (!gp) {
      this.pad.x = this.pad.z = 0;
      this.pad.run = false;
      this.padDown.fill(0);
      return;
    }
    if (gp.id !== this.padId) {
      this.padId = gp.id;
      this.padType = detectPadType(gp.id);
      if (this.onPadChange) this.onPadChange(this.padType);
    }
    let active = false;
    for (let i = 0; i < 17; i++) {
      const b = gp.buttons[i];
      const down = b ? (b.pressed || b.value > 0.5 ? 1 : 0) : 0;
      this.padEdge[i] = down && !this.padDown[i] ? 1 : 0;
      this.padDown[i] = down;
      if (this.padEdge[i]) active = true;
    }
    const ax = gp.axes;
    const [mx, my] = radial(ax[0] || 0, ax[1] || 0, 0.17);
    const [lx, ly] = radial(ax[2] || 0, ax[3] || 0, 0.13);
    if (Math.hypot(mx, my) > 0.35 || Math.hypot(lx, ly) > 0.35) active = true;
    if (active) this.setDevice('pad');

    // 移動と視点（視点は秒あたりの量にして、画面の更新頻度に左右されないように）
    this.pad.x = mx;
    this.pad.z = -my;
    this.lookDX += curve(lx) * 1300 * dt;
    this.lookDY += curve(ly) * 900 * dt;
    // 走る：L2 / R2 を押している間、または L3 で切り替え（止まると解除）
    if (this.padEdge[PAD.l3]) this.runToggle = !this.runToggle;
    if (Math.hypot(mx, my) < 0.2) this.runToggle = false;
    this.pad.run = this.runToggle || !!this.padDown[PAD.l2] || !!this.padDown[PAD.r2];

    if (this.enabled && this.padEdge[PAD.south]) this.interact = true;
    if (this.enabled && this.padEdge[PAD.east]) this.standPressed = true;
    if (this.padEdge[PAD.start] || this.padEdge[PAD.select]) this.pausePressed = true;

    // メニュー用
    const rawX = ax[0] || 0;
    const rawY = ax[1] || 0;
    const held = {
      up: !!this.padDown[PAD.up] || rawY < -0.6,
      down: !!this.padDown[PAD.down] || rawY > 0.6,
      left: !!this.padDown[PAD.left] || rawX < -0.6,
      right: !!this.padDown[PAD.right] || rawX > 0.6,
    };
    for (const k of ['up', 'down', 'left', 'right']) {
      if (!held[k]) {
        this.navHold[k] = -1;
        continue;
      }
      if (this.navHold[k] < 0) {
        nav[k] = true;
        this.navHold[k] = 0.4;
      } else {
        this.navHold[k] -= dt;
        if (this.navHold[k] <= 0) {
          nav[k] = true;
          this.navHold[k] = 0.11;
        }
      }
    }
    nav.confirm = !!this.padEdge[PAD.south];
    nav.back = !!this.padEdge[PAD.east];
  }

  // 振動（対応しているゲームパッドとブラウザだけ）
  rumble(strong, weak, ms) {
    const act = this.gp && this.gp.vibrationActuator;
    if (!act || typeof act.playEffect !== 'function') return;
    try {
      const r = act.playEffect('dual-rumble', {
        startDelay: 0,
        duration: ms,
        strongMagnitude: strong,
        weakMagnitude: weak,
      });
      if (r && r.catch) r.catch(() => {});
    } catch (err) {
      void err;
    }
  }

  get moveX() {
    if (!this.enabled) return 0;
    let v = 0;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) v += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) v -= 1;
    return v + this.touchMove.x + this.pad.x;
  }

  get moveZ() {
    if (!this.enabled) return 0;
    let v = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) v += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) v -= 1;
    return v + this.touchMove.z + this.pad.z;
  }

  get run() {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.pad.run;
  }

  endFrame() {
    this.lookDX = 0;
    this.lookDY = 0;
    this.interact = false;
    this.standPressed = false;
    this.pausePressed = false;
    this.escPressed = false;
  }
}
