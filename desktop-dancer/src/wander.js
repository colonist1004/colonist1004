// "산책": now and then the character walks along the taskbar to another spot.
// Pure planning math (no Electron) so it can be unit-tested; main.js moves the window.
const placement = require('./placement');

const MIN_GAP_S = 60; // seconds between walks
const MAX_GAP_S = 180;

/** Seconds until the next walk. */
function nextDelay(rnd = Math.random) {
  const env = Number(process.env.DANCER_WANDER_SEC);
  if (Number.isFinite(env) && env > 0) return env;
  return MIN_GAP_S + rnd() * (MAX_GAP_S - MIN_GAP_S);
}

/**
 * Where to walk: { from, to (character center, px from the work area's left), dir (+1 right / -1 left),
 * speed (px/s) } or null when a walk does not make sense (too big, not standing on the taskbar).
 */
function plan(display, settings, rnd = Math.random) {
  const wa = display.workArea;
  const scale = placement.clampScale(settings.scale ?? 1);
  const b = placement.computeBounds(display, { ...settings, scale });
  if (Math.abs(settings.yOffset || 0) > 2) return null; // only when standing on the taskbar
  const w = b.nominalWidth;
  if (w * 1.6 > wa.width) return null; // nowhere to go
  const lo = w / 2;
  const hi = wa.width - w / 2;
  const from = Math.min(hi, Math.max(lo, placement.centerPx(display, { ...settings, scale })));
  // go toward the side with more room, 15..40 % of the screen
  const dir = hi - from > from - lo ? 1 : -1;
  const room = dir > 0 ? hi - from : from - lo;
  const dist = Math.min(room, wa.width * (0.15 + 0.25 * rnd()));
  if (dist < w * 0.5) return null;
  // walking pace: about 0.45 body heights per second (the body is ~1/1.3 of the frame height)
  const speed = 0.45 * (b.nominalHeight / 1.3);
  return { from, to: from + dir * dist, dir, speed };
}

module.exports = { plan, nextDelay };
