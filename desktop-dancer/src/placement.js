// Pure window-placement math (no Electron imports) so it can be unit-tested.
// All values are Electron DIP (device-independent pixels), which already
// accounts for Windows display scaling (125%, 150%, ...).

const BASE_WIDTH = 320; // window size at scale 1.0
const BASE_HEIGHT = 340;

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

/**
 * Window bounds: feet on the top edge of a bottom taskbar (= bottom of the work area).
 * For top/left/right taskbars the character stands on the bottom of the screen inside the work area.
 * `xFraction` (0..1) is the horizontal position as a fraction of the free width, so it
 * survives resolution / DPI / monitor changes.
 */
function computeBounds(display, { scale = 1, xFraction = 1 } = {}) {
  const wa = display.workArea;
  const width = Math.round(BASE_WIDTH * scale);
  const height = Math.round(BASE_HEIGHT * scale);
  // An auto-hidden taskbar pops up over the bottom ~2 px; stand just above that strip.
  const bottomInset = taskbarEdge(display) === 'hidden' ? 2 : 0;
  const free = Math.max(0, wa.width - width);
  const x = Math.round(wa.x + free * clamp01(xFraction));
  const y = Math.round(wa.y + wa.height - height - bottomInset);
  return { x, y, width, height };
}

/** Clamp a dragged window x to the work area. */
function clampX(display, x, width) {
  const wa = display.workArea;
  return Math.min(wa.x + wa.width - width, Math.max(wa.x, Math.round(x)));
}

/** Inverse of computeBounds' x: window x -> 0..1 fraction. */
function xFractionFor(display, x, width) {
  const wa = display.workArea;
  const free = wa.width - width;
  return free > 0 ? clamp01((x - wa.x) / free) : 0;
}

function clamp01(v) {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));
}

module.exports = { BASE_WIDTH, BASE_HEIGHT, taskbarEdge, computeBounds, clampX, xFractionFor };
