// VRM 1.0 humanoid reference skeleton in T-pose (meters, facing +Z, character's left = +X).
// Shared by the sample character and the sample dance so both use the same rest pose.

/** [boneName, parentName, worldPosition] */
export const BONES = [
  ['hips', null, [0, 0.95, 0]],
  ['spine', 'hips', [0, 1.05, 0]],
  ['chest', 'spine', [0, 1.2, 0]],
  ['neck', 'chest', [0, 1.42, 0]],
  ['head', 'neck', [0, 1.5, 0]],

  ['leftShoulder', 'chest', [0.04, 1.38, 0]],
  ['leftUpperArm', 'leftShoulder', [0.17, 1.38, 0]],
  ['leftLowerArm', 'leftUpperArm', [0.43, 1.38, 0]],
  ['leftHand', 'leftLowerArm', [0.67, 1.38, 0]],
  ['rightShoulder', 'chest', [-0.04, 1.38, 0]],
  ['rightUpperArm', 'rightShoulder', [-0.17, 1.38, 0]],
  ['rightLowerArm', 'rightUpperArm', [-0.43, 1.38, 0]],
  ['rightHand', 'rightLowerArm', [-0.67, 1.38, 0]],

  ['leftUpperLeg', 'hips', [0.09, 0.91, 0]],
  ['leftLowerLeg', 'leftUpperLeg', [0.09, 0.5, 0]],
  ['leftFoot', 'leftLowerLeg', [0.09, 0.09, 0]],
  ['leftToes', 'leftFoot', [0.09, 0.02, 0.12]],
  ['rightUpperLeg', 'hips', [-0.09, 0.91, 0]],
  ['rightLowerLeg', 'rightUpperLeg', [-0.09, 0.5, 0]],
  ['rightFoot', 'rightLowerLeg', [-0.09, 0.09, 0]],
  ['rightToes', 'rightFoot', [-0.09, 0.02, 0.12]],
];

export const BONE_MAP = Object.fromEntries(BONES.map(([n, p, pos]) => [n, { parent: p, pos }]));

export function localTranslation(name) {
  const { parent, pos } = BONE_MAP[name];
  if (!parent) return [...pos];
  const pp = BONE_MAP[parent].pos;
  return [pos[0] - pp[0], pos[1] - pp[1], pos[2] - pp[2]];
}

/** Adds the skeleton as glTF nodes. Returns { boneName: nodeIndex }. */
export function addSkeletonNodes(builder, extraForBone = () => ({})) {
  const index = {};
  for (const [name] of BONES) {
    index[name] = builder.addNode({ name, translation: localTranslation(name), ...extraForBone(name) });
  }
  for (const [name, parent] of BONES) {
    if (!parent) continue;
    const p = builder.json.nodes[index[parent]];
    (p.children ||= []).push(index[name]);
  }
  builder.json.scenes[0].nodes.push(index.hips);
  return index;
}
