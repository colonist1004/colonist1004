// "Alive" layer on top of the motion: blinking, looking at the mouse cursor, reactions to clicks,
// patting and being dragged around, breathing in still poses and nodding to music.
//
// Everything here is an offset applied after the mixer each frame. Bones the clip does not drive are
// put back before the next frame (Offsets), so nothing accumulates.
import * as THREE from 'three';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (x) => x * x * (3 - 2 * x);
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

class Offsets {
  constructor() {
    this.map = new Map();
  }

  /** Start of a frame, before the mixer: undo last frame's offsets on bones the mixer will not reset. */
  begin() {
    for (const [n, { base, after }] of this.map) if (after && n.quaternion.equals(after)) n.quaternion.copy(base);
    this.map.clear();
  }

  touch(n) {
    if (!this.map.has(n)) this.map.set(n, { base: n.quaternion.clone(), after: null });
  }

  end() {
    for (const [n, v] of this.map) v.after = n.quaternion.clone();
  }
}

export class Life {
  constructor() {
    this.offsets = new Offsets();
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
    this.drag = { on: false, w: 0, vx: 0, vy: 0, lastX: 0, lastY: 0, lastT: 0, ax: 0, swing: 0, swingV: 0 };
    this.expr = {};
    this.height = 1.6;
    this.t = 0;
  }

  attach(vrm, holder, scene) {
    this.offsets.map.clear();
    this.vrm = vrm;
    this.holder = holder;
    scene.add(this.target);
    if (vrm.lookAt) vrm.lookAt.target = this.opts.lookAt ? this.target : null;
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    this.height = head ? Math.max(0.5, head.getWorldPosition(_v).y + 0.15) : 1.6;
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

  /** How much the dance should slow down (0..1) while the character is held. */
  get holdFactor() {
    return this.drag.w;
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
      n.quaternion.multiply(_q.setFromEuler(_e.set(x, y, z)));
    };
    const toward = (b, x, y, z, w) => {
      const n = node(b);
      if (!n || w <= 0) return;
      this.offsets.touch(n);
      n.quaternion.slerp(_q2.setFromEuler(_e.set(x, y, z)), w);
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

    // --- breathing in a still pose / nodding to music
    if (ctx.still || !ctx.dancing) {
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
      lookW = (ctx.dancing && !ctx.still ? 0.35 : 0.85) * idle * (1 - d.w) * (1 - 0.6 * this._patW);
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
    this.offsets.end();
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
