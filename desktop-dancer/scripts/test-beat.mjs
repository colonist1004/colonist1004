// Unit tests for src/renderer/beat.js:  node scripts/test-beat.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BeatTracker, estimateTempo, motionTempo, syncRate } from '../src/renderer/beat.js';

const rate = 100;
let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

/** Onset envelope of a drum loop: kicks on beats, softer hats on off-beats, noise. */
function drumFlux(bpm, seconds, offset = 0) {
  const n = rate * seconds;
  const out = new Float64Array(n);
  const period = (60 * rate) / bpm;
  for (let i = 0; i < n; i++) {
    const p = ((i - offset * rate) / period) % 1;
    const q = (p + 1) % 1;
    out[i] = 2 * rnd() + (q < 0.04 ? 30 : 0) + (Math.abs(q - 0.5) < 0.03 ? 12 : 0);
  }
  return out;
}

const tests = {
  'tempo of drum loops (70..175 BPM)'() {
    for (const bpm of [72, 95, 120, 128, 140, 174]) {
      const r = estimateTempo(drumFlux(bpm, 6), rate);
      // the answer may be the half/double tempo for very slow/fast songs; both line up with the beat
      const ratio = r.bpm / bpm;
      const ok = [0.5, 1, 2].some((k) => Math.abs(ratio / k - 1) < 0.015);
      assert.ok(ok, `${bpm}: got ${r.bpm.toFixed(1)}`);
    }
  },
  'clean pulse trains (flat autocorrelation peaks) are not pushed off by the refinement'() {
    for (const bpm of [97, 132, 150]) {
      const period = (60 * rate) / bpm;
      const sig = Float64Array.from({ length: 600 }, (_, i) => {
        const p = (i / period) % 1;
        return p < 1 / period ? 30 : (p > 0.5 && p < 0.5 + 1 / period ? 10 : 0);
      });
      const r = estimateTempo(sig, rate);
      assert.ok(Math.abs(r.bpm - bpm) < 1.5, `${bpm}: got ${r.bpm}`);
    }
  },
  'tracker finds tempo and beat times, ignores silence'() {
    const t = new BeatTracker(rate);
    const bpm = 128;
    const flux = drumFlux(bpm, 10, 0.13);
    // feed fake spectra whose flux equals the envelope
    let level = 0;
    for (let i = 0; i < flux.length; i++) {
      level += flux[i];
      const spec = new Float32Array(220).fill(-100);
      spec[50] = -100 + level; // monotone rise: flux of this frame = flux[i]
      t.push(spec, 0.2, i / rate);
    }
    assert.ok(t.active, 'active');
    assert.ok(Math.abs(t.bpm - bpm) < 1, `bpm ${t.bpm}`);
    const period = 60 / bpm;
    const err = ((t.lastBeatT - 0.13) / period) % 1;
    const e = Math.min(Math.abs(err), 1 - Math.abs(err));
    assert.ok(e < 0.08, `beat phase off by ${e.toFixed(3)} beats`);
    const quiet = new BeatTracker(rate);
    for (let i = 0; i < 800; i++) quiet.push(new Float32Array(220).fill(-100 + rnd()), 0.001, i / rate);
    assert.ok(!quiet.active, 'silence is not music');
  },
  'tempo of the sample dance clip (120 BPM, beats on the knee bounce)'() {
    // hips height of dance.mjs: drops on every beat
    const n = 4 * 60;
    const sig = Float64Array.from({ length: n }, (_, i) => 0.5 + 0.5 * Math.cos((2 * Math.PI * (i / 60) * 120) / 60));
    const m = motionTempo(sig, 60);
    assert.ok(Math.abs(m.bpm - 120) < 0.01, `bpm ${m.bpm}`);
    assert.ok(Math.min(m.beatAt % 0.5, 0.5 - (m.beatAt % 0.5)) < 0.02, `beat at ${m.beatAt}`);
  },
  'sync rate matches tempo and pulls the phase in'() {
    const motion = { bpm: 120, beatAt: 0 };
    const music = { bpm: 128, lastBeatT: 10 };
    const r = syncRate(motion, 0, music, 10); // both on a beat
    assert.ok(Math.abs(r.scale - 128 / 120) < 1e-9 && r.k === 1);
    // dance 0.1 beat short of its next beat while the music is on a beat: it is behind -> a bit faster
    const behind = syncRate(motion, 0.45, music, 10);
    assert.ok(behind.scale > 128 / 120 && Math.abs(behind.error - 0.1) < 1e-9, `${behind.scale}`);
    const ahead = syncRate(motion, 0.05, music, 10); // 0.1 beat past its beat: ahead -> a bit slower
    assert.ok(ahead.scale < 128 / 120, `${ahead.scale}`);
    const slow = syncRate(motion, 0, { bpm: 64, lastBeatT: 0 }, 0); // half-time song: dance 2 beats per music beat
    assert.equal(slow.k, 2);
    assert.ok(Math.abs(slow.scale - 128 / 120) < 1e-9);
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
console.log(failed ? `\n${failed} test(s) failed` : '\nall beat tests passed');
process.exit(failed ? 1 : 0);
