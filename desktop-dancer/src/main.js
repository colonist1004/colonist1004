// Desktop Dancer — Electron main process.
// Transparent, frameless, always-on-top window that sits on top of the Windows taskbar
// and renders a VRM character playing a VRMA dance.
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, dialog, shell, net, session, desktopCapturer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const settings = require('./settings');
const placement = require('./placement');
const runner = require('./pipeline-runner');

// Keep one data folder name in dev and packaged builds (the packaged app would otherwise use the
// productName "Desktop Dancer"). The Python pipeline writes motions into this same folder.
if (!process.env.DANCER_USER_DATA) app.setPath('userData', path.join(app.getPath('appData'), 'desktop-dancer'));

const SAMPLE_VRM_URL =
  'https://raw.githubusercontent.com/vrm-c/vrm-specification/master/samples/Seed-san/vrm/Seed-san.vrm';

let win = null;
let tray = null;
let studio = null;
let charStudio = null;

// ----------------------------------------------------------------- library

const bundledAssets = () =>
  app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(__dirname, '..', 'assets');
const userLibrary = () => path.join(app.getPath('userData'), 'library');

function libraryDirs(kind) {
  return [path.join(bundledAssets(), kind), path.join(userLibrary(), kind)];
}

function listLibrary(kind, ext) {
  const out = [];
  for (const dir of libraryDirs(kind)) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      if (f.toLowerCase().endsWith(ext)) out.push(path.join(dir, f));
    }
  }
  return out;
}

function ensureUserLibrary() {
  for (const kind of ['characters', 'motions']) fs.mkdirSync(path.join(userLibrary(), kind), { recursive: true });
}

// New files from the pipeline (or copied by hand) appear in the tray menu without a restart.
function watchLibrary() {
  let timer = null;
  for (const kind of ['characters', 'motions']) {
    try {
      fs.watch(path.join(userLibrary(), kind), () => {
        clearTimeout(timer);
        timer = setTimeout(rebuildTrayMenu, 500);
      });
    } catch (e) {
      console.error('library watch failed', e);
    }
  }
}

function resolveAsset(kind, ext, wanted) {
  const all = listLibrary(kind, ext);
  if (wanted && all.includes(wanted)) return wanted; // only files still in the library
  return all[0] || null;
}

// ------------------------------------------------------------------ window

function targetDisplay() {
  const s = settings.get();
  return screen.getAllDisplays().find((d) => d.id === s.displayId) || screen.getPrimaryDisplay();
}

function computeBounds() {
  return placement.computeBounds(targetDisplay(), settings.get());
}

function frameInfo(b) {
  return { nominalWidth: b.nominalWidth, nominalHeight: b.nominalHeight, cropLeft: b.cropLeft, cropTop: b.cropTop };
}

function placeWindow() {
  if (!win) return;
  const b = computeBounds();
  win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
  // The renderer draws the slice of the character's frame that this window shows.
  win.webContents.send('frame', frameInfo(b));
  placeWin?.webContents.send('place:changed', placementState());
}

function placementState() {
  const s = settings.get();
  const d = targetDisplay();
  const scale = placement.clampScale(s.scale);
  const b = computeBounds();
  const xr = placement.xRange(d, scale);
  return {
    scale,
    xCenterPx: Math.round(Math.min(xr.max, Math.max(xr.min, placement.centerPx(d, { ...s, scale })))),
    xRange: xr,
    yOffset: Math.round(Math.min(placement.yOffsetRange(d, scale).max, Math.max(placement.yOffsetRange(d, scale).min, s.yOffset || 0))),
    yRange: placement.yOffsetRange(d, scale),
    frameHeight: b.nominalHeight,
    workWidth: d.workArea.width,
    minScale: placement.MIN_SCALE,
    maxScale: placement.MAX_SCALE,
    cropped: b.cropped,
  };
}

/** Partial update from the placement window / mouse wheel / tray, validated. */
function updatePlacement(patch) {
  const d = targetDisplay();
  const cur = settings.get();
  const next = {};
  // keep the current center when only the size changes (also converts the old xFraction setting)
  const centerNow = placement.centerPx(d, { ...cur, scale: placement.clampScale(cur.scale) });
  next.scale = Number.isFinite(patch.scale) ? placement.clampScale(patch.scale) : placement.clampScale(cur.scale);
  const cx = Number.isFinite(patch.xCenterPx) ? patch.xCenterPx : centerNow;
  next.xCenter = placement.xCenterFor(d, d.workArea.x + cx, next.scale);
  const yr = placement.yOffsetRange(d, next.scale);
  const y = Number.isFinite(patch.yOffset) ? patch.yOffset : cur.yOffset || 0;
  next.yOffset = Math.round(Math.min(yr.max, Math.max(yr.min, y)));
  settings.update(next);
  placeWindow();
  rebuildTrayMenu();
  return placementState();
}

function resetPlacement() {
  const d = targetDisplay();
  settings.update({ displayId: null });
  return updatePlacement({ scale: 1, xCenterPx: d.workArea.width - placement.BASE_WIDTH / 2, yOffset: 0 });
}

function createWindow() {
  win = new BrowserWindow({
    ...computeBounds(),
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  // 'screen-saver' level keeps it above normal always-on-top windows on Windows.
  win.setAlwaysOnTop(true, 'screen-saver');
  // Click-through by default; the renderer turns it off while the cursor is over the character.
  win.setIgnoreMouseEvents(true, { forward: true });
  if (process.env.DANCER_SELFTEST) {
    win.webContents.on('console-message', (_e, level, message) => console.log(`[renderer:${level}] ${message}`));
  }
  // DANCER_FREEZE_T=1.5 freezes the motion at that time (dev: inspect poses).
  // DANCER_RECORD=dir DANCER_RECORD_FRAMES=240 renders frames at 30 fps into dir, then quits (dev: test videos).
  const query = {};
  if (process.env.DANCER_FREEZE_T) query.t = process.env.DANCER_FREEZE_T;
  if (process.env.DANCER_RECORD) query.record = process.env.DANCER_RECORD_FRAMES || '240';
  // DANCER_FAKE_MUSIC=128: a generated drum loop instead of the PC's sound (dev/tests; never audible)
  if (process.env.DANCER_FAKE_MUSIC) query.fakeMusic = process.env.DANCER_FAKE_MUSIC;
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: Object.keys(query).length ? query : undefined });
  win.once('ready-to-show', () => {
    if (settings.get().visible) win.showInactive();
  });
  win.webContents.on('did-finish-load', placeWindow); // sends the frame info
  win.on('closed', () => (win = null));
  startCursorFeed();
}

// The character looks at the mouse: the cursor position relative to the window, 20 times a second
// (only while it moves, only while the character is shown and looking is on).
let cursorTimer = null;
function startCursorFeed() {
  clearInterval(cursorTimer);
  let last = null;
  cursorTimer = setInterval(() => {
    const s = settings.get();
    if (!win || win.isDestroyed() || !s.visible || s.lookAt === false) return;
    const p = screen.getCursorScreenPoint();
    if (last && last.x === p.x && last.y === p.y) return;
    last = p;
    const b = win.getBounds();
    win.webContents.send('cursor', { x: p.x - b.x, y: p.y - b.y });
  }, 50);
}

// "음악에 맞춰 춤추기": the dancer window asks for the screen with system-audio loopback
// (Windows); only the sound is used and it never leaves the renderer.
function allowSystemAudio() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const fromDancer = win && !win.isDestroyed() && request.frame?.processId === win.webContents.mainFrame.processId;
    if (!fromDancer || !settings.get().music) return callback({});
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => callback(sources.length ? { video: sources[0], audio: 'loopback' } : {}))
      .catch(() => callback({}));
  });
}

function setVisible(v) {
  settings.update({ visible: v });
  if (!win) return;
  if (v) win.showInactive();
  else win.hide();
  rebuildTrayMenu();
}

// -------------------------------------------------------------------- tray

function trayIcon() {
  // 16x16 BGRA bitmap drawn in code: a small dancing figure on a pink dot.
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const fig = [
    '................',
    '......####......',
    '.....######.....',
    '.....######.....',
    '......####......',
    '..#....##....#..',
    '...#.######.#...',
    '....########....',
    '.......##.......',
    '.......##.......',
    '......####......',
    '.....##..##.....',
    '....##....##....',
    '...##......##...',
    '..##........##..',
    '................',
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const on = fig[y][x] === '#';
      buf[i] = on ? 0xff : 0x00; // B
      buf[i + 1] = on ? 0x6b : 0x00; // G
      buf[i + 2] = on ? 0xd6 : 0x00; // R
      buf[i + 3] = on ? 0xff : 0x00; // A
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

// Still poses (made from a photo) are motions too, named <name>.pose.vrma.
const isPose = (file) => /\.pose\.vrma$/i.test(file);

function libraryMenu(kind, ext, current, key, filter = () => true) {
  const items = listLibrary(kind, ext).filter(filter).map((file) => ({
    label: path.basename(file, path.extname(file)).replace(/\.pose$/i, ''),
    type: 'radio',
    checked: file === current,
    click: () => {
      settings.update({ [key]: file });
      sendLoad();
      rebuildTrayMenu();
    },
  }));
  if (!items.length) items.push({ label: '(비어 있음)', enabled: false });
  return items;
}

async function importFile(kind, ext, key, title) {
  const r = await dialog.showOpenDialog({
    title,
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: ext.slice(1).toUpperCase(), extensions: [ext.slice(1)] }],
  });
  if (r.canceled || !r.filePaths.length) return;
  ensureUserLibrary();
  let last = null;
  for (const src of r.filePaths) {
    last = path.join(userLibrary(), kind, path.basename(src));
    fs.copyFileSync(src, last);
  }
  settings.update({ [key]: last });
  sendLoad();
  rebuildTrayMenu();
}

async function downloadSampleVrm() {
  const ok = await dialog.showMessageBox({
    type: 'info',
    buttons: ['내려받기', '취소'],
    defaultId: 0,
    title: '샘플 캐릭터 내려받기',
    message: 'VRM 컨소시엄의 샘플 캐릭터 "Seed-san"(약 11MB)을 내려받습니다.',
    detail:
      '라이선스: VRM Public License 1.0 (Seed-san model by VirtualCast, Inc.)\n' +
      '개인 사용 외 용도라면 https://vrm.dev/licenses/1.0/ 의 조건을 확인하세요.',
  });
  if (ok.response !== 0) return;
  try {
    const res = await net.fetch(SAMPLE_VRM_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    ensureUserLibrary();
    const dest = path.join(userLibrary(), 'characters', 'Seed-san.vrm');
    fs.writeFileSync(dest, buf);
    settings.update({ character: dest });
    sendLoad();
    rebuildTrayMenu();
  } catch (e) {
    dialog.showErrorBox('내려받기 실패', String(e.message || e));
  }
}

function rebuildTrayMenu() {
  if (!tray) return;
  const s = settings.get();
  const character = resolveAsset('characters', '.vrm', s.character);
  const motion = resolveAsset('motions', '.vrma', s.motion);
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  const menu = Menu.buildFromTemplate([
    { label: s.visible ? '숨기기' : '보이기', click: () => setVisible(!s.visible) },
    { label: '춤 만들기 (영상에서)…', click: () => openStudio('dance') },
    { label: '포즈 만들기 (사진에서)…', click: () => openStudio('pose') },
    { label: '캐릭터 만들기 (그림에서)…', click: openCharStudio },
    { type: 'separator' },
    {
      label: '캐릭터',
      submenu: [
        ...libraryMenu('characters', '.vrm', character, 'character'),
        { type: 'separator' },
        { label: 'VRM 파일 추가…', click: () => importFile('characters', '.vrm', 'character', 'VRM 캐릭터 추가') },
        { label: '샘플 캐릭터 내려받기 (Seed-san)…', click: downloadSampleVrm },
      ],
    },
    {
      label: '춤',
      submenu: [
        ...libraryMenu('motions', '.vrma', motion, 'motion', (f) => !isPose(f)),
        { type: 'separator' },
        { label: 'VRMA 파일 추가…', click: () => importFile('motions', '.vrma', 'motion', 'VRMA 모션 추가') },
      ],
    },
    {
      label: '포즈',
      submenu: [
        ...libraryMenu('motions', '.vrma', motion, 'motion', isPose),
        { type: 'separator' },
        { label: '사진으로 포즈 만들기…', click: () => openStudio('pose') },
      ],
    },
    {
      label: `크기 (${Math.round(placement.clampScale(s.scale) * 100)}%)`,
      submenu: [
        ...[0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16].map((v) => ({
          label: `${Math.round(v * 100)}%`,
          type: 'radio',
          checked: Math.abs(s.scale - v) < 1e-3,
          click: () => updatePlacement({ scale: v }),
        })),
        { type: 'separator' },
        { label: '위치·크기 자세히 조정…', click: openPlaceWindow },
      ],
    },
    { label: '위치·크기 자세히 조정…', click: openPlaceWindow },
    {
      label: '모니터',
      enabled: displays.length > 1,
      submenu: displays.map((d, i) => ({
        label: `${i + 1}: ${d.size.width}×${d.size.height}${d.id === primaryId ? ' (주 모니터)' : ''}`,
        type: 'radio',
        checked: d.id === targetDisplay().id,
        click: () => {
          settings.update({ displayId: d.id });
          placeWindow();
          rebuildTrayMenu();
        },
      })),
    },
    {
      label: '속도',
      submenu: [0.5, 0.75, 1, 1.25, 1.5].map((v) => ({
        label: `${v}x`,
        type: 'radio',
        checked: Math.abs(s.speed - v) < 1e-3,
        click: () => {
          settings.update({ speed: v });
          win?.webContents.send('settings', settings.get());
          rebuildTrayMenu();
        },
      })),
    },
    {
      label: 'FPS 제한',
      submenu: [24, 30, 60].map((v) => ({
        label: `${v}`,
        type: 'radio',
        checked: s.fps === v,
        click: () => {
          settings.update({ fps: v });
          win?.webContents.send('settings', settings.get());
          rebuildTrayMenu();
        },
      })),
    },
    {
      label: '반응',
      submenu: [
        { label: '마우스 쳐다보기', key: 'lookAt' },
        { label: '클릭·쓰다듬기·들어 올리기 반응', key: 'reactions' },
        { label: '음악에 맞춰 춤추기 (PC 소리 듣기)', key: 'music' },
      ].map(({ label, key }) => ({
        label,
        type: 'checkbox',
        checked: key === 'music' ? !!s[key] : s[key] !== false,
        click: (item) => {
          settings.update({ [key]: item.checked });
          win?.webContents.send('settings', settings.get());
          rebuildTrayMenu();
        },
      })),
    },
    { type: 'separator' },
    {
      label: 'Windows 시작 시 자동 실행',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      enabled: app.isPackaged,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    {
      label: '위치 초기화',
      click: () => {
        resetPlacement();
        rebuildTrayMenu();
      },
    },
    {
      label: '라이브러리 폴더 열기',
      click: () => {
        ensureUserLibrary();
        shell.openPath(userLibrary());
      },
    },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

// --------------------------------------------------------------------- IPC

function sendLoad() {
  if (!win) return;
  const s = settings.get();
  win.webContents.send('load', {
    character: resolveAsset('characters', '.vrm', s.character),
    motion: resolveAsset('motions', '.vrma', s.motion),
  });
}

function isLibraryFile(file) {
  const resolved = path.resolve(file);
  return ['characters', 'motions']
    .flatMap(libraryDirs)
    .some((dir) => resolved.startsWith(path.resolve(dir) + path.sep));
}

ipcMain.handle('read-asset', (_e, file) => {
  // Only files inside the library folders may be read by the renderer.
  if (typeof file !== 'string' || !isLibraryFile(file)) throw new Error('not a library file');
  const buf = fs.readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

// ------------------------------------------------- character tweaks (sliders)

/** Tweaks live in the user library (bundled characters are read-only in the packaged app). */
function customPath(vrmFile) {
  return path.join(userLibrary(), 'characters', `${path.basename(vrmFile, path.extname(vrmFile))}.custom.json`);
}

function readCustom(vrmFile) {
  try {
    return JSON.parse(fs.readFileSync(customPath(vrmFile), 'utf8'));
  } catch {
    return null;
  }
}

ipcMain.handle('custom:get', (_e, file) => (typeof file === 'string' && isLibraryFile(file) ? readCustom(file) : null));

ipcMain.handle('custom:set', (_e, file, custom) => {
  if (typeof file !== 'string' || !isLibraryFile(file) || typeof custom !== 'object' || custom === null) return false;
  const num = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 1);
  const clean = {
    height: num(custom.height, 0.5, 2), head: num(custom.head, 0.5, 2), arms: num(custom.arms, 0.5, 2),
    legs: num(custom.legs, 0.5, 2), shoulders: num(custom.shoulders, 0.5, 2), brightness: num(custom.brightness, 0.2, 3),
    colors: Object.fromEntries(Object.entries(custom.colors || {})
      .filter(([k, v]) => typeof k === 'string' && k.length < 200 && /^#[0-9a-f]{6}$/i.test(v)).slice(0, 64)),
  };
  ensureUserLibrary();
  fs.writeFileSync(customPath(file), JSON.stringify(clean, null, 2));
  win?.webContents.send('custom-updated', { character: file, custom: clean });
  return true;
});

ipcMain.handle('get-initial', () => {
  const s = settings.get();
  return {
    settings: s,
    character: resolveAsset('characters', '.vrm', s.character),
    motion: resolveAsset('motions', '.vrma', s.motion),
  };
});

ipcMain.on('set-hover', (_e, hovering) => {
  win?.setIgnoreMouseEvents(!hovering, { forward: true });
});

// Drag the character anywhere: x along the work area, y as a height above the taskbar
// (snaps back onto the taskbar when released close to it). Coordinates are DIP.
let dragStart = null;
ipcMain.on('drag', (_e, phase, screenX, screenY) => {
  if (!win) return;
  const d = targetDisplay();
  if (phase === 'start') {
    dragStart = { mouseX: screenX, mouseY: screenY, ...placement.frameAnchor(d, settings.get()) };
  } else if (phase === 'move' && dragStart) {
    const scale = placement.clampScale(settings.get().scale);
    settings.update({
      xCenter: placement.xCenterFor(d, dragStart.centerX + (screenX - dragStart.mouseX), scale),
      yOffset: placement.yOffsetFor(d, dragStart.bottom + (screenY - dragStart.mouseY), scale),
    });
    const b = computeBounds();
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    win.webContents.send('frame', frameInfo(b));
  } else if (phase === 'end' && dragStart) {
    dragStart = null;
    placeWin?.webContents.send('place:changed', placementState());
  }
});

// Ctrl + mouse wheel over the character: resize by steps.
ipcMain.on('resize-by', (_e, factor) => {
  if (Number.isFinite(factor) && factor > 0.5 && factor < 2) updatePlacement({ scale: settings.get().scale * factor });
});

// ---------------------------------------------------- 위치·크기 window

let placeWin = null;
function openPlaceWindow() {
  if (placeWin) {
    placeWin.show();
    placeWin.focus();
    return;
  }
  placeWin = new BrowserWindow({
    width: 460,
    height: 560,
    resizable: true,
    minimizable: false,
    maximizable: false,
    title: '위치·크기 — Desktop Dancer',
    autoHideMenuBar: true,
    backgroundColor: '#f4f5f8',
    webPreferences: {
      preload: path.join(__dirname, 'placewin-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  placeWin.loadFile(path.join(__dirname, 'placewin', 'index.html'));
  placeWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  placeWin.webContents.on('will-navigate', (e) => e.preventDefault());
  placeWin.on('closed', () => (placeWin = null));
}

ipcMain.handle('place:get', () => placementState());
ipcMain.handle('place:set', (_e, patch) => updatePlacement(patch && typeof patch === 'object' ? patch : {}));
ipcMain.handle('place:reset', () => resetPlacement());

ipcMain.on('renderer-error', (_e, msg) => {
  console.error('[renderer]', msg);
});


// ------------------------------------------------------------ 춤 만들기 window

function openStudio(mode = 'dance') {
  if (typeof mode !== 'string') mode = 'dance';
  if (studio) {
    studio.show();
    studio.focus();
    studio.webContents.send('studio:mode', mode);
    return;
  }
  studio = new BrowserWindow({
    width: 760,
    height: 900,
    minWidth: 560,
    minHeight: 500,
    title: '춤·포즈 만들기 — Desktop Dancer',
    autoHideMenuBar: true,
    backgroundColor: '#f4f5f8',
    webPreferences: {
      preload: path.join(__dirname, 'studio-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  studio.loadFile(path.join(__dirname, 'studio', 'index.html'), { query: { mode } });
  // Links never open inside the app.
  studio.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  studio.webContents.on('will-navigate', (e) => e.preventDefault());
  if (process.env.DANCER_SELFTEST) {
    studio.webContents.on('console-message', (_e, level, message) => console.log(`[studio:${level}] ${message}`));
  }
  studio.on('closed', () => {
    runner.cancel();
    studio = null;
  });
}

const sendStudio = (channel, v) => studio && !studio.isDestroyed() && studio.webContents.send(channel, v);

ipcMain.handle('studio:status', () => runner.status());

ipcMain.handle('studio:setup', async () => {
  try {
    await runner.setup((line) => sendStudio('studio:setup-log', line));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('studio:open-python', () => shell.openExternal('https://www.python.org/downloads/windows/'));

// Only these pages can be opened from the windows (the renderer cannot open arbitrary URLs).
const LINKS = new Set([
  'https://www.rokoko.com/products/vision',
  'https://plask.ai',
  'https://www.deepmotion.com/animate-3d',
  'https://www.quickmagic.ai',
  'https://vroid.com/en/studio',
  'https://www.tripo3d.ai',
  'https://www.meshy.ai',
]);
ipcMain.handle('studio:open-link', (_e, url) => (LINKS.has(url) ? shell.openExternal(url) : false));

ipcMain.handle('studio:download', (_e, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return { type: 'error', msg: '주소가 올바르지 않습니다' };
  try {
    return runner.runJob([url, '--download-only'], (ev) => sendStudio('studio:job', ev));
  } catch (e) {
    return { type: 'error', msg: e.message };
  }
});

ipcMain.handle('studio:read-video', (_e, file) => {
  // Only downloads made by the pipeline (its cache folder) can be read back for preview.
  const resolved = path.resolve(String(file));
  if (!resolved.startsWith(path.resolve(runner.cacheDir()) + path.sep)) throw new Error('not a pipeline download');
  const buf = fs.readFileSync(resolved);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

ipcMain.handle('studio:pick-gvhmr', async () => {
  const r = await dialog.showOpenDialog(studio, {
    title: 'GVHMR 결과 파일',
    properties: ['openFile'],
    filters: [{ name: 'GVHMR 결과', extensions: ['npz', 'pt'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('studio:run', (_e, opts) => {
  try {
    ensureUserLibrary();
    const args = runner.buildArgs(opts || {}, path.join(userLibrary(), 'motions'));
    return runner.runJob(args, (ev) => sendStudio('studio:job', ev));
  } catch (e) {
    return { type: 'error', msg: e.message };
  }
});

ipcMain.handle('studio:cancel', () => runner.cancel());

ipcMain.handle('studio:apply', (_e, file) => {
  if (typeof file !== 'string' || !isLibraryFile(file)) return false;
  settings.update({ motion: file });
  sendLoad();
  rebuildTrayMenu();
  if (!settings.get().visible) setVisible(true);
  return true;
});

ipcMain.handle('studio:open-folder', () => {
  ensureUserLibrary();
  shell.openPath(path.join(userLibrary(), 'motions'));
});


// -------------------------------------------------------- 캐릭터 만들기 window

function openCharStudio() {
  if (charStudio) {
    charStudio.show();
    charStudio.focus();
    return;
  }
  charStudio = new BrowserWindow({
    width: 780,
    height: 940,
    minWidth: 560,
    minHeight: 500,
    title: '캐릭터 만들기 — Desktop Dancer',
    autoHideMenuBar: true,
    backgroundColor: '#f4f5f8',
    webPreferences: {
      preload: path.join(__dirname, 'charstudio-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  charStudio.loadFile(path.join(__dirname, 'charstudio', 'index.html'));
  charStudio.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  charStudio.webContents.on('will-navigate', (e) => e.preventDefault());
  if (process.env.DANCER_SELFTEST) {
    charStudio.webContents.on('console-message', (_e, level, message) => console.log(`[char:${level}] ${message}`));
  }
  charStudio.on('closed', () => {
    runner.cancel();
    charStudio = null;
  });
}

const reply = (e, channel) => (v) => !e.sender.isDestroyed() && e.sender.send(channel, v);

ipcMain.handle('char:setup', async (e) => {
  try {
    await runner.setup(reply(e, 'char:setup-log'));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('char:check-image', async (e, file) => {
  if (typeof file !== 'string' || !/\.(png|jpe?g|webp)$/i.test(file)) return { type: 'error', msg: '그림 파일(png/jpg/webp)이 아닙니다' };
  try {
    return await runner.runJob([file], reply(e, 'char:job'), 'check_image.py');
  } catch (err) {
    return { type: 'error', msg: err.message };
  }
});

ipcMain.handle('char:convert', async (e, opts) => {
  try {
    ensureUserLibrary();
    const args = runner.buildCharArgs(opts || {}, path.join(userLibrary(), 'characters'));
    return await runner.runJob(args, reply(e, 'char:job'), 'make_character.py');
  } catch (err) {
    return { type: 'error', msg: err.message };
  }
});

ipcMain.handle('char:import-vrm', (_e, file) => {
  try {
    if (typeof file !== 'string' || !/\.vrm$/i.test(file)) throw new Error('.vrm 파일이 아닙니다');
    const buf = fs.readFileSync(file);
    if (buf.toString('latin1', 0, 4) !== 'glTF') throw new Error('VRM(glTF 바이너리) 형식이 아닙니다');
    ensureUserLibrary();
    const dest = path.join(userLibrary(), 'characters', `${runner.safeName(path.basename(file, path.extname(file)))}.vrm`);
    fs.writeFileSync(dest, buf);
    return { out: dest };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('char:read-library-file', (_e, file) => {
  if (typeof file !== 'string' || !isLibraryFile(file)) throw new Error('not a library file');
  const buf = fs.readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

ipcMain.handle('char:read-sample-motion', () => {
  const buf = fs.readFileSync(path.join(bundledAssets(), 'motions', 'sample-dance.vrma'));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

ipcMain.handle('char:list', () => {
  const current = resolveAsset('characters', '.vrm', settings.get().character);
  return listLibrary('characters', '.vrm').map((p) => ({ path: p, name: path.basename(p, '.vrm'), current: p === current }));
});

ipcMain.handle('char:open-cloud-folder', () => shell.openPath(runner.pipelineDir()));

ipcMain.handle('char:apply', (_e, file) => {
  if (typeof file !== 'string' || !isLibraryFile(file)) return false;
  settings.update({ character: file });
  sendLoad();
  rebuildTrayMenu();
  if (!settings.get().visible) setVisible(true);
  return true;
});

// --------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => setVisible(true));
  // The beat analysis runs an AudioContext without a click first (it never plays anything).
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

  // Dev self-test: DANCER_SELFTEST=out.png npm start → screenshot after a few seconds, then quit.
  if (process.env.DANCER_USER_DATA) app.setPath('userData', process.env.DANCER_USER_DATA);
  if (process.env.DANCER_SELFTEST) {
    app.whenReady().then(() =>
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.DANCER_SELFTEST, img.toPNG());
        const d = targetDisplay();
        console.log('selftest', JSON.stringify({ bounds: win.getBounds(), workArea: d.workArea, edge: placement.taskbarEdge(d) }));
        app.quit();
      }, Number(process.env.DANCER_SELFTEST_DELAY || 4000)),
    );
  }

  app.whenReady().then(() => {
    runner.init(app);
    settings.load(app.getPath('userData'));
    ensureUserLibrary();
    watchLibrary();
    allowSystemAudio();
    createWindow();
    tray = new Tray(trayIcon());
    tray.setToolTip('Desktop Dancer');
    tray.on('click', () => setVisible(!settings.get().visible));
    rebuildTrayMenu();

    // Taskbar moved / resized / auto-hide toggled, resolution or DPI changed, monitor plugged.
    const onDisplayChange = () => {
      placeWindow();
      rebuildTrayMenu();
    };
    screen.on('display-metrics-changed', onDisplayChange);
    screen.on('display-added', onDisplayChange);
    screen.on('display-removed', onDisplayChange);

    // Windows sometimes drops always-on-top after the taskbar is clicked; re-assert it.
    setInterval(() => {
      if (win && win.isVisible()) win.setAlwaysOnTop(true, 'screen-saver');
    }, 5000);
  });

  if (process.env.DANCER_OPEN_STUDIO) app.whenReady().then(() => setTimeout(() => openStudio(process.env.DANCER_OPEN_STUDIO === 'pose' ? 'pose' : 'dance'), 300));
  if (process.env.DANCER_OPEN_PLACE) app.whenReady().then(() => setTimeout(openPlaceWindow, 300));
  if (process.env.DANCER_OPEN_CHAR) app.whenReady().then(() => setTimeout(openCharStudio, 300));

  app.on('window-all-closed', () => {
    // Keep running in the tray.
  });
}
