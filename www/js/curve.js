// 톤 커브: 단조 3차 보간(Fritsch–Carlson) LUT + 터치로 편집하는 커브 에디터

export const DEFAULT_CURVE = () => ({ rgb: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] });

export function isIdentity(pts) {
  return pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1;
}

export function buildLUT(points) {
  const p = [...points].sort((a, b) => a[0] - b[0]);
  const n = p.length, lut = new Float32Array(256);
  if (n < 2) { for (let i = 0; i < 256; i++) lut[i] = i / 255; return lut; }
  const xs = p.map(q => q[0]), ys = p.map(q => q[1]);
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  let k = 0;
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let y;
    if (x <= xs[0]) y = ys[0];
    else if (x >= xs[n - 1]) y = ys[n - 1];
    else {
      while (k < n - 2 && x > xs[k + 1]) k++;
      const h = xs[k + 1] - xs[k], t = (x - xs[k]) / h, t2 = t * t, t3 = t2 * t;
      y = (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1];
    }
    lut[i] = Math.min(1, Math.max(0, y));
  }
  return lut;
}

const CH_COLOR = { rgb: '#e8e8e8', r: '#ff5a5a', g: '#4cd964', b: '#4a90ff' };

export class CurveEditor {
  constructor(canvas, { onInput, onCommit }) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.onInput = onInput; this.onCommit = onCommit;
    this.channel = 'rgb'; this.curve = DEFAULT_CURVE(); this.hist = null;
    this.drag = -1; this.lastTap = 0;
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', e => this.up(e));
    canvas.addEventListener('pointercancel', e => this.up(e));
    new ResizeObserver(() => this.draw()).observe(canvas);
  }
  set(curve) { this.curve = curve; this.draw(); }
  setHist(h) { this.hist = h; this.draw(); }
  setChannel(c) { this.channel = c; this.draw(); }
  get pts() { return this.curve[this.channel]; }
  pos(e) {
    const r = this.cv.getBoundingClientRect(), pad = 10;
    return [Math.min(1, Math.max(0, (e.clientX - r.left - pad) / (r.width - 2 * pad))),
      Math.min(1, Math.max(0, 1 - (e.clientY - r.top - pad) / (r.height - 2 * pad))),
      (e.clientY - r.top) < -30 || (e.clientY - r.top) > r.height + 30];
  }
  hit(x, y) {
    const r = this.cv.getBoundingClientRect(), tol = 22 / r.width;
    let best = -1, bd = tol;
    this.pts.forEach((p, i) => { const d = Math.hypot(p[0] - x, (p[1] - y) * r.height / r.width); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  down(e) {
    e.preventDefault(); this.cv.setPointerCapture(e.pointerId);
    const [x, y] = this.pos(e); let i = this.hit(x, y);
    const now = Date.now();
    if (i > 0 && i < this.pts.length - 1 && now - this.lastTap < 320 && this.lastHit === i) { // 더블탭: 점 삭제
      this.pts.splice(i, 1); this.drag = -1; this.changed(true); return;
    }
    this.lastTap = now; this.lastHit = i;
    if (i < 0) {
      const lut = buildLUT(this.pts);
      const yy = Math.abs(lut[Math.round(x * 255)] - y) < 0.12 ? lut[Math.round(x * 255)] : y;
      this.pts.push([x, yy]); this.pts.sort((a, b) => a[0] - b[0]);
      i = this.pts.findIndex(p => p[0] === x); this.lastHit = i;
    }
    this.drag = i; this.dirty = true; this.changed(false);
  }
  move(e) {
    if (this.drag < 0) return;
    const [x, y, out] = this.pos(e), p = this.pts, i = this.drag, last = p.length - 1;
    if (out && i > 0 && i < last) { p.splice(i, 1); this.drag = -1; this.changed(false); return; }
    const lo = i === 0 ? 0 : p[i - 1][0] + 0.01, hi = i === last ? 1 : p[i + 1][0] - 0.01;
    p[i] = [Math.min(hi, Math.max(lo, x)), y]; this.changed(false);
  }
  up() { if (this.dirty) { this.dirty = false; this.drag = -1; this.changed(true); } }
  changed(commit) { this.draw(); (commit ? this.onCommit : this.onInput)(); }
  draw() {
    const cv = this.cv, dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    if (!W) return;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const c = this.ctx, pad = 10, w = W - 2 * pad, h = H - 2 * pad;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
    c.fillStyle = '#16171a'; c.fillRect(pad, pad, w, h);
    if (this.hist) {
      const off = { rgb: 0, r: 256, g: 512, b: 768 }[this.channel], hs = this.hist;
      let mx = 1; for (let i = 2; i < 254; i++) mx = Math.max(mx, hs[off + i]);
      c.beginPath(); c.moveTo(pad, pad + h);
      for (let i = 0; i < 256; i++) c.lineTo(pad + (i / 255) * w, pad + h - Math.min(1, hs[off + i] / mx) * h * 0.92);
      c.lineTo(pad + w, pad + h); c.closePath();
      c.fillStyle = this.channel === 'rgb' ? 'rgba(255,255,255,.12)' : CH_COLOR[this.channel] + '33'; c.fill();
    }
    c.strokeStyle = 'rgba(255,255,255,.1)'; c.lineWidth = 1;
    for (let k = 1; k < 4; k++) {
      c.beginPath(); c.moveTo(pad + (w * k) / 4, pad); c.lineTo(pad + (w * k) / 4, pad + h); c.stroke();
      c.beginPath(); c.moveTo(pad, pad + (h * k) / 4); c.lineTo(pad + w, pad + (h * k) / 4); c.stroke();
    }
    c.beginPath(); c.moveTo(pad, pad + h); c.lineTo(pad + w, pad); c.strokeStyle = 'rgba(255,255,255,.18)'; c.stroke();
    const lut = buildLUT(this.pts);
    c.beginPath();
    for (let i = 0; i < 256; i++) { const X = pad + (i / 255) * w, Y = pad + h - lut[i] * h; i ? c.lineTo(X, Y) : c.moveTo(X, Y); }
    c.strokeStyle = CH_COLOR[this.channel]; c.lineWidth = 2; c.stroke();
    this.pts.forEach((p, i) => {
      c.beginPath(); c.arc(pad + p[0] * w, pad + h - p[1] * h, i === this.drag ? 7 : 5, 0, Math.PI * 2);
      c.fillStyle = i === this.drag ? CH_COLOR[this.channel] : '#16171a'; c.fill();
      c.strokeStyle = CH_COLOR[this.channel]; c.lineWidth = 2; c.stroke();
    });
  }
}
