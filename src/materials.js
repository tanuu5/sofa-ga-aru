// 床・壁・天井・蛍光灯・水面のシェーダー。
// 照明はライトマップ（CPU で計算した床面の照度）から引くので、明かりが何百個あっても軽い。
import * as THREE from 'three';
import { LM_MAX } from './lightmap.js';

const COMMON = /* glsl */ `
uniform sampler2D uLightmap;
uniform float uWorldSize;
uniform vec3 uLightColor;
uniform float uBounce;
uniform vec3 uAmbient;
uniform vec3 uFogColor;
uniform vec3 uFogColorFar;
uniform float uFogDensity;
uniform float uTime;
uniform float uWet;
uniform float uWaterLevel;
uniform float uCeil;
varying vec3 vWorldPos;
varying vec3 vNormal;

float lmDecode(float v) { return v * v * ${LM_MAX.toFixed(2)}; }
vec2 lmUv(vec2 xz) { return xz / uWorldSize; }
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// 周期 P の値ノイズ（世界が一周してもつなぎ目が出ない）
float vnoiseP(vec2 p, float P) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(mod(i, P));
  float b = hash12(mod(i + vec2(1.0, 0.0), P));
  float c = hash12(mod(i + vec2(0.0, 1.0), P));
  float d = hash12(mod(i + vec2(1.0, 1.0), P));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
vec3 applyFog(vec3 col, vec3 wp) {
  float d = length(wp - cameraPosition);
  float f = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
  // 近くの霧は手元の明るさ、遠くの霧は全体の明るさで色が決まる
  vec3 fc = mix(uFogColorFar, uFogColor, exp(-d * 0.07));
  return mix(col, fc, f);
}
`;

const VERT = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vNormal;
#ifdef PANEL
attribute float aLight;
varying float vLight;
varying vec2 vUv;
#endif
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  #ifdef PANEL
  vLight = aLight;
  vUv = uv;
  #endif
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FLOOR_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uCarpet;
void main() {
  vec2 xz = vWorldPos.xz;
  vec3 alb = texture2D(uCarpet, xz).rgb;
  float n1 = vnoiseP(xz * 0.5, uWorldSize * 0.5);
  float n2 = vnoiseP(xz * 0.25 + 3.7, uWorldSize * 0.25);
  float n3 = vnoiseP(xz * 1.0 + 1.3, uWorldSize);
  alb *= 0.88 + 0.22 * n1;
  // 湿ったしみ
  float damp = smoothstep(0.5, 0.78, n2 * 0.75 + n3 * 0.25);
  alb = mix(alb, alb * vec3(0.56, 0.5, 0.4), damp * 0.75);
  vec4 lm = texture2D(uLightmap, lmUv(xz));
  float direct = lmDecode(lm.r);
  float bounce = lmDecode(textureLod(uLightmap, lmUv(xz), 3.5).r);
  float ao = lm.g;
  vec3 light = uLightColor * (direct + bounce * uBounce) + uAmbient;
  vec3 col = alb * light * ao;
  // 水の下では暗く、少し青緑に
  col = mix(col, col * vec3(0.42, 0.5, 0.47), uWet);
  gl_FragColor = vec4(applyFog(col, vWorldPos), 1.0);
}
`;

const WALL_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uWallpaper;
void main() {
  vec3 n = normalize(vNormal);
  vec3 wp = vWorldPos;
  bool xFacing = abs(n.x) > 0.5;
  float u = xFacing ? wp.z : wp.x;
  float h = wp.y;
  vec3 alb = texture2D(uWallpaper, vec2(u, h)).rgb;
  // 大きな色むら・日焼け
  float side = xFacing ? 17.0 : 0.0;
  float n1 = vnoiseP(vec2(u * 0.5 + side, h * 0.5), uWorldSize * 0.5);
  float n2 = vnoiseP(vec2(u * 2.0 + side, h * 2.0), uWorldSize * 2.0);
  alb *= 0.9 + 0.16 * n1;
  // 天井から垂れたしみ
  float streak = vnoiseP(vec2(u * 3.0 + side, 0.5), uWorldSize * 3.0);
  float drip = smoothstep(0.72, 0.95, streak) * smoothstep(1.2, uCeil, h) * (0.5 + 0.5 * n2);
  alb *= 1.0 - 0.22 * drip;
  // 床ぎわの汚れ
  float grime = (1.0 - smoothstep(0.08, 0.55, h)) * (0.45 + 0.55 * n2);
  alb *= 1.0 - 0.28 * grime;
  // ところどころにコンセント（2m ごとの壁の区画で抽選）
  {
    float line = floor((xFacing ? wp.x : wp.z) + 0.5);
    float seg = floor(u / 2.0);
    float side = (xFacing ? n.x : n.z) > 0.0 ? 1.0 : 0.0;
    vec2 key = vec2(mod(line, uWorldSize) + side * 0.37, mod(seg, uWorldSize * 0.5));
    float hk = hash12(key * 1.7 + 0.13);
    if (hk < 0.16) {
      float cu = seg * 2.0 + 0.4 + hash12(key + 5.1) * 1.2;
      vec2 q = vec2(u - cu, h - 0.31);
      vec2 aq = abs(q);
      if (aq.x < 0.037 && aq.y < 0.06) {
        float edge = step(0.031, aq.x) + step(0.054, aq.y);
        alb = vec3(0.78, 0.74, 0.62) * (edge > 0.0 ? 0.82 : 1.0);
        // 差し込み口がふたつ
        vec2 o = vec2(aq.x, abs(aq.y - 0.026));
        if (abs(o.x - 0.008) < 0.0025 && o.y < 0.007) alb = vec3(0.12, 0.1, 0.08);
        if (aq.y > 0.022 && aq.y < 0.03 && aq.x < 0.003 && q.y < 0.0) alb *= 0.7;
      }
    }
  }
  // 幅木
  if (h < 0.1) {
    alb = vec3(0.47, 0.43, 0.33) * (0.92 + 0.12 * n2);
    if (h > 0.088) alb *= 1.22;
  }
  vec2 sp = wp.xz + n.xz * 0.2;
  vec4 lm = texture2D(uLightmap, lmUv(sp));
  float direct = lmDecode(lm.r);
  float bounce = lmDecode(textureLod(uLightmap, lmUv(sp), 3.5).r);
  // 壁は上ほど明るく、天井ぎわで少し陰る
  float vert = mix(0.42, 1.0, smoothstep(0.0, 2.3, h)) * (1.0 - 0.3 * smoothstep(2.35, uCeil, h));
  // 入隅の陰（この壁自身の寄与を割り戻す）
  float corner = clamp(lm.g / 0.667, 0.0, 1.0);
  float ao = mix(0.72, 1.0, smoothstep(0.0, 0.35, h)) * mix(0.55, 1.0, corner);
  vec3 light = uLightColor * (direct * vert * 0.82 + bounce * uBounce) + uAmbient;
  vec3 col = alb * light * ao;
  // 水につかった跡
  float wetZone = 1.0 - smoothstep(uWaterLevel, uWaterLevel + 0.22 + 0.12 * n2, h);
  col *= mix(1.0, 0.5, wetZone * uWet);
  gl_FragColor = vec4(applyFog(col, wp), 1.0);
}
`;

const CEIL_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uCeilTex;
void main() {
  vec2 xz = vWorldPos.xz;
  vec3 alb = texture2D(uCeilTex, xz).rgb;
  vec2 tile = floor(xz * 2.0);
  vec2 mt = mod(tile, uWorldSize * 2.0);
  float tv = hash12(mt);
  alb *= 0.94 + 0.08 * tv;
  // 雨漏りのしみ（いくつかのタイルだけ）
  float sv = hash12(mt + 7.7);
  if (sv > 0.93) {
    vec2 c = (tile + 0.5) / 2.0 + (vec2(hash12(mt + 1.3), hash12(mt + 2.1)) - 0.5) * 0.2;
    float r = length(xz - c) + (vnoiseP(xz * 12.0, uWorldSize * 12.0) - 0.5) * 0.06;
    float ring = smoothstep(0.03, 0.0, abs(r - 0.17)) * 0.6 + smoothstep(0.2, 0.0, r) * 0.35;
    alb = mix(alb, alb * vec3(0.72, 0.6, 0.42), ring);
  }
  // 黒ずんだタイル（ところどころ）
  if (sv < 0.012) alb *= 0.55;
  // 空調の吹き出し口
  if (sv > 0.5 && sv < 0.518) {
    vec2 f = fract(xz * 2.0) - 0.5;
    float m = max(abs(f.x), abs(f.y));
    if (m < 0.44) {
      float ring = fract(m * 18.0);
      vec3 metal = vec3(0.8, 0.8, 0.77);
      alb = metal * (ring < 0.35 ? 0.55 : 1.0) * (m < 0.07 ? 0.6 : 1.0);
    }
  }
  vec4 lm = texture2D(uLightmap, lmUv(xz));
  float direct = lmDecode(lm.r);
  float bounce = lmDecode(textureLod(uLightmap, lmUv(xz), 2.5).r);
  float far = lmDecode(textureLod(uLightmap, lmUv(xz), 4.5).r);
  vec3 light = uLightColor * (bounce * 0.26 + far * 0.14 + direct * 0.05) + uAmbient;
  vec3 col = alb * light * mix(0.62, 1.0, lm.g);
  gl_FragColor = vec4(applyFog(col, vWorldPos), 1.0);
}
`;

const PANEL_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uPanelTex;
uniform sampler2D uLevels;
uniform float uPanelGain;
varying float vLight;
varying vec2 vUv;
void main() {
  vec3 col;
  if (vLight < -0.5) {
    // 金属の縁
    vec4 lm = texture2D(uLightmap, lmUv(vWorldPos.xz));
    col = vec3(0.5) * (uLightColor * lmDecode(lm.r) * 0.25 + uAmbient);
  } else {
    float level = texelFetch(uLevels, ivec2(int(vLight + 0.5), 0), 0).r;
    float t = texture2D(uPanelTex, vUv).r;
    vec4 lm = texture2D(uLightmap, lmUv(vWorldPos.xz));
    vec3 lit = uLightColor * lmDecode(lm.r) * 0.2 + uAmbient * 2.0;
    // 枠は光らない金属、内側の拡散板だけが光る
    float frame = 1.0 - smoothstep(0.02, 0.08, t);
    vec3 offCol = mix(vec3(0.46, 0.46, 0.44) * (0.5 + 0.5 * t), vec3(0.62, 0.62, 0.6), frame) * lit;
    vec3 onCol = uLightColor * t * uPanelGain + vec3(0.62, 0.62, 0.6) * lit * frame;
    col = mix(offCol, onCol, level);
  }
  gl_FragColor = vec4(applyFog(col, vWorldPos), 1.0);
}
`;

// 浅い水面。Reflector の反射テクスチャを波紋でゆがめる
export const WaterShader = {
  name: 'SofaWater',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    uTime: { value: 0 },
    uFogColor: { value: new THREE.Color(0, 0, 0) },
    uFogColorFar: { value: new THREE.Color(0, 0, 0) },
    uFogDensity: { value: 0.03 },
    uRipples: { value: Array.from({ length: 16 }, () => new THREE.Vector4(0, 0, -100, 0)) },
    uWorldSize: { value: 96 },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorldPos;
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec3 uFogColor;
    uniform vec3 uFogColorFar;
    uniform float uFogDensity;
    uniform vec4 uRipples[16];
    uniform float uWorldSize;
    varying vec4 vUv;
    varying vec3 vWorldPos;
    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    float vnoise(vec2 p, float P) {
      vec2 i = floor(p); vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      float a = hash12(mod(i, P)), b = hash12(mod(i + vec2(1, 0), P));
      float c = hash12(mod(i + vec2(0, 1), P)), d = hash12(mod(i + vec2(1, 1), P));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
    float heightAt(vec2 p) {
      float h = 0.0;
      // ほとんど動かない水。ごくわずかなうねり
      h += (vnoise(p * 1.5 + vec2(uTime * 0.05, uTime * 0.03), uWorldSize * 1.5) - 0.5) * 0.004;
      h += (vnoise(p * 4.0 - vec2(uTime * 0.08, -uTime * 0.06), uWorldSize * 4.0) - 0.5) * 0.002;
      for (int k = 0; k < 16; k++) {
        vec4 r = uRipples[k];
        float age = uTime - r.z;
        if (age < 0.0 || age > 4.0) continue;
        vec2 d = p - r.xy;
        d -= uWorldSize * floor(d / uWorldSize + 0.5);
        float dist = length(d);
        float front = age * 0.55;
        float x = dist - front;
        float env = exp(-x * x * 40.0) * exp(-age * 1.1) * r.w / (1.0 + dist * 3.0);
        h += sin(x * 34.0) * env * 0.022;
      }
      return h;
    }
    void main() {
      vec2 p = vWorldPos.xz;
      float e = 0.02;
      float h0 = heightAt(p);
      vec2 grad = vec2(heightAt(p + vec2(e, 0.0)) - h0, heightAt(p + vec2(0.0, e)) - h0) / e;
      vec3 n = normalize(vec3(-grad.x, 1.0, -grad.y));
      vec3 V = normalize(cameraPosition - vWorldPos);
      vec4 uv = vUv;
      uv.xy += n.xz * 0.6 * uv.w * 0.05;
      vec3 refl = texture2D(tDiffuse, uv.xy / uv.w).rgb;
      float cosT = clamp(dot(V, n), 0.0, 1.0);
      float fres = 0.04 + 0.96 * pow(1.0 - cosT, 5.0);
      float a = clamp(0.5 + fres * 0.5, 0.0, 0.95);
      vec3 col = refl * (0.78 + 0.22 * fres);
      float d = length(vWorldPos - cameraPosition);
      float f = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
      col = mix(col, mix(uFogColorFar, uFogColor, exp(-d * 0.07)), f);
      a = mix(a, 1.0, f);
      gl_FragColor = vec4(col * a, a);
    }`,
};

export class EnvMaterials {
  constructor(textures) {
    this.shared = {
      uLightmap: { value: null },
      uWorldSize: { value: 96 },
      uLightColor: { value: new THREE.Color(1, 0.95, 0.84) },
      uBounce: { value: 0.35 },
      uAmbient: { value: new THREE.Color(0.01, 0.009, 0.006) },
      uFogColor: { value: new THREE.Color(0.2, 0.18, 0.1) },
      uFogColorFar: { value: new THREE.Color(0.2, 0.18, 0.1) },
      uFogDensity: { value: 0.028 },
      uTime: { value: 0 },
      uWet: { value: 0 },
      uWaterLevel: { value: 0.12 },
      uCeil: { value: 2.7 },
    };
    const s = this.shared;
    const mk = (frag, extra = {}, defines = {}) =>
      new THREE.ShaderMaterial({
        uniforms: { ...s, ...extra },
        vertexShader: VERT,
        fragmentShader: frag,
        defines,
      });
    this.floor = mk(FLOOR_FRAG, { uCarpet: { value: textures.carpet } });
    this.wall = mk(WALL_FRAG, { uWallpaper: { value: textures.wallpaper } });
    this.ceiling = mk(CEIL_FRAG, { uCeilTex: { value: textures.ceiling } });
    this.panel = mk(
      PANEL_FRAG,
      { uPanelTex: { value: textures.panel }, uLevels: { value: null }, uPanelGain: { value: 3.6 } },
      { PANEL: '' },
    );
  }

  bind(lightmap, lights, worldSize) {
    this.shared.uLightmap.value = lightmap.texture;
    this.shared.uWorldSize.value = worldSize;
    this.panel.uniforms.uLevels.value = lights.texture;
  }
}
