// 조명 설정 window: brightness of face / body / hair, the shade side, and the light itself.
// Values are stored as factors (1 = default); the sliders show percent.
const api = window.light;
const $ = (id) => document.getElementById(id);
const sliders = {};

for (const el of document.querySelectorAll('.lslider')) {
  const key = el.dataset.key;
  el.innerHTML = '';
  const lbl = document.createElement('div');
  lbl.className = 'lbl';
  const name = document.createElement('span');
  name.textContent = el.dataset.label;
  const val = document.createElement('b');
  lbl.append(name, val);
  const ctl = document.createElement('div');
  ctl.className = 'ctl';
  const range = document.createElement('input');
  range.type = 'range';
  range.min = el.dataset.min;
  range.max = el.dataset.max;
  range.step = 1;
  ctl.append(range);
  el.append(lbl, ctl);
  sliders[key] = { range, val };
  range.addEventListener('input', () => {
    show(key, Number(range.value) / 100);
    send({ [key]: Number(range.value) / 100 });
  });
}

function show(key, v) {
  const s = sliders[key];
  s.val.textContent = key === 'dirX' || key === 'dirY' ? (v * 100).toFixed(0) : `${Math.round(v * 100)}%`;
}

function render(light) {
  for (const [k, s] of Object.entries(sliders)) {
    if (document.activeElement !== s.range) s.range.value = Math.round(light[k] * 100);
    show(k, light[k]);
  }
}

// at most one request in flight; the latest values win
let pending = null;
let busy = false;
async function send(patch) {
  pending = { ...(pending || {}), ...patch };
  if (busy) return;
  busy = true;
  while (pending) {
    const p = pending;
    pending = null;
    await api.set(p);
  }
  busy = false;
}

$('reset').onclick = async () => render(await api.set('reset'));
api.get().then(({ light, toon }) => {
  render(light);
  $('toon-off').hidden = toon;
});
