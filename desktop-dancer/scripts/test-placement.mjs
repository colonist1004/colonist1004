// Unit tests for src/placement.js:  node scripts/test-placement.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { taskbarEdge, computeBounds, clampX, xFractionFor, yOffsetFor, yOffsetRange, BASE_HEIGHT, BASE_WIDTH } = require('../src/placement.js');

const display = (bounds, workArea) => ({ bounds, workArea });
// 1920x1080 at 100%, taskbar 48 px at the bottom (Windows 11 default)
const bottom = display({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1032 });
// 2560x1440 at 150% → 1707x960 DIP, taskbar 48 DIP
const hiDpi = display({ x: 0, y: 0, width: 1707, height: 960 }, { x: 0, y: 0, width: 1707, height: 912 });
const top = display({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 48, width: 1920, height: 1032 });
const left = display({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 62, y: 0, width: 1858, height: 1080 });
const right = display({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1858, height: 1080 });
const hidden = display({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1080 });
// second monitor to the left of the primary, negative coordinates
const second = display({ x: -1920, y: 0, width: 1920, height: 1080 }, { x: -1920, y: 0, width: 1920, height: 1040 });

const tests = {
  'detects taskbar edge'() {
    assert.equal(taskbarEdge(bottom), 'bottom');
    assert.equal(taskbarEdge(hiDpi), 'bottom');
    assert.equal(taskbarEdge(top), 'top');
    assert.equal(taskbarEdge(left), 'left');
    assert.equal(taskbarEdge(right), 'right');
    assert.equal(taskbarEdge(hidden), 'hidden');
  },
  'feet stand on top of a bottom taskbar'() {
    const b = computeBounds(bottom, { scale: 1, xFraction: 1 });
    assert.equal(b.y + b.height, 1032);
    assert.equal(b.x + b.width, 1920); // right edge, next to the clock
  },
  'works in DIP at 150% scaling'() {
    const b = computeBounds(hiDpi, { scale: 1, xFraction: 0 });
    assert.equal(b.y + b.height, 912);
    assert.equal(b.x, 0);
  },
  'scale changes size, keeps feet on the taskbar'() {
    const b = computeBounds(bottom, { scale: 1.5, xFraction: 0.5 });
    assert.equal(b.height, Math.round(BASE_HEIGHT * 1.5));
    assert.equal(b.y + b.height, 1032);
    assert.equal(Math.round(b.x + b.width / 2), 960);
  },
  'top/left/right taskbar: stays inside the work area at the bottom'() {
    for (const d of [top, left, right]) {
      for (const xFraction of [0, 1]) {
        const b = computeBounds(d, { xFraction });
        assert.ok(b.x >= d.workArea.x && b.x + b.width <= d.workArea.x + d.workArea.width, JSON.stringify(b));
        assert.equal(b.y + b.height, d.workArea.y + d.workArea.height);
      }
    }
  },
  'auto-hide taskbar leaves the pop-up strip free'() {
    const b = computeBounds(hidden);
    assert.equal(b.y + b.height, 1078);
  },
  'secondary monitor with negative coordinates'() {
    const b = computeBounds(second, { xFraction: 0 });
    assert.equal(b.x, -1920);
    assert.equal(b.y + b.height, 1040);
  },
  'drag clamps to the work area and round-trips through xFraction'() {
    const w = 320;
    assert.equal(clampX(bottom, -500, w), 0);
    assert.equal(clampX(bottom, 5000, w), 1600);
    const x = clampX(bottom, 777, w);
    const f = xFractionFor(bottom, x, w);
    assert.equal(computeBounds(bottom, { xFraction: f }).x, x);
  },
  'up to 800%: window stops at the screen, feet stay on the taskbar'() {
    const b = computeBounds(bottom, { scale: 8, xFraction: 0.5 });
    assert.equal(b.nominalHeight, BASE_HEIGHT * 8);
    assert.equal(b.y, 0); // cut at the top of the screen
    assert.equal(b.y + b.height, 1032); // feet still on the taskbar
    assert.equal(b.cropTop, BASE_HEIGHT * 8 - 1032);
    assert.equal(b.width, Math.min(BASE_WIDTH * 8, 1920));
    assert.equal(computeBounds(bottom, { scale: 50 }).nominalHeight, BASE_HEIGHT * 8); // clamped to 800%
    assert.equal(computeBounds(bottom, { scale: 0.01 }).nominalHeight, Math.round(BASE_HEIGHT * 0.25));
  },
  'vertical offset: up, down behind the taskbar, clamped'() {
    assert.equal(computeBounds(bottom, { yOffset: 200 }).y + computeBounds(bottom, { yOffset: 200 }).height, 832);
    const sunk = computeBounds(bottom, { yOffset: -30 });
    assert.equal(sunk.y + sunk.height, 1062);
    const r = yOffsetRange(bottom);
    assert.deepEqual(r, { min: -48, max: 972 });
    const far = computeBounds(bottom, { yOffset: 99999 });
    assert.equal(far.y + far.height, 1032 - 972);
    assert.ok(far.height > 0);
  },
  'dragging the feet near the taskbar snaps back onto it'() {
    assert.equal(yOffsetFor(bottom, 1032 - 7), 0);
    assert.equal(yOffsetFor(bottom, 1032 - 40), 40);
    assert.equal(yOffsetFor(bottom, 5000), -48);
  },
  'bad stored settings fall back sanely'() {
    assert.equal(computeBounds(bottom, { yOffset: NaN }).y + computeBounds(bottom, { yOffset: NaN }).height, 1032);
    const b = computeBounds(bottom, { xFraction: NaN });
    assert.equal(b.x + b.width, 1920);
    assert.equal(xFractionFor(display(bottom.bounds, { x: 0, y: 0, width: 100, height: 100 }), 0, 320), 0);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}
console.log(failed ? `\n${failed} test(s) failed` : '\nall tests passed');
process.exit(failed ? 1 : 0);
