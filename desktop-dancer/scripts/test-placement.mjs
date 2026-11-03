// Unit tests for src/placement.js:  node scripts/test-placement.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const P = require('../src/placement.js');
const { taskbarEdge, computeBounds, yOffsetFor, yOffsetRange, xRange, xCenterFor, frameAnchor, BASE_HEIGHT, BASE_WIDTH } = P;

const display = (bounds, workArea) => ({ bounds, workArea });
// 1920x1080 at 100%, taskbar 48 px at the bottom (Windows 11 default)
const bottom = display({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1032 });
// 4K (3840x2160) at 150% -> 2560x1440 DIP, taskbar 48 DIP
const uhd = display({ x: 0, y: 0, width: 2560, height: 1440 }, { x: 0, y: 0, width: 2560, height: 1392 });
const top = display({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 48, width: 1920, height: 1032 });
const left = display({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 62, y: 0, width: 1858, height: 1080 });
const right = display({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1858, height: 1080 });
const hidden = display({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1080 });
const second = display({ x: -1920, y: 0, width: 1920, height: 1080 }, { x: -1920, y: 0, width: 1920, height: 1040 });
const feet = (b) => b.y - b.cropTop + b.nominalHeight; // frame bottom
const center = (b) => b.x - b.cropLeft + b.nominalWidth / 2;

const tests = {
  'detects taskbar edge'() {
    assert.equal(taskbarEdge(bottom), 'bottom');
    assert.equal(taskbarEdge(top), 'top');
    assert.equal(taskbarEdge(left), 'left');
    assert.equal(taskbarEdge(right), 'right');
    assert.equal(taskbarEdge(hidden), 'hidden');
  },
  'default: feet on the taskbar, right edge (old xFraction setting still works)'() {
    const b = computeBounds(bottom, { scale: 1, xFraction: 1 });
    assert.deepEqual([b.x, b.y, b.width, b.height], [1600, 692, 320, 340]);
    assert.equal(b.cropped, false);
    const l = computeBounds(bottom, { xFraction: 0 });
    assert.equal(l.x, 0);
  },
  'xCenter places the character center'() {
    const b = computeBounds(uhd, { xCenter: 0.5, scale: 2 });
    assert.equal(center(b), 1280);
    assert.equal(feet(b), 1392);
    assert.equal(xCenterFor(uhd, 1280, 2), 0.5);
  },
  'sink down until only the upper body shows (window = visible part)'() {
    const s = { scale: 2, xCenter: 0.5, yOffset: -340 }; // half of the 680 px frame below the floor
    const b = computeBounds(uhd, s);
    assert.equal(feet(b), 1392 + 340);
    assert.equal(b.y + b.height, 1440); // window stops at the screen bottom
    assert.equal(b.cropTop, 0);
    assert.equal(b.height, 1440 - (1732 - 680));
    assert.equal(b.cropped, true);
    const r = yOffsetRange(uhd, 2);
    assert.equal(r.min, Math.floor(1392 - (1440 + 0.65 * 680))); // head and shoulders (35 %) stay visible
    const deepest = computeBounds(uhd, { ...s, yOffset: -99999 });
    assert.ok(Math.abs(deepest.height - 0.35 * 680) <= 1, `${deepest.height}`);
  },
  'push past the left/right edges, keeping 40 % of the frame (about half the body) visible'() {
    const r = xRange(uhd, 2);
    const b = computeBounds(uhd, { scale: 2, xCenter: -1 }); // far left -> clamped
    assert.equal(center(b), r.min);
    assert.ok(b.x === 0 && b.cropLeft > 0 && Math.abs(b.width - 0.4 * 640) <= 1, JSON.stringify(b));
    const c = computeBounds(uhd, { scale: 2, xCenter: 2 });
    assert.ok(c.x + c.width === 2560 && Math.abs(c.width - 0.4 * 640) <= 1);
  },
  'up to 1600%: frame keeps its size, window = the screen'() {
    const b = computeBounds(uhd, { scale: 16, xCenter: 0.5 });
    assert.equal(b.nominalHeight, BASE_HEIGHT * 16);
    assert.equal(b.nominalWidth, BASE_WIDTH * 16);
    assert.deepEqual([b.x, b.y, b.width, b.height], [0, 0, 2560, 1392]);
    assert.equal(feet(b), 1392);
    assert.equal(b.cropTop, BASE_HEIGHT * 16 - 1392);
    assert.equal(computeBounds(uhd, { scale: 99 }).nominalHeight, BASE_HEIGHT * 16);
    assert.equal(computeBounds(uhd, { scale: 0.01 }).nominalHeight, Math.round(BASE_HEIGHT * 0.25));
  },
  'raise above the taskbar'() {
    const b = computeBounds(bottom, { yOffset: 200 });
    assert.equal(feet(b), 832);
  },
  'dragging the feet near the taskbar snaps back onto it'() {
    assert.equal(yOffsetFor(bottom, 1032 - 7), 0);
    assert.equal(yOffsetFor(bottom, 1032 - 40), 40);
    assert.equal(yOffsetFor(bottom, 1032 + 200), -200);
    assert.equal(yOffsetFor(bottom, 1032 + 900), yOffsetRange(bottom, 1).min); // clamped
  },
  'frameAnchor round-trips through the setters'() {
    const s = { scale: 3, xCenter: 0.3, yOffset: -500 };
    const a = frameAnchor(uhd, s);
    assert.ok(Math.abs(xCenterFor(uhd, a.centerX, 3) - 0.3) < 1e-3);
    assert.equal(yOffsetFor(uhd, a.bottom, 3), -500);
  },
  'other taskbar positions and monitors'() {
    for (const d of [top, left, right]) {
      const b = computeBounds(d, { xFraction: 0 });
      assert.equal(feet(b), d.workArea.y + d.workArea.height);
    }
    assert.equal(feet(computeBounds(hidden)), 1078);
    const s = computeBounds(second, { xFraction: 0 });
    assert.equal(s.x, -1920);
    assert.equal(feet(s), 1040);
  },
  'bad stored settings fall back sanely'() {
    const b = computeBounds(bottom, { xFraction: NaN, yOffset: NaN, scale: NaN });
    assert.deepEqual([b.x + b.width, feet(b), b.nominalHeight], [1920, 1032, BASE_HEIGHT]);
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
