// "캐릭터 만들기" window: image check → cloud instructions → import/convert → preview → apply.
const api = window.charStudio;
const $ = (id) => document.getElementById(id);
const show = (id, on) => ($(id).hidden = !on);

const state = { model: null, result: null, shading: 'toon', flip: false, running: false };

// ------------------------------------------------------------------ setup
async function checkSetup() {
  const s = await api.status();
  show('setup', !s.ready);
  show('main', s.ready);
  if (!s.ready) {
    show('setup-nopython', !s.python);
    show('setup-ready', !!s.python);
    if (s.python) $('setup-python').textContent = `Python ${s.python.version}`;
  }
}
$('btn-recheck').onclick = checkSetup;
$('btn-get-python').onclick = () => api.openPythonDownload();
$('btn-setup').onclick = async () => {
  $('btn-setup').disabled = true;
  $('btn-setup').textContent = '설치 중…';
  const logEl = $('setup-log');
  logEl.hidden = false;
  logEl.textContent = '';
  const off = api.onSetupLog((l) => {
    logEl.textContent += l + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  });
  const r = await api.setup();
  off();
  if (r.ok) return checkSetup();
  logEl.textContent += `\n설치 실패: ${r.error}`;
  $('btn-setup').disabled = false;
  $('btn-setup').textContent = '다시 시도';
};

// ------------------------------------------------------------- drag & drop
function dropZone(zoneId, inputId, onFile) {
  const zone = $(zoneId);
  $(inputId).addEventListener('change', (e) => e.target.files[0] && onFile(e.target.files[0]));
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
  });
}
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ------------------------------------------------------------------ 1. image
dropZone('drop-img', 'file-img', async (file) => {
  const p = api.pathForFile(file);
  const img = $('img-preview');
  img.src = URL.createObjectURL(file);
  img.hidden = false;
  $('img-hint').hidden = true;
  const fname = file.name;
  $('cmd').textContent = `bash pipeline/cloud/run_character.sh "${fname}"`;
  if (!$('name').value) $('name').value = fname.replace(/\.[^.]+$/, '');
  const list = $('checks');
  list.innerHTML = '<li class="wait">그림 확인 중…</li>';
  const r = await api.checkImage(p);
  list.innerHTML = '';
  for (const c of r.checks || [{ level: 'info', msg: r.msg || '확인하지 못했습니다' }]) {
    const li = document.createElement('li');
    li.className = c.level;
    li.textContent = c.msg;
    list.appendChild(li);
  }
});

// ------------------------------------------------------------------ 2. cloud
$('btn-cloud-folder').onclick = () => api.openCloudFolder();
$('btn-copy').onclick = async () => {
  await navigator.clipboard.writeText($('cmd').textContent);
  $('btn-copy').textContent = '복사됨 ✓';
  setTimeout(() => ($('btn-copy').textContent = '복사'), 1500);
};

// ------------------------------------------------------------------ 3. import
function segment(id, key) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    for (const x of $(id).querySelectorAll('button')) x.classList.toggle('on', x === b);
    state[key] = b.dataset.v;
  });
}
segment('shading', 'shading');
$('height').addEventListener('input', () => ($('height-label').textContent = `${Number($('height').value).toFixed(2)} m`));

function setProgress(frac, text) {
  show('progress', true);
  $('bar-fill').style.width = `${Math.round(frac * 100)}%`;
  if (text) $('progress-text').textContent = text;
}
function showError(msg) {
  $('error').textContent = msg;
  show('error', true);
}
api.onJob((ev) => {
  if (ev.type === 'progress') setProgress(ev.frac, ev.msg ? `${ev.msg}…` : null);
  if (ev.type === 'log') {
    $('log').textContent += ev.msg + '\n';
  }
});

dropZone('drop-model', 'file-model', async (file) => {
  show('error', false);
  const p = api.pathForFile(file);
  state.model = p;
  state.flip = false;
  const base = file.name.replace(/(\.rigged)?\.(glb|vrm)$/i, '');
  if (!$('name').value || $('name').dataset.auto !== '0') $('name').value = base;
  if (/\.vrm$/i.test(file.name)) {
    show('glb-options', false);
    setProgress(0.5, '캐릭터 라이브러리에 추가하는 중…');
    const r = await api.importVrm(p);
    show('progress', false);
    if (r.error) return showError(r.error);
    finish(r.out, [], false);
  } else {
    show('glb-options', true);
    $('btn-convert').focus();
  }
});
$('name').addEventListener('input', () => ($('name').dataset.auto = '0'));

async function convert() {
  if (!state.model || state.running) return;
  state.running = true;
  $('btn-convert').disabled = true;
  show('error', false);
  $('log').textContent = '';
  setProgress(0, '시작하는 중…');
  const r = await api.convert({
    input: state.model,
    name: $('name').value.trim() || 'character',
    height: Number($('height').value),
    shading: state.shading,
    flip: state.flip,
  });
  state.running = false;
  $('btn-convert').disabled = false;
  if (r.type === 'done') {
    setProgress(1, '완료');
    finish(r.out, r.warnings || [], true);
  } else {
    show('progress', false);
    showError(`변환하지 못했습니다.\n${r.msg || ''}\n\n뼈대가 사람 형태로 인식되지 않으면 클라우드에서 다시 만들거나(다른 seed), 팔을 벌린 전신 정면 그림으로 시도해 보세요.`);
  }
}
$('btn-convert').onclick = convert;

// ------------------------------------------------------------------ 4. preview
async function finish(out, warnings, fromGlb) {
  state.result = out;
  show('preview-card', true);
  show('btn-flip', fromGlb);
  $('warnings').textContent = warnings.length ? `참고: ${warnings.join(' · ')}` : '';
  $('btn-apply').textContent = '이 캐릭터로 바꾸기';
  $('btn-dance').textContent = '▶ 춤 미리보기';
  await window.preview.load(out);
  $('preview-card').scrollIntoView({ behavior: 'smooth' });
}
$('btn-dance').onclick = async () => {
  const on = await window.preview.toggleDance();
  $('btn-dance').textContent = on ? '■ 춤 멈추기' : '▶ 춤 미리보기';
};
$('btn-flip').onclick = () => {
  state.flip = !state.flip;
  convert();
};
$('btn-apply').onclick = async () => {
  await api.apply(state.result);
  $('btn-apply').textContent = '적용했어요 ✓';
};

checkSetup();
