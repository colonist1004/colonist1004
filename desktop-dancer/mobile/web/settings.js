// Settings screen. Native side: window.App (Java @JavascriptInterface), see MainActivity.java.
const App = window.App;
const $ = (id) => document.getElementById(id);
let state = null;

const pct = (v) => `${Math.round(v)}%`;
const FIELDS = {
  speed: { scale: 1, fmt: (v) => `${Number(v).toFixed(2)}x` },
  scale: { scale: 100, fmt: pct }, // overlay size, stored as 0.25..8
  wpScale: { scale: 100, fmt: pct }, // wallpaper: share of the screen height
  wpX: { scale: 100, fmt: pct },
  wpY: { scale: 100, fmt: pct },
};

function refreshPreviews() {
  for (const id of ['preview', 'wp-preview']) $(id).contentWindow?.dancer?.refresh();
}

function fillSelect(sel, items, value) {
  sel.innerHTML = '';
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.id;
    o.textContent = it.name;
    sel.appendChild(o);
  }
  if (value) sel.value = value;
}

function render(s) {
  state = s;
  fillSelect($('character'), s.characters, s.settings.character);
  fillSelect($('motion'), s.motions, s.settings.motion);
  for (const [k, f] of Object.entries(FIELDS)) {
    $(k).value = s.settings[k] * f.scale;
    $(`${k}-v`).textContent = f.fmt(s.settings[k] * f.scale);
  }
  $('bg').value = s.settings.bg;
  $('perm-box').hidden = s.overlay.permission;
  $('btn-overlay').textContent = s.overlay.running ? '띄우기 끄기' : '화면 위에 띄우기';
}

function load() {
  render(JSON.parse(App.getState()));
}

function set(key, value) {
  App.setSetting(key, JSON.stringify(value));
  state.settings[key] = value;
  refreshPreviews();
}

$('character').addEventListener('change', (e) => set('character', e.target.value));
$('motion').addEventListener('change', (e) => set('motion', e.target.value));
$('bg').addEventListener('input', (e) => set('bg', e.target.value));
for (const [k, f] of Object.entries(FIELDS)) {
  $(k).addEventListener('input', (e) => {
    const v = Number(e.target.value) / f.scale;
    $(`${k}-v`).textContent = f.fmt(Number(e.target.value));
    set(k, v);
  });
}
for (const b of document.querySelectorAll('[data-add]')) b.onclick = () => App.pickFiles(b.dataset.add);
$('btn-perm').onclick = () => App.requestOverlayPermission();
$('btn-overlay').onclick = () => {
  if (state.overlay.running) App.stopOverlay();
  else if (!state.overlay.permission) App.requestOverlayPermission();
  else App.startOverlay();
  setTimeout(load, 400);
};
$('btn-wallpaper').onclick = () => App.setWallpaper();

// Called from Java after files were added or the app came back to the foreground.
window.onAppResume = load;
window.onFilesAdded = (json) => {
  load();
  const added = JSON.parse(json);
  if (added.length) alert(`${added.length}개 파일을 추가했어요.`);
};

load();
