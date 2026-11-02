// Procedural sample dance, authored in code so it carries no third-party rights.
// 120 BPM, 8 beats (4 s), loops seamlessly: every term is periodic in the loop length.
// Rotations are local rotations relative to the T-pose rest (VRM normalized bone space).

export const BPM = 120;
export const LOOP_SECONDS = 4;
export const FPS = 30;

const TAU = Math.PI * 2;
const THIGH = 0.41; // upperLeg -> lowerLeg length in skeleton.mjs
const SHIN = 0.41;

/** Euler (applied Z first, then Y, then X; i.e. R = Rx * Ry * Rz) -> quaternion [x,y,z,w] */
export function eulerXYZ(x = 0, y = 0, z = 0) {
  const c1 = Math.cos(x / 2), s1 = Math.sin(x / 2);
  const c2 = Math.cos(y / 2), s2 = Math.sin(y / 2);
  const c3 = Math.cos(z / 2), s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

const lerp = (a, b, w) => a + (b - a) * w;

/** Pose at time t (seconds). Returns { hipsPosition:[x,y,z], rotations: { bone: [x,y,z] euler } } */
export function poseAt(t, restHipsY = 0.95) {
  const beat = (t * BPM) / 60; // 0..8
  const onBeat = 0.5 + 0.5 * Math.cos(TAU * beat); // 1 on each beat, 0 between
  const sway = Math.sin((TAU * beat) / 2); // one side per beat
  const twist = Math.sin((TAU * beat) / 4); // slow body twist
  // 0 at the start of the loop, 1 in the middle: section A (arm pumps) -> B (arms up) -> A
  const w = 0.5 - 0.5 * Math.cos((TAU * t) / LOOP_SECONDS);

  // Knee bounce, feet stay planted: hips drop by exactly what the bent legs lose.
  const knee = 0.12 + 0.28 * onBeat;
  const drop = THIGH * (1 - Math.cos(knee)) + SHIN * (1 - Math.cos(knee));

  const r = {};
  r.hips = [0, 0.22 * twist, 0.04 * sway];
  r.spine = [0.05, -0.12 * twist, -0.08 * sway];
  r.chest = [0.04 * onBeat, -0.08 * twist, -0.06 * sway];
  r.neck = [0, -0.02 * twist, 0.05 * sway];
  r.head = [0.1 * onBeat - 0.04, 0, 0.06 * sway];

  for (const side of ['left', 'right']) {
    const s = side === 'left' ? 1 : -1; // mirror sign
    const alt = side === 'left' ? 1 : -1; // alternate arms in section A

    // Section A: arms down, elbows bent, pumping forward/back on the beat
    const aX = -0.55 * alt * Math.sin((TAU * beat) / 2);
    const aZ = -1.15;
    const aBend = 1.25 + 0.3 * onBeat;
    // Section B: arms raised in a V, waving on the beat
    const bX = -0.15;
    const bZ = 0.55 + 0.3 * Math.sin(TAU * beat + (side === 'left' ? 0 : Math.PI));
    const bBend = 0.35 + 0.25 * onBeat;

    r[`${side}Shoulder`] = [0, 0, s * lerp(0, 0.12, w) * onBeat];
    r[`${side}UpperArm`] = [lerp(aX, bX, w), 0, s * lerp(aZ, bZ, w)];
    r[`${side}LowerArm`] = [0, -s * lerp(aBend, bBend, w), 0];
    r[`${side}Hand`] = [0, 0, s * lerp(-0.2, 0.25 * Math.sin(TAU * beat), w)];

    // Legs: bounce, plus a small alternating heel lift
    const lift = Math.max(0, alt * sway) * 0.12;
    r[`${side}UpperLeg`] = [-knee - lift, 0, -0.07 * sway]; // cancel hips roll/shift so feet stay put
    r[`${side}LowerLeg`] = [2 * knee + 2 * lift, 0, 0];
    r[`${side}Foot`] = [-knee - lift, 0, 0];
  }

  return {
    hipsPosition: [0.025 * sway, restHipsY - drop, 0],
    rotations: r,
  };
}
