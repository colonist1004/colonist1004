// Unit tests for src/perch.js (where to sit on another window) and the seated window size:
// node scripts/test-perch.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { perchPlacement, parseMessage, shouldHideFor, dropTarget } = require('../src/perch.js');
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
    assert.deepEqual(parseMessage('F 123 10 20 300 400 0 0 2').value, { hwnd: 123, x: 10, y: 20, width: 300, height: 400, zoomed: false, full: false, quns: 2 });
    assert.equal(parseMessage('F 123 -8 -8 2576 1408 1 1 2').value.zoomed, true);
    assert.deepEqual(parseMessage('F none 3').value, { none: true, quns: 3 });
    assert.equal(parseMessage('T gone').value, null);
    assert.equal(parseMessage('T 7 1 2 300 200 0').value.hwnd, 7);
    assert.deepEqual(parseMessage('L 5 1 2 300 300').value, { hwnd: 5, x: 1, y: 2, width: 300, height: 300 });
    assert.equal(parseMessage('L end').kind, 'Lend');
    assert.equal(parseMessage('garbage here'), null);
    assert.equal(parseMessage('F 1 2'), null);
  },
  'game mode: hides for fullscreen apps on its own monitor only'() {
    const b = uhd.bounds;
    assert.equal(shouldHideFor({ hwnd: 1, x: 0, y: 0, width: 2560, height: 1440, full: true, quns: 2 }, b), true);
    assert.equal(shouldHideFor({ hwnd: 1, x: 2560, y: 0, width: 1920, height: 1080, full: true, quns: 2 }, b), false); // other monitor
    assert.equal(shouldHideFor({ hwnd: 1, x: 100, y: 100, width: 800, height: 600, full: false, quns: 2 }, b), false);
    assert.equal(shouldHideFor({ none: true, quns: 3 }, b), true); // exclusive D3D fullscreen
    assert.equal(shouldHideFor({ none: true, quns: 0 }, b), false);
    assert.equal(shouldHideFor(null, b), false);
  },
  'drop onto a window: the visible top edge near the feet'() {
    const front = { hwnd: 1, x: 100, y: 300, width: 600, height: 400 };
    const back = { hwnd: 2, x: 500, y: 500, width: 800, height: 400 };
    const list = [front, back];
    assert.equal(dropTarget(list, 400, 310)?.hwnd, 1);
    assert.equal(dropTarget(list, 1000, 480)?.hwnd, 2);
    assert.equal(dropTarget(list, 600, 500), null); // back's edge there is hidden behind the front window
    assert.equal(dropTarget(list, 400, 200), null); // too far above
    assert.equal(dropTarget(list, 50, 300), null); // beside it
  },
  'a window dropped on by hand may be high up, a chosen one may not'() {
    const r = { x: 900, y: 60, width: 900, height: 700, zoomed: false };
    assert.equal(perchPlacement(r, uhd, frame, 1000), null);
    assert.ok(perchPlacement(r, uhd, frame, 1000, { manual: true }));
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
