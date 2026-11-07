// "Alive" layer on top of the motion: blinking, looking at the mouse cursor, reactions to clicks,
// patting and being dragged around, breathing in still poses and nodding to music.
//
// Everything here is an offset applied after the mixer each frame. Bones the clip does not drive are
// put back before the next frame (Offsets), so nothing accumulates.
import * as THREE from 'three';
import { SIT_STYLES } from './poses-data.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (x) => x * x * (3 - 2 * x);
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/**
 * VRM 0.x models face -Z in their own space; three-vrm turns the whole scene 180° (rotateVRM0), so in
 * their normalized bones a turn about X or Z goes the other way (nodding up becomes nodding down,
 * raising an arm lowers it). Every offset here is written for VRM 1.0 (facing +Z): flip x and z for 0.x.
 */
export function vrmAxisSign(vrm) {
  return vrm?.meta?.metaVersion === '0' ? -1 : 1;
}

class Offsets {
  constructor() {
    this.map = new Map();
  }

  /** Start of a frame, before the mixer: undo last frame's offsets on bones the mixer will not reset. */
  begin() {
    for (const [n, v] of this.map) {
      if (v.after && n.quaternion.equals(v.after)) n.quaternion.copy(v.base);
      if (v.posAfter && n.position.equals(v.posAfter)) n.position.copy(v.pos);
    }
    this.map.clear();
  }

  touch(n) {
    if (!this.map.has(n)) this.map.set(n, { base: n.quaternion.clone(), after: null, pos: n.position.clone(), posAfter: null });
  }

  end() {
    for (const [n, v] of this.map) {
      v.after = n.quaternion.clone();
      v.posAfter = n.position.clone();
    }
  }
}

/**
 * How thick the thighs are, as a share of the thigh's length: the distance of the vertices skinned
 * mostly to an upper leg from the hip-knee line (bind pose, 75th percentile). Seated, the underside
 * of the thigh, not the hips bone, rests on the edge (models put the hips bone at different heights).
 */
export function thighRadius(vrm) {
  const h = vrm.humanoid;
  const ul = h.getRawBoneNode('leftUpperLeg'), ll = h.getRawBoneNode('leftLowerLeg');
  if (!ul || !ll) return 0.12;
  const d = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), p = new THREE.Vector3(), m = new THREE.Matrix4();
  let len = 0;
  vrm.scene.traverse((o) => {
    if (!o.isSkinnedMesh || d.length > 20000) return;
    const bones = o.skeleton.bones;
    const iu = bones.indexOf(ul), il = bones.indexOf(ll);
    if (iu < 0 || il < 0) return;
    a.setFromMatrixPosition(m.copy(o.skeleton.boneInverses[iu]).invert());
    b.setFromMatrixPosition(m.copy(o.skeleton.boneInverses[il]).invert());
    const ab = b.clone().sub(a);
    len = ab.length();
    const pos = o.geometry.attributes.position, si = o.geometry.attributes.skinIndex, sw = o.geometry.attributes.skinWeight;
    if (!pos || !si || !sw || len < 1e-4) return;
    for (let i = 0; i < pos.count; i++) {
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > bw) (bw = sw.getComponent(i, k)), (best = si.getComponent(i, k));
      if (best !== iu) continue;
      p.fromBufferAttribute(pos, i).applyMatrix4(o.bindMatrix);
      const t = clamp(p.clone().sub(a).dot(ab) / (len * len), 0, 1);
      if (t < 0.25 || t > 0.85) continue; // the middle of the thigh, not the hip or the knee
      d.push(a.clone().addScaledVector(ab, t).distanceTo(p) / len);
    }
  });
  if (d.length < 20) return 0.12;
  d.sort((x, y) => x - y);
  return clamp(d[Math.floor(d.length * 0.6)], 0.05, 0.35);
}

export class Life {
  constructor() {
    this.offsets = new Offsets();
    this.axis = 1;
    this.vrm = null;
    this.holder = null;
    this.opts = { lookAt: true, reactions: true };
    this.cursor = null; // {x, y} in window CSS px (may be outside the window)
    this.cursorMovedAt = 0;
    this.target = new THREE.Object3D();
    this.look = { yaw: 0, pitch: 0, w: 0 };
    this.blink = { next: 2, t: -1 };
    this.react = null; // { kind, t0, dur }
    this.clicks = [];
    this.pat = { lastX: null, dir: 0, run: 0, flips: [], until: 0 };
    this.walk = { on: false, dir: 1, w: 0, yaw: 0, phase: 0 };
    this.grab = null; // Alt+drag: { part, target (world), w, releasing }
    this.sit = { mode: null, w: 0, posed: false, style: 'basic', pick: 'random' }; // mode: 'dance' (legs sit, the rest dances) | 'rest' | null
    this.pins = new Map(); // part -> { part, target, w, releasing }: limbs left where they were put (Shift on release)
    this.drag = { on: false, w: 0, vx: 0, vy: 0, lastX: 0, lastY: 0, lastT: 0, ax: 0, swing: 0, swingV: 0 };
    this.expr = {};
    this.height = 1.6;
    this.seatY = 0; // world y the seated thighs rest on (the renderer sets it: floor line + user offset)
    this.t = 0;
  }

  attach(vrm, holder, scene) {
    this.axis = vrmAxisSign(vrm);
    this.offsets.map.clear();
    this.vrm = vrm;
    this.holder = holder;
    scene.add(this.target);
    if (vrm.lookAt) vrm.lookAt.target = this.opts.lookAt ? this.target : null;
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    this.height = head ? Math.max(0.5, head.getWorldPosition(_v).y + 0.15) : 1.6;
    this.hipsRest = vrm.humanoid.getNormalizedBoneNode('hips')?.position.clone() || null;
    this.thighR = thighRadius(vrm);
    this.react = null;
  }

  detach() {
    this.offsets.map.clear();
    this.vrm = null;
  }

  setOptions(o) {
    this.opts = { ...this.opts, ...o };
    if (this.vrm?.lookAt) {
      this.vrm.lookAt.target = this.opts.lookAt ? this.target : null;
      if (!this.opts.lookAt) {
        this.vrm.lookAt.yaw = 0;
        this.vrm.lookAt.pitch = 0;
      }
    }
  }

  /** Release offsets (when the motion changes). */
  reset() {
    this.offsets.begin();
  }

  setCursor(p) {
    if (p && (!this.cursor || Math.abs(p.x - this.cursor.x) + Math.abs(p.y - this.cursor.y) > 1)) this.cursorMovedAt = this.t;
    this.cursor = p;
  }

  // ------------------------------------------------------------- events

  /** A click on the character; part = 'head' | 'body'. */
  click(part) {
    if (!this.opts.reactions) return;
    const now = this.t;
    this.clicks = this.clicks.filter((c) => now - c < 3).concat(now);
    if (this.clicks.length >= 5) {
      this.clicks = [];
      return this.start('angry', 1.6);
    }
    this.start(part === 'head' ? 'happy' : 'surprised', part === 'head' ? 1.3 : 1.0);
  }

  /** Cursor moving over the character (not dragging). overHead: is it on the head? */
  hover(x, overHead) {
    if (!this.opts.reactions) return;
    const p = this.pat;
    if (!overHead) {
      p.lastX = null;
      return;
    }
    if (p.lastX != null) {
      const dx = x - p.lastX;
      const dir = Math.sign(dx);
      if (dir && dir !== p.dir) {
        if (Math.abs(p.run) > 5) p.flips.push(this.t); // a stroke the other way
        p.dir = dir;
        p.run = 0;
      }
      p.run += dx;
    }
    p.lastX = x;
    p.flips = p.flips.filter((f) => this.t - f < 1.5);
    if (p.flips.length >= 3) p.until = this.t + 0.8; // patting: keep it up while the strokes continue
  }

  dragStart(x, y) {
    Object.assign(this.drag, { on: true, lastX: x, lastY: y, lastT: this.t, vx: 0, vy: 0, ax: 0 });
  }

  dragMove(x, y) {
    const d = this.drag;
    const dt = Math.max(1 / 240, this.t - d.lastT);
    const vx = (x - d.lastX) / dt;
    d.ax += ((vx - d.vx) / dt - d.ax) * 0.3;
    d.vx += (vx - d.vx) * 0.4;
    d.vy += ((y - d.lastY) / dt - d.vy) * 0.4;
    Object.assign(d, { lastX: x, lastY: y, lastT: this.t });
  }

  dragEnd() {
    this.drag.on = false;
    if (this.opts.reactions && this.drag.w > 0.5) this.start('relieved', 0.9);
  }

  start(kind, dur) {
    this.react = { kind, t0: this.t, dur };
  }

  /** Seated: move the hips up/down so the underside of the thighs rests on the floor line (world y 0). */
  _seat(w) {
    const h = this.vrm.humanoid;
    const hips = h.getNormalizedBoneNode('hips');
    const legs = ['left', 'right'].map((s) => [h.getNormalizedBoneNode(`${s}UpperLeg`), h.getNormalizedBoneNode(`${s}LowerLeg`)]);
    if (!hips || legs.some(([u, l]) => !u || !l)) return;
    hips.updateWorldMatrix(true, true);
    let low = Infinity;
    for (const [u, l] of legs) {
      const a = u.getWorldPosition(new THREE.Vector3());
      const b = l.getWorldPosition(new THREE.Vector3());
      const r = this.thighR * a.distanceTo(b);
      // lowest point of the thigh's middle part, a tube of radius r around the hip-knee line
      const mid = a.clone().lerp(b, 0.4);
      low = Math.min(low, mid.y - r * Math.sqrt(Math.max(0, 1 - ((b.y - a.y) / Math.max(a.distanceTo(b), 1e-6)) ** 2)));
    }
    if (!Number.isFinite(low)) return;
    this.offsets.touch(hips);
    const sy = hips.parent ? hips.parent.getWorldScale(new THREE.Vector3()).y : 1;
    hips.position.y += ((this.seatY - low) / (sy || 1)) * w;
  }

  // ------------------------------------------------ Alt+drag a hand, a foot or the chest

  /** Start pulling `part` ('leftHand' | 'rightHand' | 'leftFoot' | 'rightFoot' | 'chest') from world point p. */
  grabStart(part, p) {
    const n = this._grabNode(part);
    if (!n) return false;
    const pin = this.pins.get(part);
    this.pins.delete(part);
    const at = pin ? pin.target.clone() : n.getWorldPosition(new THREE.Vector3());
    // keep the offset between where it was clicked and the joint, so it does not jump
    this.grab = { part, offset: at.clone().sub(p), target: at, w: pin ? pin.w : 0, releasing: false };
    return true;
  }

  grabMove(p) {
    if (this.grab && !this.grab.releasing) this.grab.target.copy(p).add(this.grab.offset);
  }

  /** Let go: the limb eases back into the dance, or with `pin` stays where it was put. */
  grabEnd(pin = false) {
    if (!this.grab) return;
    if (pin) {
      this.pins.set(this.grab.part, this.grab);
      this.grab = null;
    } else this.grab.releasing = true;
  }

  /** Pinned limbs ease back into the dance. */
  releasePins() {
    for (const p of this.pins.values()) p.releasing = true;
  }

  get grabbing() {
    return !!this.grab && !this.grab.releasing;
  }

  _grabNode(part) {
    const h = this.vrm?.humanoid;
    if (!h) return null;
    const bone = { leftHand: 'leftHand', rightHand: 'rightHand', leftFoot: 'leftFoot', rightFoot: 'rightFoot', chest: 'chest' }[part];
    return h.getNormalizedBoneNode(bone) || (part === 'chest' ? h.getNormalizedBoneNode('spine') : null);
  }

  /** Walking along the taskbar: dir +1 = to the right of the screen. */
  setWalk(on, dir = 1) {
    this.walk.on = on;
    if (on) this.walk.dir = dir;
  }

  /** How much the dance should pause (0..1): while held or walking. */
  get holdFactor() {
    return Math.max(this.drag.w, this.walk.w, this.sit.mode === 'rest' ? this.sit.w : 0);
  }

  /** Sit on the taskbar's edge: 'dance' keeps dancing from the hips up, 'rest' sits still; null stands. */
  setSit(mode) {
    const st = this.sit;
    // a new sit picks its style (a random one each time with 'random')
    if (mode && !st.mode && st.w < 0.05) {
      const keys = Object.keys(SIT_STYLES);
      st.style = SIT_STYLES[st.pick] ? st.pick : keys[Math.floor(Math.random() * keys.length)];
    }
    st.mode = mode || null;
  }

  /** Which sitting style: a key of SIT_STYLES, or 'random'. Applies from the next sit (now if seated). */
  setSitStyle(pick) {
    const st = this.sit;
    if (pick === st.pick) return;
    st.pick = pick || 'random';
    if (SIT_STYLES[st.pick]) st.style = st.pick;
  }

  /** Seated (by setSit, or a still pose with the thighs forward): the lower legs hang below the floor. */
  get sitting() {
    return this.sit.w > 0.3 || this.sit.posed;
  }

  // -------------------------------------------------------------- frame

  /**
   * ctx: { camera, width, height (window px), dancing, still (holding a pose), beat: { active, phase } }
   * Call after the mixer, before vrm.update().
   */
  update(dt, t, ctx) {
    this.t = t;
    const vrm = this.vrm;
    if (!vrm) return;
    const h = vrm.humanoid;
    const node = (b) => h.getNormalizedBoneNode(b);
    const rot = (b, x, y, z) => {
      const n = node(b);
      if (!n || (!x && !y && !z)) return;
      this.offsets.touch(n);
      n.quaternion.multiply(_q.setFromEuler(_e.set(this.axis * x, y, this.axis * z)));
    };
    const toward = (b, x, y, z, w) => {
      const n = node(b);
      if (!n || w <= 0) return;
      this.offsets.touch(n);
      n.quaternion.slerp(_q2.setFromEuler(_e.set(this.axis * x, y, this.axis * z)), w);
    };
    const expr = { happy: 0, surprised: 0, angry: 0, relaxed: 0, blink: 0 };

    // --- reactions
    let hop = 0;
    const r = this.react;
    if (r) {
      const k = (t - r.t0) / r.dur;
      if (k >= 1) this.react = null;
      else {
        const env = smooth(clamp(k / 0.12, 0, 1)) * smooth(clamp((1 - k) / 0.35, 0, 1));
        const u = t - r.t0;
        if (r.kind === 'happy') {
          expr.happy = env;
          rot('head', 0, 0, 0.18 * env);
          rot('neck', -0.05 * env, 0, 0.06 * env);
          rot('spine', 0, 0, -0.05 * env * Math.sin(u * 7));
          hop = 0.035 * Math.max(0, Math.sin(Math.PI * clamp(u / 0.32, 0, 1)));
        } else if (r.kind === 'surprised') {
          expr.surprised = env;
          rot('spine', -0.1 * env, 0, 0);
          rot('head', -0.12 * env, 0, 0);
          rot('leftUpperArm', 0, 0, 0.35 * env);
          rot('rightUpperArm', 0, 0, -0.35 * env);
          hop = 0.018 * Math.max(0, Math.sin(Math.PI * clamp(u / 0.2, 0, 1)));
        } else if (r.kind === 'angry') {
          expr.angry = env;
          const shake = 0.22 * env * Math.sin(u * 16) * Math.max(0, 1 - u / 0.9);
          rot('head', 0.05 * env, shake, 0);
          rot('leftUpperArm', 0, 0, -0.25 * env);
          rot('rightUpperArm', 0, 0, 0.25 * env);
          rot('leftLowerArm', 0, -0.9 * env, 0);
          rot('rightLowerArm', 0, 0.9 * env, 0);
        } else if (r.kind === 'relieved') {
          expr.relaxed = env;
          rot('chest', 0.06 * env, 0, 0);
        }
      }
    }
    // patting: eyes closed happily, leaning into the hand
    const patW = this.opts.reactions ? clamp((this.pat.until - t) / 0.4, 0, 1) : 0;
    this._patW = (this._patW || 0) + (patW - (this._patW || 0)) * Math.min(1, dt * 6);
    if (this._patW > 0.01) {
      const w = this._patW;
      expr.happy = Math.max(expr.happy, w);
      rot('head', 0.08 * w, 0, 0.12 * w * Math.sin(t * 3));
      rot('neck', 0.05 * w, 0, 0);
    }

    // --- held by the mouse: legs kick and swing, arms up a little, the dance pauses
    const d = this.drag;
    const held = d.on && this.opts.reactions;
    d.w += ((held ? 1 : 0) - d.w) * Math.min(1, dt * (held ? 6 : 4));
    if (!d.on) {
      d.vx *= 0.9;
      d.ax *= 0.8;
    }
    // pendulum for the sideways swing, pushed by the drag acceleration (screen px/s^2)
    const acc = -36 * d.swing - 5 * d.swingV - clamp(d.ax, -20000, 20000) * 0.00025;
    d.swingV += acc * dt;
    d.swing = clamp(d.swing + d.swingV * dt, -0.7, 0.7);
    if (d.w > 0.01) {
      const w = d.w;
      expr.surprised = Math.max(expr.surprised, 0.7 * w);
      for (const [side, s] of [['left', 1], ['right', -1]]) {
        const ph = t * 9 + (s > 0 ? 0 : Math.PI);
        toward(`${side}UpperLeg`, -0.25 + 0.32 * Math.sin(ph), 0, d.swing + s * 0.06, w);
        toward(`${side}LowerLeg`, 0.55 + 0.35 * Math.sin(ph + 0.9), 0, 0, w);
        toward(`${side}Foot`, 0.35, 0, 0, w);
        toward(`${side}UpperArm`, 0, 0, s * (0.55 + 0.1 * Math.sin(ph * 0.7)), w);
        toward(`${side}LowerArm`, 0, -s * 0.7, 0, w);
      }
      rot('spine', 0, 0, -0.4 * d.swing * w);
    }

    // --- walking: turn toward where it goes, walk cycle on top of everything, standing hips height
    const wk = this.walk;
    wk.w += ((wk.on ? 1 : 0) - wk.w) * Math.min(1, dt * (wk.on ? 4 : 3));
    const yawTarget = wk.on ? wk.dir * 1.2 : 0; // ~70 degrees: a profile that still shows the face
    wk.yaw += (yawTarget - wk.yaw) * Math.min(1, dt * 5);
    if (this.holder) this.holder.rotation.y = wk.yaw;
    if (wk.w > 0.01) {
      const w = wk.w;
      wk.phase += dt * 2 * Math.PI * 0.95; // ~1.9 steps per second
      for (const [side, s] of [['left', 1], ['right', -1]]) {
        const ph = wk.phase + (s > 0 ? 0 : Math.PI);
        const knee = 0.12 + 0.7 * Math.max(0, Math.cos(ph)) ** 1.5; // bends while the leg swings forward
        toward(`${side}UpperLeg`, -0.42 * Math.sin(ph), 0, s * 0.03, w);
        toward(`${side}LowerLeg`, knee, 0, 0, w);
        toward(`${side}Foot`, 0.12 * Math.sin(ph) - 0.05, 0, 0, w);
        toward(`${side}UpperArm`, 0.35 * Math.sin(ph), 0, -s * 1.25, w); // opposite to the leg on its side
        toward(`${side}LowerArm`, 0, -s * 0.35, 0, w);
        toward(`${side}Hand`, 0, 0, 0, w);
      }
      toward('spine', 0.04, 0.08 * Math.sin(wk.phase), 0, w);
      toward('chest', 0, 0.05 * Math.sin(wk.phase), 0, w);
      toward('hips', 0, -0.06 * Math.sin(wk.phase), 0, w);
      const hips = node('hips');
      if (hips && this.hipsRest) {
        this.offsets.touch(hips);
        const bob = 0.012 * this.height * Math.abs(Math.cos(wk.phase));
        hips.position.lerp(_v.set(this.hipsRest.x, this.hipsRest.y - bob, this.hipsRest.z), w);
      }
    }

    // --- sitting on the edge of the taskbar (the reference pose is "걸터앉기" in scripts/poses.mjs)
    const st = this.sit;
    st.w += ((st.mode && !wk.on ? 1 : 0) - st.w) * Math.min(1, dt * 2.2);
    const restW = st.mode === 'rest' ? st.w : 0;
    const style = SIT_STYLES[st.style] || SIT_STYLES.basic;
    if (st.w > 0.01) {
      const w = smooth(clamp(st.w, 0, 1));
      // a style rotation, written for VRM 1.0 (x/z mirrored for 0.x like `toward`)
      const towardQ = (b, q, ww) => {
        const n = node(b);
        if (!n || ww <= 0) return;
        this.offsets.touch(n);
        n.quaternion.slerp(_q2.set(this.axis * q[0], q[1], this.axis * q[2], q[3]), ww);
      };
      const LEG = /UpperLeg|LowerLeg|Foot$/;
      for (const [b, q] of Object.entries(style.rotations)) if (LEG.test(b)) towardQ(b, q, w);
      if (restW > 0.01) {
        // sitting still: arms, spine and head from the style too
        const r = smooth(clamp(restW, 0, 1));
        for (const [b, q] of Object.entries(style.rotations)) if (!LEG.test(b)) towardQ(b, q, r);
        if (!style.rotations.chest) toward('chest', 0, 0, 0, r);
      }
      const hips = node('hips');
      if (hips && this.hipsRest) {
        this.offsets.touch(hips);
        hips.quaternion.slerp(_q2.identity(), 0.85 * w); // the dance's hip turns stay a little
        hips.position.y += (this.hipsRest.y * (0.09 / 0.95) - hips.position.y) * w;
        this._seat(w);
      }
    }
    // lower legs swing while seated, also in a still pose that sits (thighs forward, hips low)
    st.posed = false;
    if (st.w > 0.5 || ctx.still) {
      const hips = node('hips');
      const ul = node('leftUpperLeg'), ll = node('leftLowerLeg');
      const thighUp = ul ? _v.set(0, -1, 0).applyQuaternion(ul.quaternion).y : -1;
      const knee = ll ? 2 * Math.acos(Math.min(1, Math.abs(ll.quaternion.w))) : 0;
      const seated = thighUp > -0.55 && knee > 0.7 && hips && this.hipsRest && hips.position.y < this.hipsRest.y * 0.6;
      // crossed legs do not swing: the thighs of a style without swing, or of a still pose, are not side by side
      const ur = node('rightUpperLeg');
      const parallel = !ul || !ur || _v.set(0, -1, 0).applyQuaternion(ul.quaternion).dot(_v2.set(0, -1, 0).applyQuaternion(ur.quaternion)) > 0.93;
      if (seated) {
        st.posed = st.w <= 0.3;
        if (st.posed) this._seat(1); // a still sitting pose, too
      }
      if (seated && parallel && (st.w <= 0.3 || style.swing)) {
        const amp = (0.22 + 0.08 * Math.sin(t * 0.31)) * (1 - d.w);
        for (const [side, s] of [['left', 1], ['right', -1]]) {
          // on the beat when there is music (one kick per beat, legs taking turns), lazily otherwise
          const ph = ctx.beat?.active ? Math.PI * ctx.beat.phase + (s > 0 ? 0 : Math.PI)
            : t * 2.5 + (s > 0 ? 0 : 2.2);
          const k = Math.sin(ph);
          rot(`${side}LowerLeg`, -amp * (0.5 + 0.5 * k), 0, s * 0.25 * amp * k); // a little sideways, so it reads from the front
          rot(`${side}Foot`, 0.15 * amp * Math.sin(ph - 0.8), 0, 0);
        }
      }
    }

    // --- breathing in a still pose / nodding to music
    if ((ctx.still || !ctx.dancing || restW > 0.5) && wk.w < 0.5) {
      const b = Math.sin(t * 1.6);
      rot('chest', -0.025 * b, 0, 0);
      rot('upperChest', -0.015 * b, 0, 0);
      rot('neck', 0.012 * b, 0.02 * Math.sin(t * 0.37), 0);
      rot('head', 0, 0.025 * Math.sin(t * 0.29 + 1), 0.015 * Math.sin(t * 0.23));
      rot('hips', 0, 0, 0.008 * Math.sin(t * 0.5));
      rot('leftUpperArm', 0, 0, 0.02 * b);
      rot('rightUpperArm', 0, 0, -0.02 * b);
      if (ctx.beat?.active && d.w < 0.5) {
        const pulse = Math.exp(-ctx.beat.phase * 7); // sharp on the beat, fading until the next one
        rot('head', 0.09 * pulse, 0, 0);
        rot('neck', 0.04 * pulse, 0, 0);
        rot('chest', 0.03 * pulse, 0, 0);
        hop = Math.max(hop, 0.006 * pulse);
      }
    }

    // --- looking at the cursor: eyes always, the head turns a bit (less while dancing)
    let lookW = 0;
    if (this.opts.lookAt && this.cursor && ctx.camera) {
      const cam = ctx.camera;
      const wx = cam.left + (this.cursor.x / ctx.width) * (cam.right - cam.left);
      const wy = cam.top - (this.cursor.y / ctx.height) * (cam.top - cam.bottom);
      const head = node('head');
      const hp = head ? head.getWorldPosition(_v) : _v.set(0, this.height * 0.9, 0);
      this.target.position.set(wx, wy, hp.z + 0.7 * this.height);
      const dx = wx - hp.x, dy = wy - hp.y, dz = 0.7 * this.height;
      const yaw = clamp(Math.atan2(dx, dz), -0.6, 0.6);
      const pitch = clamp(Math.atan2(dy, Math.hypot(dx, dz)), -0.3, 0.35);
      const k = Math.min(1, dt * 5);
      this.look.yaw += (yaw - this.look.yaw) * k;
      this.look.pitch += (pitch - this.look.pitch) * k;
      const idle = t - this.cursorMovedAt > 8 ? 0.35 : 1; // looked long enough: only glance
      lookW = (ctx.dancing && !ctx.still ? 0.35 : 0.85) * idle * (1 - d.w) * (1 - 0.6 * this._patW) * (1 - 0.7 * wk.w);
    }
    this.look.w += (lookW - this.look.w) * Math.min(1, dt * 3);
    if (this.look.w > 0.01) {
      const w = this.look.w;
      rot('neck', -0.4 * this.look.pitch * w, 0.4 * this.look.yaw * w, 0);
      rot('head', -0.6 * this.look.pitch * w, 0.6 * this.look.yaw * w, 0);
    }

    // --- blinking (not while the eyes are closed by a smile)
    const bl = this.blink;
    if (bl.t < 0 && t >= bl.next) bl.t = t;
    if (bl.t >= 0) {
      const u = (t - bl.t) / 0.16;
      if (u >= 1) {
        bl.t = -1;
        bl.next = t + (Math.random() < 0.15 ? 0.25 : 2 + Math.random() * 4); // sometimes a double blink
      } else expr.blink = u < 0.4 ? u / 0.4 : 1 - (u - 0.4) / 0.6;
    }
    expr.blink *= 1 - Math.max(expr.happy, expr.relaxed);

    const em = vrm.expressionManager;
    for (const [name, v] of Object.entries(expr)) {
      const prev = this.expr[name] || 0;
      const next = name === 'blink' ? v : prev + (v - prev) * Math.min(1, dt * 10);
      this.expr[name] = next;
      if (em?.getExpression(name)) em.setValue(name, next);
    }
    if (this.holder) this.holder.position.y = hop * this.height;
    this._applyGrab(dt);
    this.offsets.end();
  }

  _applyGrab(dt) {
    for (const [part, p] of this.pins) if (!this._pull(p, dt)) this.pins.delete(part);
    if (this.grab && !this._pull(this.grab, dt)) this.grab = null;
  }

  /** One pulled limb; false once it has gone back to the dance. */
  _pull(g, dt) {
    // quick to take hold, slow to let go (about 0.8 s, eased) so the limb drifts back into the dance
    g.w = THREE.MathUtils.clamp(g.w + (g.releasing ? -dt / 0.8 : dt / 0.15), 0, 1);
    if (g.releasing && g.w <= 0) return false;
    const w = g.w * g.w * (3 - 2 * g.w);
    const h = this.vrm.humanoid;
    const node = (b) => h.getNormalizedBoneNode(b);
    if (g.part === 'chest') {
      this._leanTo(node('spine'), node('chest') || node('upperChest'), g.target, w);
      return true;
    }
    const side = g.part.startsWith('left') ? 'left' : 'right';
    const arm = g.part.endsWith('Hand');
    const [a, b, c] = arm ? [`${side}UpperArm`, `${side}LowerArm`, `${side}Hand`] : [`${side}UpperLeg`, `${side}LowerLeg`, `${side}Foot`];
    this._twoBone(node(a), node(b), node(c), g.target, w, arm);
    return true;
  }

  /** Turn `bone` (world rotation applied) so its child direction goes from `from` to `to`, mixed by w. */
  _aim(bone, from, to, w) {
    if (!bone || from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return;
    this.offsets.touch(bone);
    bone.parent.updateWorldMatrix(true, false);
    const pw = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    const bw = bone.getWorldQuaternion(new THREE.Quaternion());
    const turn = new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
    const want = turn.multiply(bw); // new world rotation
    const local = pw.invert().multiply(want);
    bone.quaternion.slerp(local, w);
    bone.updateMatrixWorld(true);
  }

  /** Two-bone IK: root -> mid -> end reaches `target` (world), the knee/elbow bending the way it already bends. */
  _twoBone(root, mid, end, target, w, arm) {
    if (!root || !mid || !end) return;
    root.updateWorldMatrix(true, true);
    const S = root.getWorldPosition(new THREE.Vector3());
    const E = mid.getWorldPosition(new THREE.Vector3());
    const H = end.getWorldPosition(new THREE.Vector3());
    const l1 = S.distanceTo(E), l2 = E.distanceTo(H);
    const toT = target.clone().sub(S);
    const d = THREE.MathUtils.clamp(toT.length(), Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
    const u = toT.normalize();
    // bend plane: where the elbow/knee points now; a straight limb bends down (arms) / forward (legs)
    let pole = E.clone().sub(S).sub(u.clone().multiplyScalar(E.clone().sub(S).dot(u)));
    if (pole.lengthSq() < 1e-8) pole = arm ? new THREE.Vector3(0, -1, -0.3) : new THREE.Vector3(0, 0, 1);
    pole.sub(u.clone().multiplyScalar(pole.dot(u))).normalize();
    const ang = Math.acos(THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
    const E2 = S.clone().add(u.clone().multiplyScalar(Math.cos(ang) * l1)).add(pole.multiplyScalar(Math.sin(ang) * l1));
    const H2 = S.clone().add(u.clone().multiplyScalar(d));
    this._aim(root, E.clone().sub(S), E2.clone().sub(S), w);
    const E3 = mid.getWorldPosition(new THREE.Vector3());
    const H3 = end.getWorldPosition(new THREE.Vector3());
    this._aim(mid, H3.clone().sub(E3), H2.clone().sub(E3), w);
  }

  /** Lean the upper body toward the target: half in the spine, half in the chest, at most ~40°. */
  _leanTo(spine, chest, target, w) {
    if (!spine) return;
    spine.updateWorldMatrix(true, true);
    const base = spine.getWorldPosition(new THREE.Vector3());
    const top = (chest || spine).getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.15 * this.height, 0));
    const from = top.clone().sub(base);
    let to = target.clone().sub(base);
    const a = from.angleTo(to);
    if (a > 0.7) to = from.clone().lerp(to.clone().setLength(from.length()), 0.7 / a);
    const half = new THREE.Vector3().lerpVectors(from, to, 0.5);
    this._aim(spine, from, half, w);
    if (chest) {
      const t2 = (chest || spine).getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.15 * this.height, 0));
      const b2 = chest.getWorldPosition(new THREE.Vector3());
      this._aim(chest, t2.clone().sub(b2).normalize(), to.clone().sub(half).normalize().add(half.clone().normalize()).normalize(), w);
    }
  }

  /** Head center and radius in window px. */
  headPx(camera, width, height) {
    const head = this.vrm?.humanoid.getNormalizedBoneNode('head');
    const neck = this.vrm?.humanoid.getNormalizedBoneNode('neck');
    if (!head) return null;
    const toPx = (v) => {
      v.project(camera);
      return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height };
    };
    const hp = toPx(head.getWorldPosition(_v));
    const np = neck ? toPx(neck.getWorldPosition(_v2)) : { x: hp.x, y: hp.y + 20 };
    const r = Math.max(12, 1.6 * Math.hypot(hp.x - np.x, hp.y - np.y));
    return { x: hp.x, y: hp.y - 0.6 * r, r }; // the head's center is above the head bone
  }

  /** Which part of the character is at window px (x, y)? 'head' | 'body' */
  partAt(x, y, camera, width, height) {
    const h = this.headPx(camera, width, height);
    return h && Math.hypot(x - h.x, y - h.y) < h.r ? 'head' : 'body';
  }
}
