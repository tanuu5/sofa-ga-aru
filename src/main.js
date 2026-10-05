// ソファーがある。
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { createTextures } from './textures.js';
import { EnvMaterials, WaterShader } from './materials.js';
import { World, CEIL } from './world.js';
import { Lightmap } from './lightmap.js';
import { LightSystem } from './lights.js';
import { Sofa, sofaFits } from './sofa.js';
import { Player } from './player.js';
import { Input } from './input.js';
import { AudioEngine } from './audio.js';
import { Post } from './post.js';
import { UI } from './ui.js';
import { Director } from './director.js';
import { STAGES } from './stages.js';
import { clamp, mod, wrapDelta } from './util.js';

const STORE = 'sofa-ga-aru';

function loadJSON(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch (err) {
    void err;
    return fallback;
  }
}

function saveJSON(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch (err) {
    void err;
  }
}

class Game {
  constructor() {
    this.params = new URLSearchParams(location.search);
    this.debug = this.params.has('debug');
    this.canvas = document.getElementById('c');
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer = renderer;
    renderer.info.autoReset = false;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.scene.fog = new THREE.FogExp2(0x000000, 0.03);
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.05, 160);
    this.camera.rotation.order = 'YXZ';
    this.hemi = new THREE.HemisphereLight(0xfff2d8, 0x6a5530, 0);
    this.scene.add(this.hemi);

    this.input = new Input(this.canvas);
    this.ui = new UI(this.input.isTouch);
    this.textures = createTextures(renderer);
    this.mats = new EnvMaterials(this.textures);
    this.sofa = new Sofa(this.textures);
    this.scene.add(this.sofa.root);
    this.player = new Player();
    this.audio = new AudioEngine();
    this.post = new Post(renderer, this.scene, this.camera, { msaa: this.input.isTouch ? 0 : 4 });
    this.director = new Director(this);
    this.settings = loadJSON(`${STORE}.settings`, {
      volume: 0.8,
      sensScale: 1,
      bob: true,
      invertY: false,
      rumble: true,
      padType: 'auto',
    });
    this.cleared = loadJSON(`${STORE}.progress`, { cleared: false }).cleared;

    this.state = 'loading';
    this.time = 0;
    this.localLight = 1;
    this.globalLight = 1;
    this.fogOverride = null;
    this.lightColor = new THREE.Color(1, 1, 1);
    this.frustum = new THREE.Frustum();
    this._m = new THREE.Matrix4();
    this._v = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this.water = null;
    this.ripples = null;
    this.rippleIdx = 0;
    this.dripT = 1;
    this.endingReady = false;
    this.debugQuick = false;
    this.qualityScale = 1;
    // ?quality=high：描画解像度を自動で下げない（撮影や、性能に余裕がある環境向け）
    this.fixedQuality = this.params.get('quality') === 'high';
    this.pendingResize = false;
    this.timeScale = 1;
    this.fps = { t: 0, n: 0, el: null };

    this.player.onStep = (spd) => this.onStep(spd);
    this.input.onLockChange = (locked) => this.onLockChange(locked);
    this.input.onDeviceChange = () => this.refreshInputMode();
    this.input.onPadChange = () => this.refreshInputMode();
    this.navRoot = null;
    this.navIdx = 0;
    this.refreshInputMode();
    this.bindDom();
    this.resize();
    // 大きさの変更も次のコマを描く直前に行う（描いたあとに変えると一瞬黒くなる）
    window.addEventListener('resize', () => {
      this.pendingResize = true;
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'play') this.pause();
    });
    if (this.debug) this.initDebug();
    window.__game = this;

    this.lastT = performance.now();
    this.ui.setLoading(true);
    // 「準備しています」を描いてから重い計算に入る
    requestAnimationFrame(() =>
      setTimeout(() => {
        this.loadStage(1);
        this.lights.setAll(true);
        this.lightmap.flush();
        const sp = this.world.spawn;
        this.player.spawn(sp.x, sp.z, sp.yaw);
        this.titleYaw = sp.yaw;
        this.localLight = this.lightmap.sampleArea(sp.x, sp.z, 6) / this.lightmap.typical;
        this.state = 'title';
        this.ui.setLoading(false);
        this.ui.showTitle(this.cleared);
        requestAnimationFrame(this.frame);
      }, 30),
    );
  }

  // ---------- DOM ----------
  bindDom() {
    const $ = (id) => document.getElementById(id);
    $('start').addEventListener('click', () => this.start());
    $('pause').addEventListener('click', (e) => {
      if (e.target.closest('.panel-controls')) return;
      this.resume();
    });
    const vol = $('volume');
    vol.value = this.settings.volume;
    vol.addEventListener('input', () => {
      this.settings.volume = parseFloat(vol.value);
      this.audio.setVolume(this.settings.volume);
      saveJSON(`${STORE}.settings`, this.settings);
    });
    const sens = $('sens');
    sens.value = this.settings.sensScale;
    sens.addEventListener('input', () => {
      this.settings.sensScale = parseFloat(sens.value);
      saveJSON(`${STORE}.settings`, this.settings);
    });
    const bob = $('bob');
    bob.checked = this.settings.bob;
    bob.addEventListener('change', () => {
      this.settings.bob = bob.checked;
      saveJSON(`${STORE}.settings`, this.settings);
    });
    const invert = $('invert');
    invert.checked = this.settings.invertY;
    invert.addEventListener('change', () => {
      this.settings.invertY = invert.checked;
      saveJSON(`${STORE}.settings`, this.settings);
    });
    const rumble = $('rumble');
    rumble.checked = this.settings.rumble;
    rumble.addEventListener('change', () => {
      this.settings.rumble = rumble.checked;
      saveJSON(`${STORE}.settings`, this.settings);
      if (rumble.checked) this.rumble(0.25, 0.25, 120);
    });
    for (const b of document.querySelectorAll('#padtype [data-v]')) {
      b.addEventListener('click', () => this.setPadType(b.dataset.v));
    }
    this.markPadType();
    $('resumeBtn').addEventListener('click', () => this.resume());
    $('restart').addEventListener('click', () => location.reload());
    $('again').addEventListener('click', () => location.reload());
    $('stay').addEventListener('click', () => this.stay());
    // ゲームパッドで始めた場合など、音がまだ止まっているときは最初の操作で鳴らす
    const wake = () => {
      if (!this.audio.ready) return;
      this.audio.resume();
      setTimeout(() => this.checkAudio(), 250);
    };
    for (const ev of ['pointerdown', 'keydown', 'touchend']) document.addEventListener(ev, wake, true);
  }

  // ---------- 入力の種類とゲームパッド ----------
  get padType() {
    return this.settings.padType === 'auto' ? this.input.padType : this.settings.padType;
  }

  refreshInputMode() {
    this.ui.setInputMode(this.input.device, this.padType);
    this.applyNavFocus();
  }

  setPadType(v) {
    this.settings.padType = v;
    saveJSON(`${STORE}.settings`, this.settings);
    this.markPadType();
    this.refreshInputMode();
  }

  markPadType() {
    for (const b of document.querySelectorAll('#padtype [data-v]')) {
      const on = b.dataset.v === this.settings.padType;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  rumble(strong, weak, ms) {
    if (this.settings.rumble && this.input.device === 'pad') this.input.rumble(strong, weak, ms);
  }

  checkAudio() {
    const ctx = this.audio.ctx;
    this.ui.showAudioNotice(!!ctx && ctx.state !== 'running' && this.state !== 'paused' && this.state !== 'title');
  }

  // 開いている画面（タイトル・一時停止・おしまい）をゲームパッドで操作する
  navRootNow() {
    if (this.state === 'title') return document.getElementById('title');
    if (this.state === 'paused') return document.getElementById('pause');
    if (this.state === 'ending' && this.endingReady) return document.getElementById('ending');
    return null;
  }

  navItems(root) {
    return [...root.querySelectorAll('[data-nav]')].filter((el) => el.offsetParent !== null);
  }

  applyNavFocus() {
    for (const el of document.querySelectorAll('.nav-focus')) el.classList.remove('nav-focus');
    const root = this.navRoot;
    if (!root || this.input.device !== 'pad') return;
    const items = this.navItems(root);
    if (!items.length) return;
    this.navIdx = clamp(this.navIdx, 0, items.length - 1);
    items[this.navIdx].classList.add('nav-focus');
  }

  updatePadNav() {
    const root = this.navRootNow();
    if (root !== this.navRoot) {
      this.navRoot = root;
      this.navIdx = 0;
      this.applyNavFocus();
    }
    if (!root) return;
    const n = this.input.nav;
    if (!(n.up || n.down || n.left || n.right || n.confirm || n.back)) return;
    const items = this.navItems(root);
    if (!items.length) return;
    // 横並びのボタン（おしまいの画面）は左右でも移動する
    const horizontal = this.state === 'ending';
    if (n.up || (horizontal && n.left)) this.navIdx = (this.navIdx - 1 + items.length) % items.length;
    if (n.down || (horizontal && n.right)) this.navIdx = (this.navIdx + 1) % items.length;
    const el = items[clamp(this.navIdx, 0, items.length - 1)];
    if (!horizontal && (n.left || n.right)) this.navAdjust(el, n.right ? 1 : -1);
    if (n.confirm) this.navActivate(el);
    if (n.back && this.state === 'paused') this.resume();
    this.applyNavFocus();
  }

  navAdjust(el, dir) {
    const kind = el.dataset.nav;
    if (kind === 'range') {
      const input = el.querySelector('input');
      const min = parseFloat(input.min);
      const max = parseFloat(input.max);
      const step = (max - min) / 20;
      input.value = clamp(parseFloat(input.value) + step * dir, min, max);
      input.dispatchEvent(new Event('input'));
    } else if (kind === 'seg') {
      const opts = ['auto', 'type1', 'type2'];
      const i = opts.indexOf(this.settings.padType);
      this.setPadType(opts[(i + dir + opts.length) % opts.length]);
    } else if (kind === 'check') {
      this.navActivate(el);
    }
  }

  navActivate(el) {
    const kind = el.dataset.nav;
    if (kind === 'check') {
      const input = el.querySelector('input');
      input.checked = !input.checked;
      input.dispatchEvent(new Event('change'));
    } else if (kind === 'seg') {
      this.navAdjust(el, 1);
    } else if (kind === 'range') {
      // 何もしない（左右で動かす）
    } else {
      el.click();
    }
  }

  get playerSettings() {
    return {
      sens: 0.0021 * this.settings.sensScale,
      invertY: this.settings.invertY,
      bob: this.settings.bob,
    };
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const maxPr = this.input.isTouch ? 1.25 : 1.5;
    const pr = Math.min(window.devicePixelRatio || 1, maxPr) * this.qualityScale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.camera.aspect = aspect;
    // 縦長の画面でも横の視野が狭くなりすぎないように
    const hFov = 72;
    const vFromH = (2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(hFov / 2)) / aspect) * 180) / Math.PI;
    this.camera.fov = clamp(Math.max(66, aspect < 1 ? vFromH : 66), 50, 100);
    this.camera.updateProjectionMatrix();
    this.post.setSize(w, h, pr);
    if (this.water) this.water.getRenderTarget().setSize(Math.floor(w * pr * 0.5), Math.floor(h * pr * 0.5));
  }

  // ---------- 状態 ----------
  start() {
    if (this.state !== 'title') return;
    this.audio.init();
    this.audio.resume();
    this.audio.setVolume(this.settings.volume);
    this.audio.setReverb(this.stageDef.reverb);
    this.ui.hideTitle();
    this.ui.showTouch(true);
    this.state = 'play';
    this.input.enabled = true;
    if (this.input.device === 'kbm') this.input.requestLock();
    // ゲームパッドのボタンはブラウザの「ユーザー操作」に数えられないため、音が止まったままのことがある
    setTimeout(() => this.checkAudio(), 600);
    const jump = parseInt(this.params.get('stage') || '1', 10);
    if (jump >= 2 && jump <= 4) {
      const g = this;
      this.director.run(function* () {
        g.post.fade = 1;
        yield 0.3;
        g.post.fade = 0;
        g.lights.setAll(false);
        yield* this.transition(jump);
      });
    } else {
      this.director.run(this.director.stage1);
    }
  }

  pause() {
    if (this.state !== 'play') return;
    this.state = 'paused';
    this.input.enabled = false;
    this.ui.showPause(true);
    this.ui.showAudioNotice(false);
    this.audio.suspend();
    if (this.input.device === 'pad') this.input.exitLock();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'play';
    this.input.enabled = true;
    this.ui.showPause(false);
    this.audio.resume();
    if (this.input.device === 'kbm') this.input.requestLock();
    this.lastT = performance.now();
    setTimeout(() => this.checkAudio(), 400);
  }

  onLockChange(locked) {
    if (this.input.isTouch || this.input.noLock) return;
    if (!locked && this.state === 'play') this.pause();
  }

  beginEnding() {
    this.state = 'ending';
    this.input.enabled = false;
    this.ui.setPrompt(null);
    this.ui.showTouch(false);
  }

  stay() {
    if (this.state !== 'ending' || !this.endingReady) return;
    this.ui.showEnding(false);
    this.ui.showEndingButtons(false);
    this.ui.setHud(true);
    this.player.cutscene = null;
    this.player.seatInstant(this.sofa);
    this.player.lockSeat = false;
    this.world.ceiling.visible = true;
    for (const ch of this.world.chunks) ch.group.visible = true;
    this.fogOverride = null;
    this.state = 'play';
    this.input.enabled = true;
    this.ui.showTouch(true);
    if (this.input.device === 'kbm') this.input.requestLock();
  }

  markCleared() {
    this.cleared = true;
    saveJSON(`${STORE}.progress`, { cleared: true });
  }

  // ---------- 場所の読み込み ----------
  loadStage(n) {
    const def = STAGES[n];
    if (this.world) {
      this.world.dispose();
      this.lightmap.dispose();
      this.lights.dispose();
    }
    if (this.water) {
      this.scene.remove(this.water);
      this.water.dispose();
      this.water = null;
      this.ripples = null;
    }
    this.sofa.hide();
    this.stageId = n;
    this.stageDef = def;
    const t0 = performance.now();
    this.world = new World(def.world);
    this.lightmap = new Lightmap(this.world);
    this.lightmap.build();
    this.lightmap.measureTypical();
    this.lights = new LightSystem(this.world, this.lightmap, (def.world.seed || 1) + 11);
    this.lights.onEvent = (type, i) => this.onLightEvent(type, i);
    this.mats.bind(this.lightmap, this.lights, this.world.W);
    const sh = this.mats.shared;
    sh.uLightColor.value.setRGB(...def.lightColor);
    this.lightColor.setRGB(...def.lightColor);
    sh.uBounce.value = def.bounce;
    sh.uAmbient.value.setRGB(...def.ambient);
    sh.uWet.value = def.wet;
    sh.uWaterLevel.value = def.water ? def.water.level : 0.12;
    sh.uCeil.value = CEIL;
    this.scene.add(this.world.buildMeshes(this.mats));
    if (def.water) this.createWater(def.water.level);
    this.hemi.color.setRGB(...def.lightColor);
    this.hemi.groundColor.setRGB(def.lightColor[0] * 0.5, def.lightColor[1] * 0.4, def.lightColor[2] * 0.22);
    if (this.audio.ready) this.audio.setReverb(def.reverb);
    this.fogOverride = null;
    this.buildMs = performance.now() - t0;
    console.info(`[sofa] stage ${n}: ${this.buildMs.toFixed(0)} ms, ${this.world.lights.length} lights`);
  }

  createWater(level) {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const water = new Reflector(new THREE.PlaneGeometry(180, 180), {
      textureWidth: Math.max(256, Math.floor(size.x * 0.5)),
      textureHeight: Math.max(256, Math.floor(size.y * 0.5)),
      clipBias: 0.002,
      shader: WaterShader,
      multisample: this.input.isTouch ? 0 : 4,
    });
    water.rotation.x = -Math.PI / 2;
    water.position.y = level;
    water.material.transparent = true;
    water.material.premultipliedAlpha = true;
    water.material.depthWrite = false;
    water.renderOrder = 2;
    water.frustumCulled = false;
    water.material.uniforms.uWorldSize.value = this.world.W;
    this.scene.add(water);
    this.water = water;
    this.ripples = water.material.uniforms.uRipples.value;
  }

  addRipple(x, z, strength = 1) {
    if (!this.ripples) return;
    const W = this.world.W;
    this.ripples[this.rippleIdx].set(mod(x, W), mod(z, W), this.time, strength);
    this.rippleIdx = (this.rippleIdx + 1) % this.ripples.length;
  }

  // ---------- ソファーの置き場所 ----------
  hiddenFrom(px, pz, sx, sz, rot) {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const pts = [
      [0, 0],
      [-0.98, -0.44],
      [0.98, -0.44],
      [-0.98, 0.44],
      [0.98, 0.44],
      [0, 0.44],
      [0, -0.44],
    ];
    for (const [lx, lz] of pts) {
      const wx = sx + lx * c + lz * s;
      const wz = sz - lx * s + lz * c;
      if (!this.world.segmentBlocked(px, pz, wx, wz)) return false;
    }
    return true;
  }

  // ステージ 1：プレイヤーから見えない、少し先の部屋に置く
  spawnSofaHidden() {
    const w = this.world;
    const p = this.player;
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    const pi = Math.floor(p.x / w.cell);
    const pj = Math.floor(p.z / w.cell);
    const R = 7;
    let best = null;
    for (let dj = -R; dj <= R; dj++) {
      for (let di = -R; di <= R; di++) {
        const i = pi + di;
        const j = pj + dj;
        const cx = (i + 0.5) * w.cell;
        const cz = (j + 0.5) * w.cell;
        const dx = cx - p.x;
        const dz = cz - p.z;
        const d = Math.hypot(dx, dz);
        if (d < 5.5 || d > 14) continue;
        const li = w.lightAt[mod(j, w.N) * w.N + mod(i, w.N)];
        const lit = li >= 0 && this.lights.level[li] > 0.5 && !w.lights[li].flicker;
        for (let r = 0; r < 4; r++) {
          const rot = (r * Math.PI) / 2;
          let sx = cx;
          let sz = cz;
          if (lit) {
            sx = cx - Math.sin(rot) * 0.3;
            sz = cz - 0.25 - Math.cos(rot) * 0.3;
          }
          if (!sofaFits(w, sx, sz, rot, 1.2)) continue;
          if (!this.hiddenFrom(p.x, p.z, sx, sz, rot)) continue;
          const fd = (dx * fx + dz * fz) / d;
          const facing = (Math.sin(rot) * -dx + Math.cos(rot) * -dz) / d;
          const [vl, vc, vr] = this.viewDepth(sx, sz, rot, 12);
          if (vc < 3) continue;
          const view = Math.min(vc, 10) * 0.22 + Math.min(vl + vr, 12) * 0.06;
          const score = (lit ? 2.2 : 0) + fd * 1.4 + facing * 0.5 + view - Math.abs(d - 9) * 0.12 + Math.random() * 0.9;
          if (!best || score > best.score) best = { x: sx, z: sz, rot, score };
        }
      }
    }
    if (!best) return false;
    this.sofa.place(best.x, best.z, best.rot, w);
    return true;
  }

  // ソファーに座ったときの見通し（正面と左右斜め前、メートル）
  viewDepth(x, z, rot, max = 14) {
    const w = this.world;
    const out = [];
    for (const da of [-0.6, 0, 0.6]) {
      const a = rot + da;
      const sx = x + Math.sin(rot) * 0.5;
      const sz = z + Math.cos(rot) * 0.5;
      let d = 0;
      for (let step = 1.5; step <= max; step += 1.5) {
        if (w.segmentBlocked(sx, sz, sx + Math.sin(a) * step, sz + Math.cos(a) * step)) break;
        d = step;
      }
      out.push(d);
    }
    return out;
  }

  sofaPoseUnder(L, rot) {
    return { x: L.x - Math.sin(rot) * 0.3, z: L.z - Math.cos(rot) * 0.3 };
  }

  placeSofaForStage(n) {
    const w = this.world;
    if (n === 4) {
      const L = w.lights[0];
      const pz = this.sofaPoseUnder(L, 0);
      this.sofa.place(pz.x, pz.z, 0, w);
      return;
    }
    // 世界のまんなかあたりの、ひらけた明かりの下
    const c = w.W / 2;
    const cands = w.lights
      .filter((L) => !L.dead && !L.flicker)
      .map((L) => ({ L, d: w.torusDist(c, c, L.x, L.z) + Math.random() * 6 }))
      .sort((a, b) => a.d - b.d);
    const need = n === 2 ? 12 : 6;
    for (const { L } of cands) {
      for (let r = 0; r < 4; r++) {
        const rot = (r * Math.PI) / 2 + (n === 2 ? 0.12 : 0);
        const ps = this.sofaPoseUnder(L, rot);
        if (!sofaFits(w, ps.x, ps.z, rot, 3.0)) continue;
        const [vl, vc, vr] = this.viewDepth(ps.x, ps.z, rot, 14);
        if (vc < need || vl < need * 0.5 || vr < need * 0.5) continue;
        if (n === 2 && w.pointBlocked(ps.x, ps.z, 1.9)) continue;
        this.sofa.place(ps.x, ps.z, rot, w);
        return;
      }
    }
    this.sofa.place(c, c, 0, w);
  }

  placeSofaUnderLight(i) {
    const w = this.world;
    const L = w.lights[i];
    const p = this.player;
    let best = null;
    for (let r = 0; r < 8; r++) {
      const rot = (r * Math.PI) / 4 + 0.13;
      const ps = this.sofaPoseUnder(L, rot);
      if (!sofaFits(w, ps.x, ps.z, rot, 1.2)) continue;
      const dx = wrapDelta(p.x - ps.x, w.W);
      const dz = wrapDelta(p.z - ps.z, w.W);
      const d = Math.hypot(dx, dz) || 1;
      const [vl, vc, vr] = this.viewDepth(ps.x, ps.z, rot, 12);
      const facing = (Math.sin(rot) * dx + Math.cos(rot) * dz) / d + Math.min(vc, 12) * 0.08 + Math.min(vl + vr, 16) * 0.03;
      if (!best || facing > best.facing) best = { ...ps, rot, facing };
    }
    if (!best) best = { x: L.x, z: L.z - 0.3, rot: 0 };
    this.sofa.place(best.x, best.z, best.rot, w);
  }

  lightHasRoom(L) {
    for (let r = 0; r < 8; r++) {
      const rot = (r * Math.PI) / 4 + 0.13;
      const ps = this.sofaPoseUnder(L, rot);
      if (sofaFits(this.world, ps.x, ps.z, rot, 1.2)) return true;
    }
    return false;
  }

  pickBeacon() {
    const w = this.world;
    const p = this.player;
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    let best = -1;
    let bs = -1e9;
    for (const L of w.lights) {
      if (L.dead || L.flicker) continue;
      const dx = wrapDelta(L.x - p.x, w.W);
      const dz = wrapDelta(L.z - p.z, w.W);
      const d = Math.hypot(dx, dz);
      if (d < 17 || d > 27) continue;
      const fd = (dx * fx + dz * fz) / d;
      const score = fd * 2 + Math.random() * 0.6 - Math.abs(d - 22) * 0.03;
      if (score <= bs) continue;
      if (w.pointBlocked(L.x, L.z, 1.9)) continue;
      if (!this.lightHasRoom(L)) continue;
      bs = score;
      best = L.index;
    }
    if (best < 0) best = w.lights.find((L) => !L.dead).index;
    return best;
  }

  placeSofaFar(minD, maxD) {
    const w = this.world;
    const p = this.player;
    const cands = w.lights.filter((L) => {
      if (L.dead || L.flicker) return false;
      const d = w.torusDist(p.x, p.z, L.x, L.z);
      return d >= minD && d <= maxD;
    });
    for (let k = cands.length - 1; k > 0; k--) {
      const j = Math.floor(Math.random() * (k + 1));
      [cands[k], cands[j]] = [cands[j], cands[k]];
    }
    for (const L of cands) {
      for (let r = 0; r < 4; r++) {
        const rot = (r * Math.PI) / 2;
        const ps = this.sofaPoseUnder(L, rot);
        const ux = p.x + wrapDelta(ps.x - p.x, w.W);
        const uz = p.z + wrapDelta(ps.z - p.z, w.W);
        if (!sofaFits(w, ux, uz, rot, 1.2)) continue;
        if (!this.hiddenFrom(p.x, p.z, ux, uz, rot)) continue;
        if (this.viewDepth(ux, uz, rot, 6)[1] < 4.5) continue;
        this.sofa.place(ps.x, ps.z, rot, w);
        return true;
      }
    }
    this.placeSofaForStage(3);
    return false;
  }

  // ソファーが画面に映っているか（壁にさえぎられていないか）
  sofaInView(maxDist = 40) {
    const s = this.sofa;
    if (!s.active) return false;
    const cam = this.camera;
    const W = this.world.W;
    const cx = cam.position.x;
    const cz = cam.position.z;
    if (this.world.torusDist(cx, cz, s.x, s.z) > maxDist) return false;
    this.frustum.setFromProjectionMatrix(this._m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    for (const pt of s.samplePoints()) {
      const rx = cx + wrapDelta(pt.x - cx, W);
      const rz = cz + wrapDelta(pt.z - cz, W);
      let inF = false;
      for (const y of [0.1, 0.8]) {
        this._v.set(rx, y, rz);
        if (this.frustum.containsPoint(this._v)) {
          inF = true;
          break;
        }
      }
      if (!inF) continue;
      if (!this.world.segmentBlocked(cx, cz, rx, rz)) return true;
    }
    return false;
  }

  // ---------- 毎フレーム ----------
  frame = (now) => {
    requestAnimationFrame(this.frame);
    if (this.pendingResize) {
      this.pendingResize = false;
      this.resize();
    }
    const realDt = Math.min(0.05, Math.max(0, (now - this.lastT) / 1000));
    const dt = realDt * this.timeScale;
    this.lastT = now;
    this.renderer.info.reset();
    this.input.poll(realDt);
    if (this.input.pausePressed) {
      if (this.state === 'play') this.pause();
      else if (this.state === 'paused') this.resume();
      else if (this.state === 'title' && this.input.device === 'pad') this.start();
    } else if (this.input.escPressed && this.state === 'play' && !this.input.locked) {
      // マウスのロックがないとき（ゲームパッドで遊んでいるときなど）は Esc で止める
      this.pause();
    }
    this.updatePadNav();
    const playing = this.state === 'play' || this.state === 'ending';
    if (playing) {
      this.time += dt;
      this.updateInteraction();
      this.player.update(dt, this.input, this.world, this.sofa, this.playerSettings);
      this.director.update(dt);
    } else if (this.state === 'title') {
      this.time += dt;
      this.player.yaw = this.titleYaw + Math.sin(this.time * 0.11) * 0.22;
      this.player.pitch = -0.03 + Math.sin(this.time * 0.07) * 0.02;
      this.player.y = 1.62 + Math.sin(this.time * 0.5) * 0.004;
    }
    if (this.state !== 'paused') {
      this.lights.update(dt);
      this.lightmap.flush();
    }
    this.player.applyTo(this.camera);
    this.camera.updateMatrixWorld();
    const cx = this.camera.position.x;
    const cz = this.camera.position.z;
    this.world.updateView(cx, cz);
    this.sofa.update(cx, cz, this.world, this.lights, this.lightColor);
    this.updateAtmosphere(dt);
    this.updateAudio(dt);
    if (this.water) {
      this.water.position.x = cx;
      this.water.position.z = cz;
      this.water.material.uniforms.uTime.value = this.time;
    }
    this.mats.shared.uTime.value = this.time;
    this.ui.update(dt);
    this.post.render(this.time, dt);
    this.input.endFrame();
    this.adaptQuality(now);
    if (this.debug) this.updateDebug(dt);
  };

  // 重い端末では、描画解像度を少しずつ下げる（上げ直しはしない）
  adaptQuality(now) {
    if (this.state !== 'play' || this.timeScale !== 1 || this.fixedQuality) {
      this.perf = null;
      return;
    }
    if (!this.perf) this.perf = { t0: now, last: now, sum: 0, n: 0 };
    const p = this.perf;
    const ft = now - p.last;
    p.last = now;
    // 場所の読み込みなどの一瞬の引っかかりは数えない
    if (ft < 200) {
      p.sum += ft;
      p.n++;
    }
    if (now - p.t0 < 4000 || p.n < 30) return;
    const avg = p.sum / p.n;
    this.perf = null;
    if (avg > 24 && this.qualityScale > 0.62) {
      this.qualityScale = Math.max(0.6, this.qualityScale - 0.15);
      // 描き終えたあとにキャンバスの大きさを変えると、そのコマが消えて黒く点滅する。
      // 次のコマを描く前に変える
      this.pendingResize = true;
      console.info(`[sofa] quality → ${this.qualityScale.toFixed(2)} (${avg.toFixed(1)} ms/frame)`);
    }
  }

  updateInteraction() {
    const p = this.player;
    const s = this.sofa;
    let kind = null;
    if (this.state === 'play' && !p.anim && !p.cutscene) {
      if (p.seated) {
        if (!p.lockSeat) kind = 'stand';
      } else if (s.active) {
        const cam = this.camera;
        const dir = this._dir.set(0, 0, -1).applyQuaternion(cam.quaternion);
        const hit = s.rayHit(p.x, cam.position.y, p.z, dir.x, dir.y, dir.z);
        // ソファーの外形までの水平距離と、そちらを向いているか
        const lp = s.toLocal(p.x, p.z);
        const qx = clamp(lp.x, -1.0, 1.0);
        const qz = clamp(lp.z, -0.46, 0.46);
        const gap = Math.hypot(qx - lp.x, qz - lp.z);
        const c = Math.cos(s.rot);
        const sn = Math.sin(s.rot);
        const fx = -Math.sin(p.yaw);
        const fz = -Math.cos(p.yaw);
        const lfx = fx * c - fz * sn;
        const lfz = fx * sn + fz * c;
        // 足もとではなく、ソファーの中心寄りの点に向かっているか
        const tx = qx * 0.6 - lp.x;
        const tz = qz * 0.6 - lp.z;
        const tl = Math.hypot(tx, tz) || 1;
        const facing = (tx * lfx + tz * lfz) / tl;
        // 背もたれの裏側からは座れない
        const behind = lp.z < -0.3;
        if (!behind && ((hit >= 0 && hit < 3.2 && gap < 1.4) || (gap < 1.15 && facing > 0.5))) kind = 'sit';
      }
    }
    this.ui.setPrompt(kind);
    const wantStand = kind === 'stand' && this.input.standPressed;
    if ((this.input.interact && kind) || wantStand) {
      if (kind === 'sit') {
        p.sitOn(s, () => {
          this.audio.sit(true);
          this.rumble(0.35, 0.15, 110);
        });
      } else {
        p.standUp(s, () => {
          this.audio.sit(false);
          this.rumble(0.15, 0.1, 80);
        });
      }
    }
  }

  updateAtmosphere(dt) {
    const def = this.stageDef;
    const cam = this.camera.position;
    const raw = this.lightmap.sampleArea(cam.x, cam.z, 6) / this.lightmap.typical;
    this.localLight += (clamp(raw, 0, 1.4) - this.localLight) * (1 - Math.exp(-dt * 2.5));
    const k = Math.min(1, this.localLight);
    const fc = def.fog.color;
    const sh = this.mats.shared;
    sh.uFogColor.value.setRGB(fc[0] * k, fc[1] * k, fc[2] * k);
    // 世界全体でどれだけ点いているか
    let on = 0;
    let n = 0;
    const lv = this.lights.level;
    const Ls = this.world.lights;
    for (let i = 0; i < lv.length; i++) {
      if (Ls[i].dead) continue;
      on += lv[i];
      n++;
    }
    const gk = n ? Math.min(k, on / n) : 0;
    this.globalLight += (gk - this.globalLight) * (1 - Math.exp(-dt * 2));
    sh.uFogColorFar.value.setRGB(fc[0] * this.globalLight, fc[1] * this.globalLight, fc[2] * this.globalLight);
    const dens = this.fogOverride ? this.fogOverride.density : def.fog.density;
    sh.uFogDensity.value = dens;
    this.scene.fog.color.copy(sh.uFogColor.value);
    this.scene.fog.density = dens;
    this.scene.background.copy(sh.uFogColorFar.value);
    if (this.water) {
      this.water.material.uniforms.uFogColor.value.copy(sh.uFogColor.value);
      this.water.material.uniforms.uFogColorFar.value.copy(sh.uFogColorFar.value);
      this.water.material.uniforms.uFogDensity.value = dens;
    }
    if (this.sofa.active) {
      const ls = this.lightmap.sampleArea(this.sofa.x, this.sofa.z, 2.5);
      this.hemi.intensity = ls * 1.6;
    } else this.hemi.intensity = 0;
  }

  updateAudio(dt) {
    if (!this.audio.ready) return;
    const dir = this._dir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.audio.setListener(dir.x, dir.y, dir.z);
    if (this.state === 'play') this.audio.setHum(clamp(this.localLight, 0, 1.2) * this.stageDef.hum);
    this.audio.update(dt);
    if (this.stageDef.wet && this.state === 'play') {
      this.dripT -= dt;
      if (this.dripT <= 0) {
        this.dripT = 0.5 + Math.random() * 2.2;
        const a = Math.random() * Math.PI * 2;
        const r = 2.5 + Math.random() * 8;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        if (!this.world.segmentBlocked(this.player.x, this.player.z, this.player.x + x, this.player.z + z)) {
          this.audio.plip(x, -1.5, z, 0.8);
          this.addRipple(this.player.x + x, this.player.z + z, 0.6);
        }
      }
    }
  }

  onStep(spd) {
    const wet = !!this.stageDef.wet;
    this.audio.footstep(clamp(spd / 1.45, 0.5, 1.3), wet);
    if (wet) {
      const f = 0.15;
      this.addRipple(this.player.x - Math.sin(this.player.yaw) * f, this.player.z - Math.cos(this.player.yaw) * f, 1);
    }
  }

  onLightEvent(type, i) {
    if (!this.audio.ready || this.state === 'title') return;
    const L = this.world.lights[i];
    const cam = this.camera.position;
    const W = this.world.W;
    const x = wrapDelta(L.x - cam.x, W);
    const z = wrapDelta(L.z - cam.z, W);
    const kind = type === 'on' ? 'on' : this.lights.target[i] ? 'flick' : 'off';
    this.audio.lightClick(x, CEIL - cam.y, z, kind);
  }

  // ---------- デバッグ ----------
  initDebug() {
    const el = document.createElement('div');
    el.id = 'debug';
    document.body.appendChild(el);
    this.fps.el = el;
    window.addEventListener('keydown', (e) => {
      if (this.state !== 'play') return;
      if (e.code === 'KeyQ') this.debugQuick = true;
      if (e.code === 'KeyP') {
        const p = this.player;
        this.sofa.place(p.x - Math.sin(p.yaw) * 3, p.z - Math.cos(p.yaw) * 3, p.yaw, this.world);
      }
      if (e.code === 'KeyO') this.lights.setAll(!this.lights.target[0]);
    });
  }

  updateDebug(dt) {
    const f = this.fps;
    f.t += dt / this.timeScale;
    f.n++;
    if (f.t >= 0.5) {
      const info = this.renderer.info.render;
      f.el.textContent = `${(f.n / f.t).toFixed(0)} fps · stage ${this.stageId} · ${info.calls} calls · ${(info.triangles / 1000).toFixed(0)}k tri · pos ${this.player.x.toFixed(1)},${this.player.z.toFixed(1)}`;
      f.t = 0;
      f.n = 0;
    }
  }
}

function boot() {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) {
    document.getElementById('loading-text').textContent = 'WebGL2 is not available.';
    document.getElementById('loading').classList.add('show');
    return;
  }
  new Game();
}

boot();
