// 이미지 처리 워커: 모든 보정 연산을 메인 스레드 밖에서 수행해 슬라이더가 끊기지 않게 한다.
import { orientedSize, outputAffine } from './geom.js';

let W = null;           // 작업 해상도 버퍼
let faces = [];         // 얼굴 랜드마크 (source 정규화 좌표 [[x,y],...])
let grid = null;        // 리퀴파이 변형 그리드 {gw,gh,D}
let faceWarp = null;    // 눈/얼굴형 자동 변형 그리드 (캐시)
let faceWarpKey = '';
const snapshots = new Map(); // warpId -> Float32Array
let warpSeq = 0;

// ───────────────────────── 블러 ─────────────────────────
function blurPass(src, dst, w, h, ch, r, horiz) {
  const n = horiz ? w : h, lines = horiz ? h : w, step = horiz ? ch : w * ch, ls = horiz ? w * ch : ch, div = 2 * r + 1;
  for (let l = 0; l < lines; l++) {
    const base = l * ls;
    for (let c = 0; c < ch; c++) {
      const b = base + c;
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += src[b + (i < 0 ? 0 : i >= n ? n - 1 : i) * step];
      for (let i = 0; i < n; i++) {
        dst[b + i * step] = sum / div + 0.5;
        const ia = i + r + 1, ir = i - r;
        sum += src[b + (ia >= n ? n - 1 : ia) * step] - src[b + (ir < 0 ? 0 : ir) * step];
      }
    }
  }
}
function blur(src, w, h, ch, r, passes = 2) {
  const t = new Uint8ClampedArray(src.length), o = new Uint8ClampedArray(src.length);
  let cur = src;
  for (let p = 0; p < passes; p++) { blurPass(cur, t, w, h, ch, r, true); blurPass(t, o, w, h, ch, r, false); cur = o; }
  return o;
}

// ───────────────────────── 피부 마스크 ─────────────────────────
function colorSkin(d, w, h) {
  const m = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < m.length; i++, p += 4) {
    const r = d[p], g = d[p + 1], b = d[p + 2];
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b, cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const a = Math.max(0, 1 - Math.max(77 - cb, cb - 127, 135 - cr, cr - 173, 0) / 10);
    m[i] = y > 40 && y < 245 ? a * 255 : 0;
  }
  return m;
}

const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const EYE_L = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
const EYE_R = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const BROW_L = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276];
const BROW_R = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46];
const LIPS = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const NOSTRILS = [98, 97, 2, 326, 327, 294, 278, 344, 440, 275, 4, 45, 220, 115, 48, 64];
const JAW_L = [93, 132, 58, 172, 136, 150, 149, 176, 148];
const JAW_R = [323, 361, 288, 397, 365, 379, 378, 400, 377];

function faceGeom(lm, w, h) {
  const P = i => [lm[i][0] * w, lm[i][1] * h];
  const avg = ids => { let x = 0, y = 0; ids.forEach(i => { x += lm[i][0]; y += lm[i][1]; }); return [x / ids.length * w, y / ids.length * h]; };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  return {
    P, center: avg(FACE_OVAL), width: dist(P(234), P(454)),
    eyeL: avg(EYE_L), eyeR: avg(EYE_R), eyeLW: dist(P(362), P(263)), eyeRW: dist(P(33), P(133)),
  };
}

function faceRegions(w, h) {
  // R 채널: 얼굴 윤곽 안, G 채널: 눈·눈썹·입술·콧구멍 (보정 제외 영역)
  if (!faces.length || typeof OffscreenCanvas === 'undefined') return null;
  const oc = new OffscreenCanvas(w, h), c = oc.getContext('2d');
  if (!c) return null;
  c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
  c.globalCompositeOperation = 'lighter';
  c.lineJoin = 'round';
  const poly = (lm, ids, color, grow) => {
    c.beginPath(); ids.forEach((i, k) => { const x = lm[i][0] * w, y = lm[i][1] * h; k ? c.lineTo(x, y) : c.moveTo(x, y); });
    c.closePath(); c.fillStyle = color; c.fill();
    if (grow) { c.strokeStyle = color; c.lineWidth = grow; c.stroke(); }
  };
  for (const lm of faces) {
    const fw = faceGeom(lm, w, h).width;
    poly(lm, FACE_OVAL, 'rgb(255,0,0)', 0);
    for (const ids of [EYE_L, EYE_R]) poly(lm, ids, 'rgb(0,255,0)', fw * 0.05);
    for (const ids of [BROW_L, BROW_R]) poly(lm, ids, 'rgb(0,255,0)', fw * 0.03);
    poly(lm, LIPS, 'rgb(0,255,0)', fw * 0.02);
    poly(lm, NOSTRILS, 'rgb(0,90,0)', 0);
  }
  const d = c.getImageData(0, 0, w, h).data;
  const reg = new Uint8ClampedArray(w * h * 2);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) { reg[i * 2] = d[p]; reg[i * 2 + 1] = d[p + 1]; }
  return blur(reg, w, h, 2, Math.max(1, Math.round(Math.max(w, h) / 400)), 2);
}

function buildMask(B) {
  const { w, h, src } = B, N = w * h, br = Math.max(1, Math.round(Math.max(w, h) / 350));
  const reg = faceRegions(w, h);
  if (!reg) { B.mask = blur(colorSkin(src, w, h), w, h, 1, br); return; }
  // 인식된 얼굴 안쪽 피부에서 실제 피부색(Cb/Cr 평균·분산)을 학습
  let n = 0, sb = 0, sr = 0, sbb = 0, srr = 0;
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    if (reg[i * 2] < 240 || reg[i * 2 + 1] > 10) continue;
    const r = src[p], g = src[p + 1], b = src[p + 2];
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b, cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    n++; sb += cb; sr += cr; sbb += cb * cb; srr += cr * cr;
  }
  let cm;
  if (n > 200) {
    const mb = sb / n, mr = sr / n;
    const vb = Math.max(9, sbb / n - mb * mb) * 2.2, vr = Math.max(9, srr / n - mr * mr) * 2.2;
    cm = new Uint8ClampedArray(N);
    for (let i = 0, p = 0; i < N; i++, p += 4) {
      const r = src[p], g = src[p + 1], b = src[p + 2];
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b, cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      const d = (cb - mb) * (cb - mb) / vb + (cr - mr) * (cr - mr) / vr;
      cm[i] = y > 25 && y < 250 ? Math.max(0, Math.min(1, 1.5 - d * 0.5)) * 255 : 0;
    }
  } else cm = colorSkin(src, w, h);
  cm = blur(cm, w, h, 1, br);
  const m = new Uint8ClampedArray(N);
  for (let i = 0; i < N; i++) {
    const c = cm[i] / 255, oval = reg[i * 2] / 255, feat = reg[i * 2 + 1] / 255;
    const inFace = oval * (0.5 + 0.5 * Math.min(1, c * 1.6));
    m[i] = Math.max(inFace, c * 0.9) * (1 - feat) * 255;
  }
  B.mask = m;
}

// ───────────────────────── 버퍼 준비 ─────────────────────────
// needs: 저장 시에는 현재 설정에 필요한 중간 이미지만 만든다 (속도·메모리 절약)
const ALL = { smooth: true, sharpen: true, texture: true, clarity: true, dehaze: true, mask: true };
function needsFor(A) {
  const skin = !!(A.smooth || A.skinBright || A.skinTone);
  return { smooth: !!A.smooth, sharpen: !!A.sharpen, texture: !!A.texture, clarity: !!A.clarity, dehaze: A.dehaze > 0, mask: skin };
}
function build(data, w, h, needs = ALL) {
  const L = Math.max(w, h), N = w * h;
  const src = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data);
  const lum = new Uint8ClampedArray(N), dark = needs.dehaze ? new Uint8ClampedArray(N) : null;
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    const r = src[p], g = src[p + 1], b = src[p + 2];
    const l = (r * 54 + g * 183 + b * 19) >> 8;
    lum[i] = l; hist[l]++;
    if (dark) dark[i] = r < g ? (r < b ? r : b) : (g < b ? g : b);
  }
  const B = {
    w, h, src, hist,
    smooth: needs.smooth ? blur(src, w, h, 4, Math.max(1, Math.round(L / 220))) : null,
    lS: needs.sharpen ? blur(lum, w, h, 1, Math.max(1, Math.round(L / 1100)), 1) : null,
    lM: needs.texture ? blur(lum, w, h, 1, Math.max(1, Math.round(L / 260))) : null,
    lL: needs.clarity ? blur(lum, w, h, 1, Math.max(2, Math.round(L / 45))) : null,
    dark: dark ? blur(dark, w, h, 1, Math.max(2, Math.round(L / 120))) : null,
  };
  // 디헤이즈용 대기광: 밝은 쪽 0.5% 지점
  let acc = 0, air = 255;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > N * 0.005) { air = i; break; } }
  B.air = Math.max(0.6, air / 255);
  if (needs.mask) buildMask(B); else B.mask = new Uint8ClampedArray(N);
  return B;
}

// ───────────────────────── 변형 그리드 ─────────────────────────
function makeGrid(w, h) {
  const L = Math.max(w, h), gs = Math.max(2, Math.ceil(L / 420));
  const gw = Math.ceil(w / gs) + 1, gh = Math.ceil(h / gs) + 1;
  return { gw, gh, D: new Float32Array(gw * gh * 2) };
}
function sampleGrid(D, gw, gh, u, v, out) {
  let x = u * (gw - 1), y = v * (gh - 1);
  x = x < 0 ? 0 : x > gw - 1.001 ? gw - 1.001 : x; y = y < 0 ? 0 : y > gh - 1.001 ? gh - 1.001 : y;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, k = (y0 * gw + x0) * 2, k2 = k + gw * 2;
  out[0] = (D[k] * (1 - fx) + D[k + 2] * fx) * (1 - fy) + (D[k2] * (1 - fx) + D[k2 + 2] * fx) * fy;
  out[1] = (D[k + 1] * (1 - fx) + D[k + 3] * fx) * (1 - fy) + (D[k2 + 1] * (1 - fx) + D[k2 + 3] * fx) * fy;
}

// 그리드 한 점(px 단위) 주변에 변형 적용. fn(dx,dy,w)→[δx,δy] (px), compose: 기존 변형과 합성
function applyDab(G, cx, cy, R, fn, compose) {
  const { gw, gh, D } = G, w = W.w, h = W.h, sx = (gw - 1) / w, sy = (gh - 1) / h;
  const old = compose ? D.slice() : null, tmp = [0, 0];
  const x0 = Math.max(0, Math.floor((cx - R) * sx)), x1 = Math.min(gw - 1, Math.ceil((cx + R) * sx));
  const y0 = Math.max(0, Math.floor((cy - R) * sy)), y1 = Math.min(gh - 1, Math.ceil((cy + R) * sy));
  for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
    const px = gx / sx, py = gy / sy, dx = px - cx, dy = py - cy, d2 = (dx * dx + dy * dy) / (R * R);
    if (d2 >= 1) continue;
    const f = (1 - d2) * (1 - d2), k = (gy * gw + gx) * 2;
    const dl = fn(dx, dy, f, k);
    if (!dl) continue;
    if (compose) {
      sampleGrid(old, gw, gh, (px + dl[0]) / w, (py + dl[1]) / h, tmp);
      D[k] = tmp[0] + dl[0] / w; D[k + 1] = tmp[1] + dl[1] / h;
    } else { D[k] += dl[0] / w; D[k + 1] += dl[1] / h; }
  }
}

function brush({ tool, from, to, radius, strength }) {
  const w = W.w, h = W.h, R = Math.max(4, radius), k = strength;
  const ax = from[0] * w, ay = from[1] * h, bx = to[0] * w, by = to[1] * h;
  const len = Math.hypot(bx - ax, by - ay), steps = Math.max(1, Math.ceil(len / (R * 0.2)));
  for (let s = 1; s <= steps; s++) {
    const cx = ax + ((bx - ax) * s) / steps, cy = ay + ((by - ay) * s) / steps;
    if (tool === 'push') {
      const vx = (bx - ax) / steps, vy = (by - ay) / steps;
      if (!vx && !vy) continue;
      applyDab(grid, cx, cy, R, (dx, dy, f) => [-vx * f * k, -vy * f * k], true);
    } else if (tool === 'pucker' || tool === 'bloat') {
      const sg = tool === 'pucker' ? 1 : -1, a = 0.06 * k / steps;
      applyDab(grid, cx, cy, R, (dx, dy, f) => [sg * dx * f * a, sg * dy * f * a], true);
    } else if (tool === 'restore') {
      const D = grid.D, a = 0.25 * k / steps;
      applyDab(grid, cx, cy, R, (dx, dy, f, idx) => { const m = 1 - Math.min(1, a * f); D[idx] *= m; D[idx + 1] *= m; return null; }, false);
    }
  }
}

function buildFaceWarp(eye, slim) {
  const key = faces.length + ':' + eye + ':' + slim;
  if (key === faceWarpKey) return faceWarp;
  faceWarpKey = key;
  if (!faces.length || (!eye && !slim)) return (faceWarp = null);
  const G = makeGrid(W.w, W.h);
  for (const lm of faces) {
    const g = faceGeom(lm, W.w, W.h);
    if (eye) {
      const a = (eye / 100) * 0.32;
      for (const [c, ew] of [[g.eyeL, g.eyeLW], [g.eyeR, g.eyeRW]])
        applyDab(G, c[0], c[1], ew * 1.25, (dx, dy, f) => [-dx * f * a, -dy * f * a], false);
    }
    if (slim) {
      const amt = (slim / 100) * g.width * 0.045, R = g.width * 0.26;
      for (const i of [...JAW_L, ...JAW_R]) {
        const p = g.P(i), nx = p[0] - g.center[0], ny = p[1] - g.center[1], nl = Math.hypot(nx, ny) || 1;
        applyDab(G, p[0], p[1], R, (dx, dy, f) => [(nx / nl) * amt * f / 3, (ny / nl) * amt * f / 3], false);
      }
    }
  }
  return (faceWarp = G);
}

function isZero(D) { for (let i = 0; i < D.length; i++) if (D[i] !== 0) return false; return true; }

// ───────────────────────── 렌더링 ─────────────────────────
function hue2rgb(hDeg) {
  const h = ((hDeg % 360) + 360) % 360 / 60, x = 1 - Math.abs((h % 2) - 1);
  const [r, g, b] = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [r - l, g - l, b - l];
}
const BAND = [0, 30, 60, 120, 180, 240, 270, 300, 360];
function hash(x, y) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function lutAt(L, x) {
  x = x < 0 ? 0 : x > 1 ? 1 : x;
  const f = x * 255, i = f | 0;
  return i >= 255 ? L[255] : L[i] + (L[i + 1] - L[i]) * (f - i);
}

function render(B, st, luts, outW, outH, crop, mode, D, Df) {
  const { w, h, src, smooth, lS, lM, lL, dark, mask } = B;
  const A = st.adj, geo = st.geo;
  const [ow, oh] = orientedSize(w, h, geo.rot);
  const M = outputAffine(geo, ow, oh, outW, outH, crop);
  const out = new Uint8ClampedArray(outW * outH * 4);
  const hist = new Uint32Array(1024);
  const orig = mode === 'original', showMask = mode === 'mask';

  const ex = Math.pow(2, A.exposure), ct = 1 + A.contrast / 100, hi = A.highlights / 100, sh = A.shadows / 100;
  const tp = A.temp / 100, tn = A.tint / 100, sat = 1 + A.sat / 100, vib = A.vibrance / 100;
  const sm = A.smooth / 100, sb = A.skinBright / 100, stn = A.skinTone / 100;
  const b0 = -A.blacks / 100 * 0.12, w0 = 1 - A.whites / 100 * 0.2, lv = 1 / (w0 - b0);
  const clar = A.clarity / 100, tex = A.texture / 100, shp = A.sharpen / 100 * 2.2;
  const dh = A.dehaze / 100, air = B.air, vig = A.vignette / 100, grn = A.grain / 100;
  const gS = hue2rgb(A.gShadowHue), gH = hue2rgb(A.gHighHue), gsS = A.gShadowSat / 100 * 0.35, gsH = A.gHighSat / 100 * 0.35;
  const gBal = A.gBalance / 100;
  const hsl = st.hsl, hslOn = hsl.h.some(x => x) || hsl.s.some(x => x) || hsl.l.some(x => x);
  const curveOn = !!luts, Lm = luts && luts.rgb, Lr = luts && luts.r, Lg = luts && luts.g, Lb = luts && luts.b;
  const gscale = Math.max(1, Math.max(outW, outH) / 1100);
  const warpOn = !orig && (D || Df);
  const gw = grid.gw, gh = grid.gh, fgw = Df ? Df.gw : 0, fgh = Df ? Df.gh : 0, tmp = [0, 0];
  const detailOn = clar || tex || shp, gradeOn = gsS || gsH;

  for (let j = 0; j < outH; j++) {
    let u = M.u0 + M.ux * 0.5 + M.uy * (j + 0.5), v = M.v0 + M.vx * 0.5 + M.vy * (j + 0.5);
    for (let i = 0; i < outW; i++, u += M.ux, v += M.vx) {
      const o = (j * outW + i) * 4;
      if (u < -0.0005 || u > 1.0005 || v < -0.0005 || v > 1.0005) { out[o] = out[o + 1] = out[o + 2] = 28; out[o + 3] = 255; continue; }
      let su = u, sv = v;
      if (warpOn) {
        if (D) { sampleGrid(D, gw, gh, u, v, tmp); su += tmp[0]; sv += tmp[1]; }
        if (Df) { sampleGrid(Df.D, fgw, fgh, u, v, tmp); su += tmp[0]; sv += tmp[1]; }
      }
      let x = su * w - 0.5, y = sv * h - 0.5;
      x = x < 0 ? 0 : x > w - 1.001 ? w - 1.001 : x; y = y < 0 ? 0 : y > h - 1.001 ? h - 1.001 : y;
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
      const p00 = (y0 * w + x0) * 4, p10 = p00 + 4, p01 = p00 + w * 4, p11 = p01 + 4;
      const a00 = (1 - fx) * (1 - fy), a10 = fx * (1 - fy), a01 = (1 - fx) * fy, a11 = fx * fy;
      let r = (src[p00] * a00 + src[p10] * a10 + src[p01] * a01 + src[p11] * a11) / 255;
      let g = (src[p00 + 1] * a00 + src[p10 + 1] * a10 + src[p01 + 1] * a01 + src[p11 + 1] * a11) / 255;
      let b = (src[p00 + 2] * a00 + src[p10 + 2] * a10 + src[p01 + 2] * a01 + src[p11 + 2] * a11) / 255;
      const k = (y0 + (fy > 0.5 ? 1 : 0)) * w + x0 + (fx > 0.5 ? 1 : 0), kp = k * 4;
      if (orig) {
        out[o] = r * 255; out[o + 1] = g * 255; out[o + 2] = b * 255; out[o + 3] = 255; continue;
      }
      const mk = mask[k] / 255;
      if (showMask) { out[o] = out[o + 1] = out[o + 2] = mk * 255; out[o + 3] = 255; continue; }

      // 인물: 피부 스무딩 (엣지 보존)
      let soft = 0;
      if (sm > 0 && mk > 0.02) {
        const br = smooth[kp] / 255, bg = smooth[kp + 1] / 255, bb = smooth[kp + 2] / 255;
        const diff = Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb);
        const edge = Math.max(0, 1 - diff / 0.35);
        soft = sm * 0.9 * mk * edge;
        r += (br - r) * soft; g += (bg - g) * soft; b += (bb - b) * soft;
      }
      if (mk > 0.02) {
        if (sb) { const q = sb * 0.25 * mk; r += q; g += q; b += q; }
        if (stn) { const q = stn * 0.06 * mk; r += q; g += q * 0.25; b -= q; }
      }
      // 디테일: 선명도·텍스처·부분 대비
      if (detailOn) {
        const l = (r * 0.2126 + g * 0.7152 + b * 0.0722);
        let dd = 0;
        if (shp) dd += shp * (l - lS[k] / 255);
        if (tex) dd += tex * 1.1 * (l - lM[k] / 255);
        if (clar) { const mw = 1 - (2 * l - 1) * (2 * l - 1); dd += clar * 1.4 * mw * (l - lL[k] / 255); }
        dd *= 1 - soft;
        r += dd; g += dd; b += dd;
      }
      // 기본: 노출·화이트밸런스
      r *= ex; g *= ex; b *= ex;
      r *= 1 + tp * 0.3; b *= 1 - tp * 0.3; g *= 1 - tn * 0.2; r *= 1 + tn * 0.1; b *= 1 + tn * 0.1;
      // 흰색/검정 계열 (레벨)
      r = (r - b0) * lv; g = (g - b0) * lv; b = (b - b0) * lv;
      // 하이라이트/섀도우
      let l = 0.2126 * r + 0.7152 * g + 0.0722 * b; l = l < 0 ? 0 : l > 1 ? 1 : l;
      const adj = sh * 0.4 * (1 - l) * (1 - l) + hi * 0.4 * l * l;
      r += adj; g += adj; b += adj;
      // 대비
      r = (r - 0.5) * ct + 0.5; g = (g - 0.5) * ct + 0.5; b = (b - 0.5) * ct + 0.5;
      // 디헤이즈
      if (dh > 0) {
        const t = Math.max(0.3, 1 - dh * 0.85 * (dark[k] / 255) / air);
        r = (r - air) / t + air; g = (g - air) / t + air; b = (b - air) / t + air;
      } else if (dh < 0) {
        const q = -dh * 0.45; r += (0.82 - r) * q; g += (0.82 - g) * q; b += (0.84 - b) * q;
      }
      // 톤 커브
      if (curveOn) {
        r = lutAt(Lr, lutAt(Lm, r)); g = lutAt(Lg, lutAt(Lm, g)); b = lutAt(Lb, lutAt(Lm, b));
      }
      // HSL
      if (hslOn) {
        r = r < 0 ? 0 : r > 1 ? 1 : r; g = g < 0 ? 0 : g > 1 ? 1 : g; b = b < 0 ? 0 : b > 1 ? 1 : b;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        if (d > 1e-4) {
          let L2 = (mx + mn) / 2, S = d / (1 - Math.abs(2 * L2 - 1));
          let H = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
          H *= 60; if (H < 0) H += 360;
          let bi = 0; while (H >= BAND[bi + 1]) bi++;
          let t = (H - BAND[bi]) / (BAND[bi + 1] - BAND[bi]); t = t * t * (3 - 2 * t);
          const b1 = bi, b2 = (bi + 1) % 8;
          const dH = hsl.h[b1] * (1 - t) + hsl.h[b2] * t, dS = hsl.s[b1] * (1 - t) + hsl.s[b2] * t, dL = hsl.l[b1] * (1 - t) + hsl.l[b2] * t;
          H += dH * 0.3; S = Math.min(1, Math.max(0, S * (1 + dS / 100)));
          L2 = Math.min(1, Math.max(0, L2 + (dL / 100) * 0.3 * S));
          const C = (1 - Math.abs(2 * L2 - 1)) * S, hp = (((H % 360) + 360) % 360) / 60, X = C * (1 - Math.abs((hp % 2) - 1)), m0 = L2 - C / 2;
          const [r1, g1, b1c] = hp < 1 ? [C, X, 0] : hp < 2 ? [X, C, 0] : hp < 3 ? [0, C, X] : hp < 4 ? [0, X, C] : hp < 5 ? [X, 0, C] : [C, 0, X];
          r = r1 + m0; g = g1 + m0; b = b1c + m0;
        }
      }
      // 활기·채도
      let gr = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (sat !== 1 || vib) {
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), s = mx > 0 ? (mx - mn) / mx : 0;
        const f = sat * (1 + vib * (1 - s));
        r = gr + (r - gr) * f; g = gr + (g - gr) * f; b = gr + (b - gr) * f;
      }
      // 컬러 그레이딩
      if (gradeOn) {
        let lw = gr < 0 ? 0 : gr > 1 ? 1 : gr;
        lw = Math.min(1, Math.max(0, lw - gBal * 0.3));
        const ws = (1 - lw) * (1 - lw) * gsS, wh = lw * lw * gsH;
        r += gS[0] * ws + gH[0] * wh; g += gS[1] * ws + gH[1] * wh; b += gS[2] * ws + gH[2] * wh;
      }
      // 비네팅
      if (vig) {
        const nx = (i + 0.5) / outW * 2 - 1, ny = (j + 0.5) / outH * 2 - 1;
        let d = Math.sqrt(nx * nx + ny * ny) / 1.4142;
        d = d < 0.3 ? 0 : d > 1 ? 1 : (d - 0.3) / 0.7; d = d * d * (3 - 2 * d);
        if (vig < 0) { const m = 1 + vig * d * 0.9; r *= m; g *= m; b *= m; }
        else { const q = vig * d * 0.8; r += (1 - r) * q; g += (1 - g) * q; b += (1 - b) * q; }
      }
      // 그레인
      if (grn) {
        const gx = i / gscale, gy = j / gscale, ix = gx | 0, iy = gy | 0, tx = gx - ix, ty = gy - iy;
        const n = (hash(ix, iy) * (1 - tx) + hash(ix + 1, iy) * tx) * (1 - ty) + (hash(ix, iy + 1) * (1 - tx) + hash(ix + 1, iy + 1) * tx) * ty;
        const q = (n - 0.5) * grn * 0.22; r += q; g += q; b += q;
      }
      const R8 = r * 255, G8 = g * 255, B8 = b * 255;
      out[o] = R8; out[o + 1] = G8; out[o + 2] = B8; out[o + 3] = 255;
    }
  }
  // 히스토그램 (출력 기준, 샘플링)
  const stepH = Math.max(1, Math.floor((outW * outH) / 250000)) * 4;
  for (let p = 0; p < out.length; p += stepH) {
    const r = out[p], g = out[p + 1], b = out[p + 2];
    hist[(r * 54 + g * 183 + b * 19) >> 8]++; hist[256 + r]++; hist[512 + g]++; hist[768 + b]++;
  }
  return { out, hist };
}

function outSize(B, st, outMax, full) {
  const [ow, oh] = orientedSize(B.w, B.h, st.geo.rot);
  const c = full ? { x: 0, y: 0, w: 1, h: 1 } : st.geo.crop;
  const pw = c.w * ow, ph = c.h * oh, s = Math.min(1, outMax / Math.max(pw, ph));
  return { crop: c, outW: Math.max(1, Math.round(pw * s)), outH: Math.max(1, Math.round(ph * s)) };
}

// ───────────────────────── 메시지 ─────────────────────────
self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'init') {
      W = build(new Uint8ClampedArray(m.buffer), m.width, m.height);
      grid = makeGrid(m.width, m.height); faces = []; faceWarpKey = ''; faceWarp = null;
      snapshots.clear(); snapshots.set(0, null);
      self.postMessage({ type: 'ready', hist: Array.from(W.hist), air: W.air });
    } else if (m.type === 'faces') {
      faces = m.faces; faceWarpKey = '';
      if (W) buildMask(W);
      self.postMessage({ type: 'facesReady', count: faces.length });
    } else if (m.type === 'render') {
      if (!W) return;
      const st = m.state, { crop, outW, outH } = outSize(W, st, m.outMax, m.full);
      const Df = buildFaceWarp(st.adj.eyes, st.adj.faceSlim);
      const D = isZero(grid.D) ? null : grid.D;
      const t0 = performance.now();
      const { out, hist } = render(W, st, m.luts, outW, outH, crop, m.mode, D, Df);
      self.postMessage({ type: 'frame', id: m.id, w: outW, h: outH, buffer: out.buffer, hist, ms: performance.now() - t0 }, [out.buffer]);
    } else if (m.type === 'brush') {
      brush(m);
      self.postMessage({ type: 'brushed' });
    } else if (m.type === 'brushEnd') {
      const id = ++warpSeq;
      snapshots.set(id, isZero(grid.D) ? null : grid.D.slice());
      self.postMessage({ type: 'warpSaved', warpId: id });
    } else if (m.type === 'setWarp') {
      const s = snapshots.get(m.warpId);
      if (s) grid.D.set(s); else grid.D.fill(0);
    } else if (m.type === 'pruneWarps') {
      const keep = new Set(m.keep);
      for (const k of [...snapshots.keys()]) if (k !== 0 && !keep.has(k)) snapshots.delete(k);
    } else if (m.type === 'export') {
      const st = m.state, B = build(new Uint8ClampedArray(m.buffer), m.width, m.height, needsFor(st.adj));
      const { crop, outW, outH } = outSize(B, st, Infinity, false);
      // 얼굴 변형 그리드는 정규화 좌표라 그대로 사용 (작업 해상도 기준으로 계산됨)
      const Df = buildFaceWarp(st.adj.eyes, st.adj.faceSlim);
      const D = isZero(grid.D) ? null : grid.D;
      const { out } = render(B, st, m.luts, outW, outH, crop, 'normal', D, Df);
      const oc = new OffscreenCanvas(outW, outH);
      oc.getContext('2d').putImageData(new ImageData(out, outW, outH), 0, 0);
      const blob = await oc.convertToBlob({ type: 'image/jpeg', quality: m.quality || 0.92 });
      self.postMessage({ type: 'exported', blob, w: outW, h: outH });
    }
  } catch (err) {
    self.postMessage({ type: 'error', op: m.type, message: String(err && err.message || err) });
  }
};
