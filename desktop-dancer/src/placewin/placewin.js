// 위치·크기 window: size 25–800 %, horizontal position in px, height above the taskbar in px.
const api = window.place;
const $ = (id) => document.getElementById(id);
let st = null;

function render(s) {
  st = s;
  const pct = Math.round(s.scale * 100);
  $('scale').min = Math.round(s.minScale * 100);
  $('scale').max = Math.round(s.maxScale * 100);
  if (document.activeElement !== $('scale')) $('scale').value = pct;
  if (document.activeElement !== $('scale-num')) $('scale-num').value = pct;
  const xpx = Math.round(s.xFraction * s.freeWidth);
  $('x').max = Math.max(1, s.freeWidth);
  if (document.activeElement !== $('x')) $('x').value = xpx;
  if (document.activeElement !== $('x-num')) $('x-num').value = xpx;
  $('x-num').max = s.freeWidth;
  $('y').min = s.yRange.min;
  $('y').max = s.yRange.max;
  if (document.activeElement !== $('y')) $('y').value = s.yOffset;
  if (document.activeElement !== $('y-num')) $('y-num').value = s.yOffset;
  $('crop-note').hidden = !s.cropped;
}

const set = async (patch) => render(await api.set(patch));
const setX = (px) => set({ xFraction: st.freeWidth > 0 ? Math.min(st.freeWidth, Math.max(0, px)) / st.freeWidth : 0 });

$('scale').addEventListener('input', () => set({ scale: Number($('scale').value) / 100 }));
$('scale-num').addEventListener('change', () => set({ scale: Number($('scale-num').value) / 100 }));
$('x').addEventListener('input', () => setX(Number($('x').value)));
$('x-num').addEventListener('change', () => setX(Number($('x-num').value)));
$('y').addEventListener('input', () => set({ yOffset: Number($('y').value) }));
$('y-num').addEventListener('change', () => set({ yOffset: Number($('y-num').value) }));

for (const b of document.querySelectorAll('[data-scale]')) {
  b.onclick = () => set({ scale: st.scale + Number(b.dataset.scale) / 100 });
}
for (const b of document.querySelectorAll('[data-preset]')) b.onclick = () => set({ scale: Number(b.dataset.preset) / 100 });
for (const b of document.querySelectorAll('[data-x]')) b.onclick = () => setX(Math.round(st.xFraction * st.freeWidth) + Number(b.dataset.x));
for (const b of document.querySelectorAll('[data-xpos]')) b.onclick = () => set({ xFraction: Number(b.dataset.xpos) });
for (const b of document.querySelectorAll('[data-y]')) b.onclick = () => set({ yOffset: st.yOffset + Number(b.dataset.y) });
for (const b of document.querySelectorAll('[data-ypos]')) b.onclick = () => set({ yOffset: Number(b.dataset.ypos) });
$('reset').onclick = async () => render(await api.reset());

api.onChanged(render); // dragging the character, Ctrl+wheel, tray presets
api.get().then(render);
