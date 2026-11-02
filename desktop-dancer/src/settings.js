// Persistent settings stored as JSON in the user data folder
// (%APPDATA%\desktop-dancer\settings.json on Windows).
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  visible: true,
  scale: 1,
  xFraction: 1, // 0 = left edge of the screen, 1 = right edge (next to the tray clock)
  yOffset: 0, // px the feet stand above the taskbar (negative: sink behind it)
  displayId: null, // null = primary display
  character: null, // absolute path; null = first in library
  motion: null,
  speed: 1,
  fps: 30,
};

let file = null;
let data = { ...DEFAULTS };

function load(userDataDir) {
  file = path.join(userDataDir, 'settings.json');
  try {
    data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    data = { ...DEFAULTS };
  }
}

function get() {
  return data;
}

function update(patch) {
  data = { ...data, ...patch };
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('settings save failed', e);
  }
}

module.exports = { load, get, update, DEFAULTS };
