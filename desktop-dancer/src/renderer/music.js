// Listens to what the PC is playing (Windows system audio loopback, through getDisplayMedia; main
// answers the request with the screen + 'loopback' audio) and tracks the beat. Audio never leaves
// the renderer: only the spectrum is analysed, nothing is recorded or saved.
import { BeatTracker } from './beat.js';

const RATE = 100; // analysis frames per second

export class Music {
  constructor(onState = () => {}) {
    this.tracker = new BeatTracker(RATE);
    this.onState = onState;
    this.ctx = null;
    this.stream = null;
    this.timer = null;
    this.running = false;
  }

  get active() {
    return this.running && this.tracker.active;
  }

  phase(now = performance.now() / 1000) {
    return this.tracker.phaseAt(now);
  }

  /** Audio-clock time in performance.now() seconds (exact spacing, same clock as the renderer). */
  _now() {
    const perf = performance.now() / 1000;
    const audio = this.ctx.currentTime;
    const off = perf - audio;
    // the audio clock moves in small blocks; the smallest offset seen is the true one
    this.offset = this.offset == null ? off : Math.min(off, this.offset + 0.0005);
    return audio + this.offset;
  }

  /** Start listening to the system audio. Resolves to true when audio is coming in. */
  async start() {
    if (this.running) return true;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      for (const t of stream.getVideoTracks()) t.stop(); // only the sound is used
      if (!stream.getAudioTracks().length) throw new Error('소리 트랙이 없습니다');
      this.stream = stream;
      this.ctx = new AudioContext();
      this._analyse(this.ctx.createMediaStreamSource(stream));
      this.onState({ listening: true });
      return true;
    } catch (e) {
      this.stop();
      this.onState({ listening: false, error: `PC 소리를 가져오지 못했습니다 (${e?.message || e})` });
      return false;
    }
  }

  /** Dev/test: a generated drum loop at `bpm` instead of the system audio (never audible). */
  startFake(bpm) {
    this.ctx = new AudioContext();
    const sr = this.ctx.sampleRate;
    const beat = 60 / bpm;
    const buf = this.ctx.createBuffer(1, Math.round(sr * beat * 8), sr);
    const d = buf.getChannelData(0);
    for (let b = 0; b < 8; b++) {
      for (const [off, amp, freq, len] of [[0, 0.9, 60, 0.12], [0.5, 0.35, 3000, 0.03]]) {
        const s0 = Math.round((b + off) * beat * sr);
        for (let i = 0; i < len * sr && s0 + i < d.length; i++) {
          const env = Math.exp((-i / sr) * 30);
          const tone = freq < 1000 ? Math.sin((2 * Math.PI * freq * i) / sr) : Math.random() * 2 - 1;
          d[s0 + i] += amp * env * tone;
        }
      }
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.start();
    this._analyse(src);
    this.onState({ listening: true, fake: bpm });
  }

  _analyse(source) {
    const an = this.ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0;
    source.connect(an); // not connected to the speakers
    const spec = new Float32Array(an.frequencyBinCount);
    const wave = new Float32Array(an.fftSize);
    this.ctx.resume?.();
    this.running = true;
    this.timer = setInterval(() => {
      an.getFloatFrequencyData(spec);
      an.getFloatTimeDomainData(wave);
      let e = 0;
      for (const v of wave) e += v * v;
      this.tracker.push(spec, Math.sqrt(e / wave.length), this._now());
    }, 1000 / RATE);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const t of this.stream?.getTracks() || []) t.stop();
    this.stream = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.running = false;
    this.offset = null;
    this.tracker = new BeatTracker(RATE);
  }
}
