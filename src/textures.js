// 画像素材は使わず、すべて Canvas で手続き的に描く
import * as THREE from 'three';
import { mulberry32, makeNoise2D, clamp, smoothstep } from './util.js';

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// fn(x, y, out) で 0..1 の RGB(A) を書く
function paint(w, h, fn, withAlpha = false) {
  const canvas = canvasOf(w, h);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const out = [0, 0, 0, 1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[3] = 1;
      fn(x, y, out);
      const i = (y * w + x) * 4;
      d[i] = clamp(out[0], 0, 1) * 255;
      d[i + 1] = clamp(out[1], 0, 1) * 255;
      d[i + 2] = clamp(out[2], 0, 1) * 255;
      d[i + 3] = withAlpha ? clamp(out[3], 0, 1) * 255 : 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, ctx };
}

function toTexture(canvas, { srgb = true, repeat = true, aniso = 4, mip = true } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  else t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = aniso;
  t.generateMipmaps = mip;
  t.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

// 黄色い壁紙（1 タイル = 1m × 1m）
function wallpaper(aniso) {
  const S = 512;
  const nLow = makeNoise2D(8, 11);
  const nMid = makeNoise2D(64, 12);
  const rnd = mulberry32(13);
  const { canvas } = paint(S, S, (x, y, o) => {
    let v = 1.0;
    const xm = x % 64;
    // 縦の細い線（二重線）
    if (xm < 2) v -= 0.075;
    else if (xm >= 5 && xm < 6) v -= 0.035;
    // 小さな菱形の連なり
    const dx = Math.abs(xm - 33);
    const dy = Math.abs(((y + 32) % 64) - 32);
    const dd = dx + dy * 0.8;
    if (Math.abs(dd - 9.5) < 1.1) v -= 0.05;
    if (dd < 2.0) v -= 0.06;
    // 紙のむら
    v += (nLow((x / S) * 8, (y / S) * 8) - 0.5) * 0.07;
    v += (nMid((x / S) * 64, (y / S) * 64) - 0.5) * 0.035;
    v += (rnd() - 0.5) * 0.03;
    o[0] = 0.82 * v;
    o[1] = 0.735 * v;
    o[2] = 0.43 * v;
  });
  return toTexture(canvas, { aniso });
}

// 湿ったカーペット（1 タイル = 1m）
function carpet(aniso) {
  const S = 512;
  const n1 = makeNoise2D(8, 21);
  const n2 = makeNoise2D(32, 22);
  const n3 = makeNoise2D(128, 23);
  const rnd = mulberry32(24);
  const { canvas } = paint(S, S, (x, y, o) => {
    const u = x / S;
    const v = y / S;
    let b = 1.0;
    b += (n1(u * 8, v * 8) - 0.5) * 0.12;
    b += (n2(u * 32, v * 32) - 0.5) * 0.14;
    b += (n3(u * 128, v * 128) - 0.5) * 0.16;
    const r = rnd();
    b += (r - 0.5) * 0.2;
    if (r > 0.986) b -= 0.18;
    // ループパイルの細かい畝
    b += Math.sin((y / S) * Math.PI * 2 * 128) * 0.025;
    const hue = (n2(u * 32 + 5.3, v * 32 + 1.7) - 0.5) * 0.08;
    o[0] = 0.62 * b * (1 + hue);
    o[1] = 0.53 * b;
    o[2] = 0.33 * b * (1 - hue);
  });
  return toTexture(canvas, { aniso });
}

// 天井のトラバーチン模様の吸音板（1m に 0.5m 角のタイルが 2×2）
function ceiling(aniso) {
  const S = 512;
  const T = 256;
  const n1 = makeNoise2D(64, 31);
  const rnd = mulberry32(32);
  const tileVar = [rnd(), rnd(), rnd(), rnd()];
  const barDist = (x, y) => {
    const gx = Math.min(x % T, T - (x % T));
    const gy = Math.min(y % T, T - (y % T));
    return Math.min(gx, gy);
  };
  const { canvas, ctx } = paint(S, S, (x, y, o) => {
    const tx = (x / T) | 0;
    const ty = (y / T) | 0;
    let b = 0.94 + (tileVar[ty * 2 + tx] - 0.5) * 0.04;
    b += (n1((x / S) * 64, (y / S) * 64) - 0.5) * 0.05;
    b += (rnd() - 0.5) * 0.035;
    const g = barDist(x + 0.5, y + 0.5);
    if (g < 5) {
      o[0] = 0.9;
      o[1] = 0.895;
      o[2] = 0.87;
    } else if (g < 6.5) {
      o[0] = o[1] = o[2] = 0.58;
    } else if (g < 9) {
      // 板の縁の面取り
      const e = 0.9 + (g - 6.5) * 0.04;
      o[0] = 0.86 * b * e;
      o[1] = 0.85 * b * e;
      o[2] = 0.8 * b * e;
    } else {
      o[0] = 0.86 * b;
      o[1] = 0.85 * b;
      o[2] = 0.8 * b;
    }
  });
  // 細かいピンホールと虫食いのような溝
  for (let i = 0; i < 3200; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    if (barDist(x, y) < 11) continue;
    const r = 0.5 + rnd() * 1.0;
    ctx.fillStyle = `rgba(85,80,66,${0.18 + rnd() * 0.25})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.lineCap = 'round';
  for (let i = 0; i < 320; i++) {
    let x = rnd() * S;
    let y = rnd() * S;
    if (barDist(x, y) < 16) continue;
    ctx.strokeStyle = `rgba(90,84,70,${0.15 + rnd() * 0.18})`;
    ctx.lineWidth = 0.8 + rnd() * 0.8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    let a = rnd() * Math.PI * 2;
    const steps = 2 + ((rnd() * 4) | 0);
    for (let s = 0; s < steps; s++) {
      a += (rnd() - 0.5) * 1.6;
      x += Math.cos(a) * (1.5 + rnd() * 2);
      y += Math.sin(a) * (1.5 + rnd() * 2);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return toTexture(canvas, { aniso });
}

// 蛍光灯パネル（0.5m × 1.0m）。発光の強さのマップとして使う
function panel() {
  const W = 128;
  const H = 256;
  const { canvas } = paint(W, H, (x, y, o) => {
    const fx = Math.min(x, W - 1 - x);
    const fy = Math.min(y, H - 1 - y);
    const f = Math.min(fx, fy);
    let v;
    if (f < 5) v = 0.0;
    else if (f < 7) v = 0.3;
    else {
      const u = (x + 0.5) / W;
      const tube = Math.exp(-Math.pow((u - 0.3) / 0.075, 2)) + Math.exp(-Math.pow((u - 0.7) / 0.075, 2));
      const prism = x % 3 === 0 || y % 3 === 0 ? 0.93 : 1.0;
      const edge = smoothstep(6, 18, f);
      v = (0.62 + 0.45 * tube) * prism * (0.8 + 0.2 * edge);
    }
    o[0] = o[1] = o[2] = v;
  });
  return toTexture(canvas, { srgb: false, repeat: false });
}

// ソファーの布地（ノーマルマップと色むら）
function fabric() {
  const S = 256;
  const n = makeNoise2D(64, 41);
  const n2 = makeNoise2D(16, 42);
  const rnd = mulberry32(43);
  const hgt = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const weave =
        Math.sin(u * Math.PI * 2 * 64) * 0.5 * Math.abs(Math.sin(v * Math.PI * 2 * 32)) +
        Math.sin(v * Math.PI * 2 * 64) * 0.5 * Math.abs(Math.sin(u * Math.PI * 2 * 32));
      hgt[y * S + x] = weave * 0.35 + (n(u * 64, v * 64) - 0.5) * 0.9 + (rnd() - 0.5) * 0.35;
    }
  }
  const at = (x, y) => hgt[((y + S) % S) * S + ((x + S) % S)];
  const nrm = paint(S, S, (x, y, o) => {
    const dx = (at(x + 1, y) - at(x - 1, y)) * 0.9;
    const dy = (at(x, y + 1) - at(x, y - 1)) * 0.9;
    const l = Math.hypot(dx, dy, 1);
    o[0] = (-dx / l) * 0.5 + 0.5;
    o[1] = (dy / l) * 0.5 + 0.5;
    o[2] = (1 / l) * 0.5 + 0.5;
  });
  const col = paint(S, S, (x, y, o) => {
    const u = x / S;
    const v = y / S;
    const b = 0.9 + (n2(u * 16, v * 16) - 0.5) * 0.14 + (at(x, y) * 0.04);
    o[0] = o[1] = o[2] = b;
  });
  return {
    normal: toTexture(nrm.canvas, { srgb: false, aniso: 4 }),
    map: toTexture(col.canvas, { srgb: true, aniso: 4 }),
  };
}

// ソファーの下に落とす柔らかい影
function blobShadow() {
  const W = 256;
  const H = 128;
  const hw = 98;
  const hh = 36;
  const rad = 22;
  const { canvas } = paint(
    W,
    H,
    (x, y, o) => {
      const px = Math.abs(x + 0.5 - W / 2) - (hw - rad);
      const py = Math.abs(y + 0.5 - H / 2) - (hh - rad);
      const qx = Math.max(px, 0);
      const qy = Math.max(py, 0);
      const sd = Math.hypot(qx, qy) + Math.min(Math.max(px, py), 0) - rad;
      const a = 1 - smoothstep(-14, 26, sd);
      o[0] = o[1] = o[2] = 0;
      o[3] = a * a * 0.9;
    },
    true,
  );
  return toTexture(canvas, { srgb: false, repeat: false });
}

export function createTextures(renderer) {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return {
    wallpaper: wallpaper(aniso),
    carpet: carpet(aniso),
    ceiling: ceiling(aniso),
    panel: panel(),
    fabric: fabric(),
    blob: blobShadow(),
  };
}
