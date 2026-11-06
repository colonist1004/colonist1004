// Unit tests for src/perch.js (where to sit on another window) and the seated window size:
// node scripts/test-perch.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { perchPlacement, parseLine } = require('../src/perch.js');
const placement = require('../src/placement.js');
const uhd = { bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 0, width: 2560, height: 1392 } };
const frame = placement.frameSize(1);

const tests = {
  'sits on the top edge of a normal window, over it'() {
    const r = { x: 800, y: 600, width: 1000, height: 600, zoomed: false };
    const p = perchPlacement(r, uhd, frame, 300);
    assert.ok(p);
    assert.ok(p.floorY >= 600 && p.floorY <= 610, JSON.stringify(p));
    assert.ok(p.centerX >= r.x && p.centerX <= r.x + r.width, JSON.stringify(p));
    // keeps its place when already over the window
    assert.equal(perchPlacement(r, uhd, frame, 1300).centerX, 1300);
  },
  'stays on the taskbar for maximized, fullscreen, tiny or too high windows'() {
    assert.equal(perchPlacement({ x: 0, y: 0, width: 2560, height: 1392, zoomed: true }, uhd, frame, 500), null);
    assert.equal(perchPlacement({ x: 0, y: 0, width: 2560, height: 1440, zoomed: false }, uhd, frame, 500), null);
    assert.equal(perchPlacement({ x: 900, y: 700, width: 60, height: 300, zoomed: false }, uhd, frame, 500), null);
    assert.equal(perchPlacement({ x: 900, y: 20, width: 900, height: 700, zoomed: false }, uhd, frame, 500), null);
    assert.equal(perchPlacement({ x: 900, y: 1380, width: 900, height: 700, zoomed: false }, uhd, frame, 500), null);
    assert.equal(perchPlacement(null, uhd, frame, 500), null);
  },
  'parses watcher lines'() {
    assert.deepEqual(parseLine('123 10 20 300 400 0'), { hwnd: 123, x: 10, y: 20, width: 300, height: 400, zoomed: false });
    assert.equal(parseLine('123 -8 -8 2576 1408 1').zoomed, true);
    assert.equal(parseLine('none'), null);
    assert.equal(parseLine('garbage here'), null);
  },
  'perched bounds: the frame stands on the window, the seated legs reach below it'() {
    const b = placement.computeBounds(uhd, { scale: 1, xCenter: 0.5, floorY: 600 });
    assert.equal(b.y + b.height, 600);
    const seated = placement.computeBounds(uhd, { scale: 1, xCenter: 0.5, floorY: 600, hang: 0.3 });
    assert.equal(seated.y, b.y);
    assert.equal(seated.height, b.height + Math.round(0.3 * b.nominalHeight));
    // on the taskbar with behindTaskbar the legs are cut at the taskbar's edge
    const cut = placement.computeBounds(uhd, { scale: 1, xCenter: 0.5, hang: 0.3, behindTaskbar: true });
    assert.equal(cut.y + cut.height, 1392);
    const front = placement.computeBounds(uhd, { scale: 1, xCenter: 0.5, hang: 0.3 });
    assert.ok(front.y + front.height > 1392);
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
if (failed) process.exit(1);
console.log('\nall perch tests passed');
