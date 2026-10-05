// 音はすべて Web Audio で合成する（音声ファイルは使わない）

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

function setPos(node, x, y, z, t) {
  if (node.positionX) {
    node.positionX.setValueAtTime(x, t);
    node.positionY.setValueAtTime(y, t);
    node.positionZ.setValueAtTime(z, t);
  } else node.setPosition(x, y, z);
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.volume = 0.8;
    this.clickBudget = 0;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));
    this.out = ctx.createGain();
    this.out.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 10;
    comp.ratio.value = 3;
    comp.attack.value = 0.008;
    comp.release.value = 0.3;
    this.out.connect(comp);
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.connect(this.out);

    this.noise = this.makeNoise(3, false);
    this.brown = this.makeNoise(5, true);

    // 残響
    this.verb = ctx.createConvolver();
    this.verbIn = ctx.createGain();
    this.verbOut = ctx.createGain();
    this.verbOut.gain.value = 0.55;
    this.verbIn.connect(this.verb);
    this.verb.connect(this.verbOut);
    this.verbOut.connect(this.master);
    this.setReverb(1.2);

    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.sfxSend = ctx.createGain();
    this.sfxSend.gain.value = 0.3;
    this.sfx.connect(this.sfxSend);
    this.sfxSend.connect(this.verbIn);

    this.initHum();
    this.initRoom();
    this.initWater();
    this.music = new Music(this);
    this.ready = true;
  }

  resume() {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume();
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }

  setVolume(v) {
    this.volume = v;
    if (this.out) this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  makeNoise(sec, brown) {
    const ctx = this.ctx;
    const len = Math.floor(sec * ctx.sampleRate);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else d[i] = w;
    }
    return buf;
  }

  // 残響の長さ（秒）を変える。部屋の広さに合わせて
  setReverb(sec) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * sec);
    const pre = Math.floor(rate * 0.012);
    const buf = ctx.createBuffer(2, len + pre, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const k = i / len;
        d[i + pre] = (Math.random() * 2 - 1) * Math.pow(1 - k, 2.6) * (0.9 + 0.1 * Math.sin(i * 0.002 + ch));
      }
      // 初期反射
      for (let r = 0; r < 6; r++) {
        const at = pre + Math.floor(rate * (0.008 + Math.random() * 0.05));
        if (at < d.length) d[at] += (Math.random() < 0.5 ? -1 : 1) * (0.5 - r * 0.06);
      }
    }
    this.verb.buffer = buf;
  }

  setListener(fx, fy, fz) {
    if (!this.ready) return;
    const L = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (L.forwardX) {
      L.positionX.setValueAtTime(0, t);
      L.positionY.setValueAtTime(0, t);
      L.positionZ.setValueAtTime(0, t);
      L.forwardX.setValueAtTime(fx, t);
      L.forwardY.setValueAtTime(fy, t);
      L.forwardZ.setValueAtTime(fz, t);
      L.upX.setValueAtTime(0, t);
      L.upY.setValueAtTime(1, t);
      L.upZ.setValueAtTime(0, t);
    } else {
      L.setPosition(0, 0, 0);
      L.setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  panner(x, y, z, ref = 1.5, roll = 1.1) {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = roll;
    p.maxDistance = 80;
    setPos(p, x, y, z, this.ctx.currentTime);
    return p;
  }

  env(g, t, peak, a, d) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  noiseSrc(t, dur) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.start(t, Math.random() * 2, dur);
    return s;
  }

  // ---------- 環境音 ----------
  initHum() {
    const ctx = this.ctx;
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 650;
    const mk = (type, f, g) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const gn = ctx.createGain();
      gn.gain.value = g;
      o.connect(gn);
      gn.connect(lp);
      o.start();
    };
    mk('sawtooth', 120, 0.13);
    mk('sine', 60, 0.28);
    mk('sine', 240, 0.05);
    mk('sine', 360.5, 0.02);
    lp.connect(this.humGain);
    // 安定器のジー音
    const nz = ctx.createBufferSource();
    nz.buffer = this.noise;
    nz.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3600;
    bp.Q.value = 1.4;
    const am = ctx.createGain();
    am.gain.value = 0;
    const amOsc = ctx.createOscillator();
    amOsc.frequency.value = 120;
    const amDepth = ctx.createGain();
    amDepth.gain.value = 0.014;
    amOsc.connect(amDepth);
    amDepth.connect(am.gain);
    amOsc.start();
    nz.connect(bp);
    bp.connect(am);
    am.connect(this.humGain);
    nz.start();
    // 電圧が落ちたときだけ動かす、もう一段の音量
    this.humSag = ctx.createGain();
    this.humGain.connect(this.humSag);
    this.humSag.connect(this.master);
  }

  // すべての明かりが一瞬ゆらぐときの、うなりの落ち込み
  humDip() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const g = this.humSag.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(1, t);
    g.linearRampToValueAtTime(0.2, t + 0.05);
    g.linearRampToValueAtTime(0.85, t + 0.1);
    g.linearRampToValueAtTime(0.45, t + 0.18);
    g.linearRampToValueAtTime(1, t + 0.45);
  }

  setHum(level, tc = 0.35) {
    if (!this.ready) return;
    this.humGain.gain.setTargetAtTime(Math.max(0, level) * 0.1, this.ctx.currentTime, tc);
  }

  initRoom() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 200;
    this.roomGain = ctx.createGain();
    this.roomGain.gain.value = 0.05;
    src.connect(lp);
    lp.connect(this.roomGain);
    this.roomGain.connect(this.master);
    src.start();
  }

  setRoom(level, tc = 1) {
    if (!this.ready) return;
    this.roomGain.gain.setTargetAtTime(level, this.ctx.currentTime, tc);
  }

  initWater() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 520;
    bp.Q.value = 0.7;
    const am = ctx.createGain();
    am.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.17;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.35;
    lfo.connect(lfoG);
    lfoG.connect(am.gain);
    lfo.start();
    this.waterGain = ctx.createGain();
    this.waterGain.gain.value = 0;
    src.connect(bp);
    bp.connect(am);
    am.connect(this.waterGain);
    this.waterGain.connect(this.master);
    this.waterGain.connect(this.verbIn);
    src.start();
  }

  setWater(level, tc = 2) {
    if (!this.ready) return;
    this.waterGain.gain.setTargetAtTime(level * 0.02, this.ctx.currentTime, tc);
  }

  // ---------- 効果音 ----------
  footstep(strength = 1, wet = false) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.004;
    const v = (0.65 + Math.random() * 0.3) * strength;
    const hit = (g, peak, at, tc) => {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + at);
      g.gain.setTargetAtTime(0, t + at, tc);
    };
    // 柔らかい踏み音（カーペットに吸われた低めの音）
    const s = this.noiseSrc(t, 0.4);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 650 + Math.random() * 350;
    lp.Q.value = 0.4;
    const g = ctx.createGain();
    hit(g, 0.5 * v, 0.006, 0.035);
    s.connect(lp);
    lp.connect(g);
    g.connect(this.sfx);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(110 + Math.random() * 25, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.08);
    const og = ctx.createGain();
    hit(og, 0.32 * v, 0.004, 0.04);
    o.connect(og);
    og.connect(this.sfx);
    o.start(t);
    o.stop(t + 0.3);
    // カーペットのこすれ
    const s2 = this.noiseSrc(t + 0.025, 0.2);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2400;
    const g2 = ctx.createGain();
    this.env(g2, t + 0.025, 0.06 * v, 0.02, 0.08);
    s2.connect(hp);
    hp.connect(g2);
    g2.connect(this.sfx);
    if (wet) {
      const s3 = this.noiseSrc(t, 0.6);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900 + Math.random() * 900;
      bp.Q.value = 0.8;
      const g3 = ctx.createGain();
      g3.gain.setValueAtTime(0.0001, t);
      g3.gain.exponentialRampToValueAtTime(0.38 * v, t + 0.03);
      g3.gain.exponentialRampToValueAtTime(0.09 * v, t + 0.12);
      g3.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      s3.connect(bp);
      bp.connect(g3);
      g3.connect(this.sfx);
      g3.connect(this.verbIn);
      this.plip(0, -1.4, 0.3, 0.8, t + 0.05 + Math.random() * 0.08);
    }
  }

  // 水滴の「ぽちゃ」
  plip(x, y, z, vol = 1, t0 = null) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = t0 ?? ctx.currentTime + 0.01;
    const f = 700 + Math.random() * 1300;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 2.1, t + 0.05);
    const g = ctx.createGain();
    this.env(g, t, 0.09 * vol, 0.004, 0.09);
    const p = this.panner(x, y, z, 1.2, 1.0);
    o.connect(g);
    g.connect(p);
    p.connect(this.sfx);
    const send = ctx.createGain();
    send.gain.value = 0.8;
    g.connect(send);
    send.connect(this.verbIn);
    o.start(t);
    o.stop(t + 0.12);
    o.onended = () => p.disconnect();
  }

  // 蛍光灯のカチッ・ジッ
  lightClick(x, y, z, kind) {
    if (!this.ready) return;
    const d2 = x * x + y * y + z * z;
    if (d2 > 30 * 30) return;
    if (this.clickBudget <= 0) return;
    this.clickBudget--;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.003;
    const p = this.panner(x, y, z, 1.8, 1.15);
    p.connect(this.sfx);
    const out = ctx.createGain();
    out.gain.value = kind === 'flick' ? 0.75 : 1.5;
    out.connect(p);
    const s = this.noiseSrc(t, 0.05);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1600;
    const g = ctx.createGain();
    this.env(g, t, 0.11, 0.002, 0.03);
    s.connect(hp);
    hp.connect(g);
    g.connect(out);
    if (kind === 'on') {
      for (const f of [2150, 3320]) {
        const o = ctx.createOscillator();
        o.frequency.value = f * (0.97 + Math.random() * 0.06);
        const og = ctx.createGain();
        this.env(og, t, 0.03, 0.002, 0.09);
        o.connect(og);
        og.connect(out);
        o.start(t);
        o.stop(t + 0.12);
      }
    }
    // 一瞬のジジッ
    const bz = ctx.createOscillator();
    bz.type = 'sawtooth';
    bz.frequency.value = 120;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1100;
    bp.Q.value = 2;
    const bg = ctx.createGain();
    this.env(bg, t, kind === 'off' ? 0.05 : 0.035, 0.005, kind === 'off' ? 0.18 : 0.1);
    bz.connect(bp);
    bp.connect(bg);
    bg.connect(out);
    bz.start(t);
    bz.stop(t + 0.25);
    if (kind === 'off') {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(70, t + 0.08);
      const og = ctx.createGain();
      this.env(og, t, 0.06, 0.004, 0.1);
      o.connect(og);
      og.connect(out);
      o.start(t);
      o.stop(t + 0.14);
    }
    bz.onended = () => p.disconnect();
  }

  // 遠くでブレーカーが落ちるような音
  clunk() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.01;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(75, t);
    o.frequency.exponentialRampToValueAtTime(34, t + 0.35);
    const g = ctx.createGain();
    this.env(g, t, 0.55, 0.006, 0.7);
    o.connect(g);
    g.connect(this.master);
    g.connect(this.verbIn);
    o.start(t);
    o.stop(t + 0.8);
    const s = this.noiseSrc(t, 0.3);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    const g2 = ctx.createGain();
    this.env(g2, t, 0.5, 0.003, 0.12);
    s.connect(lp);
    lp.connect(g2);
    g2.connect(this.master);
    g2.connect(this.verbIn);
  }

  // ソファーに沈む音
  sit(down = true) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.01;
    const s = this.noiseSrc(t, 0.8);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(down ? 500 : 350, t);
    lp.frequency.exponentialRampToValueAtTime(140, t + 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(down ? 1.1 : 0.6, t + (down ? 0.06 : 0.12));
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    s.connect(lp);
    lp.connect(g);
    g.connect(this.sfx);
    // スプリングのきしみ
    for (const [f, a, dl] of [
      [205, 0.03, 0.05],
      [318, 0.018, 0.09],
      [161, 0.02, 0.2],
    ]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(f * (0.95 + Math.random() * 0.1), t + dl);
      o.frequency.linearRampToValueAtTime(f * 0.93, t + dl + 0.3);
      const og = ctx.createGain();
      this.env(og, t + dl, a * (down ? 2 : 1.2), 0.01, 0.28);
      o.connect(og);
      og.connect(this.sfx);
      o.start(t + dl);
      o.stop(t + dl + 0.4);
    }
    // 布のこすれ
    const s2 = this.noiseSrc(t + 0.05, 0.4);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3000;
    bp.Q.value = 0.6;
    const g2 = ctx.createGain();
    this.env(g2, t + 0.05, 0.06, 0.08, 0.25);
    s2.connect(bp);
    bp.connect(g2);
    g2.connect(this.sfx);
  }

  // ソファーを見つけたときの、ごく小さな和音
  chime() {
    if (!this.ready) return;
    const t = this.ctx.currentTime + 0.05;
    [61, 65, 68, 72].forEach((m, k) => this.music.ep(midiHz(m), t + k * 0.09, 2.5, 0.12, this.verbIn));
  }

  update(dt) {
    this.clickBudget = Math.min(10, this.clickBudget + dt * 30);
    if (this.music) this.music.update();
  }
}

// どこかで鳴っている、古いラウンジ音楽
const CHORDS = [
  { root: 42, notes: [58, 61, 65, 68] }, // G♭maj9
  { root: 41, notes: [56, 60, 63, 67] }, // Fm9
  { root: 39, notes: [54, 58, 61, 65] }, // E♭m9
  { root: 44, notes: [54, 58, 61, 63] }, // A♭9sus4
];
const HOME = { root: 37, notes: [53, 56, 60, 63] }; // D♭maj9
const SCALE = [65, 68, 70, 72, 73, 75, 77, 80, 82];

class Music {
  constructor(e) {
    this.e = e;
    const ctx = e.ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = 2.2;
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 160;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 900;
    this.lp.Q.value = 0.6;
    this.bus.connect(this.hp);
    this.hp.connect(this.lp);
    this.amb = ctx.createGain();
    this.pos = ctx.createGain();
    this.pos.gain.value = 0;
    this.panner = e.panner(0, 0, -3, 2.5, 1.0);
    this.lp.connect(this.amb);
    this.lp.connect(this.pos);
    this.pos.connect(this.panner);
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.amb.connect(this.out);
    this.panner.connect(this.out);
    this.out.connect(e.master);
    this.send = ctx.createGain();
    this.send.gain.value = 0.45;
    this.out.connect(this.send);
    this.send.connect(e.verbIn);
    // テープのゆらぎ
    this.wow = ctx.createGain();
    this.wow.gain.value = 9;
    const l1 = ctx.createOscillator();
    l1.frequency.value = 0.55;
    l1.connect(this.wow);
    l1.start();
    const l2 = ctx.createOscillator();
    l2.frequency.value = 0.13;
    const l2g = ctx.createGain();
    l2g.gain.value = 0.7;
    l2.connect(l2g);
    l2g.connect(this.wow);
    l2.start();
    this.playing = false;
    this.bpm = 66;
    this.beat = 60 / this.bpm;
    this.step = 0;
    this.melodyIdx = 4;
  }

  start() {
    if (this.playing) return;
    this.playing = true;
    this.next = this.e.ctx.currentTime + 0.15;
    this.step = 0;
  }

  stop() {
    this.playing = false;
  }

  setVolume(v, tc = 1.2) {
    this.out.gain.setTargetAtTime(v, this.e.ctx.currentTime, tc);
  }

  // muffle: 0（はっきり）〜 1（壁の向こう）
  setTone(cutoff, hp = 160, tc = 1.0) {
    const t = this.e.ctx.currentTime;
    this.lp.frequency.setTargetAtTime(cutoff, t, tc);
    this.hp.frequency.setTargetAtTime(hp, t, tc);
  }

  setPositional(on, tc = 0.8) {
    const t = this.e.ctx.currentTime;
    this.amb.gain.setTargetAtTime(on ? 0 : 1, t, tc);
    this.pos.gain.setTargetAtTime(on ? 1 : 0, t, tc);
  }

  setSource(x, y, z) {
    setPos(this.panner, x, y, z, this.e.ctx.currentTime);
  }

  update() {
    if (!this.playing) return;
    const ctx = this.e.ctx;
    while (this.next < ctx.currentTime + 0.5) {
      this.playStep(this.step, this.next);
      this.next += this.beat;
      this.step++;
    }
  }

  playStep(step, t) {
    const loop = Math.floor(step / 32);
    const ci = Math.floor(step / 8) % 4;
    const b = step % 8;
    let ch = CHORDS[ci];
    if (ci === 3 && loop % 2 === 1) ch = HOME;
    const sw = this.beat * 0.12; // ほんの少しのスウィング
    if (b === 0) {
      this.pad(ch.notes, t, this.beat * 8);
      this.bass(midiHz(ch.root), t, this.beat * 1.6);
      ch.notes.forEach((m, k) => this.ep(midiHz(m), t + k * 0.012, this.beat * 2.5, 0.05));
    }
    if (b === 3) ch.notes.slice(1).forEach((m, k) => this.ep(midiHz(m), t + sw + k * 0.01, this.beat * 1.2, 0.03));
    if (b === 4) this.bass(midiHz(ch.root + 7), t, this.beat * 1.2, 0.7);
    if (b === 6) this.bass(midiHz(ch.root + 12), t + sw, this.beat * 0.8, 0.5);
    if (b === 1 || b === 3 || b === 5 || b === 7) this.brush(t + (b % 2 ? sw : 0));
    // まばらなメロディー
    if ((b === 2 || b === 5 || b === 7) && Math.random() < 0.42) {
      this.melodyIdx = Math.max(0, Math.min(SCALE.length - 1, this.melodyIdx + Math.round((Math.random() - 0.5) * 3.2)));
      this.ep(midiHz(SCALE[this.melodyIdx]), t + sw, this.beat * 1.5, 0.045, null, true);
    }
  }

  ep(f, t, dur, vel, dest = null, bright = false) {
    const ctx = this.e.ctx;
    const car = ctx.createOscillator();
    car.frequency.value = f;
    const mod = ctx.createOscillator();
    mod.frequency.value = f * (bright ? 2.0 : 1.0);
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(f * (bright ? 1.1 : 1.6), t);
    mg.gain.exponentialRampToValueAtTime(f * 0.08, t + 0.5);
    mod.connect(mg);
    mg.connect(car.frequency);
    const h2 = ctx.createOscillator();
    h2.frequency.value = f * 2;
    const h2g = ctx.createGain();
    h2g.gain.value = 0.12;
    h2.connect(h2g);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(vel, t + 0.008);
    env.gain.exponentialRampToValueAtTime(vel * 0.3, t + 1.2);
    env.gain.setTargetAtTime(0.0001, t + dur, 0.35);
    car.connect(env);
    h2g.connect(env);
    env.connect(dest ?? this.bus);
    if (!dest) {
      this.wow.connect(car.detune);
      this.wow.connect(h2.detune);
    }
    const end = t + dur + 2.0;
    for (const o of [car, mod, h2]) {
      o.start(t);
      o.stop(end);
    }
    car.onended = () => {
      if (!dest) {
        try {
          this.wow.disconnect(car.detune);
          this.wow.disconnect(h2.detune);
        } catch (err) {
          void err;
        }
      }
      env.disconnect();
    };
  }

  pad(notes, t, dur) {
    const ctx = this.e.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 650;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.012, t + 1.6);
    env.gain.setValueAtTime(0.012, t + dur - 0.4);
    env.gain.setTargetAtTime(0.0001, t + dur - 0.4, 0.6);
    lp.connect(env);
    env.connect(this.bus);
    const oscs = [];
    for (const m of notes) {
      for (const det of [-7, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midiHz(m);
        o.detune.value = det;
        this.wow.connect(o.detune);
        o.connect(lp);
        o.start(t);
        o.stop(t + dur + 3);
        oscs.push(o);
      }
    }
    oscs[0].onended = () => {
      for (const o of oscs) {
        try {
          this.wow.disconnect(o.detune);
        } catch (err) {
          void err;
        }
      }
      env.disconnect();
    };
  }

  bass(f, t, dur, vel = 1) {
    const ctx = this.e.ctx;
    const o = ctx.createOscillator();
    o.frequency.value = f;
    const o2 = ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.value = f * 2;
    const g2 = ctx.createGain();
    g2.gain.value = 0.25;
    o2.connect(g2);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.09 * vel, t + 0.012);
    env.gain.exponentialRampToValueAtTime(0.04 * vel, t + 0.5);
    env.gain.setTargetAtTime(0.0001, t + dur, 0.12);
    o.connect(env);
    g2.connect(env);
    env.connect(this.bus);
    o.start(t);
    o2.start(t);
    o.stop(t + dur + 1);
    o2.stop(t + dur + 1);
    o.onended = () => env.disconnect();
  }

  brush(t) {
    const ctx = this.e.ctx;
    const s = this.e.noiseSrc(t, 0.2);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 5200;
    bp.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.012, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    s.connect(bp);
    bp.connect(g);
    g.connect(this.bus);
  }
}
