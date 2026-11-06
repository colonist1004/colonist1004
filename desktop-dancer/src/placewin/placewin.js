// 위치·크기 window: size 25–800 %, horizontal position in px, height above the taskbar in px.
const api = window.place;
const $ = (id) => document.getElementById(id);
let st = null;

function render(s) {
  st = s;
  const pct = Math.round(s.scale * 100);
  $('scale').min = Math.round(s.minScale * 100);
  $('scale').max = Math.round(s.maxScale * 100);
  $('scale-num').max = Math.round(s.maxScale * 100);
  if (document.activeElement !== $('scale')) $('scale').value = pct;
  if (document.activeElement !== $('scale-num')) $('scale-num').value = pct;
  $('x').min = s.xRange.min;
  $('x').max = s.xRange.max;
  if (document.activeElement !== $('x')) $('x').value = s.xCenterPx;
  if (document.activeElement !== $('x-num')) $('x-num').value = s.xCenterPx;
  $('y').min = s.yRange.min;
  $('y').max = s.yRange.max;
  if (document.activeElement !== $('y')) $('y').value = s.yOffset;
  if (document.activeElement !== $('y-num')) $('y-num').value = s.yOffset;
  $('crop-note').hidden = !s.cropped;
  $('behind').checked = !!s.behindTaskbar;
}

const set = async (patch) => render(await api.set(patch));
const setX = (px) => set({ xCenterPx: px });

$('scale').addEventListener('input', () => set({ scale: Number($('scale').value) / 100 }));
$('scale-num').addEventListener('change', () => {
  $('scale-num').blur(); // so the clamped value shows
  set({ scale: Number($('scale-num').value) / 100 });
});
$('x').addEventListener('input', () => setX(Number($('x').value)));
$('x-num').addEventListener('change', () => {
  $('x-num').blur(); // so the clamped value shows
  setX(Number($('x-num').value));
});
$('y').addEventListener('input', () => set({ yOffset: Number($('y').value) }));
$('y-num').addEventListener('change', () => {
  $('y-num').blur(); // so the clamped value shows
  set({ yOffset: Number($('y-num').value) });
});
// Upper body only: about the lower half of the character goes below the floor.
$('behind').addEventListener('change', () => set({ behindTaskbar: $('behind').checked }));
$('upper').onclick = () => set({ yOffset: -Math.round(st.frameHeight * 0.42) });

for (const b of document.querySelectorAll('[data-scale]')) {
  b.onclick = () => set({ scale: st.scale + Number(b.dataset.scale) / 100 });
}
for (const b of document.querySelectorAll('[data-preset]')) b.onclick = () => set({ scale: Number(b.dataset.preset) / 100 });
for (const b of document.querySelectorAll('[data-x]')) b.onclick = () => setX(st.xCenterPx + Number(b.dataset.x));
// left edge / middle / right edge of the work area, character fully on screen
for (const b of document.querySelectorAll('[data-xpos]')) {
  b.onclick = () => {
    const f = Number(b.dataset.xpos);
    const w = st.frameHeight * (320 / 340); // frame width (same aspect as the frame)
    setX(Math.round(f === 0 ? w / 2 : f === 1 ? st.workWidth - w / 2 : st.workWidth / 2));
  };
}
for (const b of document.querySelectorAll('[data-y]')) b.onclick = () => set({ yOffset: st.yOffset + Number(b.dataset.y) });
for (const b of document.querySelectorAll('[data-ypos]')) b.onclick = () => set({ yOffset: Number(b.dataset.ypos) });
$('reset').onclick = async () => render(await api.reset());

api.onChanged(render); // dragging the character, Ctrl+wheel, tray presets
api.get().then(render);
