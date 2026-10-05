// 空間の生成。世界はトーラス（端と端がつながっている）
import * as THREE from 'three';
import { mulberry32, mod, wrapDelta } from './util.js';

export const CEIL = 2.7; // 天井の高さ
export const WALL_T = 0.2; // 壁の厚み

// 頂点 4 つを受け取り、指定の法線側から見て表になるように四角形を積む
class GeoAcc {
  constructor(withUv = false, withLight = false) {
    this.pos = [];
    this.nor = [];
    this.uv = withUv ? [] : null;
    this.lid = withLight ? [] : null;
    this.idx = [];
    this.count = 0;
  }

  quad(p, n, uvs = null, light = 0) {
    const base = this.count;
    for (let k = 0; k < 4; k++) {
      this.pos.push(p[k][0], p[k][1], p[k][2]);
      this.nor.push(n[0], n[1], n[2]);
      if (this.uv) this.uv.push(uvs ? uvs[k][0] : 0, uvs ? uvs[k][1] : 0);
      if (this.lid) this.lid.push(light);
    }
    // 巻き方向を法線に合わせる
    const ax = p[1][0] - p[0][0];
    const ay = p[1][1] - p[0][1];
    const az = p[1][2] - p[0][2];
    const bx = p[2][0] - p[0][0];
    const by = p[2][1] - p[0][1];
    const bz = p[2][2] - p[0][2];
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    const dot = cx * n[0] + cy * n[1] + cz * n[2];
    if (dot >= 0) this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    this.count += 4;
  }

  build() {
    if (this.count === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    if (this.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.lid) g.setAttribute('aLight', new THREE.Float32BufferAttribute(this.lid, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

export class World {
  constructor(opts) {
    this.opts = opts;
    this.type = opts.type;
    this.N = opts.N;
    this.cell = opts.cell;
    this.W = this.N * this.cell;
    const NN = this.N * this.N;
    // H[j*N+i]: z = j*cell の線上、x = i..i+1 の壁
    // V[j*N+i]: x = i*cell の線上、z = j..j+1 の壁
    this.H = new Uint8Array(NN);
    this.V = new Uint8Array(NN);
    this.P = new Uint8Array(NN); // 頂点 (i,j) に立つ独立した柱
    this.pillarSize = opts.pillarSize ?? 0.6;
    this.lights = [];
    this.rng = mulberry32(opts.seed ?? 1);
    this.spawn = { x: this.W / 2, z: this.W / 2, yaw: 0 };

    if (this.type === 'maze') this.genMaze();
    else if (this.type === 'pillars') this.genPillars();
    this.placeLights();
    if (this.type === 'maze') this.pickSpawn();
    this._boxes = [];
  }

  // ---------- 生成 ----------
  genMaze() {
    const { N, H, V, rng } = this;
    const o = this.opts;
    const segs = Math.floor(N * N * (o.segDensity ?? 0.11));
    for (let k = 0; k < segs; k++) {
      const i = (rng() * N) | 0;
      const j = (rng() * N) | 0;
      const len = 1 + ((rng() * (o.maxLen ?? 5)) | 0);
      if (rng() < 0.5) for (let t = 0; t < len; t++) H[j * N + mod(i + t, N)] = 1;
      else for (let t = 0; t < len; t++) V[mod(j + t, N) * N + i] = 1;
    }
    // 部屋：外周を壁で囲み、内側を空にして、出入口をあける
    const rooms = Math.floor(N * N * (o.roomDensity ?? 0.006));
    for (let k = 0; k < rooms; k++) {
      const w = 2 + ((rng() * 5) | 0);
      const h = 2 + ((rng() * 5) | 0);
      const i0 = (rng() * N) | 0;
      const j0 = (rng() * N) | 0;
      for (let a = 0; a < w; a++) {
        for (let b = 0; b < h; b++) {
          if (a > 0) V[mod(j0 + b, N) * N + mod(i0 + a, N)] = 0;
          if (b > 0) H[mod(j0 + b, N) * N + mod(i0 + a, N)] = 0;
        }
      }
      for (let t = 0; t < w; t++) {
        H[j0 * N + mod(i0 + t, N)] = 1;
        H[mod(j0 + h, N) * N + mod(i0 + t, N)] = 1;
      }
      for (let t = 0; t < h; t++) {
        V[mod(j0 + t, N) * N + i0] = 1;
        V[mod(j0 + t, N) * N + mod(i0 + w, N)] = 1;
      }
      const doors = 1 + ((rng() * 3) | 0);
      for (let d = 0; d < doors; d++) {
        const side = (rng() * 4) | 0;
        if (side < 2) {
          const t = (rng() * w) | 0;
          const jj = side === 0 ? j0 : mod(j0 + h, N);
          H[jj * N + mod(i0 + t, N)] = 0;
        } else {
          const t = (rng() * h) | 0;
          const ii = side === 2 ? i0 : mod(i0 + w, N);
          V[mod(j0 + t, N) * N + ii] = 0;
        }
      }
    }
    // 広い場所にぽつぽつと柱
    const pp = o.pillarProb ?? 0.02;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        if (!this.vertexHasWall(i, j) && rng() < pp) this.P[j * N + i] = 1;
      }
    }
    this.ensureConnected(N >> 1, N >> 1);
  }

  genPillars() {
    const { N, rng } = this;
    const o = this.opts;
    const s = o.pillarSpacing ?? 4;
    for (let j = 0; j < N; j += s) for (let i = 0; i < N; i += s) this.P[j * N + i] = 1;
    // ところどころ、意味もなく立っている壁
    const lonely = o.lonelyWalls ?? 20;
    for (let k = 0; k < lonely; k++) {
      const i = (rng() * N) | 0;
      const j = (rng() * N) | 0;
      const len = 1 + ((rng() * 2) | 0);
      if (rng() < 0.5) for (let t = 0; t < len; t++) this.H[j * N + mod(i + t, N)] = 1;
      else for (let t = 0; t < len; t++) this.V[mod(j + t, N) * N + i] = 1;
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) if (this.vertexHasWall(i, j)) this.P[j * N + i] = 0;
  }

  vertexHasWall(i, j) {
    const { N, H, V } = this;
    i = mod(i, N);
    j = mod(j, N);
    return !!(H[j * N + i] || H[j * N + mod(i - 1, N)] || V[j * N + i] || V[mod(j - 1, N) * N + i]);
  }

  // 孤立した領域がなくなるまで壁を抜く
  ensureConnected(si, sj) {
    const { N, H, V, rng } = this;
    const seen = new Uint8Array(N * N);
    const stack = [];
    const push = (i, j) => {
      const k = j * N + i;
      if (!seen[k]) {
        seen[k] = 1;
        stack.push(k);
      }
    };
    push(si, sj);
    let count = 0;
    for (;;) {
      while (stack.length) {
        const k = stack.pop();
        count++;
        const i = k % N;
        const j = (k / N) | 0;
        if (!V[j * N + mod(i + 1, N)]) push(mod(i + 1, N), j);
        if (!V[j * N + i]) push(mod(i - 1, N), j);
        if (!H[mod(j + 1, N) * N + i]) push(i, mod(j + 1, N));
        if (!H[j * N + i]) push(i, mod(j - 1, N));
      }
      if (count >= N * N) break;
      const cands = [];
      for (let k = 0; k < N * N; k++) {
        if (!seen[k]) continue;
        const i = k % N;
        const j = (k / N) | 0;
        if (V[j * N + mod(i + 1, N)] && !seen[j * N + mod(i + 1, N)]) cands.push([1, j * N + mod(i + 1, N), mod(i + 1, N), j]);
        if (V[j * N + i] && !seen[j * N + mod(i - 1, N)]) cands.push([1, j * N + i, mod(i - 1, N), j]);
        if (H[mod(j + 1, N) * N + i] && !seen[mod(j + 1, N) * N + i]) cands.push([0, mod(j + 1, N) * N + i, i, mod(j + 1, N)]);
        if (H[j * N + i] && !seen[mod(j - 1, N) * N + i]) cands.push([0, j * N + i, i, mod(j - 1, N)]);
      }
      if (!cands.length) break;
      const c = cands[(rng() * cands.length) | 0];
      if (c[0] === 1) V[c[1]] = 0;
      else H[c[1]] = 0;
      push(c[2], c[3]);
    }
    // 壁を抜いたあとに頂点に残った柱を整理
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) if (this.vertexHasWall(i, j)) this.P[j * N + i] = 0;
  }

  placeLights() {
    const { N, rng } = this;
    const o = this.opts;
    this.lightAt = new Int32Array(N * N).fill(-1);
    if (this.type === 'void') {
      const i = N >> 1;
      const j = N >> 1;
      this.addLight(i, j, false, false);
      return;
    }
    const s = o.lightSpacing ?? 2;
    for (let j = 0; j < N; j += s) {
      for (let i = 0; i < N; i += s) {
        const r = rng();
        const dead = r < (o.deadProb ?? 0.05);
        const flicker = !dead && r < (o.deadProb ?? 0.05) + (o.flickerProb ?? 0.02);
        this.addLight(i, j, dead, flicker);
      }
    }
  }

  addLight(i, j, dead, flicker) {
    const c = this.cell;
    const idx = this.lights.length;
    // パネルは 0.5m の天井タイルに合わせて置く（x 方向に 1m、z 方向に 0.5m）
    this.lights.push({ i, j, x: (i + 0.5) * c, z: (j + 0.5) * c - 0.25, dead, flicker, index: idx });
    this.lightAt[j * this.N + i] = idx;
  }

  pickSpawn() {
    // 明かりのある、ひらけた場所から始める
    const { rng } = this;
    let best = null;
    for (let tries = 0; tries < 400; tries++) {
      const L = this.lights[(rng() * this.lights.length) | 0];
      if (L.dead || L.flicker) continue;
      const open = this.cellOpenness(L.i, L.j);
      if (open < 3) continue;
      // 長く見通せる方向を向く
      let bestDir = 0;
      let bestLen = -1;
      for (let d = 0; d < 4; d++) {
        const len = this.runLength(L.i, L.j, d, 10);
        if (len > bestLen) {
          bestLen = len;
          bestDir = d;
        }
      }
      const score = open + bestLen * 0.6;
      if (!best || score > best.score) best = { L, dir: bestDir, score };
    }
    if (!best) return;
    const { L, dir } = best;
    const yaws = [-Math.PI / 2, Math.PI / 2, Math.PI, 0]; // +x, -x, +z, -z を向く yaw
    this.spawn = { x: (L.i + 0.5) * this.cell, z: (L.j + 0.5) * this.cell + 0.3, yaw: yaws[dir] };
  }

  cellOpenness(i, j) {
    const { N, H, V } = this;
    let n = 0;
    if (!V[j * N + mod(i + 1, N)]) n++;
    if (!V[j * N + i]) n++;
    if (!H[mod(j + 1, N) * N + i]) n++;
    if (!H[j * N + i]) n++;
    return n;
  }

  // dir: 0=+x 1=-x 2=+z 3=-z。壁にぶつかるまで何マス進めるか
  runLength(i, j, dir, max) {
    let n = 0;
    for (; n < max; n++) {
      if (this.edgeBlocked(i, j, dir)) break;
      if (dir === 0) i++;
      else if (dir === 1) i--;
      else if (dir === 2) j++;
      else j--;
    }
    return n;
  }

  edgeBlocked(i, j, dir) {
    const { N, H, V } = this;
    i = mod(i, N);
    j = mod(j, N);
    if (dir === 0) return !!V[j * N + mod(i + 1, N)];
    if (dir === 1) return !!V[j * N + i];
    if (dir === 2) return !!H[mod(j + 1, N) * N + i];
    return !!H[j * N + i];
  }

  // ---------- 形状 ----------
  buildMeshes(mats) {
    const { N, cell, W, H, V, P } = this;
    const t = WALL_T / 2;
    const CH = 8; // チャンクの一辺（マス）
    const nC = Math.ceil(N / CH);
    const chunkSize = CH * cell;
    const accs = [];
    for (let k = 0; k < nC * nC; k++) accs.push({ walls: new GeoAcc(), panels: new GeoAcc(true, true) });
    const accAt = (x, z) => {
      const ci = Math.min(nC - 1, Math.floor(mod(x, W) / chunkSize));
      const cj = Math.min(nC - 1, Math.floor(mod(z, W) / chunkSize));
      return accs[cj * nC + ci];
    };
    const y0 = 0;
    const y1 = CEIL;
    const vquad = (acc, ax, az, bx, bz, n) => {
      acc.quad(
        [
          [ax, y0, az],
          [bx, y0, bz],
          [bx, y1, bz],
          [ax, y1, az],
        ],
        n,
      );
    };

    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        if (H[k]) {
          const z = j * cell;
          const xa = i * cell + t;
          const xb = (i + 1) * cell - t;
          const acc = accAt((xa + xb) / 2, z).walls;
          vquad(acc, xa, z + t, xb, z + t, [0, 0, 1]);
          vquad(acc, xa, z - t, xb, z - t, [0, 0, -1]);
        }
        if (V[k]) {
          const x = i * cell;
          const za = j * cell + t;
          const zb = (j + 1) * cell - t;
          const acc = accAt(x, (za + zb) / 2).walls;
          vquad(acc, x + t, za, x + t, zb, [1, 0, 0]);
          vquad(acc, x - t, za, x - t, zb, [-1, 0, 0]);
        }
        // 壁の継ぎ目の小さな角柱
        const right = H[k];
        const left = H[j * N + mod(i - 1, N)];
        const down = V[k];
        const up = V[mod(j - 1, N) * N + i];
        if (right || left || down || up) {
          const x = i * cell;
          const z = j * cell;
          const acc = accAt(x, z).walls;
          if (!right) vquad(acc, x + t, z - t, x + t, z + t, [1, 0, 0]);
          if (!left) vquad(acc, x - t, z - t, x - t, z + t, [-1, 0, 0]);
          if (!down) vquad(acc, x - t, z + t, x + t, z + t, [0, 0, 1]);
          if (!up) vquad(acc, x - t, z - t, x + t, z - t, [0, 0, -1]);
        } else if (P[k]) {
          const x = i * cell;
          const z = j * cell;
          const p = this.pillarSize / 2;
          const acc = accAt(x, z).walls;
          vquad(acc, x + p, z - p, x + p, z + p, [1, 0, 0]);
          vquad(acc, x - p, z - p, x - p, z + p, [-1, 0, 0]);
          vquad(acc, x - p, z + p, x + p, z + p, [0, 0, 1]);
          vquad(acc, x - p, z - p, x + p, z - p, [0, 0, -1]);
        }
      }
    }

    // 蛍光灯のパネル
    const py = CEIL - 0.012;
    for (const L of this.lights) {
      const acc = accAt(L.x, L.z).panels;
      const x0 = L.x - 0.5;
      const x1 = L.x + 0.5;
      const z0 = L.z - 0.25;
      const z1 = L.z + 0.25;
      acc.quad(
        [
          [x0, py, z0],
          [x1, py, z0],
          [x1, py, z1],
          [x0, py, z1],
        ],
        [0, -1, 0],
        [
          [0, 0],
          [0, 1],
          [1, 1],
          [1, 0],
        ],
        L.index,
      );
      // 縁（ほんの少しだけ天井から出っ張る）
      const rim = [
        [x0, z0, x1, z0, [0, 0, -1]],
        [x0, z1, x1, z1, [0, 0, 1]],
        [x0, z0, x0, z1, [-1, 0, 0]],
        [x1, z0, x1, z1, [1, 0, 0]],
      ];
      for (const r of rim) {
        acc.quad(
          [
            [r[0], py, r[1]],
            [r[2], py, r[3]],
            [r[2], CEIL, r[3]],
            [r[0], CEIL, r[1]],
          ],
          r[4],
          [
            [0, 0],
            [0, 0],
            [0, 0],
            [0, 0],
          ],
          -1,
        );
      }
    }

    this.group = new THREE.Group();
    this.chunks = [];
    for (let cj = 0; cj < nC; cj++) {
      for (let ci = 0; ci < nC; ci++) {
        const a = accs[cj * nC + ci];
        const g = new THREE.Group();
        const wg = a.walls.build();
        if (wg) {
          const m = new THREE.Mesh(wg, mats.wall);
          m.matrixAutoUpdate = true;
          g.add(m);
        }
        const pg = a.panels.build();
        if (pg) g.add(new THREE.Mesh(pg, mats.panel));
        if (!g.children.length) continue;
        this.group.add(g);
        this.chunks.push({ group: g, cx: (ci + 0.5) * chunkSize, cz: (cj + 0.5) * chunkSize });
      }
    }

    // 床と天井は、カメラについていく大きな板（模様はワールド座標で決まる）
    const span = 180;
    const fg = new THREE.PlaneGeometry(span, span, 1, 1);
    fg.rotateX(-Math.PI / 2);
    this.floor = new THREE.Mesh(fg, mats.floor);
    this.floor.frustumCulled = false;
    const cg = new THREE.PlaneGeometry(span, span, 1, 1);
    cg.rotateX(Math.PI / 2);
    this.ceiling = new THREE.Mesh(cg, mats.ceiling);
    this.ceiling.position.y = CEIL;
    this.ceiling.frustumCulled = false;
    this.group.add(this.floor, this.ceiling);
    return this.group;
  }

  // カメラの近くに、各チャンクのいちばん近い像を置く
  updateView(camX, camZ) {
    const W = this.W;
    for (const ch of this.chunks) {
      ch.group.position.x = W * Math.round((camX - ch.cx) / W);
      ch.group.position.z = W * Math.round((camZ - ch.cz) / W);
    }
    this.floor.position.x = camX;
    this.floor.position.z = camZ;
    this.ceiling.position.x = camX;
    this.ceiling.position.z = camZ;
  }

  dispose() {
    if (!this.group) return;
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    this.group.removeFromParent();
  }

  // ---------- 衝突と見通し ----------
  // (x,z) の周り r 以内の箱 [minx, minz, maxx, maxz] を返す（座標は折り返さない）
  boxesNear(x, z, r) {
    const out = this._boxes;
    out.length = 0;
    const { N, cell, H, V, P } = this;
    const t = WALL_T / 2;
    const i0 = Math.floor((x - r) / cell) - 1;
    const i1 = Math.floor((x + r) / cell) + 1;
    const j0 = Math.floor((z - r) / cell) - 1;
    const j1 = Math.floor((z + r) / cell) + 1;
    for (let j = j0; j <= j1; j++) {
      const mj = mod(j, N);
      for (let i = i0; i <= i1; i++) {
        const k = mj * N + mod(i, N);
        if (H[k]) out.push([i * cell - t, j * cell - t, (i + 1) * cell + t, j * cell + t]);
        if (V[k]) out.push([i * cell - t, j * cell - t, i * cell + t, (j + 1) * cell + t]);
        if (P[k]) {
          const p = this.pillarSize / 2;
          out.push([i * cell - p, j * cell - p, i * cell + p, j * cell + p]);
        }
      }
    }
    return out;
  }

  // 円（プレイヤー）を壁の外へ押し出す
  collide(pos, r) {
    for (let iter = 0; iter < 3; iter++) {
      const boxes = this.boxesNear(pos.x, pos.z, r + 0.3);
      let moved = false;
      for (const b of boxes) {
        const qx = Math.max(b[0], Math.min(pos.x, b[2]));
        const qz = Math.max(b[1], Math.min(pos.z, b[3]));
        const dx = pos.x - qx;
        const dz = pos.z - qz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          pos.x += (dx / d) * (r - d);
          pos.z += (dz / d) * (r - d);
        } else {
          // 中心が箱の中：いちばん浅い方向へ
          const pl = pos.x - b[0] + r;
          const pr = b[2] - pos.x + r;
          const pt = pos.z - b[1] + r;
          const pb = b[3] - pos.z + r;
          const m = Math.min(pl, pr, pt, pb);
          if (m === pl) pos.x -= pl;
          else if (m === pr) pos.x += pr;
          else if (m === pt) pos.z -= pt;
          else pos.z += pb;
        }
        moved = true;
      }
      if (!moved) break;
    }
  }

  // 点が壁や柱の中にあるか（余白 margin つき）
  pointBlocked(x, z, margin = 0) {
    const boxes = this.boxesNear(x, z, margin + 0.5);
    for (const b of boxes) {
      if (x > b[0] - margin && x < b[2] + margin && z > b[1] - margin && z < b[3] + margin) return true;
    }
    return false;
  }

  // a→b の線分が壁か柱にさえぎられるか（2D、折り返さない座標で）
  segmentBlocked(ax, az, bx, bz, pillars = true) {
    const { N, cell, H, V, P } = this;
    const x = ax / cell;
    const z = az / cell;
    const ex = bx / cell;
    const ez = bz / cell;
    let ci = Math.floor(x);
    let cj = Math.floor(z);
    const ti = Math.floor(ex);
    const tj = Math.floor(ez);
    const dx = ex - x;
    const dz = ez - z;
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tmx = dx > 0 ? (ci + 1 - x) * tdx : dx < 0 ? (x - ci) * tdx : Infinity;
    let tmz = dz > 0 ? (cj + 1 - z) * tdz : dz < 0 ? (z - cj) * tdz : Infinity;
    const hasPillars = pillars && this.type !== 'void';
    const p = this.pillarSize / 2 / cell;
    for (let guard = 0; guard < 256; guard++) {
      if (hasPillars) {
        // このマスの四隅にある柱との交差
        for (let q = 0; q < 4; q++) {
          const vi = ci + (q & 1);
          const vj = cj + (q >> 1);
          if (!P[mod(vj, N) * N + mod(vi, N)]) continue;
          if (segBox(x, z, ex, ez, vi - p, vj - p, vi + p, vj + p)) return true;
        }
      }
      if (ci === ti && cj === tj) break;
      if (tmx < tmz) {
        if (tmx > 1) break;
        const lineX = stepX > 0 ? ci + 1 : ci;
        if (V[mod(cj, N) * N + mod(lineX, N)]) return true;
        ci += stepX;
        tmx += tdx;
      } else {
        if (tmz > 1) break;
        const lineZ = stepZ > 0 ? cj + 1 : cj;
        if (H[mod(lineZ, N) * N + mod(ci, N)]) return true;
        cj += stepZ;
        tmz += tdz;
      }
    }
    return false;
  }

  // 間にある壁の数（音のこもり具合に使う）
  wallsBetween(ax, az, bx, bz, max = 6) {
    const { N, cell, H, V } = this;
    const x = ax / cell;
    const z = az / cell;
    const ex = bx / cell;
    const ez = bz / cell;
    let ci = Math.floor(x);
    let cj = Math.floor(z);
    const ti = Math.floor(ex);
    const tj = Math.floor(ez);
    const dx = ex - x;
    const dz = ez - z;
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tmx = dx > 0 ? (ci + 1 - x) * tdx : dx < 0 ? (x - ci) * tdx : Infinity;
    let tmz = dz > 0 ? (cj + 1 - z) * tdz : dz < 0 ? (z - cj) * tdz : Infinity;
    let n = 0;
    for (let guard = 0; guard < 512 && (ci !== ti || cj !== tj); guard++) {
      if (tmx < tmz) {
        if (tmx > 1) break;
        const lineX = stepX > 0 ? ci + 1 : ci;
        if (V[mod(cj, N) * N + mod(lineX, N)]) n++;
        ci += stepX;
        tmx += tdx;
      } else {
        if (tmz > 1) break;
        const lineZ = stepZ > 0 ? cj + 1 : cj;
        if (H[mod(lineZ, N) * N + mod(ci, N)]) n++;
        cj += stepZ;
        tmz += tdz;
      }
      if (n >= max) break;
    }
    return n;
  }

  torusDist(ax, az, bx, bz) {
    return Math.hypot(wrapDelta(bx - ax, this.W), wrapDelta(bz - az, this.W));
  }
}

// 線分と箱の交差（スラブ法）
function segBox(ax, az, bx, bz, minx, minz, maxx, maxz) {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dz = bz - az;
  if (Math.abs(dx) < 1e-12) {
    if (ax < minx || ax > maxx) return false;
  } else {
    let ta = (minx - ax) / dx;
    let tb = (maxx - ax) / dx;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  if (Math.abs(dz) < 1e-12) {
    if (az < minz || az > maxz) return false;
  } else {
    let ta = (minz - az) / dz;
    let tb = (maxz - az) / dz;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}
