// "캐릭터 만들기" window: image check → cloud instructions → import/convert → preview → apply.
const api = window.charStudio;
const $ = (id) => document.getElementById(id);
const show = (id, on) => ($(id).hidden = !on);

const state = { model: null, result: null, shading: 'toon', flip: false, running: false, image: null,
  genModel: 'triposg', genSteps: '50' };

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
  state.image = p;
  const img = $('img-preview');
  img.src = URL.createObjectURL(file);
  img.hidden = false;
  $('img-hint').hidden = true;
  const fname = file.name;
  $('cmd').textContent = `bash pipeline/cloud/run_character.sh "${fname}"`;
  if (!$('name').value) $('name').value = fname.replace(/\.[^.]+$/, '');
  const list = $('checks');
  list.innerHTML = '<li class="wait">그림 확인 중…</li>';
  state.checking = api.checkImage(p); // one pipeline job at a time: generating waits for this
  const r = await state.checking;
  state.checking = null;
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

// ------------------------------------------------- 2. on this PC's graphics card
const VENDOR_LABEL = { amd: 'AMD', nvidia: 'NVIDIA', cpu: 'CPU' };
async function refreshGen() {
  const st = await api.genStatus();
  const names = st.gpu?.names?.length ? st.gpu.names.join(', ') : '알 수 없음';
  $('gen-gpu').textContent = st.ready
    ? `준비됨 (${VENDOR_LABEL[st.installedFor] || st.installedFor}) · 그래픽카드: ${names}`
    : `그래픽카드: ${names}`;
  if (!st.ready) $('gen-vendor').value = st.gpu?.vendor || 'cpu';
  show('gen-amd-note', $('gen-vendor').value === 'amd');
  show('gen-setup-box', !st.ready);
  show('gen-run-box', st.ready);
  if (st.installedFor === 'cpu') {
    state.genModel = 'triposr';
    for (const b of $('gen-model').querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === 'triposr');
  }
  state.genDevice = st.installedFor === 'cpu' ? 'cpu' : 'auto';
}
$('gen-vendor').addEventListener('change', () => show('gen-amd-note', $('gen-vendor').value === 'amd'));
$('btn-gen-setup').onclick = async () => {
  const btn = $('btn-gen-setup');
  btn.disabled = true;
  btn.textContent = '설치 중… (오래 걸립니다)';
  const logEl = $('gen-setup-log');
  logEl.hidden = false;
  logEl.textContent = '';
  const off = api.onGenLog((l) => {
    logEl.textContent += l + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  });
  const r = await api.genSetup($('gen-vendor').value);
  off();
  btn.disabled = false;
  btn.textContent = '준비하기 (설치)';
  if (!r.ok) {
    logEl.textContent += `\n설치 실패: ${r.error}`;
    return;
  }
  refreshGen();
};
$('btn-gen-reinstall').onclick = () => {
  show('gen-run-box', false);
  show('gen-setup-box', true);
};
segment('gen-model', 'genModel');
segment('gen-steps', 'genSteps');
$('btn-gen').onclick = async () => {
  if (state.running) return;
  if (!state.image) return showError('1번에서 캐릭터 그림을 먼저 고르세요.');
  state.running = true;
  if (state.checking) {
    setProgress(0, '그림 확인이 끝나기를 기다리는 중…');
    await state.checking.catch(() => {});
  }
  $('btn-gen').disabled = true;
  show('btn-gen-cancel', true);
  show('error', false);
  $('log').textContent = '';
  setProgress(0, '시작하는 중…');
  const name = $('name').value.trim() || 'character';
  const r = await api.genRun({
    image: state.image,
    name,
    model: state.genModel,
    steps: Number(state.genSteps),
    device: state.genDevice,
    realistic: $('gen-realistic').checked,
  });
  state.running = false;
  $('btn-gen').disabled = false;
  show('btn-gen-cancel', false);
  if (r.type !== 'done' || !r.out) {
    show('progress', false);
    return showError(`3D 모델을 만들지 못했습니다.\n${r.msg || ''}`);
  }
  // straight on to rigging (step 3) with the generated model
  state.model = r.out;
  state.flip = false;
  show('glb-options', true);
  $('autorig').checked = true;
  await convert();
};
$('btn-gen-cancel').onclick = () => api.cancel();

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
    autorig: $('autorig').checked,
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

// ------------------------------------------------------------------ 4. preview, tweak, apply
async function refreshCharacters(select) {
  const list = await api.listCharacters();
  const sel = $('char-select');
  sel.innerHTML = '';
  for (const c of list) {
    const o = document.createElement('option');
    o.value = c.path;
    o.textContent = c.name + (c.current ? ' (지금 춤추는 캐릭터)' : '');
    sel.appendChild(o);
  }
  const pick = select || list.find((c) => c.current)?.path || list[0]?.path;
  if (pick) sel.value = pick;
  return pick;
}

async function showCharacter(file, fromGlb = false, warnings = []) {
  state.result = file;
  show('preview-card', true);
  show('btn-flip', fromGlb);
  $('warnings').textContent = warnings.length ? `참고: ${warnings.join(' · ')}` : '';
  $('btn-apply').textContent = '저장하고 이 캐릭터로 바꾸기';
  $('btn-dance').textContent = '▶ 춤 미리보기';
  await window.charPreview.load(file);
}

async function finish(out, warnings, fromGlb) {
  await refreshCharacters(out);
  await showCharacter(out, fromGlb, warnings);
  $('preview-card').scrollIntoView({ behavior: 'smooth' });
}

$('char-select').addEventListener('change', () => showCharacter($('char-select').value));
$('btn-dance').onclick = async () => {
  const on = await window.charPreview.toggleDance();
  $('btn-dance').textContent = on ? '■ 춤 멈추기' : '▶ 춤 미리보기';
};
$('btn-flip').onclick = () => {
  state.flip = !state.flip;
  convert();
};
$('btn-reset').onclick = () => window.charPreview.resetCustom();
$('btn-apply').onclick = async () => {
  await window.charPreview.saveCustom();
  await api.apply(state.result);
  $('btn-apply').textContent = '저장하고 적용했어요 ✓';
  refreshCharacters(state.result);
};
for (const b of document.querySelectorAll('[data-link]')) b.onclick = () => api.openLink(b.dataset.link);

// Show the library right away so existing characters can be tweaked too.
const whenPreview = () => new Promise((r) => (window.charPreview ? r() : setTimeout(() => whenPreview().then(r), 50)));
refreshGen();
checkSetup().then(async () => {
  await whenPreview();
  const pick = await refreshCharacters();
  if (pick) showCharacter(pick);
});

