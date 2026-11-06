// "춤 만들기" window: pick a video, choose a range and options, run the pipeline.
const api = window.studio;
const $ = (id) => document.getElementById(id);

const state = {
  input: null, // file path or URL handed to the pipeline
  duration: 0,
  start: 0,
  end: 0,
  root: 'planted',
  model: 'rtm',
  bvh: false,
  photo: false,
  mode: 'dance', // 'dance' (video -> motion) or 'pose' (photo -> still pose)
  gvhmr: null,
  result: null,
  running: false,
  objectUrl: null,
};

// ------------------------------------------------------------------ helpers

function fmt(t) {
  if (!Number.isFinite(t)) return '0:00.0';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function parseTime(text) {
  const parts = String(text).trim().split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function show(el, on) {
  (typeof el === 'string' ? $(el) : el).hidden = !on;
}

function log(line) {
  const el = $('log');
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}

function segment(id, key) {
  const box = $(id);
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    for (const x of box.querySelectorAll('button')) x.classList.toggle('on', x === b);
    state[key] = b.dataset.v;
  });
}

// -------------------------------------------------------------------- setup

async function checkSetup() {
  const s = await api.status();
  if (s.ready) {
    show('setup', false);
    show('main', true);
    return;
  }
  show('setup', true);
  show('main', false);
  show('setup-nopython', !s.python);
  show('setup-ready', !!s.python);
  if (s.python) $('setup-python').textContent = `Python ${s.python.version}`;
}

$('btn-recheck').onclick = checkSetup;
$('btn-get-python').onclick = () => api.openPythonDownload();
$('btn-setup').onclick = async () => {
  $('btn-setup').disabled = true;
  $('btn-setup').textContent = '설치 중…';
  const logEl = $('setup-log');
  show(logEl, true);
  logEl.textContent = '';
  const off = api.onSetupLog((line) => {
    logEl.textContent += line + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  });
  const r = await api.setup();
  off();
  if (r.ok) {
    await setMode(new URLSearchParams(location.search).get('mode') || 'dance');
checkSetup();
  } else {
    logEl.textContent += `\n설치 실패: ${r.error}\n인터넷 연결을 확인하고 다시 시도하세요.`;
    $('btn-setup').disabled = false;
    $('btn-setup').textContent = '다시 시도';
  }
};

// --------------------------------------------------------------------- mode

const IMAGE_RE = /\.(jpe?g|png|webp|bmp)$/i;

function setMode(mode) {
  mode = mode === 'pose' ? 'pose' : 'dance';
  if (mode === state.mode && document.body.dataset.ready) return;
  document.body.dataset.ready = '1';
  state.mode = mode;
  document.body.classList.toggle('pose', mode === 'pose');
  for (const b of $('mode').querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === mode);
  $('title').textContent = mode === 'pose' ? '포즈 만들기' : '춤 만들기';
  document.title = `${mode === 'pose' ? '포즈' : '춤'} 만들기 — Desktop Dancer`;
  $('name').placeholder = mode === 'pose' ? '내 포즈' : '내 춤';
  $('btn-run').textContent = mode === 'pose' ? '포즈 만들기' : '춤 만들기';
  $('btn-apply').textContent = mode === 'pose' ? '지금 이 포즈 취하게 하기' : '지금 춤추게 하기';
  // what was picked for the other mode does not carry over
  if ((mode === 'pose') !== state.photo && state.input) clearInput();
  hideOutcome();
  updateRunButton();
}

function clearInput() {
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = null;
  state.input = null;
  state.photo = false;
  state.bvh = false;
  video.removeAttribute('src');
  $('photo').removeAttribute('src');
  show('video-box', false);
  show('photo-box', false);
  show('bvh-box', false);
  if ($('name').dataset.auto === '1') $('name').value = '';
}

$('mode').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setMode(b.dataset.v);
});
api.onMode?.(setMode);

function usePhoto(file, p) {
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(file);
  state.input = p;
  state.photo = true;
  state.bvh = false;
  video.removeAttribute('src');
  show('video-box', false);
  show('bvh-box', false);
  $('photo').src = state.objectUrl;
  show('photo-box', true);
  if (!$('name').value || $('name').dataset.auto === '1') {
    $('name').value = file.name.replace(/\.[^.]+$/, '');
    $('name').dataset.auto = '1';
  }
  hideOutcome();
  updateRunButton();
}

// -------------------------------------------------------------------- video

const video = $('video');

function loadVideo(src, input, name) {
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = src;
  state.input = input;
  state.bvh = false;
  state.photo = false;
  show('bvh-box', false);
  show('photo-box', false);
  video.src = src;
  show('video-box', true);
  if (!$('name').value || $('name').dataset.auto === '1') {
    $('name').value = name;
    $('name').dataset.auto = '1';
  }
  hideOutcome();
  updateRunButton();
}

function useFile(file) {
  if (!file) return;
  const p = api.pathForFile(file);
  if (!p) return showError('이 파일의 경로를 알 수 없습니다. 다른 방법으로 선택해 보세요.');
  if (IMAGE_RE.test(file.name) || /^image\//.test(file.type)) {
    if (!IMAGE_RE.test(file.name)) return showError('jpg, png, webp, bmp 사진을 써 주세요.');
    setMode('pose');
    return usePhoto(file, p);
  }
  setMode('dance');
  if (/\.(bvh|vmd)$/i.test(file.name)) {
    // Motion capture file from another tool: no video, no range, convert as is.
    video.removeAttribute('src');
    show('video-box', false);
    state.input = p;
    state.bvh = true;
    state.photo = false;
    show('photo-box', false);
    state.duration = 0;
    const mmd = /\.vmd$/i.test(file.name);
    $('bvh-text').textContent = `${mmd ? 'MMD 모션(VMD)' : 'BVH 모션'} 파일: ${file.name}`;
    $('bvh-note').textContent = mmd
      ? 'MikuMikuDance용 춤 모션입니다. 캐릭터 뼈대에 맞게 변환합니다 (다리 IK 포함). 모션 배포처의 이용 규약을 지켜 주세요.'
      : '다른 모션캡처 도구에서 만든 동작입니다. 영상 인식 없이 그대로 캐릭터용으로 변환합니다.';
    show('bvh-box', true);
    if (!$('name').value || $('name').dataset.auto === '1') {
      $('name').value = file.name.replace(/\.[^.]+$/, '');
      $('name').dataset.auto = '1';
    }
    hideOutcome();
    updateRunButton();
    return;
  }
  loadVideo(URL.createObjectURL(file), p, file.name.replace(/\.[^.]+$/, ''));
}

$('file').addEventListener('change', (e) => useFile(e.target.files[0]));
const drop = $('drop');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  useFile(e.dataTransfer.files[0]);
});
// Never let a dropped file navigate the window away.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('btn-url').onclick = async () => {
  const url = $('url').value.trim();
  if (!/^https?:\/\//.test(url)) return showError('http:// 또는 https:// 로 시작하는 주소를 넣어 주세요.');
  hideOutcome();
  $('btn-url').disabled = true;
  $('btn-url').textContent = '내려받는 중…';
  setProgress(0, '영상 내려받는 중');
  const r = await api.download(url);
  $('btn-url').disabled = false;
  $('btn-url').textContent = '불러오기';
  show('progress', false);
  if (r.type !== 'done') return showError(r.msg || '내려받기에 실패했습니다');
  const buf = await api.readVideo(r.video);
  loadVideo(URL.createObjectURL(new Blob([buf])), r.video, 'dance');
};

video.addEventListener('loadedmetadata', () => {
  state.duration = video.duration || 0;
  state.start = 0;
  state.end = state.duration;
  syncRange();
});
video.addEventListener('timeupdate', () => {
  syncHead();
  if (state.playRange && video.currentTime >= state.end) {
    video.currentTime = state.start;
  }
});
video.addEventListener('pause', () => (state.playRange = false));

function syncRange() {
  $('start').value = fmt(state.start);
  $('end').value = fmt(state.end);
  const d = state.duration || 1;
  const sel = $('range-sel');
  sel.style.left = `${(state.start / d) * 100}%`;
  sel.style.width = `${(Math.max(0, state.end - state.start) / d) * 100}%`;
  const len = state.end - state.start;
  $('range-info').textContent =
    len > 0
      ? `선택 구간 ${len.toFixed(1)}초${len > 60 ? ' · 길면 처리 시간이 오래 걸립니다 (1분 영상에 약 2~3분)' : ''}`
      : '끝이 시작보다 뒤여야 합니다';
  syncHead();
  updateRunButton();
}

function syncHead() {
  $('range-head').style.left = `${(video.currentTime / (state.duration || 1)) * 100}%`;
}

$('btn-set-start').onclick = () => {
  state.start = Math.min(video.currentTime, state.end);
  syncRange();
};
$('btn-set-end').onclick = () => {
  state.end = Math.max(video.currentTime, state.start);
  syncRange();
};
for (const id of ['start', 'end']) {
  $(id).addEventListener('change', () => {
    const t = parseTime($(id).value);
    if (t != null) state[id] = Math.min(Math.max(0, t), state.duration);
    if (state.start > state.end) [state.start, state.end] = [state.end, state.start];
    syncRange();
  });
}
$('range-bar').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  video.currentTime = ((e.clientX - r.left) / r.width) * state.duration;
});
$('btn-play-range').onclick = () => {
  video.currentTime = state.start;
  state.playRange = true;
  video.play();
};

// ------------------------------------------------------------------ options

segment('root', 'root');
segment('model', 'model');
// 0..2: plain smoothing; above 2 the slow parts are smoothed harder while fast moves are kept
function smoothLabel(v) {
  v = Number(v);
  if (v === 0) return '끔';
  if (v <= 0.5) return '약하게';
  if (v < 1) return '조금 약하게';
  if (v === 1) return '보통';
  if (v <= 1.5) return '조금 강하게';
  if (v <= 2) return '강하게';
  if (v <= 3) return '매우 부드럽게 (빠른 동작은 살림)';
  if (v < 4) return '아주 매우 부드럽게';
  return '최대';
}
$('smooth').addEventListener('input', () => ($('smooth-label').textContent = smoothLabel($('smooth').value)));
$('name').addEventListener('input', () => ($('name').dataset.auto = '0'));

$('btn-gvhmr').onclick = async () => {
  const p = await api.pickGvhmr();
  if (!p) return;
  state.gvhmr = p;
  $('gvhmr-file').textContent = p.split(/[\\/]/).pop();
  show('btn-gvhmr-clear', true);
  show('orig-row', true);
  updateRunButton();
};
$('btn-gvhmr-clear').onclick = () => {
  state.gvhmr = null;
  $('gvhmr-file').textContent = '선택 안 함 (내 PC에서 인식)';
  show('btn-gvhmr-clear', false);
  show('orig-row', false);
  updateRunButton();
};

// ---------------------------------------------------------------------- run

function updateRunButton() {
  if (state.mode === 'pose') {
    $('btn-run').disabled = state.running || !(state.input && state.photo);
    return;
  }
  const hasVideo = !!state.input && (state.bvh || state.end > state.start);
  $('btn-run').disabled = state.running || !(hasVideo || state.gvhmr);
}

function setProgress(frac, text) {
  show('progress', true);
  $('bar-fill').style.width = `${Math.round(frac * 100)}%`;
  if (text) $('progress-text').textContent = text;
}

function hideOutcome() {
  show('result', false);
  show('error', false);
}

function showError(msg) {
  $('error').textContent = msg;
  show('error', true);
}

api.onJob((ev) => {
  if (ev.type === 'progress') setProgress(ev.frac, ev.msg ? `${ev.msg}…` : null);
  if (ev.type === 'log') log(ev.msg);
});

$('btn-run').onclick = async () => {
  hideOutcome();
  $('log').textContent = '';
  state.running = true;
  updateRunButton();
  show('btn-cancel', true);
  setProgress(0, '시작하는 중…');
  const pose = state.mode === 'pose';
  const opts = {
    input: state.input || 'gvhmr-only',
    name: $('name').value.trim() || (pose ? 'pose' : 'dance'),
    loop: $('loop').checked,
    mirror: $('mirror').checked,
    root: state.gvhmr && $('root-original').checked ? 'original' : state.root,
    smooth: Number($('smooth').value),
    model: state.model,
    person: $('person').value === '' ? null : Number($('person').value),
    engine: !pose && state.gvhmr ? 'gvhmr' : state.model === 'rtm' ? 'rtm' : 'mediapipe',
    gvhmrResult: pose ? null : state.gvhmr,
  };
  if (pose) {
    opts.loop = false;
  } else if (state.input && state.duration) {
    if (state.start > 0.05) opts.start = Number(state.start.toFixed(2));
    if (state.end < state.duration - 0.05) opts.end = Number(state.end.toFixed(2));
  }
  const r = await api.run(opts);
  state.running = false;
  show('btn-cancel', false);
  updateRunButton();
  if (r.type === 'done') {
    setProgress(1, '완료');
    state.result = r.out;
    const detected = r.detected != null ? ` · 사람 인식 ${Math.round(r.detected * 100)}%` : '';
    $('result-text').textContent = pose
      ? `완성! 포즈 “${opts.name}” · 트레이 메뉴 → 포즈 에도 들어갔어요`
      : `완성! “${opts.name}” (${r.duration?.toFixed(1)}초${detected})`;
    show('result', true);
  } else {
    show('progress', false);
    showError(r.cancelled ? '취소했습니다.' : `만들지 못했습니다.\n${r.msg || ''}`);
  }
};

$('btn-cancel').onclick = () => api.cancel();
for (const b of document.querySelectorAll('[data-link]')) b.onclick = () => api.openLink(b.dataset.link);
$('btn-apply').onclick = async () => {
  await api.apply(state.result);
  $('btn-apply').textContent = '적용했어요 ✓';
  setTimeout(() => ($('btn-apply').textContent = state.mode === 'pose' ? '지금 이 포즈 취하게 하기' : '지금 춤추게 하기'), 2000);
};
$('btn-folder').onclick = () => api.openFolder();

setMode(new URLSearchParams(location.search).get('mode') || 'dance');
checkSetup();
