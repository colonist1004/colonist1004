// Non-destructive character tweaks (proportions and colors) for any VRM, stored next to the
// character as <name>.custom.json and applied when the model loads. Shared by the dancer window and
// the "캐릭터 만들기" preview.
//
// Proportions use uniform bone scales with the inverse on the child bone, so animation never shears
// (uniform scale commutes with rotation) and hands/feet keep their size. Leg changes keep the feet on
// the floor by moving the model root.
import * as THREE from 'three';
import { kindFromName } from './toon/toon.js';

// opaque: material name -> true (draw it opaque), false (keep its transparency); unset = automatic
export const DEFAULTS = { height: 1, head: 1, arms: 1, legs: 1, shoulders: 1, brightness: 1, colors: {}, opaque: {} };

// Overlays that are meant to be see-through (never made opaque automatically)
const OVERLAY = /blush|cheek|eyeline|lash|mastuge|matsuge|brow|mayu|shadow|highlight|tear|glass|lens|lace|veil|sheer|stocking|tights|_trans|transparent/i;

/** Alpha values of a texture, sampled small: shares of half-transparent and fully transparent texels. */
function alphaStats(tex) {
  const img = tex?.image;
  if (!img || !img.width || typeof document === 'undefined') return null;
  try {
    const n = 192;
    const c = Object.assign(document.createElement('canvas'), { width: n, height: n });
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, n, n);
    const d = g.getImageData(0, 0, n, n).data;
    let mid = 0;
    let clear = 0;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] > 24 && d[i] < 231) mid++;
      else if (d[i] <= 24) clear++;
    }
    return { mid: mid / (n * n), clear: clear / (n * n) };
  } catch {
    return null; // e.g. a texture the canvas cannot read
  }
}

/**
 * Find materials whose texture alpha is data, not transparency. Game-style textures (Genshin and
 * similar) keep emission/specular masks in the alpha channel; drawn as transparent (BLEND/MASK), the
 * clothes turn see-through or get holes and arms and the body show through them. Flags cloth/skin
 * materials whose alpha is half-transparent over a large area (real cut-outs are 0 or 1 with soft
 * edges only). Returns the flagged names.
 */
export function markAlphaData(vrm) {
  const flagged = [];
  for (const [name, mats] of listMaterials(vrm)) {
    for (const m of mats) {
      if (m.userData.alphaData !== undefined) continue;
      m.userData.alphaData = false;
      const usesAlpha = m.transparent || m.alphaTest > 0;
      const kind = kindFromName(name);
      if (!usesAlpha || !m.map || OVERLAY.test(name) || !(kind === 'cloth' || kind === 'skin')) continue;
      const st = alphaStats(m.map);
      if (st && st.mid > 0.2) {
        m.userData.alphaData = true;
        flagged.push(`${name} (반투명 ${Math.round(st.mid * 100)}%)`);
      }
    }
  }
  return flagged;
}

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

  // Transparency: opaque where the user said so, or where the alpha looks like data (markAlphaData).
  for (const [name, mats] of listMaterials(vrm)) {
    for (const m of mats) {
      const want = c.opaque?.[name] ?? !!m.userData.alphaData;
      m.userData.dancerAlphaBase ??= { transparent: m.transparent, alphaTest: m.alphaTest, depthWrite: m.depthWrite };
      const t = want ? { transparent: false, alphaTest: 0, depthWrite: true } : m.userData.dancerAlphaBase;
      if (m.transparent !== t.transparent || m.alphaTest !== t.alphaTest || m.depthWrite !== t.depthWrite) {
        Object.assign(m, t);
        m.needsUpdate = true;
      }
    }
  }

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
