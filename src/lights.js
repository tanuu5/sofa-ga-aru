// 蛍光灯ひとつひとつの状態（点灯・消灯・ちらつき）
import * as THREE from 'three';
import { mulberry32 } from './util.js';

export class LightSystem {
  constructor(world, lightmap, seed = 99) {
    this.world = world;
    this.lightmap = lightmap;
    const n = (this.n = world.lights.length);
    this.target = new Uint8Array(n);
    this.level = new Float32Array(n);
    this.seq = new Array(n).fill(null);
    this.delay = new Float32Array(n).fill(-1);
    this.pending = new Uint8Array(n);
    this.flickT = new Float32Array(n);
    this.rng = mulberry32(seed);
    this.data = new Uint8Array(Math.max(1, n));
    const tex = new THREE.DataTexture(this.data, Math.max(1, n), 1, THREE.RedFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.texture = tex;
    this.onEvent = null;
    this.active = []; // 何かが動いている明かりの一覧
    this.activeFlag = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.flickT[i] = 1 + this.rng() * 8;
  }

  get lights() {
    return this.world.lights;
  }

  // すべてを即座に点ける／消す
  setAll(on) {
    for (let i = 0; i < this.n; i++) {
      const L = this.lights[i];
      this.seq[i] = null;
      this.delay[i] = -1;
      this.target[i] = on ? 1 : 0;
      this.apply(i, on && !L.dead ? 1 : 0);
    }
  }

  setTarget(i, on, delay = 0) {
    on = on ? 1 : 0;
    if (delay > 0) {
      this.delay[i] = delay;
      this.pending[i] = on;
      this.mark(i);
      return;
    }
    this.delay[i] = -1;
    if (this.target[i] === on) return;
    this.target[i] = on;
    const L = this.lights[i];
    if (L.dead) return;
    this.seq[i] = { steps: on ? this.startSteps() : this.dieSteps(), k: 0, t: 0 };
    this.mark(i);
  }

  mark(i) {
    if (!this.activeFlag[i]) {
      this.activeFlag[i] = 1;
      this.active.push(i);
    }
  }

  startSteps() {
    const r = this.rng;
    const s = [[0.02 + r() * 0.2, 0]];
    const blinks = 1 + ((r() * 3) | 0);
    for (let b = 0; b < blinks; b++) {
      s.push([0.03 + r() * 0.06, 0.55 + r() * 0.45]);
      s.push([0.05 + r() * 0.22, r() * 0.08]);
    }
    s.push([0.05, 0.85]);
    s.push([Infinity, 1]);
    return s;
  }

  dieSteps() {
    const r = this.rng;
    const s = [];
    const blinks = 1 + ((r() * 3) | 0);
    for (let b = 0; b < blinks; b++) {
      s.push([0.03 + r() * 0.07, r() * 0.15]);
      s.push([0.03 + r() * 0.08, 0.6 + r() * 0.4]);
    }
    s.push([Infinity, 0]);
    return s;
  }

  burstSteps() {
    const r = this.rng;
    const s = [];
    const n = 2 + ((r() * 6) | 0);
    for (let b = 0; b < n; b++) {
      s.push([0.02 + r() * 0.07, r() * 0.25]);
      s.push([0.03 + r() * 0.15, 0.7 + r() * 0.3]);
    }
    if (r() < 0.3) s.push([0.4 + r() * 1.2, 0.02]);
    s.push([Infinity, 1]);
    return s;
  }

  apply(i, v) {
    if (this.level[i] === v) return;
    const prev = this.level[i];
    this.level[i] = v;
    this.lightmap.setLevel(i, v);
    this.data[i] = Math.round(v * 255);
    this.texDirty = true;
    if (this.onEvent) {
      if (prev < 0.35 && v >= 0.5) this.onEvent('on', i);
      else if (prev >= 0.5 && v < 0.35) this.onEvent('off', i);
    }
  }

  update(dt) {
    const r = this.rng;
    // ちらつく明かりは、点いている間ときどき不安定になる
    for (let i = 0; i < this.n; i++) {
      const L = this.lights[i];
      if (!L.flicker || !this.target[i] || this.seq[i]) continue;
      this.flickT[i] -= dt;
      if (this.flickT[i] <= 0) {
        this.flickT[i] = 1.5 + r() * 9;
        this.seq[i] = { steps: this.burstSteps(), k: 0, t: 0 };
        this.mark(i);
      }
    }
    const next = [];
    for (const i of this.active) {
      let busy = false;
      if (this.delay[i] >= 0) {
        this.delay[i] -= dt;
        if (this.delay[i] <= 0) {
          this.delay[i] = -1;
          this.setTarget(i, this.pending[i]);
        } else busy = true;
      }
      const s = this.seq[i];
      if (s) {
        s.t += dt;
        while (s.k < s.steps.length - 1 && s.t >= s.steps[s.k][0]) {
          s.t -= s.steps[s.k][0];
          s.k++;
        }
        this.apply(i, s.steps[s.k][1]);
        if (s.k >= s.steps.length - 1) this.seq[i] = null;
        else busy = true;
      }
      if (busy) next.push(i);
      else this.activeFlag[i] = 0;
    }
    this.active = next;
    if (this.texDirty) {
      this.texture.needsUpdate = true;
      this.texDirty = false;
    }
  }

  // 一瞬の電圧降下（すべての点いている明かりが同時に揺らぐ）
  dip() {
    const r = this.rng;
    for (let i = 0; i < this.n; i++) {
      if (!this.target[i] || this.lights[i].dead || this.seq[i]) continue;
      this.seq[i] = {
        steps: [
          [0.05 + r() * 0.02, 0.35],
          [0.05, 0.9],
          [0.08, 0.5],
          [Infinity, 1],
        ],
        k: 0,
        t: 0,
      };
      this.mark(i);
    }
  }

  dispose() {
    this.texture.dispose();
  }
}
