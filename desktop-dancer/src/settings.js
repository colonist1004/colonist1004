// Persistent settings stored as JSON in the user data folder
// (%APPDATA%\desktop-dancer\settings.json on Windows).
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  visible: true,
  scale: 1,
  xFraction: 1, // legacy (before xCenter): 0 = left edge, 1 = right edge
  xCenter: null, // character center as a share of the work area width (null = use xFraction)
  yOffset: 0, // px the feet stand above the taskbar (negative: sink below it)
  behindTaskbar: false, // true: what goes below the taskbar's edge is hidden behind it, not drawn over it
  displayId: null, // null = primary display
  character: null, // absolute path; null = first in library
  motion: null,
  speed: 1,
  fps: 30,
  lookAt: true, // eyes and head follow the mouse cursor
  reactions: true, // clicks, patting, dangling when dragged
  music: false, // listen to the PC's sound and dance on its beat
  wander: true, // now and then walk along the taskbar to another spot
  restSit: true, // after a walk, now and then sit on the taskbar edge for 20-40 s
  // 조명 설정 (toon look): brightness per part, how light the shade side is, the light itself
  light: { face: 1, hair: 1, body: 1, shade: 0.7, sun: 1, ambient: 1, dirX: 0.65, dirY: 0.6 },
  sitStyle: 'random', // how it sits when resting / on a window / dancing seated: a key of SIT_STYLES or random
  sitOffset: 0, // px: seated, the hips go this much lower (+) or higher (-) than the automatic seat
  perch: false, // Windows: sit on the top edge of the window in front
  sitDance: false, // dance sitting down: legs from the sitting pose, the rest from the dance
  toonShader: true, // Desktop Dancer toon look (cel shading, face/hair/skin effects, toon lighting)
  toonStrength: 1, // 0..1: mix with plain MToon
  toonHairShadow: true, // hair casts a shadow on the face (an extra depth pass)
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
