// Pure window-placement math (no Electron imports) so it can be unit-tested.
// All values are Electron DIP (device-independent pixels), which already
// accounts for Windows display scaling (125%, 150%, ...).

const BASE_WIDTH = 320; // window size at scale 1.0
const BASE_HEIGHT = 340;
const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
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

/** The floor line (y of the feet) when yOffset = 0: top edge of a bottom taskbar. */
function floorY(display) {
  const wa = display.workArea;
  // An auto-hidden taskbar pops up over the bottom ~2 px; stand just above that strip.
  return wa.y + wa.height - (taskbarEdge(display) === 'hidden' ? 2 : 0);
}

/** Allowed vertical offsets: down to the screen bottom (behind the taskbar), up until ~60 px stay visible. */
function yOffsetRange(display) {
  const b = display.bounds;
  return { min: -(b.y + b.height - floorY(display)), max: floorY(display) - b.y - 60 };
}

/**
 * Window bounds. The character keeps its full size (BASE * scale) even when that is bigger than
 * the screen: the window is then cut at the screen edges and `cropTop` tells the renderer how many
 * pixels of the character's frame are above the window (so the feet stay where they belong).
 *  - xFraction (0..1): horizontal position as a fraction of the free width (survives resolution/DPI changes)
 *  - yOffset (px): feet above the taskbar's top edge (0 = standing on the taskbar, negative = sinks behind it)
 */
function computeBounds(display, { scale = 1, xFraction = 1, yOffset = 0 } = {}) {
  const wa = display.workArea;
  const b = display.bounds;
  const s = clampScale(scale);
  const nominalWidth = Math.round(BASE_WIDTH * s);
  const nominalHeight = Math.round(BASE_HEIGHT * s);
  const r = yOffsetRange(display);
  const off = Math.min(r.max, Math.max(r.min, Number.isFinite(yOffset) ? yOffset : 0));
  const bottom = Math.round(floorY(display) - off);
  const width = Math.min(nominalWidth, b.width);
  const height = Math.min(nominalHeight, bottom - b.y); // never above the top of the screen
  const free = Math.max(0, wa.width - width);
  const x = Math.round(wa.x + free * clamp01(xFraction));
  return { x, y: bottom - height, width, height, nominalWidth, nominalHeight, cropTop: nominalHeight - height };
}

/** Clamp a dragged window x to the work area. */
function clampX(display, x, width) {
  const wa = display.workArea;
  const max = Math.max(wa.x, wa.x + wa.width - width);
  return Math.min(max, Math.max(wa.x, Math.round(x)));
}

/** Inverse of computeBounds' x: window x -> 0..1 fraction. */
function xFractionFor(display, x, width) {
  const wa = display.workArea;
  const free = wa.width - width;
  return free > 0 ? clamp01((x - wa.x) / free) : 0;
}

/** Window bottom (feet) -> yOffset, clamped, snapping onto the taskbar when close. */
function yOffsetFor(display, bottom) {
  const r = yOffsetRange(display);
  const off = Math.round(floorY(display) - bottom);
  if (Math.abs(off) <= SNAP) return 0;
  return Math.min(r.max, Math.max(r.min, off));
}

function clamp01(v) {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));
}

module.exports = {
  BASE_WIDTH, BASE_HEIGHT, MIN_SCALE, MAX_SCALE, taskbarEdge, computeBounds, clampX, xFractionFor,
  yOffsetFor, yOffsetRange, clampScale,
};
