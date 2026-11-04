// Tempo and beat tracking, pure math (no DOM, no three.js) so it runs in tests too.
//
// Music: an onset-strength envelope (spectral flux, ~100 samples per second) -> tempo by a
// harmonic autocorrelation with a soft preference around 120 BPM, then the beat phase by a comb.
// Dance: the same tempo search on a "movement" signal sampled from the clip (circular: clips loop).

const lerpAt = (a, x) => {
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= a.length) return i >= 0 && i < a.length ? a[i] : 0;
  return a[i] + (a[i + 1] - a[i]) * (x - i);
};

const lerpWrap = (a, x) => {
  const n = a.length;
  const f = Math.floor(x);
  const i = ((f % n) + n) % n;
  return a[i] + (a[(i + 1) % n] - a[i]) * (x - f);
};

function acf(sig, lag, circular) {
  const n = sig.length;
  let s = 0;
  if (circular) {
    for (let i = 0; i < n; i++) s += sig[i] * lerpWrap(sig, i - lag);
    return s / n;
  }
  const start = Math.ceil(lag);
  for (let i = start; i < n; i++) s += sig[i] * lerpAt(sig, i - lag);
  return s / Math.max(1, n - start);
}

/**
 * Tempo of a periodic signal sampled at `rate` Hz. Returns { bpm, confidence } or null.
 * confidence ~ how strongly the signal repeats at that period (0..1).
 */
export function estimateTempo(signal, rate, { minBpm = 70, maxBpm = 180, prior = 120, circular = false } = {}) {
  const n = signal.length;
  if (n < rate) return null;
  let mean = 0;
  for (const v of signal) mean += v;
  mean /= n;
  const sig = Float64Array.from(signal, (v) => v - mean);
  const zero = acf(sig, 0, circular);
  if (!(zero > 1e-12)) return null;
  let best = null;
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.5) {
    const lag = (60 * rate) / bpm;
    if (!circular && lag * 2 > n) continue;
    // harmonics: a beat also repeats every 2 and 4 beats; half-beats count a little
    let score = acf(sig, lag, circular) + 0.5 * acf(sig, 2 * lag, circular) + 0.25 * acf(sig, lag / 2, circular);
    const oct = Math.log2(bpm / prior);
    score *= Math.exp(-0.5 * (oct / 0.9) ** 2);
    if (!best || score > best.score) best = { bpm, score, lag };
  }
  if (!best) return null;
  // refine with a parabola through the neighbors
  const f = (b) => acf(sig, (60 * rate) / b, circular);
  const a = f(best.bpm - 0.5), b = f(best.bpm), c = f(best.bpm + 0.5);
  const d = a - 2 * b + c;
  // (a flat top makes d tiny: never move further than the grid step)
  const bpm = d < 0 ? best.bpm + Math.max(-0.25, Math.min(0.25, (0.25 * (a - c)) / d)) : best.bpm;
  return { bpm, confidence: Math.max(0, Math.min(1, b / zero)) };
}

/**
 * Beat phase: the sample offset (0..period) from the end of the signal back to the latest beat.
 * For circular signals the offset is from the start (where in the loop a beat falls).
 */
export function beatPhase(signal, rate, bpm, { circular = false } = {}) {
  const n = signal.length;
  const period = (60 * rate) / bpm;
  const steps = Math.max(8, Math.round(period));
  let best = 0, bestS = -Infinity;
  for (let s = 0; s < steps; s++) {
    const phi = (s / steps) * period;
    let sum = 0;
    if (circular) {
      for (let t = phi; t < n; t += period) sum += lerpWrap(signal, t);
    } else {
      for (let k = 0, t = n - 1 - phi; t >= 0 && k < 16; k++, t -= period) sum += lerpAt(signal, t) * (1 - k / 20);
    }
    if (sum > bestS) {
      bestS = sum;
      best = phi;
    }
  }
  return best;
}

/** Music beat tracker fed with spectral frames (log magnitudes) at a fixed rate. */
export class BeatTracker {
  constructor(rate = 100, seconds = 6) {
    this.rate = rate;
    this.size = Math.round(rate * seconds);
    this.flux = [];
    this.prev = null;
    this.level = 0; // smoothed loudness 0..1
    this.bpm = null;
    this.confidence = 0;
    this.lastBeatT = 0; // seconds (caller's clock) of the latest beat
    this.pending = null;
    this.sinceEstimate = 0;
  }

  /**
   * spectrum: Float32Array of dB values; loud: RMS of the time signal (0..1); t: seconds.
   * Frames may come at uneven times (timers in a busy page): the onset envelope is resampled onto
   * an even `rate` grid using t, so tempo and phase stay exact.
   */
  push(spectrum, loud, t) {
    let f = 0;
    if (this.prev) {
      // 30 Hz .. ~5 kHz of a 2048 FFT at 48 kHz: bins 1..220. Low bins (kick drum) count double.
      const hi = Math.min(spectrum.length, 220);
      for (let i = 1; i < hi; i++) {
        const d = spectrum[i] - this.prev[i];
        if (d > 0 && Number.isFinite(d)) f += i < 12 ? 2 * d : d;
      }
    }
    this.prev = Float32Array.from(spectrum);
    this.level += (Math.min(1, loud * 4) - this.level) * 0.05;
    if (this.lastT == null || t <= this.lastT) {
      if (this.lastT == null) this.gridT = t;
      this.lastT = t;
      this.lastF = f;
      return;
    }
    if (t - this.lastT > 0.5) this.gridT = t; // a long stall: start the grid again
    // the flux of this frame spreads over the time since the last frame
    const rateF = f / ((t - this.lastT) * this.rate);
    while (this.gridT <= t) {
      this.flux.push(rateF);
      if (this.flux.length > this.size) this.flux.shift();
      this.gridT += 1 / this.rate;
      if (++this.sinceEstimate >= this.rate / 2) {
        this.sinceEstimate = 0;
        this.t = this.gridT;
        this.estimate();
      }
    }
    this.lastT = t;
    this.t = this.gridT;
  }

  estimate() {
    if (this.flux.length < this.rate * 3 || this.level < 0.02) {
      this.confidence *= 0.7;
      return;
    }
    const r = estimateTempo(this.flux, this.rate);
    if (!r || r.confidence < 0.08) {
      this.confidence *= 0.7;
      return;
    }
    // Accept a new tempo only when two estimates in a row agree (songs do not jump around).
    if (this.bpm && Math.abs(r.bpm / this.bpm - 1) < 0.04) {
      this.bpm += (r.bpm - this.bpm) * 0.3;
      this.confidence += (r.confidence - this.confidence) * 0.5;
    } else if (this.pending && Math.abs(r.bpm / this.pending - 1) < 0.04) {
      this.bpm = r.bpm;
      this.confidence = r.confidence;
      this.pending = null;
    } else {
      this.pending = r.bpm;
      this.confidence *= 0.85;
    }
    if (this.bpm) {
      const back = beatPhase(this.flux, this.rate, this.bpm);
      this.lastBeatT = this.t - back / this.rate;
    }
  }

  /** Is music playing with a tempo we trust? */
  get active() {
    return !!this.bpm && this.confidence > 0.12 && this.level > 0.02;
  }

  /** 0..1 position within the current beat at time t (0 = on the beat). */
  phaseAt(t) {
    if (!this.bpm) return 0;
    const p = ((t - this.lastBeatT) * this.bpm) / 60;
    return p - Math.floor(p);
  }
}

/**
 * Tempo of a dance clip from a movement signal sampled over one loop (`rate` samples per second).
 * Returns { bpm, beatAt (seconds into the clip of one beat), confidence } or null.
 */
export function motionTempo(signal, rate) {
  const r = estimateTempo(signal, rate, { circular: true, minBpm: 60, maxBpm: 180 });
  if (!r || r.confidence < 0.15) return null;
  // snap to a whole number of beats per loop (loops are cut on the beat when they come from music)
  const beats = Math.max(1, Math.round((signal.length / rate) * (r.bpm / 60)));
  const bpm = (beats * 60 * rate) / signal.length;
  const beatAt = beatPhase(signal, rate, bpm, { circular: true }) / rate;
  return { bpm, beatAt, confidence: r.confidence };
}

/**
 * Playback speed that lines the dance's beats up with the music's.
 * motion: { bpm, beatAt }, clipTime: current clip time (s); music: BeatTracker; now: seconds.
 * Returns the time scale (1 = normal speed) and the multiplier used (music beats per dance beat).
 */
export function syncRate(motion, clipTime, music, now, base = 1) {
  let best = null;
  for (const k of [0.5, 1, 2]) {
    const rate = (music.bpm * k) / motion.bpm; // dance at k dance-beats per music beat
    const cost = Math.abs(Math.log(rate / base));
    if (rate >= 0.55 && rate <= 1.8 && (!best || cost < best.cost)) best = { k, rate, cost };
  }
  if (!best) return null;
  // phase error in dance beats: where the music beat is vs where the dance beat is
  const dPhase = ((clipTime - motion.beatAt) * motion.bpm) / 60;
  const mPhase = ((now - music.lastBeatT) * music.bpm * best.k) / 60;
  let e = mPhase - dPhase;
  e -= Math.round(e);
  return { scale: best.rate * (1 + 0.6 * e), k: best.k, error: e };
}
