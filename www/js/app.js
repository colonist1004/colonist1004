import { DEFAULT_GEO, orientedSize, frameToSource, cropFits, maxCrop } from './geom.js';
import { DEFAULT_CURVE, buildLUT, isIdentity, CurveEditor } from './curve.js';
import { BUILTIN_PRESETS } from './presets.js';
import { detectFaces } from './face.js';

// ───────────────────────── 플랫폼 ─────────────────────────
const Cap = window.Capacitor;
const NATIVE = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const plugins = {};
const plugin = n => {
  if (!NATIVE) return null;
  if (!plugins[n]) plugins[n] = Cap.registerPlugin ? Cap.registerPlugin(n) : Cap.Plugins[n];
  return plugins[n];
};
const WORK_MAX = 2048;                       // 미리보기/편집용 작업 해상도 (긴 변)
const EXPORT_MAX = NATIVE ? 4096 : 6000;     // 저장 해상도 상한 (휴대폰 메모리 보호)

// ───────────────────────── 상태 ─────────────────────────
const ADJ_DEFAULT = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  temp: 0, tint: 0, vibrance: 0, sat: 0,
  clarity: 0, texture: 0, dehaze: 0, sharpen: 0, vignette: 0, grain: 0,
  smooth: 0, skinBright: 0, skinTone: 0, eyes: 0, faceSlim: 0,
  gShadowHue: 220, gShadowSat: 0, gHighHue: 40, gHighSat: 0, gBalance: 0,
};
const FACE_SHAPE_KEYS = ['eyes', 'faceSlim'];
const zeros8 = () => [0, 0, 0, 0, 0, 0, 0, 0];
const freshState = () => ({ adj: { ...ADJ_DEFAULT }, hsl: { h: zeros8(), s: zeros8(), l: zeros8() }, curve: DEFAULT_CURVE(), geo: DEFAULT_GEO(), warpId: 0 });
let state = freshState();

let SW = 0, SH = 0;          // 작업 해상도
let fullBitmap = null;       // 저장용 원본
let workCanvas = null;       // 얼굴 인식용
let loaded = false, srcHist = null, faceCount = -1;
let tab = 'basic', viewMode = 'normal', maskOn = false;
const ui = { tool: 'push', brushSize: 90, brushStrength: 50, hslMode: 'h', curveCh: 'rgb' };

const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'style') e.style.cssText = v; else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms);
}

// ───────────────────────── 실행 취소 ─────────────────────────
const history = { stack: [], idx: -1 };
function commit() {
  const snap = JSON.stringify(state);
  if (history.stack[history.idx] === snap) return;
  history.stack.splice(history.idx + 1);
  history.stack.push(snap);
  if (history.stack.length > 60) history.stack.shift();
  history.idx = history.stack.length - 1;
  const keep = new Set(history.stack.map(s => JSON.parse(s).warpId));
  worker.postMessage({ type: 'pruneWarps', keep: [...keep] });
  updUndo();
}
function restore(i) {
  history.idx = i;
  const s = JSON.parse(history.stack[i]);
  if (s.warpId !== state.warpId) worker.postMessage({ type: 'setWarp', warpId: s.warpId });
  state = s; syncUI(); updUndo(); requestRender();
}
const undo = () => history.idx > 0 && restore(history.idx - 1);
const redo = () => history.idx < history.stack.length - 1 && restore(history.idx + 1);
function updUndo() {
  $('#undo').disabled = history.idx <= 0;
  $('#redo').disabled = history.idx >= history.stack.length - 1;
}

// ───────────────────────── 워커 / 렌더링 ─────────────────────────
const worker = new Worker(new URL('./engine.js', import.meta.url), { type: 'module' });
let rid = 0, busy = false, pending = null, idleT = 0, lutKey = '', lutVal = null, lastHist = null;
const waiters = {};

function luts() {
  const c = state.curve, key = JSON.stringify(c);
  if (key !== lutKey) {
    lutKey = key;
    lutVal = ['rgb', 'r', 'g', 'b'].every(k => isIdentity(c[k])) ? null
      : { rgb: buildLUT(c.rgb), r: buildLUT(c.r), g: buildLUT(c.g), b: buildLUT(c.b) };
  }
  return lutVal;
}
const cropMode = () => tab === 'crop';
function previewMax(fast) {
  const v = $('#viewer'), dpr = Math.min(2, window.devicePixelRatio || 1);
  const full = Math.min(WORK_MAX, Math.max(v.clientWidth, v.clientHeight) * dpr * Math.max(1, zoom.z));
  return fast ? Math.min(full, 760) : full;
}
function requestRender(fast = false) {
  if (!loaded) return;
  pending = { fast };
  clearTimeout(idleT);
  if (fast) idleT = setTimeout(() => { pending = { fast: false }; pump(); }, 260);
  pump();
}
function pump() {
  if (busy || !pending || !loaded) return;
  const q = pending; pending = null; busy = true;
  const mode = viewMode === 'original' ? 'original' : maskOn ? 'mask' : 'normal';
  worker.postMessage({ type: 'render', id: ++rid, state, luts: luts(), outMax: previewMax(q.fast), mode, full: cropMode() });
}

const cv = $('#cv'), cx2d = cv.getContext('2d');
worker.onmessage = ({ data: m }) => {
  if (m.type === 'frame') {
    if (cv.width !== m.w || cv.height !== m.h) { cv.width = m.w; cv.height = m.h; }
    cx2d.putImageData(new ImageData(new Uint8ClampedArray(m.buffer), m.w, m.h), 0, 0);
    lastHist = m.hist; drawHist(); curveEd.setHist(m.hist); window.__lastRenderMs = m.ms;
    fitStage(); busy = false; pump();
  } else if (m.type === 'ready') {
    loaded = true; srcHist = m.hist;
    $('#empty').hidden = true; $('#stage').hidden = false;
    resetZoom(); requestRender(); runFaces();
  } else if (m.type === 'facesReady') {
    faceCount = m.count; updFaceStatus(); requestRender();
  } else if (m.type === 'warpSaved') {
    state.warpId = m.warpId; commit(); requestRender();
  } else if (m.type === 'exported') {
    waiters.export && waiters.export.resolve(m.blob);
  } else if (m.type === 'error') {
    console.error('engine', m);
    if (m.op === 'export' && waiters.export) waiters.export.reject(new Error(m.message));
    else { busy = false; toast('처리 오류: ' + m.message); pump(); }
  }
};
worker.onerror = e => { console.error(e); toast('처리 엔진을 시작하지 못했어요'); };

// ───────────────────────── 사진 열기 ─────────────────────────
async function decode(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url; await img.decode();
      return await createImageBitmap(img);
    } finally { URL.revokeObjectURL(url); }
  }
}
async function openFile(file) {
  if (!file) return;
  let bmp;
  try { bmp = await decode(file); } catch { toast('이 사진 형식은 열 수 없습니다'); return; }
  if (fullBitmap) fullBitmap.close && fullBitmap.close();
  fullBitmap = bmp;
  const s = Math.min(1, WORK_MAX / Math.max(bmp.width, bmp.height));
  SW = Math.max(1, Math.round(bmp.width * s)); SH = Math.max(1, Math.round(bmp.height * s));
  workCanvas = document.createElement('canvas'); workCanvas.width = SW; workCanvas.height = SH;
  const c = workCanvas.getContext('2d', { willReadFrequently: true });
  c.drawImage(bmp, 0, 0, SW, SH);
  const id = c.getImageData(0, 0, SW, SH);
  loaded = false; faceCount = -1; maskOn = false; updFaceStatus();
  state = freshState(); history.stack = []; history.idx = -1;
  worker.postMessage({ type: 'init', width: SW, height: SH, buffer: id.data.buffer }, [id.data.buffer]);
  commit(); syncUI();
}
for (const id of ['#file', '#file2']) $(id).addEventListener('change', e => { openFile(e.target.files[0]); e.target.value = ''; });

async function runFaces() {
  const cvs = workCanvas; faceCount = -2; updFaceStatus();
  try {
    const f = await detectFaces(cvs);
    if (cvs !== workCanvas) return;
    worker.postMessage({ type: 'faces', faces: f });
  } catch (err) {
    console.warn('face detection unavailable', err);
    faceCount = -3; updFaceStatus();
  }
}
function updFaceStatus() {
  const e = $('#faceStatus'); if (!e) return;
  e.textContent = faceCount === -2 ? '얼굴 인식 중…'
    : faceCount === -3 ? '얼굴 인식을 쓸 수 없어 색상으로 피부를 찾습니다'
    : faceCount === 0 ? '인식된 얼굴이 없어요. 색상으로 피부를 찾습니다'
    : faceCount > 0 ? `얼굴 ${faceCount}개 인식됨 — 눈·눈썹·입술은 보정에서 제외됩니다` : '사진을 열면 얼굴을 자동으로 인식합니다';
  document.querySelectorAll('[data-needs-face]').forEach(r => r.classList.toggle('dim', !(faceCount > 0)));
}

// ───────────────────────── 화면 맞춤 / 줌 ─────────────────────────
const zoom = { z: 1, tx: 0, ty: 0 };
function fitStage() {
  const v = $('#viewer'), st = $('#stage');
  if (!cv.width) return;
  const pad = cropMode() ? 28 : 8, vw = v.clientWidth - pad * 2, vh = v.clientHeight - pad * 2;
  const ar = cv.width / cv.height;
  let w = vw, h = vw / ar; if (h > vh) { h = vh; w = vh * ar; }
  st.style.width = w + 'px'; st.style.height = h + 'px';
  st.style.left = (v.clientWidth - w) / 2 + 'px'; st.style.top = (v.clientHeight - h) / 2 + 'px';
  st.style.transform = `translate(${zoom.tx}px,${zoom.ty}px) scale(${zoom.z})`;
  if (cropMode()) updCropBox();
}
function resetZoom() { zoom.z = 1; zoom.tx = 0; zoom.ty = 0; fitStage(); }
function setZoom(z, cxp, cyp) {
  const v = $('#viewer').getBoundingClientRect(), st = $('#stage');
  z = Math.min(8, Math.max(1, z));
  // 확대 기준점(cxp,cyp, 뷰어 좌표)이 화면에서 고정되도록 이동량 보정
  const ox = st.offsetLeft + st.offsetWidth / 2, oy = st.offsetTop + st.offsetHeight / 2;
  const px = cxp - v.left - ox, py = cyp - v.top - oy;
  zoom.tx = px - (px - zoom.tx) * (z / zoom.z); zoom.ty = py - (py - zoom.ty) * (z / zoom.z); zoom.z = z;
  if (z === 1) { zoom.tx = 0; zoom.ty = 0; }
  fitStage();
}
let resizeT = 0;
new ResizeObserver(() => { fitStage(); clearTimeout(resizeT); resizeT = setTimeout(() => requestRender(), 200); }).observe($('#viewer'));

// ───────────────────────── 뷰어 제스처 (줌·이동·브러시) ─────────────────────────
const viewer = $('#viewer'), ptrs = new Map();
let gesture = null, lastTap = 0, stroke = null, holdT = 0;

function toSource(clientX, clientY) {
  const r = cv.getBoundingClientRect(), g = state.geo, [ow, oh] = orientedSize(SW, SH, g.rot);
  const fx = (clientX - r.left) / r.width, fy = (clientY - r.top) / r.height;
  return frameToSource(g.crop.x + fx * g.crop.w, g.crop.y + fy * g.crop.h, g, ow, oh);
}
function brushRadiusSrc() {
  const r = cv.getBoundingClientRect(), g = state.geo, [ow] = orientedSize(SW, SH, g.rot);
  return (ui.brushSize / 2) / r.width * g.crop.w * ow;
}
function showCursor(e) {
  const c = $('#cursor');
  if (tab !== 'body' || !loaded) { c.hidden = true; return; }
  const v = viewer.getBoundingClientRect();
  c.hidden = false; c.style.width = c.style.height = ui.brushSize + 'px';
  c.style.left = e.clientX - v.left + 'px'; c.style.top = e.clientY - v.top + 'px';
}
function strokeDab(from, to) {
  worker.postMessage({ type: 'brush', tool: ui.tool, from, to, radius: brushRadiusSrc(), strength: ui.brushStrength / 100 });
  requestRender(true);
}
function endStroke() {
  if (!stroke) return;
  clearInterval(holdT); stroke = null;
  worker.postMessage({ type: 'brushEnd' });
}
viewer.addEventListener('pointerdown', e => {
  if (!loaded || e.target.closest('#cropOverlay')) return;
  viewer.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 2) {
    endStroke();
    const [a, b] = [...ptrs.values()];
    gesture = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), z: zoom.z, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, tx: zoom.tx, ty: zoom.ty };
    return;
  }
  if (ptrs.size > 2) return;
  if (tab === 'body') {
    const p = toSource(e.clientX, e.clientY);
    stroke = { last: p };
    showCursor(e);
    if (ui.tool !== 'push') {
      strokeDab(p, p);
      holdT = setInterval(() => stroke && strokeDab(stroke.last, stroke.last), 70);
    }
  } else {
    const now = Date.now();
    if (now - lastTap < 300) { setZoom(zoom.z > 1.01 ? 1 : 2.5, e.clientX, e.clientY); requestRender(); lastTap = 0; }
    else lastTap = now;
    gesture = { type: 'pan', x: e.clientX, y: e.clientY, tx: zoom.tx, ty: zoom.ty };
  }
});
viewer.addEventListener('pointermove', e => {
  showCursor(e);
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (gesture && gesture.type === 'pinch' && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    // 처음 두 손가락 중점 아래의 사진 지점이 현재 중점을 따라가도록
    const v = viewer.getBoundingClientRect(), st = $('#stage');
    const ox = v.left + st.offsetLeft + st.offsetWidth / 2, oy = v.top + st.offsetTop + st.offsetHeight / 2;
    const z = Math.min(8, Math.max(1, gesture.z * d / gesture.d));
    const cxp = (gesture.mx - ox - gesture.tx) / gesture.z, cyp = (gesture.my - oy - gesture.ty) / gesture.z;
    zoom.z = z; zoom.tx = mx - ox - z * cxp; zoom.ty = my - oy - z * cyp;
    if (z === 1) { zoom.tx = 0; zoom.ty = 0; }
    fitStage();
  } else if (stroke) {
    const p = toSource(e.clientX, e.clientY);
    if (ui.tool === 'push' || ui.tool === 'restore') strokeDab(stroke.last, p);
    stroke.last = p;
  } else if (gesture && gesture.type === 'pan' && zoom.z > 1) {
    zoom.tx = gesture.tx + e.clientX - gesture.x; zoom.ty = gesture.ty + e.clientY - gesture.y; fitStage();
  }
});
const ptrEnd = e => {
  ptrs.delete(e.pointerId);
  if (stroke) endStroke();
  if (gesture && gesture.type === 'pinch' && ptrs.size < 2) { gesture = null; requestRender(); }
  if (!ptrs.size) gesture = null;
};
viewer.addEventListener('pointerup', ptrEnd);
viewer.addEventListener('pointercancel', ptrEnd);
viewer.addEventListener('pointerleave', () => { if (!ptrs.size) $('#cursor').hidden = true; });
viewer.addEventListener('wheel', e => {
  if (!loaded || cropMode()) return; e.preventDefault();
  setZoom(zoom.z * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); requestRender(true);
}, { passive: false });

// ───────────────────────── 자르기 오버레이 ─────────────────────────
const cropBox = $('#cropBox');
function updCropBox() {
  const c = state.geo.crop;
  Object.assign(cropBox.style, { left: c.x * 100 + '%', top: c.y * 100 + '%', width: c.w * 100 + '%', height: c.h * 100 + '%' });
  const pc = v => v * 100 + '%';
  Object.assign($('#shT').style, { left: 0, right: 0, top: 0, height: pc(c.y) });
  Object.assign($('#shB').style, { left: 0, right: 0, top: pc(c.y + c.h), bottom: 0 });
  Object.assign($('#shL').style, { left: 0, width: pc(c.x), top: pc(c.y), height: pc(c.h) });
  Object.assign($('#shR').style, { left: pc(c.x + c.w), right: 0, top: pc(c.y), height: pc(c.h) });
}
let cdrag = null;
$('#cropOverlay').addEventListener('pointerdown', e => {
  const hnd = e.target.dataset.h || (e.target.closest('#cropBox') ? 'move' : null);
  if (!hnd) return;
  e.preventDefault(); e.stopPropagation();
  e.target.setPointerCapture(e.pointerId);
  cdrag = { h: hnd, x: e.clientX, y: e.clientY, c: { ...state.geo.crop }, r: $('#stage').getBoundingClientRect() };
});
$('#cropOverlay').addEventListener('pointermove', e => {
  if (!cdrag) return;
  const g = state.geo, [ow, oh] = orientedSize(SW, SH, g.rot), s = cdrag.c, h = cdrag.h;
  const dx = (e.clientX - cdrag.x) / cdrag.r.width, dy = (e.clientY - cdrag.y) / cdrag.r.height;
  let n;
  if (h === 'move') {
    n = { ...s, x: Math.min(1 - s.w, Math.max(0, s.x + dx)), y: Math.min(1 - s.h, Math.max(0, s.y + dy)) };
    if (!cropFits(n, g.angle, ow, oh)) { const nx = { ...s, x: n.x }; n = cropFits(nx, g.angle, ow, oh) ? nx : { ...s, y: n.y }; }
  } else {
    let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
    if (h.includes('w')) x0 += dx; if (h.includes('e')) x1 += dx;
    if (h.includes('n')) y0 += dy; if (h.includes('s')) y1 += dy;
    const min = 0.06;
    if (x1 - x0 < min) { if (h.includes('w')) x0 = x1 - min; else x1 = x0 + min; }
    if (y1 - y0 < min) { if (h.includes('n')) y0 = y1 - min; else y1 = y0 + min; }
    if (g.aspect > 0) { // 비율 고정: 가로 기준으로 세로 맞춤
      const wpx = (x1 - x0) * ow, hn = wpx / g.aspect / oh;
      if (h.includes('n')) y0 = y1 - hn; else y1 = y0 + hn;
    }
    n = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  if (cropFits(n, g.angle, ow, oh)) { g.crop = n; updCropBox(); }
});
const cropEnd = () => { if (cdrag) { cdrag = null; commit(); } };
$('#cropOverlay').addEventListener('pointerup', cropEnd);
$('#cropOverlay').addEventListener('pointercancel', cropEnd);

function refitCrop(aspect) {
  const g = state.geo, [ow, oh] = orientedSize(SW, SH, g.rot);
  g.crop = maxCrop(aspect, g.angle, ow, oh);
}
function currentAspectPx() {
  const g = state.geo, [ow, oh] = orientedSize(SW, SH, g.rot);
  return g.aspect > 0 ? g.aspect : (g.crop.w * ow) / (g.crop.h * oh);
}

// ───────────────────────── 패널 UI ─────────────────────────
const syncers = [];
const fmtSigned = (v, d = 0) => (v > 0 ? '+' : '') + v.toFixed(d);
const TRACK = {
  temp: 'linear-gradient(90deg,#3d7bff,#ccc,#ffbf3d)',
  tint: 'linear-gradient(90deg,#3dbf4c,#ccc,#e04fd0)',
  hue: 'linear-gradient(90deg,#f33,#fb3,#ff3,#3f3,#3ff,#33f,#c3f,#f3c,#f33)',
};
function slider({ label, min, max, step = 1, get, set, def = 0, track, fmt, needsFace }) {
  const out = el('output');
  const input = el('input', { type: 'range', min, max, step });
  if (track) input.style.setProperty('--track', track);
  const show = v => { out.textContent = fmt ? fmt(v) : (min < 0 ? fmtSigned(v, step < 1 ? 2 : 0) : String(Math.round(v))); };
  input.addEventListener('input', () => { const v = parseFloat(input.value); set(v); show(v); requestRender(true); });
  input.addEventListener('change', () => { commit(); requestRender(); });
  const lab = el('span', { class: 'lab', title: '두 번 눌러 초기화' }, label);
  lab.addEventListener('dblclick', () => { set(def); input.value = def; show(def); commit(); requestRender(); });
  const row = el('div', { class: 'row', 'data-needs-face': needsFace ? '' : null }, lab, input, out);
  syncers.push(() => { const v = get(); input.value = v; show(v); });
  return row;
}
const adjSlider = (key, label, min, max, step = 1, extra = {}) =>
  slider({ label, min, max, step, def: ADJ_DEFAULT[key], get: () => state.adj[key], set: v => { state.adj[key] = v; }, ...extra });
const group = (title, ...rows) => el('section', { class: 'grp' }, el('h3', {}, title), ...rows);
function seg(options, get, set) {
  const wrap = el('div', { class: 'seg' });
  const btns = options.map(([v, l]) => el('button', { onclick: () => { set(v); upd(); } }, l));
  const upd = () => btns.forEach((b, i) => b.classList.toggle('on', options[i][0] === get()));
  wrap.append(...btns); syncers.push(upd); upd();
  return wrap;
}

const HSL_NAMES = ['빨강', '주황', '노랑', '초록', '아쿠아', '파랑', '보라', '마젠타'];
const HSL_COL = ['#f44', '#f93', '#fd3', '#4c4', '#3cc', '#46f', '#a5f', '#f4c'];

let curveEd;
function buildPanels() {
  const P = {};
  P.presets = el('div', {}, el('div', { class: 'presets', id: 'presetGrid' }),
    el('div', { class: 'btnrow' }, el('button', { onclick: saveUserPreset }, '현재 설정을 프리셋으로 저장')),
    el('p', { class: 'note' }, '프리셋은 색·톤 보정만 바꾸고, 자르기·바디 보정·얼굴형 보정은 유지합니다.'));

  P.basic = el('div', {},
    el('div', { class: 'btnrow' }, el('button', { onclick: autoTone }, '✨ 자동 보정')),
    group('빛', adjSlider('exposure', '노출', -3, 3, 0.01), adjSlider('contrast', '대비', -100, 100), adjSlider('highlights', '하이라이트', -100, 100),
      adjSlider('shadows', '섀도우', -100, 100), adjSlider('whites', '흰색 계열', -100, 100), adjSlider('blacks', '검정 계열', -100, 100)),
    group('색', adjSlider('temp', '색온도', -100, 100, 1, { track: TRACK.temp }), adjSlider('tint', '색조', -100, 100, 1, { track: TRACK.tint }),
      adjSlider('vibrance', '활기', -100, 100), adjSlider('sat', '채도', -100, 100)));

  const curveCv = el('canvas', { class: 'curve' });
  P.curve = el('div', {},
    seg([['rgb', 'RGB'], ['r', 'R'], ['g', 'G'], ['b', 'B']], () => ui.curveCh, v => { ui.curveCh = v; curveEd.setChannel(v); }),
    curveCv,
    el('div', { class: 'btnrow' },
      el('button', { onclick: () => { state.curve[ui.curveCh] = [[0, 0], [1, 1]]; curveEd.set(state.curve); commit(); requestRender(); } }, '이 채널 초기화'),
      el('button', { onclick: () => { state.curve = DEFAULT_CURVE(); curveEd.set(state.curve); commit(); requestRender(); } }, '전체 초기화')),
    el('p', { class: 'note' }, '빈 곳을 눌러 점 추가 · 드래그로 이동 · 두 번 누르거나 밖으로 끌어내면 삭제. 뒤의 그래프는 현재 사진의 히스토그램입니다.'));
  curveEd = new CurveEditor(curveCv, { onInput: () => requestRender(true), onCommit: () => { commit(); requestRender(); } });

  const hslSets = {};
  for (const [m, name] of [['h', '색조'], ['s', '채도'], ['l', '휘도']]) {
    hslSets[m] = el('div', { class: 'hslset' }, ...HSL_NAMES.map((n, i) => slider({
      label: n, min: -100, max: 100, get: () => state.hsl[m][i], set: v => { state.hsl[m][i] = v; },
      track: m === 'h' ? `linear-gradient(90deg,${HSL_COL[(i + 7) % 8]},${HSL_COL[i]},${HSL_COL[(i + 1) % 8]})`
        : m === 's' ? `linear-gradient(90deg,#888,${HSL_COL[i]})` : `linear-gradient(90deg,#222,${HSL_COL[i]},#fff)`,
    })));
  }
  const showHsl = () => Object.entries(hslSets).forEach(([k, e]) => { e.hidden = k !== ui.hslMode; });
  syncers.push(showHsl);
  P.color = el('div', {},
    group('HSL / 색상별 조정', seg([['h', '색조'], ['s', '채도'], ['l', '휘도']], () => ui.hslMode, v => { ui.hslMode = v; showHsl(); }),
      hslSets.h, hslSets.s, hslSets.l),
    group('컬러 그레이딩',
      adjSlider('gShadowHue', '섀도우 색', 0, 360, 1, { track: TRACK.hue, fmt: v => Math.round(v) + '°' }), adjSlider('gShadowSat', '섀도우 양', 0, 100),
      adjSlider('gHighHue', '하이라이트 색', 0, 360, 1, { track: TRACK.hue, fmt: v => Math.round(v) + '°' }), adjSlider('gHighSat', '하이라이트 양', 0, 100),
      adjSlider('gBalance', '균형', -100, 100)));
  showHsl();

  P.effects = el('div', {},
    group('디테일', adjSlider('sharpen', '선명하게', 0, 100), adjSlider('texture', '텍스처', -100, 100), adjSlider('clarity', '부분 대비', -100, 100), adjSlider('dehaze', '디헤이즈', -100, 100)),
    group('효과', adjSlider('vignette', '비네팅', -100, 100), adjSlider('grain', '그레인', 0, 100)));

  const maskBtn = el('button', { onclick: () => { maskOn = !maskOn; syncMask(); requestRender(); } }, '피부 영역 보기');
  const syncMask = () => { maskBtn.textContent = maskOn ? '피부 영역 끄기' : '피부 영역 보기'; maskBtn.classList.toggle('on', maskOn); };
  syncers.push(syncMask);
  P.portrait = el('div', {},
    el('p', { class: 'status', id: 'faceStatus' }),
    group('피부', adjSlider('smooth', '피부 스무딩', 0, 100), adjSlider('skinBright', '피부 밝기', -50, 50), adjSlider('skinTone', '피부 톤', -50, 50, 1, { track: 'linear-gradient(90deg,#c9a3ff,#ccc,#ffb27a)' })),
    group('얼굴형 (얼굴 인식 필요)', adjSlider('eyes', '눈 크게', 0, 100, 1, { needsFace: true }), adjSlider('faceSlim', '얼굴 갸름하게', 0, 100, 1, { needsFace: true })),
    el('div', { class: 'btnrow' }, maskBtn));

  P.body = el('div', {},
    seg([['push', '밀기'], ['pucker', '축소'], ['bloat', '확대'], ['restore', '복원']], () => ui.tool, v => { ui.tool = v; }),
    slider({ label: '브러시 크기', min: 20, max: 300, get: () => ui.brushSize, set: v => { ui.brushSize = v; }, def: 90 }),
    slider({ label: '강도', min: 5, max: 100, get: () => ui.brushStrength, set: v => { ui.brushStrength = v; }, def: 50 }),
    el('div', { class: 'btnrow' }, el('button', { onclick: resetWarp }, '바디 보정 모두 지우기')),
    el('p', { class: 'note' }, '사진 위를 한 손가락으로 문질러 보정합니다. 밀기: 허리·팔·다리 라인을 안쪽으로 밀어 슬림하게 · 축소/확대: 누르고 있는 동안 작아지거나 커짐 · 복원: 원래대로. 두 손가락으로 확대/이동할 수 있어요.'));

  const ASPECTS = [[0, '자유'], [-1, '원본'], [1, '1:1'], [4 / 5, '4:5'], [3 / 4, '3:4'], [2 / 3, '2:3'], [9 / 16, '9:16'], [16 / 9, '16:9']];
  const aspectVal = v => { if (v !== -1) return v; const [ow, oh] = orientedSize(SW, SH, state.geo.rot); return ow / oh; };
  P.crop = el('div', {},
    el('div', { class: 'chips' }, ...ASPECTS.map(([v, l]) => {
      const b = el('button', { onclick: () => { state.geo.aspectKey = v; state.geo.aspect = Math.max(0, aspectVal(v)); refitCrop(state.geo.aspect); commit(); fitStage(); syncUI(); } }, l);
      syncers.push(() => b.classList.toggle('on', (state.geo.aspectKey ?? 0) === v));
      return b;
    })),
    el('div', { class: 'btnrow' },
      el('button', { onclick: () => rotate90(-1) }, '⟲ 90°'),
      el('button', { onclick: () => rotate90(1) }, '⟳ 90°'),
      el('button', { onclick: flipH }, '⇋ 좌우 반전'),
      el('button', { onclick: () => { state.geo = DEFAULT_GEO(); commit(); syncUI(); requestRender(); } }, '초기화')),
    slider({
      label: '수평', min: -45, max: 45, step: 0.1, get: () => state.geo.angle, fmt: v => fmtSigned(v, 1) + '°',
      set: v => { const a = currentAspectPx(); state.geo.angle = v; refitCrop(a); updCropBox(); },
    }),
    el('p', { class: 'note' }, '모서리를 끌어 자르고, 가운데를 끌어 위치를 옮기세요. 다른 탭으로 가면 자른 결과가 보입니다.'));
  return P;
}
function rotate90(dir) {
  const g = state.geo, a = currentAspectPx();
  g.rot = (g.rot + (dir > 0 ? 1 : 3)) & 3;
  if (g.aspect > 0) g.aspect = 1 / g.aspect;
  refitCrop(g.aspect > 0 ? g.aspect : 1 / a);
  commit(); syncUI(); requestRender();
}
function flipH() {
  const g = state.geo; g.flip = !g.flip; g.angle = -g.angle; g.crop = { ...g.crop, x: 1 - g.crop.x - g.crop.w };
  commit(); syncUI(); requestRender();
}
function resetWarp() {
  worker.postMessage({ type: 'setWarp', warpId: 0 });
  state.warpId = 0; commit(); requestRender();
}

const TABS = [['presets', '프리셋'], ['basic', '기본'], ['curve', '톤 커브'], ['color', '색상'], ['effects', '효과'], ['portrait', '인물'], ['body', '바디'], ['crop', '자르기']];
let panels;
function setTab(t) {
  const wasCrop = cropMode();
  tab = t;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  for (const [k, p] of Object.entries(panels)) p.hidden = k !== t;
  $('#cropOverlay').hidden = t !== 'crop';
  viewer.classList.toggle('brush', t === 'body');
  if (t !== 'body') $('#cursor').hidden = true;
  if (t === 'curve') curveEd.draw();
  if (wasCrop !== cropMode()) { resetZoom(); requestRender(); }
  if (t === 'presets') renderPresets();
  $('#panel').scrollTop = 0;
}
function syncUI() {
  syncers.forEach(f => f());
  curveEd.set(state.curve);
  if (cropMode()) updCropBox();
}

// ───────────────────────── 프리셋 ─────────────────────────
const LS_KEY = 'photoeditor.presets.v1';
function loadUserPresets() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; } }
function storeUserPresets(list) { try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { toast('프리셋을 저장할 수 없어요'); } }
function applyPreset(p) {
  const keepShape = Object.fromEntries(FACE_SHAPE_KEYS.map(k => [k, state.adj[k]]));
  state.adj = { ...ADJ_DEFAULT, ...p.adj, ...keepShape };
  state.hsl = p.hsl ? JSON.parse(JSON.stringify(p.hsl)) : { h: zeros8(), s: zeros8(), l: zeros8() };
  state.curve = p.curve ? JSON.parse(JSON.stringify(p.curve)) : DEFAULT_CURVE();
  commit(); syncUI(); requestRender();
  toast(`프리셋: ${p.name}`);
}
function renderPresets() {
  const grid = $('#presetGrid'); grid.textContent = '';
  BUILTIN_PRESETS.forEach(p => grid.append(el('button', { class: 'preset', onclick: () => applyPreset(p) }, p.name)));
  loadUserPresets().forEach((p, i) => grid.append(el('div', { class: 'preset user' },
    el('button', { onclick: () => applyPreset(p) }, p.name),
    el('button', { class: 'x', 'aria-label': '삭제', onclick: () => { const l = loadUserPresets(); l.splice(i, 1); storeUserPresets(l); renderPresets(); } }, '×'))));
}
function saveUserPreset() {
  const name = (prompt('프리셋 이름', '내 프리셋') || '').trim();
  if (!name) return;
  const adj = { ...state.adj }; FACE_SHAPE_KEYS.forEach(k => delete adj[k]);
  const l = loadUserPresets(); l.push({ name, adj, hsl: state.hsl, curve: state.curve }); storeUserPresets(l);
  renderPresets(); toast('프리셋을 저장했어요');
}

// ───────────────────────── 자동 보정 ─────────────────────────
function autoTone() {
  if (!srcHist) return;
  const N = srcHist.reduce((a, b) => a + b, 0), pct = q => { let a = 0; for (let i = 0; i < 256; i++) { a += srcHist[i]; if (a >= N * q) return i / 255; } return 1; };
  const lo = pct(0.005), mid = pct(0.5), hi = pct(0.995);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const ex = clamp(Math.log2(0.46 / Math.max(0.03, mid)) * 0.75, -1.5, 1.5), m = Math.pow(2, ex);
  const w0 = clamp(hi * m / 0.97, 0.8, 1.2), b0 = (lo * m - 0.02 * w0) / 0.98;
  Object.assign(state.adj, {
    exposure: +ex.toFixed(2), whites: Math.round(clamp((1 - w0) / 0.2 * 100, -60, 60)),
    blacks: Math.round(clamp(-b0 / 0.12 * 100, -60, 60)), contrast: 10, vibrance: 15,
    highlights: hi * m > 0.95 ? -20 : 0, shadows: lo * m < 0.05 ? 15 : 0,
  });
  commit(); syncUI(); requestRender(); toast('자동 보정을 적용했어요');
}

// ───────────────────────── 히스토그램 ─────────────────────────
function drawHist() {
  const c = $('#hist'), h = lastHist; if (!h || !c.clientWidth) return;
  const dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
  if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, H);
  let mx = 1; for (let k = 256; k < 1024; k++) if (k % 256 > 1 && k % 256 < 254) mx = Math.max(mx, h[k]);
  x.globalCompositeOperation = 'lighter';
  [['rgba(255,70,70,.55)', 256], ['rgba(70,220,90,.55)', 512], ['rgba(70,130,255,.55)', 768]].forEach(([col, off]) => {
    x.beginPath(); x.moveTo(0, H);
    for (let i = 0; i < 256; i++) x.lineTo(i / 255 * W, H - Math.min(1, h[off + i] / mx) * H);
    x.lineTo(W, H); x.closePath(); x.fillStyle = col; x.fill();
  });
  x.globalCompositeOperation = 'source-over';
}

// ───────────────────────── 저장 / 공유 ─────────────────────────
function exportBlob(max) {
  return new Promise((resolve, reject) => {
    const s = Math.min(1, max / Math.max(fullBitmap.width, fullBitmap.height));
    const w = Math.round(fullBitmap.width * s), h = Math.round(fullBitmap.height * s);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.drawImage(fullBitmap, 0, 0, w, h);
    const id = x.getImageData(0, 0, w, h); c.width = c.height = 1;
    waiters.export = { resolve, reject };
    worker.postMessage({ type: 'export', width: w, height: h, buffer: id.data.buffer, state, luts: luts(), quality: 0.93 }, [id.data.buffer]);
  }).finally(() => { waiters.export = null; });
}
async function renderForSave() {
  try { return await exportBlob(EXPORT_MAX); }
  catch (e) { console.warn('export retry', e); return await exportBlob(2560); }
}
const blobToBase64 = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(b); });
const fileName = () => 'edited_' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '.jpg';

async function shareBlob(blob, name) {
  if (NATIVE) {
    const data = await blobToBase64(blob);
    const w = await plugin('Filesystem').writeFile({ path: name, data, directory: 'CACHE' });
    await plugin('Share').share({ title: '편집한 사진', files: [w.uri], dialogTitle: '사진 공유' });
    return;
  }
  const f = new File([blob], name, { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f] });
  else download(blob, name);
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function withBusy(btn, fn) {
  if (!fullBitmap) { toast('먼저 사진을 열어주세요'); return; }
  const all = document.querySelectorAll('.top button'); all.forEach(b => (b.disabled = true));
  $('#busy').hidden = false;
  try { await fn(); }
  catch (err) { if (!/cancel/i.test(String(err && err.message))) toast('실패: ' + (err && err.message || err)); }
  finally { all.forEach(b => (b.disabled = false)); updUndo(); $('#busy').hidden = true; }
}
$('#save').onclick = () => withBusy($('#save'), async () => {
  const blob = await renderForSave(), name = fileName();
  if (!NATIVE) { download(blob, name); return; }
  try {
    await plugin('GallerySaver').save({ data: await blobToBase64(blob), filename: name, album: '사진 편집기' });
    toast('갤러리에 저장했어요 (사진/사진 편집기)', 2800);
  } catch (e) {
    console.warn('gallery save failed, fallback to share', e);
    await shareBlob(blob, name);
  }
});
$('#share').onclick = () => withBusy($('#share'), async () => shareBlob(await renderForSave(), fileName()));

// ───────────────────────── 상단 버튼 / 단축키 / 뒤로가기 ─────────────────────────
$('#undo').onclick = undo;
$('#redo').onclick = redo;
const cmp = $('#cmp');
const cmpOn = e => { e.preventDefault(); if (!loaded) return; viewMode = 'original'; cmp.classList.add('on'); requestRender(); };
const cmpOff = () => { if (viewMode !== 'original') return; viewMode = 'normal'; cmp.classList.remove('on'); requestRender(); };
cmp.addEventListener('pointerdown', cmpOn);
['pointerup', 'pointerleave', 'pointercancel'].forEach(t => cmp.addEventListener(t, cmpOff));
cmp.addEventListener('contextmenu', e => e.preventDefault());

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (e.key === '\\' && !e.repeat) cmpOn(e);
});
document.addEventListener('keyup', e => { if (e.key === '\\') cmpOff(); });

let backAt = 0;
if (NATIVE) {
  plugin('App').addListener('backButton', () => {
    if (zoom.z > 1.01) { resetZoom(); requestRender(); return; }
    if (tab !== 'basic') { setTab('basic'); return; }
    const now = Date.now();
    if (now - backAt < 2000) plugin('App').exitApp();
    else { backAt = now; toast('한 번 더 누르면 종료합니다'); }
  });
}

// ───────────────────────── 시작 ─────────────────────────
panels = buildPanels();
const panel = $('#panel');
for (const [k, p] of Object.entries(panels)) { p.classList.add('pane'); panel.append(p); }
const tabs = $('#tabs');
TABS.forEach(([t, l]) => tabs.append(el('button', { 'data-t': t, onclick: () => setTab(t) }, l)));
setTab('basic'); syncUI(); updUndo(); updFaceStatus();
new ResizeObserver(drawHist).observe($('#hist'));
