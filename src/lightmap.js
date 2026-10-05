// 床に落ちる光を CPU で計算し、テクスチャにして全シェーダーで共有する。
// 壁による遮蔽つき。明かりごとの寄与を覚えておくので、点けたり消したりが安い。
import * as THREE from 'three';
import { CEIL } from './world.js';
import { smoothstep, mod } from './util.js';

export const LM_MAX = 3.0;

export class Lightmap {
  constructor(world, { res = 4, radius = 7.5 } = {}) {
    this.world = world;
    this.res = res;
    this.T = Math.round(world.W * res);
    this.radius = radius;
    this.win = Math.ceil(radius * res) * 2 + 2;
    const TT = this.T * this.T;
    this.lm = new Float32Array(TT);
    this.ao = new Float32Array(TT);
    this.data = new Uint8Array(TT * 4);
    const tex = new THREE.DataTexture(this.data, this.T, this.T, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = THREE.NoColorSpace;
    this.texture = tex;
    const n = world.lights.length;
    this.weights = new Array(n).fill(null);
    this.origin = new Int32Array(n * 2);
    this.level = new Float32Array(n);
    this.dirty = false;
    this.typical = 1;
  }

  build() {
    this.computeAO();
    const L = this.world.lights;
    for (let i = 0; i < L.length; i++) if (!L[i].dead) this.computeWeights(i);
    this.encodeAll();
  }

  computeAO() {
    const { T, res, world } = this;
    const aoFn = (d) => 0.55 + 0.45 * smoothstep(0, 0.6, d);
    for (let ty = 0; ty < T; ty++) {
      for (let tx = 0; tx < T; tx++) {
        const px = (tx + 0.5) / res;
        const pz = (ty + 0.5) / res;
        const boxes = world.boxesNear(px, pz, 0.7);
        let ao = 1;
        for (const b of boxes) {
          const qx = Math.max(b[0], Math.min(px, b[2]));
          const qz = Math.max(b[1], Math.min(pz, b[3]));
          const d = Math.hypot(px - qx, pz - qz);
          if (d < 0.6) ao *= aoFn(d);
        }
        this.ao[ty * T + tx] = Math.max(ao, 0.3);
      }
    }
  }

  computeWeights(i) {
    const { res, win, world, radius } = this;
    const L = world.lights[i];
    const ox = Math.floor(L.x * res) - (win >> 1);
    const oy = Math.floor(L.z * res) - (win >> 1);
    const w = new Float32Array(win * win);
    const h2 = CEIL * CEIL;
    const h4 = h2 * h2;
    const R2 = radius * radius;
    // パネルの面積ぶんの柔らかい影
    const sx = [-0.36, 0.36, -0.36, 0.36, 0];
    const sz = [-0.14, -0.14, 0.14, 0.14, 0];
    for (let ty = 0; ty < win; ty++) {
      const pz = (oy + ty + 0.5) / res;
      const dz = pz - L.z;
      for (let tx = 0; tx < win; tx++) {
        const px = (ox + tx + 0.5) / res;
        const dx = px - L.x;
        const r2 = dx * dx + dz * dz;
        if (r2 > R2) continue;
        const d2 = r2 + h2;
        let base = h4 / (d2 * d2);
        base *= smoothstep(radius, radius * 0.55, Math.sqrt(r2));
        if (base < 1e-4) continue;
        let vis = 0;
        for (let s = 0; s < 5; s++) {
          if (!world.segmentBlocked(px, pz, L.x + sx[s], L.z + sz[s])) vis++;
        }
        if (vis) w[ty * win + tx] = (base * vis) / 5;
      }
    }
    this.weights[i] = w;
    this.origin[i * 2] = ox;
    this.origin[i * 2 + 1] = oy;
  }

  // 明かり i の明るさ（0..1）を変える
  setLevel(i, v) {
    const w = this.weights[i];
    if (!w) return;
    const d = v - this.level[i];
    if (Math.abs(d) < 1e-4) return;
    this.level[i] = v;
    const { T, win, lm } = this;
    const ox = this.origin[i * 2];
    const oy = this.origin[i * 2 + 1];
    for (let ty = 0; ty < win; ty++) {
      const row = mod(oy + ty, T) * T;
      const wrow = ty * win;
      for (let tx = 0; tx < win; tx++) {
        const wv = w[wrow + tx];
        if (wv === 0) continue;
        lm[row + mod(ox + tx, T)] += wv * d;
      }
    }
    this.dirty = true;
  }

  encodeAll() {
    const { lm, ao, data } = this;
    const inv = 1 / LM_MAX;
    for (let k = 0, n = lm.length; k < n; k++) {
      let v = lm[k] * inv;
      if (v < 0) {
        v = 0;
        lm[k] = 0;
      } else if (v > 1) v = 1;
      data[k * 4] = Math.sqrt(v) * 255 + 0.5;
      data[k * 4 + 1] = ao[k] * 255 + 0.5;
      data[k * 4 + 2] = 0;
      data[k * 4 + 3] = 255;
    }
    this.texture.needsUpdate = true;
    this.dirty = false;
  }

  flush() {
    if (this.dirty) this.encodeAll();
  }

  // CPU 側での明るさの問い合わせ（双一次補間）
  sample(x, z) {
    const { T, res, lm } = this;
    const fx = x * res - 0.5;
    const fz = z * res - 0.5;
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const ux = fx - x0;
    const uz = fz - z0;
    const a = lm[mod(z0, T) * T + mod(x0, T)];
    const b = lm[mod(z0, T) * T + mod(x0 + 1, T)];
    const c = lm[mod(z0 + 1, T) * T + mod(x0, T)];
    const d = lm[mod(z0 + 1, T) * T + mod(x0 + 1, T)];
    return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
  }

  // 周囲の平均的な明るさ（霧の色や蛍光灯のうなりの大きさに使う）
  sampleArea(x, z, r = 5) {
    let s = 0;
    let n = 0;
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      s += this.sample(x + Math.cos(ang) * r, z + Math.sin(ang) * r);
      s += this.sample(x + Math.cos(ang) * r * 0.5, z + Math.sin(ang) * r * 0.5);
      n += 2;
    }
    s += this.sample(x, z) * 2;
    n += 2;
    return s / n;
  }

  // 全部点いたときの典型的な明るさ（正規化用）
  measureTypical() {
    let s = 0;
    for (const w of this.weights) {
      if (!w) continue;
      for (let k = 0; k < w.length; k++) s += w[k];
    }
    this.typical = Math.max(0.05, s / this.lm.length);
    return this.typical;
  }

  dispose() {
    this.texture.dispose();
  }
}
