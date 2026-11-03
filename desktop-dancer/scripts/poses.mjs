// Built-in still poses (authored in code, no third-party rights). Same conventions as dance.mjs:
// local Euler rotations [x, y, z] relative to the T-pose (R = Rx * Ry * Rz), hips position in meters.
// The left side is written once; the right side mirrors it (y and z flip sign).

const side = (left) => {
  const out = {};
  for (const [bone, [x, y, z]] of Object.entries(left)) {
    out[`left${bone}`] = [x, y, z];
    out[`right${bone}`] = [x, -y, -z];
  }
  return out;
};

/** name -> { hipsY (meters above the floor, null = standing height), rotations } */
export const POSES = {
  '편하게 서기': {
    rotations: {
      spine: [0.02, 0, 0],
      head: [0.05, 0, 0.04],
      ...side({ UpperArm: [0.1, 0, -1.3], LowerArm: [0, -0.25, 0], Hand: [0, 0, -0.1] }),
      leftUpperLeg: [0, 0, 0.04],
      rightUpperLeg: [0, 0, -0.06],
    },
  },
  '허리에 손': {
    rotations: {
      head: [0, 0.1, 0.06],
      ...side({ UpperArm: [1.62, -0.72, -0.27], LowerArm: [0, -1.97, 0], Hand: [0, 0, 0.2] }),
      leftUpperLeg: [0, 0, 0.08],
      rightUpperLeg: [0, 0, -0.08],
    },
  },
  '만세': {
    rotations: {
      chest: [-0.06, 0, 0],
      head: [-0.12, 0, 0],
      ...side({ UpperArm: [0, 0, 1.15], LowerArm: [0, -0.15, 0], Hand: [0, 0, 0.2] }),
      leftUpperLeg: [0, 0, 0.06],
      rightUpperLeg: [0, 0, -0.06],
    },
  },
  '걸터앉기': {
    // sitting on the top edge of the taskbar, lower legs hanging in front of it
    hipsY: 0.09,
    rotations: {
      spine: [0.12, 0, 0],
      head: [0.08, 0, 0.06],
      ...side({ UpperArm: [0.35, 0.2, -1.2], LowerArm: [0, -0.7, 0], UpperLeg: [-1.45, 0, 0.06], LowerLeg: [1.35, 0, 0], Foot: [0.2, 0, 0] }),
    },
  },
};
