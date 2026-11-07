// Poses written as where the limbs point, turned into bone rotations. Shared by the built-in pose
// files (scripts/poses.mjs) and the sitting styles in life.js. No dependencies (runs in Node too).
//
// Coordinates are VRM 1.0: +Y up, the body faces +Z, character left = +X, T-pose rest = identity.
// `dirs` give a limb's direction in its torso's frame (arms: the chest, legs: the hips), so a lean
// of the spine carries the arms with it. `euler` gives plain local rotations [x, y, z]
// (R = Rx * Ry * Rz, like scripts/dance.mjs) for the other bones.

const norm = (v) => {
  const l = Math.hypot(...v) || 1;
  return v.map((x) => x / l);
};
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
/** Shortest rotation taking unit vector a to unit vector b. */
function between(a, b) {
  a = norm(a);
  b = norm(b);
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.999999) {
    const axis = Math.abs(a[0]) < 0.9 ? norm([0, -a[2], a[1]]) : norm([a[2], 0, -a[0]]);
    return [...axis, 0];
  }
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return norm([c[0], c[1], c[2], 1 + d]);
}
/** Euler [x, y, z] (R = Rx * Ry * Rz) to a quaternion [x, y, z, w]. */
export function eulerQ([x = 0, y = 0, z = 0]) {
  const c1 = Math.cos(x / 2), s1 = Math.sin(x / 2);
  const c2 = Math.cos(y / 2), s2 = Math.sin(y / 2);
  const c3 = Math.cos(z / 2), s3 = Math.sin(z / 2);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
}

// limb chains: [upper, lower, end], the rest direction of the chain
const CHAINS = {
  leftArm: [['leftUpperArm', 'leftLowerArm', 'leftHand'], [1, 0, 0]],
  rightArm: [['rightUpperArm', 'rightLowerArm', 'rightHand'], [-1, 0, 0]],
  leftLeg: [['leftUpperLeg', 'leftLowerLeg', 'leftFoot'], [0, -1, 0]],
  rightLeg: [['rightUpperLeg', 'rightLowerLeg', 'rightFoot'], [0, -1, 0]],
};

/**
 * spec: { hipsY?, euler?: { bone: [x, y, z] }, limbs?: { leftArm: [upperDir, lowerDir, endDir?], ... } }
 * -> { hipsY, rotations: { bone: [x, y, z, w] } } (local rotations from the T-pose)
 */
export function buildPose(spec) {
  const rot = {};
  for (const [b, e] of Object.entries(spec.euler || {})) rot[b] = eulerQ(e);
  for (const [chain, dirs] of Object.entries(spec.limbs || {})) {
    const [[upper, lower, end], rest] = CHAINS[chain];
    const [u, f, h] = dirs;
    // the upper bone turns from rest to u; the lower bends from u to f (keeps the twist); the end from f to h
    const wu = between(rest, u);
    const wl = qmul(between(u, f), wu);
    rot[upper] = wu;
    rot[lower] = qmul(qinv(wu), wl);
    if (h) rot[end] = qmul(qinv(wl), qmul(between(f, h), wl));
  }
  return { hipsY: spec.hipsY ?? null, rotations: rot };
}

// ------------------------------------------------------------------ pieces

const SIT_Y = 0.09; // hips above the edge in the reference skeleton (rest hips 0.95)
const legs = {
  // thighs forward, lower legs hanging over the edge
  hang: { leftLeg: [[0.04, -0.12, 1], [0, -1, 0.12]], rightLeg: [[-0.04, -0.12, 1], [0, -1, 0.12]] },
  // right leg over the left: its thigh rests on the left knee, its lower leg hangs outside the left one
  cross: { leftLeg: [[0.06, -0.12, 1], [0, -1, 0.1]], rightLeg: [[0.42, 0.3, 0.86], [0.22, -0.92, 0.32], [0.1, -0.3, 1]] },
  // knees and feet together
  together: { leftLeg: [[-0.06, -0.12, 1], [0.02, -1, 0.15]], rightLeg: [[0.06, -0.12, 1], [-0.02, -1, 0.15]] },
};
const arms = {
  // hanging at the sides, hands on the seat beside the hips
  side: { leftArm: [[0.18, -1, 0.05], [0.05, -1, 0.15]], rightArm: [[-0.18, -1, 0.05], [-0.05, -1, 0.15]] },
  // crossed in front of the chest, the right forearm over the left
  crossed: { leftArm: [[0.12, -0.85, 0.5], [-0.95, 0.1, 0.25]], rightArm: [[-0.12, -0.82, 0.55], [0.95, 0.18, 0.4]] },
  // hands resting on the thighs
  lap: { leftArm: [[0.12, -0.85, 0.5], [-0.2, -0.5, 0.85]], rightArm: [[-0.12, -0.85, 0.5], [0.2, -0.5, 0.85]] },
  // leaning back on the hands, placed on the seat behind
  back: { leftArm: [[0.25, -0.85, -0.45], [0.2, -0.9, -0.4]], rightArm: [[-0.25, -0.85, -0.45], [-0.2, -0.9, -0.4]] },
  // the right hand under the chin, its elbow on the knee; the left on the lap
  chin: { leftArm: [[0.12, -0.85, 0.5], [-0.2, -0.5, 0.85]], rightArm: [[-0.05, -0.55, 0.83], [0.25, 0.95, -0.1]] },
  // hands clasped in front, low
  clasp: { leftArm: [[0.1, -0.97, 0.2], [-0.6, -0.55, 0.58]], rightArm: [[-0.1, -0.97, 0.2], [0.6, -0.55, 0.58]] },
};

/**
 * Sitting styles for life.js (rest, perch, sit while dancing): legs and arms; `swing` = the lower legs
 * swing (not with crossed legs). Dancing uses only the legs.
 */
export const SIT_STYLES = {
  basic: { label: '다리 흔들기', swing: true, ...buildPose({ hipsY: SIT_Y, euler: { spine: [0.12, 0, 0] }, limbs: { ...legs.hang, ...arms.side } }) },
  crossLegs: { label: '다리 꼬기', swing: false, ...buildPose({ hipsY: SIT_Y, euler: SIT_EULER('crossLegs'), limbs: { ...legs.cross, ...arms.lap } }) },
  crossArms: { label: '팔짱 끼기', swing: true, ...buildPose({ hipsY: SIT_Y, euler: SIT_EULER('crossArms'), limbs: { ...legs.hang, ...arms.crossed } }) },
  crossBoth: { label: '다리 꼬고 팔짱', swing: false, ...buildPose({ hipsY: SIT_Y, euler: SIT_EULER('crossBoth'), limbs: { ...legs.cross, ...arms.crossed } }) },
  leanBack: { label: '뒤로 기대기', swing: true, ...buildPose({ hipsY: SIT_Y, euler: SIT_EULER('leanBack'), limbs: { ...legs.hang, ...arms.back } }) },
  lap: { label: '무릎에 손', swing: true, ...buildPose({ hipsY: SIT_Y, euler: SIT_EULER('lap'), limbs: { ...legs.together, ...arms.lap } }) },
  chin: { label: '턱 괴기', swing: false, ...buildPose({ hipsY: SIT_Y, euler: SIT_EULER('chin'), limbs: { ...legs.cross, ...arms.chin } }) },
};

/** Built-in still poses made from these pieces (written by scripts/make-samples.mjs). */
export const BUILT_POSES = {
  '팔짱 끼기': buildPose({ euler: { head: [0.04, 0.12, 0.06], leftUpperLeg: [0, 0, 0.05], rightUpperLeg: [0, 0, -0.05] }, limbs: { ...arms.crossed } }),
  '손 모으기': buildPose({ euler: { head: [0.1, 0, 0.1], spine: [0.04, 0, 0], leftUpperLeg: [0, 0, -0.02], rightUpperLeg: [0, 0, 0.02] }, limbs: { ...arms.clasp } }),
  '다리 꼬고 앉기': buildPose({ hipsY: SIT_Y, euler: SIT_EULER('crossLegs'), limbs: { ...legs.cross, ...arms.lap } }),
  '팔짱 끼고 앉기': buildPose({ hipsY: SIT_Y, euler: SIT_EULER('crossArms'), limbs: { ...legs.hang, ...arms.crossed } }),
  '다리 꼬고 팔짱 끼고 앉기': buildPose({ hipsY: SIT_Y, euler: SIT_EULER('crossBoth'), limbs: { ...legs.cross, ...arms.crossed } }),
  '뒤로 기대 앉기': buildPose({ hipsY: SIT_Y, euler: SIT_EULER('leanBack'), limbs: { ...legs.hang, ...arms.back } }),
  '무릎에 손 올리고 앉기': buildPose({ hipsY: SIT_Y, euler: SIT_EULER('lap'), limbs: { ...legs.together, ...arms.lap } }),
  '턱 괴고 앉기': buildPose({ hipsY: SIT_Y, euler: SIT_EULER('chin'), limbs: { ...legs.cross, ...arms.chin } }),
};
function SIT_EULER(style) {
  return {
    crossLegs: { spine: [0.05, 0, 0] },
    crossArms: { spine: [0.02, 0, 0], head: [0.05, 0, 0.08] },
    crossBoth: { spine: [-0.02, 0, 0], head: [0.04, 0.12, 0.06] },
    leanBack: { spine: [-0.16, 0, 0], head: [0.1, 0, 0] },
    lap: { spine: [0.14, 0, 0], head: [0.06, 0, 0.1] },
    chin: { spine: [0.28, 0, 0], neck: [0.05, 0, 0], head: [-0.1, 0.1, 0.18] },
  }[style];
}
