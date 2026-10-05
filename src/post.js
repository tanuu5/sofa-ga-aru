// 仕上げ：にじみ（ブルーム）、トーンマッピング、粒子、周辺減光、暗転
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const FinalShader = {
  name: 'SofaFinal',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uFade: { value: 0 },
    uGrain: { value: 0.04 },
    uVignette: { value: 0.6 },
    uAberration: { value: 0.004 },
    uRes: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uFade;
    uniform float uGrain;
    uniform float uVignette;
    uniform float uAberration;
    uniform vec2 uRes;
    varying vec2 vUv;
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    void main() {
      vec2 uv = vUv;
      vec2 d = uv - 0.5;
      float r2 = dot(d, d);
      vec2 off = d * r2 * uAberration * 4.0;
      vec3 c;
      c.r = texture2D(tDiffuse, uv - off).r;
      c.g = texture2D(tDiffuse, uv).g;
      c.b = texture2D(tDiffuse, uv + off).b;
      float vig = 1.0 - smoothstep(0.12, 0.62, r2 * 1.15);
      c *= mix(1.0, 0.25 + 0.75 * vig, uVignette);
      vec2 px = floor(uv * uRes);
      float g = hash(px + fract(uTime * 3.17) * 311.0) - 0.5;
      float lum = dot(c, vec3(0.299, 0.587, 0.114));
      c += g * uGrain * (0.55 + 0.45 * (1.0 - lum));
      c *= 1.0 - uFade;
      c += (hash(px * 1.37 + 0.71) - 0.5) / 255.0;
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }`,
};

export class Post {
  constructor(renderer, scene, camera, { msaa = 4 } = {}) {
    this.renderer = renderer;
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: msaa });
    this.composer = new EffectComposer(renderer, rt);
    this.renderPass = new RenderPass(scene, camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.34, 0.4, 1.1);
    this.output = new OutputPass();
    this.final = new ShaderPass(FinalShader);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.output);
    this.composer.addPass(this.final);
  }

  setSize(w, h, pr) {
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.final.uniforms.uRes.value.set(Math.floor(w * pr), Math.floor(h * pr));
  }

  get fade() {
    return this.final.uniforms.uFade.value;
  }

  set fade(v) {
    this.final.uniforms.uFade.value = v;
  }

  render(time, dt) {
    this.final.uniforms.uTime.value = time;
    this.composer.render(dt);
  }
}
