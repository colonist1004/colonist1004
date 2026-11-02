// Runs the Python dance pipeline (pipeline/extract_dance.py) for the "춤 만들기" window.
// Owns a private virtual environment in the user data folder so the user never touches pip.
const { spawn, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

let app = null;
let current = null; // running child process (one job at a time)

function init(electronApp) {
  app = electronApp;
}

// pipeline/ and shared/ ship as extraResources in the packaged app.
const resourcesRoot = () => (app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'));
const pipelineDir = () => path.join(resourcesRoot(), 'pipeline');
const envDir = () => path.join(app.getPath('userData'), 'pipeline-env');
const envPython = () =>
  process.env.DANCER_PYTHON ||
  (process.platform === 'win32' ? path.join(envDir(), 'Scripts', 'python.exe') : path.join(envDir(), 'bin', 'python'));
const stampFile = () => path.join(envDir(), 'desktop-dancer-ready.txt');
const cacheDir = () => path.join(app.getPath('userData'), 'pipeline-cache');
const toolsDir = () => path.join(app.getPath('userData'), 'tools');
const uvExe = () => path.join(toolsDir(), process.platform === 'win32' ? 'uv.exe' : 'uv');
const UV_ASSET = {
  win32: 'uv-x86_64-pc-windows-msvc.zip',
  linux: 'uv-x86_64-unknown-linux-gnu.tar.gz',
  darwin: process.arch === 'arm64' ? 'uv-aarch64-apple-darwin.tar.gz' : 'uv-x86_64-apple-darwin.tar.gz',
}[process.platform];

function requirementsHash() {
  const h = crypto.createHash('sha1');
  for (const f of ['requirements.txt', 'requirements-nodeps.txt']) {
    const p = path.join(pipelineDir(), f);
    if (fs.existsSync(p)) h.update(fs.readFileSync(p));
  }
  return h.digest('hex');
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, windowsHide: true, ...opts }, (err, stdout) =>
      resolve(err ? null : String(stdout).trim()),
    );
  });
}

/** Windows: a tray app started before Python was installed still has the old PATH.
 * Re-read the user and system PATH from the registry so a fresh install is found without a restart. */
async function refreshWindowsPath() {
  if (process.platform !== 'win32') return;
  const read = async (key) => {
    const out = await run('reg', ['query', key, '/v', 'Path']);
    const m = out && out.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
    return m ? m[1].trim().replace(/%([^%]+)%/g, (_, v) => process.env[v] || `%${v}%`) : '';
  };
  const user = await read('HKCU\\Environment');
  const sys = await read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment');
  const parts = [...`${user};${sys};${process.env.PATH || ''}`.split(';')].filter(Boolean);
  process.env.PATH = [...new Set(parts)].join(';');
}

/** Typical install folders, in case PATH was not set at all. */
function windowsPythonPaths() {
  const out = [];
  const roots = [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python'), process.env.ProgramFiles || 'C:\\Program Files'];
  for (const root of roots) {
    for (const v of ['312', '311', '310', '313']) out.push(path.join(root, `Python${v}`, 'python.exe'));
  }
  return out.filter((p) => fs.existsSync(p));
}

/** Finds an installed Python 3.9-3.13 (MediaPipe has wheels for these). Logs every attempt. */
async function findSystemPython(onLine = () => {}) {
  await refreshWindowsPath();
  const candidates =
    process.platform === 'win32'
      ? [['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3.10']], ['py', ['-3']], ['python', []], ['python3', []],
         ...windowsPythonPaths().map((p) => [p, []])]
      : [['python3.12', []], ['python3.11', []], ['python3', []], ['python', []]];
  const probe = 'import sys;print(sys.version_info[0],sys.version_info[1],sys.executable)';
  for (const [cmd, args] of candidates) {
    const out = await run(cmd, [...args, '-c', probe]);
    const label = [cmd, ...args].join(' ');
    if (!out) {
      onLine(`  - ${label}: 없음`);
      continue; // missing (or the Microsoft Store stub, which prints nothing useful)
    }
    const [major, minor, ...exe] = out.split(' ');
    const v = [Number(major), Number(minor)];
    if (v[0] === 3 && v[1] >= 9 && v[1] <= 13) {
      onLine(`  - ${label}: Python ${v[0]}.${v[1]} 사용`);
      return { cmd, args, version: `${v[0]}.${v[1]}`, executable: exe.join(' ') };
    }
    onLine(`  - ${label}: Python ${v[0]}.${v[1]} (지원 안 함: 3.9~3.13 필요)`);
  }
  return null;
}

async function status() {
  if (process.env.DANCER_PYTHON) return { ready: true, python: { version: 'DANCER_PYTHON' } };
  let ready = false;
  try {
    ready = fs.existsSync(envPython()) && fs.readFileSync(stampFile(), 'utf8') === requirementsHash();
  } catch {
    ready = false;
  }
  // No system Python is needed any more: setup downloads its own (uv). `python` stays for old UIs.
  return { ready, python: { version: '3.12' }, auto: true };
}

function stream(cmd, args, onLine, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
        DANCER_DATA_DIR: app.getPath('userData'), // pipeline cache + library = the app's folder
      },
      ...opts,
    });
    current = child;
    let tail = [];
    const handle = (buf) =>
      String(buf)
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((l) => {
          tail = [...tail.slice(-40), l];
          onLine(l);
        });
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (current === child) current = null;
      if (code === 0) resolve();
      else reject(Object.assign(new Error(signal ? '취소됨' : tail.slice(-8).join('\n') || `exit ${code}`), { cancelled: !!signal }));
    });
  });
}

/** Downloads uv (a single-file Python manager) into userData/tools. */
async function ensureUv(onLine) {
  if (fs.existsSync(uvExe())) return uvExe();
  const { net } = require('electron');
  fs.mkdirSync(toolsDir(), { recursive: true });
  const url = `https://github.com/astral-sh/uv/releases/latest/download/${UV_ASSET}`;
  onLine(`도구(uv) 내려받는 중… ${url}`);
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`uv 내려받기 실패: HTTP ${res.status}`);
  const archive = path.join(toolsDir(), UV_ASSET);
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  const out = path.join(toolsDir(), 'uv-extract');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out);
  // Windows 10+ ships tar.exe (bsdtar), which also reads zip files.
  try {
    await stream('tar', ['-xf', archive, '-C', out], onLine);
  } catch (e) {
    if (process.platform !== 'win32') throw e;
    await stream('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${out}' -Force`], onLine);
  }
  const found = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : found.push(path.join(d, e.name))));
  walk(out);
  const exe = found.find((f) => path.basename(f) === path.basename(uvExe()));
  if (!exe) throw new Error('uv 압축 파일에서 실행 파일을 찾지 못했습니다');
  fs.copyFileSync(exe, uvExe());
  if (process.platform !== 'win32') fs.chmodSync(uvExe(), 0o755);
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(archive, { force: true });
  return uvExe();
}

const uvEnv = () => ({
  UV_PYTHON_INSTALL_DIR: path.join(app.getPath('userData'), 'python'),
  UV_CACHE_DIR: path.join(app.getPath('userData'), 'uv-cache'),
  UV_NO_PROGRESS: '1',
});

/** Creates the private environment and installs requirements. onLine receives log lines.
 * Preferred: uv downloads its own Python 3.12 (nothing to install by hand).
 * Fallback: an installed Python 3.9-3.13 with venv + pip. */
async function setup(onLine) {
  const req = path.join(pipelineDir(), 'requirements.txt');
  const reqNoDeps = path.join(pipelineDir(), 'requirements-nodeps.txt');
  fs.rmSync(envDir(), { recursive: true, force: true });
  let uv = null;
  try {
    uv = await ensureUv(onLine);
  } catch (e) {
    onLine(`uv를 쓸 수 없습니다 (${e.message}). 설치된 Python을 찾아봅니다…`);
  }
  if (uv) {
    const env = { env: { ...process.env, ...uvEnv() } };
    onLine('Python 3.12 준비 중… (처음 한 번만 내려받습니다)');
    await stream(uv, ['venv', '--python', '3.12', '--python-preference', 'only-managed', envDir()], onLine, env);
    onLine('패키지 설치 중… (MediaPipe, OpenCV 등 수백 MB, 몇 분 걸릴 수 있습니다)');
    await stream(uv, ['pip', 'install', '--python', envPython(), '-r', req], onLine, env);
    await stream(uv, ['pip', 'install', '--python', envPython(), '--no-deps', '-r', reqNoDeps], onLine, env);
  } else {
    onLine('설치된 Python 찾는 중:');
    const py = await findSystemPython(onLine);
    if (!py) throw new Error('Python을 찾지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요.');
    onLine(`Python ${py.version} (${py.executable})`);
    await stream(py.cmd, [...py.args, '-m', 'venv', envDir()], onLine);
    await stream(envPython(), ['-m', 'pip', 'install', '-r', req], onLine);
    await stream(envPython(), ['-m', 'pip', 'install', '--no-deps', '-r', reqNoDeps], onLine);
  }
  // Smoke test: the packages really import.
  await stream(envPython(), ['-c', 'import numpy, cv2, mediapipe, yt_dlp, onnxruntime, rtmlib; print("imports ok", onnxruntime.get_available_providers())'], onLine);
  fs.writeFileSync(stampFile(), requirementsHash());
  onLine('설치 완료');
}

const safeName = (s) =>
  String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 80) || 'dance';

/** Builds CLI arguments from validated options (the renderer never passes raw arguments). */
function buildArgs(o, outDir) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (typeof o.input !== 'string' || !o.input) throw new Error('영상을 선택하세요');
  const args = [o.input, '--out', path.join(outDir, `${safeName(o.name)}.vrma`), '--name', safeName(o.name)];
  if (num(o.start) != null) args.push('--start', String(o.start));
  if (num(o.end) != null) args.push('--end', String(o.end));
  if (o.loop) args.push('--loop');
  if (o.mirror) args.push('--mirror');
  if (['planted', 'inplace', 'original'].includes(o.root)) args.push('--root', o.root);
  if (num(o.smooth) != null) args.push('--smooth', String(Math.min(3, Math.max(0, o.smooth))));
  if (['lite', 'full', 'heavy'].includes(o.model)) args.push('--model', o.model);
  if (Number.isInteger(o.person) && o.person >= 0) args.push('--person', String(o.person));
  if (o.engine === 'gvhmr') {
    if (typeof o.gvhmrResult !== 'string' || !o.gvhmrResult) throw new Error('GVHMR 결과 파일을 선택하세요');
    args.push('--engine', 'gvhmr', '--gvhmr-result', o.gvhmrResult);
  } else {
    args.push('--engine', o.engine === 'rtm' ? 'rtm' : 'mediapipe');
  }
  return args;
}

/** Runs a pipeline script (default extract_dance.py); onEvent gets parsed {type: progress|log|done|error} events. */
function runJob(argv, onEvent, scriptName = 'extract_dance.py') {
  if (current) throw new Error('이미 작업 중입니다');
  const script = path.join(pipelineDir(), scriptName);
  let finished = null;
  const flag = scriptName === 'check_image.py' ? '--json' : '--progress-json';
  const p = stream(envPython(), [script, ...argv, flag], (line) => {
    if (line.startsWith('@@')) {
      try {
        const ev = JSON.parse(line.slice(2));
        if (ev.type === 'done' || ev.type === 'error') finished = ev;
        onEvent(ev);
      } catch {
        onEvent({ type: 'log', msg: line });
      }
    } else {
      onEvent({ type: 'log', msg: line });
    }
  });
  return p.then(
    () => finished || { type: 'done' },
    (err) => {
      if (finished?.type === 'error') return finished;
      return { type: 'error', msg: err.cancelled ? '취소했습니다' : err.message, cancelled: !!err.cancelled };
    },
  );
}

function cancel() {
  if (current) current.kill();
}

/** make_character.py arguments from validated options. */
function buildCharArgs(o, outDir) {
  if (typeof o.input !== 'string' || !/\.(glb|vrm)$/i.test(o.input)) throw new Error('리깅된 .glb 파일을 선택하세요');
  const name = safeName(o.name);
  const args = [o.input, '--name', name, '--out', path.join(outDir, `${name}.vrm`)];
  const h = Number(o.height);
  if (Number.isFinite(h) && h > 0.3 && h < 3) args.push('--height', String(h));
  if (o.flip) args.push('--flip');
  if (o.autorig) args.push('--autorig');
  if (['toon', 'soft'].includes(o.shading)) args.push('--shading', o.shading);
  return args;
}

module.exports = { init, status, setup, runJob, buildArgs, buildCharArgs, cancel, cacheDir, pipelineDir, safeName };
