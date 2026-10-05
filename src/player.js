// 一人称の移動・座る／立つの動き
import { clamp, mod, lerp, angleDelta, easeInOut, smoothstep, wrapDelta } from './util.js';

export const EYE = 1.62;

export class Player {
  constructor() {
    this.x = 0;
    this.z = 0;
    this.y = EYE;
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.vx = 0;
    this.vz = 0;
    this.radius = 0.28;
    this.walkSpeed = 1.45;
    this.runSpeed = 2.45;
    this.stepPhase = 0;
    this.bobAmp = 0;
    this.walked = 0;
    this.seated = false;
    this.anim = null;
    this.lockSeat = false;
    this.frozen = false;
    this.cutscene = null; // { pos, quat } を director が直接書く
    this.onStep = null;
    this.breath = 0;
    this.speed = 0;
  }

  spawn(x, z, yaw) {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.pitch = -0.02;
    this.y = EYE;
    this.vx = this.vz = 0;
    this.seated = false;
    this.anim = null;
  }

  look(input, sens, invertY) {
    if (this.frozen) return;
    this.yaw -= input.lookDX * sens;
    this.pitch -= input.lookDY * sens * (invertY ? -1 : 1);
    this.pitch = clamp(this.pitch, -1.48, 1.48);
  }

  update(dt, input, world, sofa, settings) {
    this.look(input, settings.sens, settings.invertY);
    this.breath += dt;
    if (this.anim) {
      this.updateAnim(dt, sofa);
      return;
    }
    if (this.seated) {
      const base = sofa.rot + Math.PI;
      const d = angleDelta(base, this.yaw);
      const lim = 1.95;
      if (Math.abs(d) > lim) this.yaw = base + Math.sign(d) * lim;
      this.pitch = clamp(this.pitch, -1.15, 1.05);
      const sp = sofa.seatPose();
      this.x = sp.x;
      this.z = sp.z;
      this.y = sp.y + Math.sin(this.breath * 1.3) * 0.004;
      this.roll *= 0.9;
      this.speed = 0;
      return;
    }
    if (this.frozen) {
      this.speed = 0;
      return;
    }
    let mx = input.moveX;
    let mz = input.moveZ;
    const len = Math.hypot(mx, mz);
    if (len > 1) {
      mx /= len;
      mz /= len;
    }
    const sp = input.run ? this.runSpeed : this.walkSpeed;
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    const tvx = (fx * mz + rx * mx) * sp;
    const tvz = (fz * mz + rz * mx) * sp;
    const k = 1 - Math.exp(-dt * 9);
    this.vx += (tvx - this.vx) * k;
    this.vz += (tvz - this.vz) * k;
    const px = this.x;
    const pz = this.z;
    const pos = { x: this.x + this.vx * dt, z: this.z + this.vz * dt };
    world.collide(pos, this.radius);
    sofa.collide(pos, this.radius);
    world.collide(pos, this.radius);
    const moved = Math.hypot(pos.x - px, pos.z - pz);
    this.x = mod(pos.x, world.W);
    this.z = mod(pos.z, world.W);
    this.walked += moved;
    const spd = dt > 0 ? moved / dt : 0;
    this.speed = spd;
    const target = spd > 0.15 ? Math.min(spd / this.walkSpeed, 1.5) : 0;
    this.bobAmp += (target - this.bobAmp) * (1 - Math.exp(-dt * 6));
    const prev = this.stepPhase;
    this.stepPhase += moved / 0.74;
    if (Math.floor(this.stepPhase) !== Math.floor(prev) && this.onStep) this.onStep(spd);
    const bob = settings.bob ? 1 : 0.15;
    this.y = EYE - Math.cos(this.stepPhase * Math.PI * 2) * 0.022 * this.bobAmp * bob + Math.sin(this.breath * 1.1) * 0.003;
    this.roll = Math.sin(this.stepPhase * Math.PI) * 0.006 * this.bobAmp * bob;
  }

  sitOn(sofa, onLand) {
    const seat = sofa.seatPose();
    const front = sofa.standPose();
    const W = sofa.W;
    // 折り返しを考えて、今の位置からの相対で動かす
    const fdx = wrapDelta(front.x - this.x, W);
    const fdz = wrapDelta(front.z - this.z, W);
    const sdx = wrapDelta(seat.x - this.x, W);
    const sdz = wrapDelta(seat.z - this.z, W);
    const dist = Math.hypot(fdx, fdz);
    this.anim = {
      type: 'sit',
      t: 0,
      dur: clamp(1.25 + dist * 0.35, 1.25, 2.4),
      x0: this.x,
      z0: this.z,
      y0: this.y,
      fx: this.x + fdx,
      fz: this.z + fdz,
      sx: this.x + sdx,
      sz: this.z + sdz,
      sy: seat.y,
      yaw0: this.yaw,
      yaw1: this.yaw + angleDelta(this.yaw, seat.yaw),
      pitch0: this.pitch,
      landed: false,
      onLand,
    };
    this.vx = this.vz = 0;
  }

  standUp(sofa, onStart) {
    const stand = sofa.standPose();
    const W = sofa.W;
    const dx = wrapDelta(stand.x - this.x, W);
    const dz = wrapDelta(stand.z - this.z, W);
    this.seated = false;
    this.anim = {
      type: 'stand',
      t: 0,
      dur: 1.15,
      x0: this.x,
      z0: this.z,
      y0: this.y,
      x1: this.x + dx,
      z1: this.z + dz,
      pitch0: this.pitch,
    };
    if (onStart) onStart();
  }

  seatInstant(sofa) {
    const seat = sofa.seatPose();
    this.x = seat.x;
    this.z = seat.z;
    this.y = seat.y;
    this.yaw = seat.yaw;
    this.pitch = -0.06;
    this.seated = true;
    this.anim = null;
    this.vx = this.vz = 0;
  }

  updateAnim(dt, sofa) {
    const a = this.anim;
    a.t += dt / a.dur;
    const t = clamp(a.t, 0, 1);
    if (a.type === 'sit') {
      // 前に回り込み、振り向いて、腰を下ろす
      const e = easeInOut(t);
      const u = 1 - e;
      const x = u * u * a.x0 + 2 * u * e * a.fx + e * e * a.sx;
      const z = u * u * a.z0 + 2 * u * e * a.fz + e * e * a.sz;
      this.x = x;
      this.z = z;
      const ty = easeInOut(smoothstep(0.0, 0.65, t));
      this.yaw = lerp(a.yaw0, a.yaw1, ty);
      this.pitch = lerp(a.pitch0, -0.08, easeInOut(smoothstep(0.1, 0.8, t)));
      const down = easeInOut(smoothstep(0.42, 0.92, t));
      const sink = Math.sin(clamp((t - 0.82) / 0.18, 0, 1) * Math.PI) * 0.045;
      this.y = lerp(a.y0, a.sy, down) - sink;
      this.roll = Math.sin(t * Math.PI) * 0.02;
      if (!a.landed && t > 0.8) {
        a.landed = true;
        if (a.onLand) a.onLand();
      }
      if (t >= 1) {
        this.anim = null;
        this.seated = true;
        this.x = mod(this.x, sofa.W);
        this.z = mod(this.z, sofa.W);
      }
    } else {
      const e = easeInOut(t);
      this.x = lerp(a.x0, a.x1, easeInOut(smoothstep(0.15, 1, t)));
      this.z = lerp(a.z0, a.z1, easeInOut(smoothstep(0.15, 1, t)));
      this.y = lerp(a.y0, EYE, easeInOut(smoothstep(0.0, 0.75, t))) - Math.sin(e * Math.PI) * 0.02;
      this.pitch = lerp(a.pitch0, Math.max(a.pitch0, -0.1), e);
      this.roll = Math.sin(t * Math.PI) * -0.015;
      if (t >= 1) {
        this.anim = null;
        this.x = mod(this.x, sofa.W);
        this.z = mod(this.z, sofa.W);
      }
    }
  }

  applyTo(camera) {
    if (this.cutscene) {
      camera.position.copy(this.cutscene.pos);
      camera.quaternion.copy(this.cutscene.quat);
      return;
    }
    camera.position.set(this.x, this.y, this.z);
    camera.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
  }
}
