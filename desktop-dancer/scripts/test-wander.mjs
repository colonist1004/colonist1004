// Unit tests for src/wander.js:  node scripts/test-wander.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { plan } = require('../src/wander.js');
const uhd = { bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 0, width: 2560, height: 1392 } };

const tests = {
  'walks toward the side with room and stays on screen'() {
    for (const xCenter of [0.05, 0.5, 0.95]) {
      for (const r of [0, 0.5, 0.999]) {
        const p = plan(uhd, { scale: 1, xCenter }, () => r);
        assert.ok(p, `${xCenter}`);
        assert.equal(p.dir, xCenter < 0.5 ? 1 : -1);
        assert.ok(p.to >= 160 && p.to <= 2560 - 160, JSON.stringify(p));
        assert.ok(Math.abs(p.to - p.from) >= 2560 * 0.15 - 1 || Math.abs(p.to - p.from) < 2560 * 0.15, 'distance');
        assert.ok(p.speed > 50 && p.speed < 400, `${p.speed}`);
      }
    }
  },
  'no walk when raised/sunk or too big'() {
    assert.equal(plan(uhd, { scale: 1, xCenter: 0.5, yOffset: -200 }), null);
    assert.equal(plan(uhd, { scale: 6, xCenter: 0.5 }), null);
  },
  'speed grows with the size'() {
    const a = plan(uhd, { scale: 1, xCenter: 0.2 }, () => 0.5);
    const b = plan(uhd, { scale: 2, xCenter: 0.2 }, () => 0.5);
    assert.ok(Math.abs(b.speed / a.speed - 2) < 0.02);
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
console.log(failed ? `\n${failed} test(s) failed` : '\nall wander tests passed');
process.exit(failed ? 1 : 0);
