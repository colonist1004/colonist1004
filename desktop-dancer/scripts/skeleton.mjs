// VRM 1.0 humanoid reference skeleton in T-pose (meters, facing +Z, character's left = +X).
// Shared by the sample character and the sample dance so both use the same rest pose.

import { readFileSync } from 'node:fs';

// Single source of truth: shared/skeleton.json (also read by the Python pipeline).
const json = JSON.parse(readFileSync(new URL('../shared/skeleton.json', import.meta.url), 'utf8'));

/** [boneName, parentName, worldPosition] */
export const BONES = json.bones.map((b) => [b.name, b.parent, b.pos]);

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
