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

function requirementsHash() {
  const req = fs.readFileSync(path.join(pipelineDir(), 'requirements.txt'));
  return crypto.createHash('sha1').update(req).digest('hex');
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, windowsHide: true, ...opts }, (err, stdout) =>
      resolve(err ? null : String(stdout).trim()),
    );
  });
}

/** Finds an installed Python 3.9-3.13 (MediaPipe has wheels for these). */
async function findSystemPython() {
  const candidates =
    process.platform === 'win32'
      ? [['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3.10']], ['py', ['-3']], ['python', []], ['python3', []]]
      : [['python3.12', []], ['python3.11', []], ['python3', []], ['python', []]];
  const probe = 'import sys;print(sys.version_info[0],sys.version_info[1],sys.executable)';
  for (const [cmd, args] of candidates) {
    const out = await run(cmd, [...args, '-c', probe]);
    if (!out) continue; // missing (or the Microsoft Store stub, which prints nothing useful)
    const [major, minor, ...exe] = out.split(' ');
    const v = [Number(major), Number(minor)];
    if (v[0] === 3 && v[1] >= 9 && v[1] <= 13) return { cmd, args, version: `${v[0]}.${v[1]}`, executable: exe.join(' ') };
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
  return { ready, python: ready ? { version: 'env' } : await findSystemPython() };
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

/** Creates the private venv and installs requirements. onLine receives log lines. */
async function setup(onLine) {
  const py = await findSystemPython();
  if (!py) throw new Error('Python을 찾지 못했습니다');
  onLine(`Python ${py.version} (${py.executable})`);
  if (!fs.existsSync(envPython())) {
    onLine('가상 환경 만드는 중…');
    await stream(py.cmd, [...py.args, '-m', 'venv', envDir()], onLine);
  }
  onLine('패키지 설치 중… (MediaPipe, OpenCV 등 수백 MB, 몇 분 걸릴 수 있습니다)');
  await stream(envPython(), ['-m', 'pip', 'install', '-r', path.join(pipelineDir(), 'requirements.txt')], onLine);
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
  }
  return args;
}

/** Runs extract_dance.py; onEvent gets parsed {type: progress|log|done|error} events. */
function runJob(argv, onEvent) {
  if (current) throw new Error('이미 작업 중입니다');
  const script = path.join(pipelineDir(), 'extract_dance.py');
  let finished = null;
  const p = stream(envPython(), [script, ...argv, '--progress-json'], (line) => {
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

module.exports = { init, status, setup, runJob, buildArgs, cancel, cacheDir, pipelineDir };
