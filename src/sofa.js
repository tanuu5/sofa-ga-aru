// ソファー。すべてコードで組み立てる
import * as THREE from 'three';
import { CEIL } from './world.js';
import { wrapDelta, mod, clamp, smoothstep } from './util.js';

export const SOFA_HW = 1.0; // 幅の半分
export const SOFA_HD = 0.46; // 奥行きの半分

// 角の丸い箱を細かい格子で作り、deform で形を変えてから法線を計算する
function cushionGeometry(w, h, d, r, spacing, deform) {
  const half = { x: w / 2, y: h / 2, z: d / 2 };
  const inner = { x: half.x - r, y: half.y - r, z: half.z - r };
  const faces = [
    ['x', 'z', 'y', 1],
    ['x', 'z', 'y', -1],
    ['y', 'x', 'z', 1],
    ['y', 'x', 'z', -1],
    ['z', 'x', 'y', 1],
    ['z', 'x', 'y', -1],
  ];
  const pos = [];
  const uv = [];
  const idx = [];
  const p = { x: 0, y: 0, z: 0 };
  for (const [na, ua, va, sg] of faces) {
    const nu = Math.max(2, Math.ceil((2 * half[ua]) / spacing));
    const nv = Math.max(2, Math.ceil((2 * half[va]) / spacing));
    const base = pos.length / 3;
    for (let b = 0; b <= nv; b++) {
      for (let a = 0; a <= nu; a++) {
        p[na] = sg * half[na];
        p[ua] = -half[ua] + (2 * half[ua] * a) / nu;
        p[va] = -half[va] + (2 * half[va] * b) / nv;
        const qx = clamp(p.x, -inner.x, inner.x);
        const qy = clamp(p.y, -inner.y, inner.y);
        const qz = clamp(p.z, -inner.z, inner.z);
        let nx = p.x - qx;
        let ny = p.y - qy;
        let nz = p.z - qz;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l;
        ny /= l;
        nz /= l;
        const out = [qx + nx * r, qy + ny * r, qz + nz * r];
        if (deform) deform(out, half);
        pos.push(out[0], out[1], out[2]);
        uv.push((p[ua] + half[ua]) * 2.2, (p[va] + half[va]) * 2.2);
      }
    }
    for (let b = 0; b < nv; b++) {
      for (let a = 0; a < nu; a++) {
        const i0 = base + b * (nu + 1) + a;
        const i1 = i0 + 1;
        const i2 = i0 + nu + 1;
        const i3 = i2 + 1;
        idx.push(i0, i1, i3, i0, i3, i2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  // 三角形の向きを外向きにそろえる
  fixWinding(g);
  g.computeVertexNormals();
  weldNormals(g);
  g.computeBoundingSphere();
  return g;
}

function fixWinding(g) {
  const P = g.attributes.position;
  const I = g.index.array;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const m = new THREE.Vector3();
  for (let t = 0; t < I.length; t += 3) {
    a.fromBufferAttribute(P, I[t]);
    b.fromBufferAttribute(P, I[t + 1]);
    c.fromBufferAttribute(P, I[t + 2]);
    n.subVectors(b, a).cross(m.subVectors(c, a));
    m.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    if (n.dot(m) < 0) {
      const tmp = I[t + 1];
      I[t + 1] = I[t + 2];
      I[t + 2] = tmp;
    }
  }
}

// 面の境目で重なっている頂点の法線を平均して、継ぎ目を消す
function weldNormals(g) {
  const P = g.attributes.position;
  const N = g.attributes.normal;
  const map = new Map();
  for (let i = 0; i < P.count; i++) {
    const key = `${Math.round(P.getX(i) * 2000)},${Math.round(P.getY(i) * 2000)},${Math.round(P.getZ(i) * 2000)}`;
    let e = map.get(key);
    if (!e) map.set(key, (e = []));
    e.push(i);
  }
  for (const list of map.values()) {
    if (list.length < 2) continue;
    let x = 0;
    let y = 0;
    let z = 0;
    for (const i of list) {
      x += N.getX(i);
      y += N.getY(i);
      z += N.getZ(i);
    }
    const l = Math.hypot(x, y, z) || 1;
    for (const i of list) N.setXYZ(i, x / l, y / l, z / l);
  }
}

// 上面がふくらんだ座面クッション（dent: 誰かが座っていたくぼみ）
function seatDeform(puff, dent) {
  return (o, half) => {
    const ux = o[0] / half.x;
    const uz = o[2] / half.z;
    const uy = o[1] / half.y;
    const fx = Math.max(0, 1 - ux * ux);
    const fz = Math.max(0, 1 - uz * uz);
    const top = smoothstep(-0.3, 1.0, uy);
    let b = puff * fx * fz;
    if (dent) {
      const ex = o[0] - dent.x;
      const ez = o[2] - dent.z;
      b -= dent.depth * Math.exp(-(ex * ex + ez * ez) / dent.s) * fx;
    }
    o[1] += b * top;
    // 横にも少しふくらむ
    const fy = Math.max(0, 1 - uy * uy);
    o[0] += Math.sign(ux) * 0.008 * fy * fz;
    o[2] += Math.sign(uz) * 0.008 * fy * fx;
  };
}

function backDeform(puff) {
  return (o, half) => {
    const ux = o[0] / half.x;
    const uy = o[1] / half.y;
    const uz = o[2] / half.z;
    const fx = Math.max(0, 1 - ux * ux);
    const fy = Math.max(0, 1 - uy * uy);
    o[2] += puff * fx * fy * smoothstep(-0.4, 1.0, uz);
    o[2] -= 0.01 * fx * fy * smoothstep(-0.4, 1.0, -uz);
  };
}

function pillowDeform(puff) {
  return (o, half) => {
    const ux = o[0] / half.x;
    const uy = o[1] / half.y;
    const fx = Math.max(0, 1 - ux * ux);
    const fy = Math.max(0, 1 - uy * uy);
    o[2] += Math.sign(o[2]) * puff * Math.pow(fx * fy, 0.8);
    // 角がつままれたような形
    const corner = Math.pow(Math.abs(ux * uy), 3);
    o[0] *= 1 + corner * 0.06;
    o[1] *= 1 + corner * 0.06;
  };
}

function topPuff(puff) {
  return (o, half) => {
    const ux = o[0] / half.x;
    const uz = o[2] / half.z;
    const uy = o[1] / half.y;
    o[1] += puff * Math.max(0, 1 - ux * ux) * Math.max(0, 1 - uz * uz) * smoothstep(0.2, 1.0, uy);
  };
}

export class Sofa {
  constructor(textures, palette = {}) {
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);
    this.x = 0;
    this.z = 0;
    this.rot = 0;
    this.active = false;
    this.W = 96;

    const fabricColor = new THREE.Color(palette.fabric ?? 0x5e2a2b);
    const fabric = new THREE.MeshPhysicalMaterial({
      color: fabricColor,
      roughness: 0.9,
      metalness: 0,
      sheen: 0.7,
      sheenRoughness: 0.65,
      sheenColor: new THREE.Color(palette.sheen ?? 0x9c6060),
      normalMap: textures.fabric.normal,
      normalScale: new THREE.Vector2(0.22, 0.22),
      map: textures.fabric.map,
    });
    const pillowMat = fabric.clone();
    pillowMat.color = new THREE.Color(palette.pillow ?? 0x4e6862);
    pillowMat.sheenColor = new THREE.Color(0x8fb0a8);
    const wood = new THREE.MeshStandardMaterial({ color: 0x2e1e14, roughness: 0.55, metalness: 0 });
    this.materials = [fabric, pillowMat, wood];

    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      this.body.add(m);
      return m;
    };
    const S = 0.022;
    // 土台
    add(cushionGeometry(1.58, 0.2, 0.86, 0.035, 0.04, null), fabric, 0, 0.2, 0.02);
    // ひじ掛け
    const armGeo = cushionGeometry(0.22, 0.52, 0.92, 0.085, S * 1.2, topPuff(0.012));
    add(armGeo, fabric, -0.89, 0.36, 0);
    add(armGeo, fabric, 0.89, 0.36, 0);
    // 背もたれの枠
    add(cushionGeometry(2.0, 0.74, 0.2, 0.07, 0.03, topPuff(0.01)), fabric, 0, 0.47, -0.36);
    // 座面クッション（まんなかには、くぼみ）
    const seatPlain = cushionGeometry(0.515, 0.17, 0.68, 0.06, S, seatDeform(0.03, null));
    const seatDent = cushionGeometry(0.515, 0.17, 0.68, 0.06, S, seatDeform(0.03, { x: 0.02, z: 0.04, depth: 0.03, s: 0.025 }));
    add(seatPlain, fabric, -0.523, 0.385, 0.08, 0, 0.01);
    this.middleSeat = add(seatDent, fabric, 0, 0.385, 0.08, 0, -0.008);
    add(seatPlain, fabric, 0.523, 0.385, 0.08, 0, -0.012);
    // 背クッション
    const backGeo = cushionGeometry(0.5, 0.44, 0.17, 0.065, S, backDeform(0.035));
    add(backGeo, fabric, -0.52, 0.69, -0.17, -0.2, 0.02, 0.01);
    add(backGeo, fabric, 0, 0.69, -0.165, -0.17, 0, 0);
    add(backGeo, fabric, 0.52, 0.69, -0.17, -0.21, -0.03, -0.015);
    // クッション（座面に置かれ、ひじ掛けと背もたれに寄りかかっている）
    // 位置は各パーツとの当たりを数値で解いて決めた（めり込まず、三か所で支えられる姿勢）
    this.pillow = add(cushionGeometry(0.4, 0.4, 0.095, 0.032, 0.02, pillowDeform(0.036)), pillowMat, -0.608, 0.709, 0.098, -0.4, 0.48, 0.16);
    // 脚
    const legGeo = new THREE.CylinderGeometry(0.026, 0.018, 0.1, 12);
    for (const sx of [-0.9, 0.9]) for (const sz of [-0.37, 0.37]) add(legGeo, wood, sx, 0.05, sz);

    for (const m of this.body.children) {
      m.castShadow = false;
      m.receiveShadow = false;
    }

    // 床の柔らかい影
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(2.7, 1.35),
      new THREE.MeshBasicMaterial({ map: textures.blob, transparent: true, depthWrite: false, color: 0x000000 }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.006;
    blob.renderOrder = 1;
    this.body.add(blob);
    this.blob = blob;

    // 近くの蛍光灯の光（ソファーだけを照らす）
    this.lamps = [];
    for (let k = 0; k < 3; k++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      this.root.add(l);
      this.lamps.push(l);
    }
    this.lampIdx = [-1, -1, -1];
    this.root.visible = false;
  }

  place(x, z, rot, world) {
    this.W = world.W;
    this.x = mod(x, world.W);
    this.z = mod(z, world.W);
    this.rot = rot;
    this.body.rotation.y = rot;
    this.active = true;
    this.root.visible = true;
    this.pickLamps(world);
  }

  hide() {
    this.active = false;
    this.root.visible = false;
  }

  pickLamps(world) {
    const cand = [];
    for (const L of world.lights) {
      if (L.dead) continue;
      const dx = wrapDelta(L.x - this.x, world.W);
      const dz = wrapDelta(L.z - this.z, world.W);
      const d = Math.hypot(dx, dz);
      if (d > 6.5) continue;
      // ソファーの中心からその明かりが見えるか
      if (world.segmentBlocked(this.x, this.z, this.x + dx, this.z + dz, false)) continue;
      cand.push([d, L.index]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    for (let k = 0; k < 3; k++) this.lampIdx[k] = k < cand.length ? cand[k][1] : -1;
  }

  // 前方（ソファーが向いている方向）
  forward() {
    return { x: Math.sin(this.rot), z: Math.cos(this.rot) };
  }

  toWorld(lx, lz) {
    const c = Math.cos(this.rot);
    const s = Math.sin(this.rot);
    return { x: this.x + lx * c + lz * s, z: this.z - lx * s + lz * c };
  }

  // 世界の点をソファーの局所座標へ（px,pz は折り返さない座標でよい）
  toLocal(px, pz) {
    const dx = wrapDelta(px - this.x, this.W);
    const dz = wrapDelta(pz - this.z, this.W);
    const c = Math.cos(this.rot);
    const s = Math.sin(this.rot);
    return { x: dx * c - dz * s, z: dx * s + dz * c };
  }

  update(camX, camZ, world, lights, lightColor, scale = 1) {
    if (!this.active) return;
    const W = world.W;
    this.root.position.set(camX + wrapDelta(this.x - camX, W), 0, camZ + wrapDelta(this.z - camZ, W));
    for (let k = 0; k < 3; k++) {
      const l = this.lamps[k];
      const idx = this.lampIdx[k];
      if (idx < 0) {
        l.intensity = 0;
        continue;
      }
      const L = world.lights[idx];
      l.position.set(wrapDelta(L.x - this.x, W), CEIL - 0.2, wrapDelta(L.z - this.z, W));
      l.color.copy(lightColor);
      l.intensity = lights.level[idx] * 16 * scale;
    }
  }

  // プレイヤー（円）をソファーの外へ押し出す
  collide(pos, r) {
    if (!this.active) return;
    const lp = this.toLocal(pos.x, pos.z);
    const hx = SOFA_HW;
    const hz = SOFA_HD;
    const qx = clamp(lp.x, -hx, hx);
    const qz = clamp(lp.z, -hz, hz);
    let dx = lp.x - qx;
    let dz = lp.z - qz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) return;
    let nx;
    let nz;
    if (d2 > 1e-10) {
      const d = Math.sqrt(d2);
      nx = lp.x + (dx / d) * (r - d);
      nz = lp.z + (dz / d) * (r - d);
    } else {
      const pl = lp.x + hx;
      const pr = hx - lp.x;
      const pb = lp.z + hz;
      const pf = hz - lp.z;
      const m = Math.min(pl, pr, pb, pf);
      nx = lp.x;
      nz = lp.z;
      if (m === pl) nx = -hx - r;
      else if (m === pr) nx = hx + r;
      else if (m === pb) nz = -hz - r;
      else nz = hz + r;
    }
    const c = Math.cos(this.rot);
    const s = Math.sin(this.rot);
    const wx = nx * c + nz * s;
    const wz = -nx * s + nz * c;
    pos.x += wrapDelta(this.x + wx - pos.x, this.W);
    pos.z += wrapDelta(this.z + wz - pos.z, this.W);
  }

  // 視線（原点と方向、ワールド座標）がソファーに当たるまでの距離。当たらなければ -1
  rayHit(ox, oy, oz, dx, dy, dz) {
    if (!this.active) return -1;
    const lo = this.toLocal(ox, oz);
    const c = Math.cos(this.rot);
    const s = Math.sin(this.rot);
    const ldx = dx * c - dz * s;
    const ldz = dx * s + dz * c;
    const mn = [-SOFA_HW, 0, -SOFA_HD];
    const mx = [SOFA_HW, 0.9, SOFA_HD];
    const o = [lo.x, oy, lo.z];
    const d = [ldx, dy, ldz];
    let t0 = 0;
    let t1 = 100;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-9) {
        if (o[a] < mn[a] || o[a] > mx[a]) return -1;
        continue;
      }
      let ta = (mn[a] - o[a]) / d[a];
      let tb = (mx[a] - o[a]) / d[a];
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) return -1;
    }
    return t0;
  }

  // 見えているかの判定に使う点（ワールド座標）
  samplePoints() {
    const pts = [];
    for (const [lx, lz] of [
      [0, 0],
      [-0.95, -0.4],
      [0.95, -0.4],
      [-0.95, 0.4],
      [0.95, 0.4],
    ]) {
      pts.push(this.toWorld(lx, lz));
    }
    return pts;
  }

  // 座ったときの目の位置と向き
  seatPose() {
    const e = this.toWorld(0, 0.05);
    return { x: e.x, z: e.z, y: 1.12, yaw: this.rot + Math.PI };
  }

  standPose() {
    const e = this.toWorld(0, 0.95);
    return { x: e.x, z: e.z, y: 1.62, yaw: this.rot + Math.PI };
  }
}

// その場所にソファーを置けるか（壁・柱にぶつからず、前に立つ余地がある）
export function sofaFits(world, x, z, rot, frontClear = 1.0) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (let a = -1; a <= 1; a += 0.25) {
    for (let b = -1; b <= 1; b += 0.5) {
      const lx = a * (SOFA_HW + 0.05);
      const lz = b * (SOFA_HD + 0.05);
      const wx = x + lx * c + lz * s;
      const wz = z - lx * s + lz * c;
      if (world.pointBlocked(wx, wz, 0.02)) return false;
    }
  }
  // 前方の余地
  for (let f = 0.6; f <= frontClear + 0.6; f += 0.3) {
    const wx = x + f * s;
    const wz = z + f * c;
    if (world.pointBlocked(wx, wz, 0.3)) return false;
  }
  return true;
}
