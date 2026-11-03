// Pure window-placement math (no Electron imports) so it can be unit-tested.
// All values are Electron DIP (device-independent pixels), which already
// accounts for Windows display scaling (125%, 150%, ...).
//
// The character has a "frame" (BASE size * scale) that may extend past the screen edges: it can be
// pushed down until only the upper body shows, or partly off the left/right/top edges. The window is
// the visible part of that frame (frame ∩ screen) and the renderer is told which slice it shows
// (cropLeft/cropTop), so the character keeps its true size wherever it is.

const BASE_WIDTH = 320; // frame size at scale 1.0
const BASE_HEIGHT = 340;
const MIN_SCALE = 0.25;
const MAX_SCALE = 16;
// How much of the frame must stay on screen. The character fills the middle of its frame (there is
// headroom above the head for raised arms), so these keep part of the body itself visible.
const MIN_VISIBLE_X = 0.4; // sideways: about half the body
const MIN_VISIBLE_TOP = 0.35; // sunk down: head and shoulders
const MIN_VISIBLE_BOTTOM = 0.15; // raised up: the feet
const SNAP = 10; // px: dragging this close to the taskbar snaps back onto it

/** Where is the taskbar on this display? Compares the full bounds with the work area. */
function taskbarEdge(display) {
  const b = display.bounds;
  const w = display.workArea;
  if (w.y + w.height < b.y + b.height) return 'bottom';
  if (w.y > b.y) return 'top';
  if (w.x > b.x) return 'left';
  if (w.x + w.width < b.x + b.width) return 'right';
  return 'hidden'; // auto-hide taskbar (or none): work area == full screen
}

const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number.isFinite(s) ? s : 1));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The floor line (y of the feet) when yOffset = 0: top edge of a bottom taskbar. */
function floorY(display) {
  const wa = display.workArea;
  // An auto-hidden taskbar pops up over the bottom ~2 px; stand just above that strip.
  return wa.y + wa.height - (taskbarEdge(display) === 'hidden' ? 2 : 0);
}

function frameSize(scale) {
  const s = clampScale(scale);
  return { w: Math.round(BASE_WIDTH * s), h: Math.round(BASE_HEIGHT * s) };
}

/** Allowed feet heights above the floor (px): down until only the head and shoulders show, up until only the feet show. */
function yOffsetRange(display, scale = 1) {
  const b = display.bounds;
  const { h } = frameSize(scale);
  const f = floorY(display);
  return { min: Math.floor(f - (b.y + b.height + (1 - MIN_VISIBLE_TOP) * h)), max: Math.ceil(f - (b.y + MIN_VISIBLE_BOTTOM * h)) };
}

/** Allowed character centers (px from the work area's left edge): part of the body stays on screen. */
function xRange(display, scale = 1) {
  const b = display.bounds;
  const wa = display.workArea;
  const { w } = frameSize(scale);
  return {
    min: Math.floor(b.x - wa.x - (0.5 - MIN_VISIBLE_X) * w),
    max: Math.ceil(b.x + b.width - wa.x + (0.5 - MIN_VISIBLE_X) * w),
  };
}

/** Center of the character (px from the work area's left) from the settings; supports the old xFraction. */
function centerPx(display, s) {
  const wa = display.workArea;
  const { w } = frameSize(s.scale);
  if (Number.isFinite(s.xCenter)) return s.xCenter * wa.width;
  const free = Math.max(0, wa.width - w);
  const xf = Number.isFinite(s.xFraction) ? clamp(s.xFraction, 0, 1) : 1;
  return free * xf + w / 2; // legacy: left edge as a fraction of the free width
}

/**
 * Window bounds = visible part of the character's frame.
 *  - xCenter: character center as a share of the work area width (survives resolution/DPI changes)
 *  - yOffset (px): feet above the taskbar's top edge (0 = standing on it; negative = sunk below it)
 */
function computeBounds(display, settings = {}) {
  const wa = display.workArea;
  const b = display.bounds;
  const scale = clampScale(settings.scale ?? 1);
  const { w, h } = frameSize(scale);
  const xr = xRange(display, scale);
  const yr = yOffsetRange(display, scale);
  const cx = wa.x + clamp(centerPx(display, { ...settings, scale }), xr.min, xr.max);
  const off = clamp(Number.isFinite(settings.yOffset) ? settings.yOffset : 0, yr.min, yr.max);
  const left = Math.round(cx - w / 2);
  const bottom = Math.round(floorY(display) - off);
  const top = bottom - h;
  const x0 = Math.max(left, b.x);
  const y0 = Math.max(top, b.y);
  const x1 = Math.min(left + w, b.x + b.width);
  const y1 = Math.min(bottom, b.y + b.height);
  return {
    x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0),
    nominalWidth: w, nominalHeight: h, cropLeft: x0 - left, cropTop: y0 - top,
    cropped: x0 > left || y0 > top || x1 < left + w || y1 < bottom,
  };
}

/** Frame center (screen px) -> xCenter setting, clamped. */
function xCenterFor(display, centerX, scale = 1) {
  const wa = display.workArea;
  const r = xRange(display, scale);
  return clamp(centerX - wa.x, r.min, r.max) / wa.width;
}

/** Frame bottom (feet, screen px) -> yOffset, clamped, snapping onto the taskbar when close. */
function yOffsetFor(display, bottom, scale = 1) {
  const r = yOffsetRange(display, scale);
  const off = Math.round(floorY(display) - bottom);
  if (Math.abs(off) <= SNAP) return 0;
  return clamp(off, r.min, r.max);
}

/** Current frame center/bottom in screen px (for dragging). */
function frameAnchor(display, settings = {}) {
  const b = computeBounds(display, settings);
  return { centerX: b.x - b.cropLeft + b.nominalWidth / 2, bottom: b.y - b.cropTop + b.nominalHeight };
}

module.exports = {
  BASE_WIDTH, BASE_HEIGHT, MIN_SCALE, MAX_SCALE, taskbarEdge, computeBounds, clampScale,
  yOffsetRange, xRange, xCenterFor, yOffsetFor, frameAnchor, centerPx,
};
