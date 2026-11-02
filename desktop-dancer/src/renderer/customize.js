// Non-destructive character tweaks (proportions and colors) for any VRM, stored next to the
// character as <name>.custom.json and applied when the model loads. Shared by the dancer window and
// the "캐릭터 만들기" preview.
//
// Proportions use uniform bone scales with the inverse on the child bone, so animation never shears
// (uniform scale commutes with rotation) and hands/feet keep their size. Leg changes keep the feet on
// the floor by moving the model root.
import * as THREE from 'three';

export const DEFAULTS = { height: 1, head: 1, arms: 1, legs: 1, shoulders: 1, brightness: 1, colors: {} };

export const SLIDERS = [
  { key: 'height', label: '키', min: 0.8, max: 1.25, step: 0.01 },
  { key: 'head', label: '머리 크기', min: 0.75, max: 1.4, step: 0.01 },
  { key: 'shoulders', label: '어깨 너비', min: 0.8, max: 1.25, step: 0.01 },
  { key: 'arms', label: '팔 길이', min: 0.85, max: 1.2, step: 0.01 },
  { key: 'legs', label: '다리 길이', min: 0.85, max: 1.25, step: 0.01 },
  { key: 'brightness', label: '전체 밝기', min: 0.6, max: 1.4, step: 0.01 },
];

const tmp = new THREE.Vector3();

function worldY(node) {
  node.updateWorldMatrix(true, false);
  return node.getWorldPosition(tmp).y;
}

/** Unique materials of the model, by name (unnamed ones get a numbered name). */
export function listMaterials(vrm) {
  const out = new Map();
  let k = 0;
  vrm.scene.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m || m.name?.endsWith('(Outline)')) continue;
      const name = m.name || `재질 ${++k}`;
      if (!out.has(name)) out.set(name, []);
      out.get(name).push(m);
    }
  });
  return out;
}

export function applyCustomization(vrm, custom) {
  const c = { ...DEFAULTS, ...(custom || {}) };
  const h = vrm.humanoid;
  const raw = (n) => h.getRawBoneNode(n);
  const set = (n, s) => raw(n)?.scale.setScalar(s);
  const root = vrm.scene;

  // Remember the untouched state once.
  if (!root.userData.dancerBase) {
    root.userData.dancerBase = { position: root.position.clone(), scale: root.scale.clone() };
  }
  const base = root.userData.dancerBase;
  root.position.copy(base.position);
  root.scale.copy(base.scale);
  for (const n of ['head', 'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftHand', 'rightHand',
                   'leftUpperLeg', 'rightUpperLeg', 'leftFoot', 'rightFoot']) set(n, 1);

  // Leg length before scaling (rest pose), to keep the feet on the floor afterwards.
  const legLen = raw('leftUpperLeg') && raw('leftFoot') ? worldY(raw('leftUpperLeg')) - worldY(raw('leftFoot')) : 0;

  set('head', c.head);
  for (const s of ['left', 'right']) {
    if (raw(`${s}Shoulder`)) {
      set(`${s}Shoulder`, c.shoulders);
      set(`${s}UpperArm`, c.arms / c.shoulders);
    } else {
      set(`${s}UpperArm`, c.arms);
    }
    set(`${s}Hand`, 1 / c.arms);
    set(`${s}UpperLeg`, c.legs);
    set(`${s}Foot`, 1 / c.legs);
  }
  root.scale.copy(base.scale).multiplyScalar(c.height);
  root.position.y = base.position.y + (c.legs - 1) * legLen * c.height;

  // Colors: tint per material on top of the original color, then overall brightness.
  for (const [name, mats] of listMaterials(vrm)) {
    const tint = new THREE.Color(c.colors?.[name] || '#ffffff');
    for (const m of mats) {
      for (const prop of ['color', 'shadeColorFactor']) {
        if (!m[prop]?.isColor) continue;
        m.userData.dancerBase ??= {};
        m.userData.dancerBase[prop] ??= m[prop].clone();
        m[prop].copy(m.userData.dancerBase[prop]).multiply(tint).multiplyScalar(c.brightness);
      }
    }
  }
  root.updateMatrixWorld(true);
}
