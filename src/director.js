// 物語の進行。ジェネレーター関数をコルーチンとして動かす
// yield 数値 → その秒数待つ / yield 関数 → true を返すまで待つ / yield → 次のフレーム
import * as THREE from 'three';
import { clamp, wrapDelta, easeInOutCubic, lerp } from './util.js';
import { CEIL } from './world.js';

export class Director {
  constructor(game) {
    this.game = game;
    this.procs = [];
    this.time = 0;
  }

  run(fn, ...args) {
    const p = { it: fn.apply(this, args), wait: 0, until: null, done: false };
    this.procs.push(p);
    this.step(p, 0);
    return p;
  }

  killAll() {
    for (const p of this.procs) p.done = true;
    this.procs = [];
  }

  update(dt) {
    this.time += dt;
    const list = this.procs.slice();
    for (const p of list) {
      if (p.done) continue;
      if (p.wait > 0) {
        p.wait -= dt;
        if (p.wait > 0) continue;
      }
      if (p.until) {
        if (!p.until()) continue;
        p.until = null;
      }
      this.step(p, dt);
    }
    this.procs = this.procs.filter((p) => !p.done);
  }

  step(p, dt) {
    const r = p.it.next(dt);
    if (r.done) {
      p.done = true;
      return;
    }
    const v = r.value;
    if (typeof v === 'number') p.wait = v;
    else if (typeof v === 'function') p.until = v;
  }

  // ---------- 共通の動き ----------
  *fadeTo(target, dur) {
    const post = this.game.post;
    const from = post.fade;
    let t = 0;
    while (t < dur) {
      const dt = yield;
      t += dt;
      post.fade = lerp(from, target, clamp(t / dur, 0, 1));
    }
    post.fade = target;
  }

  // 座っている間だけ、遠くから順に明かりが消えていく
  *darkenWhileSeated(duration) {
    const g = this.game;
    const L = g.world.lights;
    const sx = g.sofa.x;
    const sz = g.sofa.z;
    const th = new Float32Array(L.length);
    let nearest = -1;
    let nd = 1e9;
    for (let i = 0; i < L.length; i++) {
      const d = g.world.torusDist(sx, sz, L[i].x, L[i].z);
      th[i] = 1 - Math.sqrt(Math.min(d / 60, 1));
      if (d < nd && !L[i].dead) {
        nd = d;
        nearest = i;
      }
    }
    if (nearest >= 0) th[nearest] = 1.0;
    let p = 0;
    while (p < 1) {
      const dt = yield;
      if (g.player.seated) p += dt / duration;
      else if (!g.player.anim) p -= dt / 5;
      p = clamp(p, 0, 1);
      for (let i = 0; i < L.length; i++) {
        const want = p < th[i] - 0.001 ? 1 : 0;
        if (g.lights.target[i] !== want && g.lights.delay[i] < 0) g.lights.setTarget(i, want);
      }
      g.player.lockSeat = p > 0.93;
    }
    g.player.lockSeat = true;
  }

  // 近いものから順に、明かりが点いていく
  *startupWave(cx, cz, { base = 0.6, speed = 0.06, jitter = 0.35, except = -1 } = {}) {
    const g = this.game;
    const L = g.world.lights;
    const r = Math.random;
    let maxDelay = 0;
    for (let i = 0; i < L.length; i++) {
      if (i === except || L[i].dead) continue;
      const d = g.world.torusDist(cx, cz, L[i].x, L[i].z);
      const delay = base + d * speed + r() * jitter;
      maxDelay = Math.max(maxDelay, delay);
      g.lights.setTarget(i, true, delay);
    }
    yield Math.min(maxDelay, 4);
  }

  // 次の場所へ。真っ暗なうちに世界を入れ替え、ソファーに座らせる
  *transition(next) {
    const g = this.game;
    g.player.lockSeat = true;
    g.audio.music?.setVolume(0, 0.7);
    g.audio.setHum(0, 0.5);
    yield 2.6;
    // 鳴らないまま音を作り続けないように止めておく（次の場所で必要なら鳴らし直す）
    g.audio.music?.stop();
    g.loadStage(next);
    g.lights.setAll(false);
    g.lightmap.flush();
    g.placeSofaForStage(next);
    g.player.seatInstant(g.sofa);
    yield 1.4;
    if (next === 2) yield* this.stage2();
    else if (next === 3) yield* this.stage3();
    else if (next === 4) yield* this.stage4();
  }

  sofaRel() {
    const g = this.game;
    const W = g.world.W;
    return {
      x: wrapDelta(g.sofa.x - g.player.x, W),
      y: 0.6 - g.camera.position.y,
      z: wrapDelta(g.sofa.z - g.player.z, W),
    };
  }

  // ---------- 1. 黄色い部屋 ----------
  *stage1() {
    const g = this.game;
    g.post.fade = 1;
    g.audio.setHum(1, 2);
    yield* this.fadeTo(0, 3.0);
    g.ui.hint('move', 7);
    const t0 = this.time;
    const w0 = g.player.walked;
    yield () => {
      const t = this.time - t0;
      const w = g.player.walked - w0;
      return (t > 40 && w > 28) || (t > 100 && w > 6) || g.debugQuick;
    };
    // 見ていないうちに、ソファーが現れる
    while (!g.sofa.active) {
      if (g.spawnSofaHidden()) break;
      yield 0.4;
    }
    // 何かが変わった気配だけ（すべての明かりが一瞬ゆらぐ）
    g.lights.dip();
    g.audio.humDip();
    g.rumble(0.05, 0.22, 180);
    this.run(this.watchSofaStage1);
    yield () => g.player.seated;
    this.run(function* () {
      yield 1.2;
      g.audio.music.start();
      g.audio.music.setPositional(false, 0.1);
      g.audio.music.setTone(800, 170, 0.1);
      g.audio.music.setVolume(0.55, 3.0);
      yield 5;
      g.ui.say('music1', 6);
    });
    yield* this.darkenWhileSeated(34);
    yield* this.transition(2);
  }

  // ソファーを見つけるまでの見守り。遠く離れたら、また近くに現れる
  *watchSofaStage1() {
    const g = this.game;
    let seen = false;
    let away = 0;
    while (!g.player.seated) {
      const dt = yield;
      if (!seen && g.sofaInView(16)) {
        seen = true;
        g.audio.chime();
      }
      const d = g.world.torusDist(g.player.x, g.player.z, g.sofa.x, g.sofa.z);
      if (d > (seen ? 26 : 18) && !g.sofaInView(30)) away += dt;
      else away = 0;
      if (away > (seen ? 25 : 6)) {
        g.sofa.hide();
        while (!g.spawnSofaHidden()) yield 0.4;
        away = 0;
        seen = false;
      }
    }
  }

  // 見ていないうちに消える
  *vanishWhenUnobserved() {
    const g = this.game;
    let t = 0;
    for (;;) {
      const dt = yield;
      const ok = !g.player.seated && !g.player.anim && !g.sofaInView(60) && g.world.torusDist(g.player.x, g.player.z, g.sofa.x, g.sofa.z) > 1.5;
      if (ok) {
        t += dt;
        if (t > 0.45) break;
      } else t = 0;
    }
    g.sofa.hide();
  }

  // ---------- 2. 柱の広間 ----------
  *stage2() {
    const g = this.game;
    g.audio.setRoom(0.06);
    yield* this.startupWave(g.sofa.x, g.sofa.z, { base: 0.3, speed: 0.05 });
    g.player.lockSeat = false;
    yield () => !g.player.seated && !g.player.anim;
    yield* this.vanishWhenUnobserved();
    const w0 = g.player.walked;
    const t0 = this.time;
    yield () => g.player.walked - w0 > 5 || this.time - t0 > 9;
    // 遠くのひとつを残して、明かりが落ちる
    const beacon = g.pickBeacon();
    g.audio.clunk();
    g.lights.dip();
    g.audio.humDip();
    g.rumble(0.8, 0.35, 380);
    yield 0.5;
    const L = g.world.lights;
    for (let i = 0; i < L.length; i++) {
      if (i === beacon) continue;
      const d = g.world.torusDist(g.player.x, g.player.z, L[i].x, L[i].z);
      g.lights.setTarget(i, false, 0.15 + d * 0.035 + Math.random() * 0.2);
    }
    g.placeSofaUnderLight(beacon);
    g.fogOverride = { density: 0.016 };
    yield () => g.player.seated;
    let t = 0;
    while (t < 11) {
      const dt = yield;
      if (g.player.seated) t += dt;
    }
    g.player.lockSeat = true;
    g.lights.setTarget(beacon, false);
    yield 0.8;
    g.audio.setWater(1, 3);
    g.fogOverride = null;
    yield* this.transition(3);
  }

  // ---------- 3. 水びたしの部屋 ----------
  *stage3() {
    const g = this.game;
    const m = g.audio.music;
    m.start();
    m.setPositional(true, 0.1);
    m.setTone(5000, 90, 0.1);
    m.setVolume(0.7, 3);
    this.run(this.musicFollow);
    g.audio.setWater(1, 2);
    yield* this.startupWave(g.sofa.x, g.sofa.z, { base: 0.4, speed: 0.06 });
    g.player.lockSeat = false;
    yield () => !g.player.seated && !g.player.anim;
    yield* this.vanishWhenUnobserved();
    m.setVolume(0, 0.8);
    yield 3.0;
    g.placeSofaFar(22, 34);
    m.setVolume(0.8, 2.5);
    yield 2.5;
    g.ui.say('music3', 5);
    // 見つからないまま遠くへ行ってしまったら、近くで鳴り直す
    let lost = 0;
    while (!g.player.seated) {
      const dt = yield;
      const d = g.world.torusDist(g.player.x, g.player.z, g.sofa.x, g.sofa.z);
      lost = d > 38 && !g.player.anim ? lost + dt : 0;
      if (lost > 30) {
        lost = 0;
        m.setVolume(0, 1.0);
        yield 2.5;
        g.placeSofaFar(12, 20);
        m.setVolume(0.8, 2.5);
      }
    }
    yield* this.darkenWhileSeated(30);
    yield* this.transition(4);
  }

  // 音楽の聞こえ方をソファーの位置に合わせる（壁の向こうだとこもる）
  *musicFollow() {
    const g = this.game;
    const m = g.audio.music;
    const stage = g.stageId;
    for (;;) {
      yield;
      if (g.stageId !== stage) return;
      const r = this.sofaRel();
      m.setSource(r.x, r.y, r.z);
      const walls = g.world.wallsBetween(g.player.x, g.player.z, g.player.x + r.x, g.player.z + r.z, 6);
      const cutoff = g.player.seated ? 9000 : 5200 / (1 + walls * 1.5);
      m.setTone(cutoff, g.player.seated ? 60 : 110, 0.25);
    }
  }

  // ---------- 4. ひとつだけの明かり ----------
  *stage4() {
    const g = this.game;
    const m = g.audio.music;
    g.audio.setWater(0, 2);
    g.audio.setRoom(0.035);
    yield 1.5;
    g.lights.setTarget(0, true);
    yield 2.0;
    m.start();
    m.setPositional(true, 0.1);
    m.setVolume(0.45, 4);
    this.run(this.musicFollow);
    g.player.lockSeat = false;
    let seated = 0;
    let stood = false;
    for (;;) {
      const dt = yield;
      if (g.player.seated) {
        seated += dt;
        if (seated > (stood ? 14 : 42)) break;
      } else {
        seated = 0;
        stood = true;
      }
    }
    yield* this.ending();
  }

  // ---------- おしまい ----------
  *ending() {
    const g = this.game;
    const m = g.audio.music;
    g.beginEnding();
    g.player.lockSeat = true;
    g.ui.setHud(false);
    m.setPositional(false, 3);
    m.setTone(11000, 50, 4);
    m.setVolume(0.75, 6);
    g.audio.setHum(0, 3);
    g.markCleared();
    yield 2.0;
    // 体を離れて、上へ
    const cam = g.camera;
    const startPos = cam.position.clone();
    const startQuat = cam.quaternion.clone();
    const sofaPos = g.sofa.root.position.clone();
    const f = g.sofa.forward();
    const endPos = new THREE.Vector3(sofaPos.x + f.x * 1.9, 6.2, sofaPos.z + f.z * 1.9);
    const m4 = new THREE.Matrix4().lookAt(
      endPos,
      new THREE.Vector3(sofaPos.x, 0.35, sofaPos.z),
      new THREE.Vector3(-f.x, 0, -f.z).normalize(),
    );
    const endQuat = new THREE.Quaternion().setFromRotationMatrix(m4);
    g.player.cutscene = { pos: startPos.clone(), quat: startQuat.clone() };
    g.fogOverride = { density: 0.06 };
    const dur = 16;
    let t = 0;
    while (t < dur) {
      const dt = yield;
      t += dt;
      const e = easeInOutCubic(t / dur);
      const pos = g.player.cutscene.pos;
      pos.lerpVectors(startPos, endPos, e);
      pos.y = lerp(startPos.y, endPos.y, easeInOutCubic(clamp(t / dur, 0, 1)));
      g.player.cutscene.quat.slerpQuaternions(startQuat, endQuat, easeInOutCubic(clamp((t / dur) * 1.25 - 0.1, 0, 1)));
      if (pos.y > CEIL - 0.3) {
        g.world.ceiling.visible = false;
        for (const ch of g.world.chunks) ch.group.visible = false;
      }
    }
    g.ui.showEnding(true);
    yield 7;
    g.input.exitLock();
    g.ui.showEndingButtons(true);
    g.endingReady = true;
  }
}
