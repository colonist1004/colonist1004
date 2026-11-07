// Generates the bundled, rights-free sample assets:
//   assets/characters/mannequin.vrm   — simple blocky VRM 1.0 humanoid
//   assets/motions/sample-dance.vrma  — procedural 4 s loop (VRM Animation 1.0)
// Usage: node scripts/make-samples.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GltfBuilder } from './gltf-writer.mjs';
import { BONES, BONE_MAP, addSkeletonNodes } from './skeleton.mjs';
import { poseAt, eulerXYZ, LOOP_SECONDS, FPS } from './dance.mjs';
import { POSES } from './poses.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

function write(rel, bytes) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, bytes);
  console.log(`wrote ${rel} (${bytes.byteLength} bytes)`);
}

// ---------------------------------------------------------------- mannequin.vrm

/** Axis-aligned box mesh data, centered at c, size s. */
function boxGeometry(c, s) {
  const [hx, hy, hz] = s.map((v) => v / 2);
  const faces = [
    [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
    [[-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
    [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]],
    [[0, -1, 0], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
    [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
    [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
  ];
  const pos = [], nrm = [], idx = [];
  for (const [n, corners] of faces) {
    const base = pos.length / 3;
    for (const k of corners) {
      pos.push(c[0] + k[0] * hx, c[1] + k[1] * hy, c[2] + k[2] * hz);
      nrm.push(...n);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { pos, nrm, idx };
}

const sub = (a, b) => a.map((v, i) => v - b[i]);

/** Box spanning from bone `from` to bone `to`, expressed in `from`'s local space. */
function segment(from, to, thickness) {
  const d = sub(BONE_MAP[to].pos, BONE_MAP[from].pos);
  const c = d.map((v) => v / 2);
  const s = d.map((v) => (Math.abs(v) > 1e-6 ? Math.abs(v) + thickness * 0.3 : thickness));
  return { c, s };
}

// [bone, material, center(local), size]
const PARTS = [
  ['hips', 1, [0, 0, 0], [0.3, 0.16, 0.18]],
  ['spine', 0, [0, 0.07, 0], [0.27, 0.16, 0.16]],
  ['chest', 0, [0, 0.1, 0], [0.32, 0.22, 0.18]],
  ['neck', 2, [0, 0.04, 0], [0.07, 0.09, 0.07]],
  ['head', 2, [0, 0.11, 0], [0.2, 0.23, 0.21]],
  ['head', 3, [0.045, 0.13, 0.106], [0.035, 0.03, 0.01]], // eyes: show which way it faces
  ['head', 3, [-0.045, 0.13, 0.106], [0.035, 0.03, 0.01]],
  ['head', 1, [0, 0.235, -0.01], [0.22, 0.04, 0.23]], // cap
];
for (const s of ['left', 'right']) {
  PARTS.push([`${s}UpperArm`, 0, ...Object.values(segment(`${s}UpperArm`, `${s}LowerArm`, 0.08))]);
  PARTS.push([`${s}LowerArm`, 2, ...Object.values(segment(`${s}LowerArm`, `${s}Hand`, 0.07))]);
  PARTS.push([`${s}Hand`, 2, [(s === 'left' ? 1 : -1) * 0.05, 0, 0], [0.1, 0.035, 0.08]]);
  PARTS.push([`${s}UpperLeg`, 1, ...Object.values(segment(`${s}UpperLeg`, `${s}LowerLeg`, 0.12))]);
  PARTS.push([`${s}LowerLeg`, 1, ...Object.values(segment(`${s}LowerLeg`, `${s}Foot`, 0.1))]);
  PARTS.push([`${s}Foot`, 3, [0, -0.045, 0.04], [0.1, 0.07, 0.22]]);
}

const MATERIALS = [
  { name: 'shirt', color: [0.95, 0.45, 0.35, 1] },
  { name: 'pants', color: [0.2, 0.25, 0.45, 1] },
  { name: 'skin', color: [1.0, 0.82, 0.7, 1] },
  { name: 'dark', color: [0.08, 0.08, 0.1, 1] },
];

function makeMannequin() {
  const b = new GltfBuilder();
  b.json.materials = MATERIALS.map((m) => ({
    name: m.name,
    pbrMetallicRoughness: { baseColorFactor: m.color, metallicFactor: 0, roughnessFactor: 0.8 },
  }));
  b.json.meshes = [];

  // Merge all parts of one bone (per material) into a single mesh.
  const perBone = {};
  for (const [bone, mat, c, s] of PARTS) {
    ((perBone[bone] ||= {})[mat] ||= []).push(boxGeometry(c, s));
  }
  const meshOf = {};
  for (const [bone, mats] of Object.entries(perBone)) {
    const primitives = [];
    for (const [mat, geos] of Object.entries(mats)) {
      const pos = [], nrm = [], idx = [];
      for (const g of geos) {
        const base = pos.length / 3;
        pos.push(...g.pos);
        nrm.push(...g.nrm);
        idx.push(...g.idx.map((i) => i + base));
      }
      primitives.push({
        attributes: {
          POSITION: b.addAccessor(new Float32Array(pos), 'VEC3', { target: ARRAY_BUFFER, minMax: true }),
          NORMAL: b.addAccessor(new Float32Array(nrm), 'VEC3', { target: ARRAY_BUFFER }),
        },
        indices: b.addAccessor(new Uint16Array(idx), 'SCALAR', { target: ELEMENT_ARRAY_BUFFER }),
        material: Number(mat),
      });
    }
    b.json.meshes.push({ name: bone, primitives });
    meshOf[bone] = b.json.meshes.length - 1;
  }

  // Meshes are rigidly attached to bones (no skinning needed for a blocky figure).
  const nodes = addSkeletonNodes(b, (name) => (name in meshOf ? { mesh: meshOf[name] } : {}));

  b.json.extensionsUsed = ['VRMC_vrm'];
  b.json.extensions = {
    VRMC_vrm: {
      specVersion: '1.0',
      meta: {
        name: 'Mannequin',
        version: '1.0',
        authors: ['desktop-dancer'],
        licenseUrl: 'https://vrm.dev/licenses/1.0/',
        avatarPermission: 'everyone',
        allowExcessivelyViolentUsage: true,
        allowExcessivelySexualUsage: false,
        commercialUsage: 'corporation',
        allowPoliticalOrReligiousUsage: true,
        allowAntisocialOrHateUsage: false,
        creditNotation: 'unnecessary',
        allowRedistribution: true,
        modification: 'allowModificationRedistribution',
      },
      humanoid: {
        humanBones: Object.fromEntries(BONES.map(([n]) => [n, { node: nodes[n] }])),
      },
    },
  };
  return b.toGlb();
}

// ------------------------------------------------------------ sample-dance.vrma

/** VRMA from a pose function: frames at `fps`, poseFn(t) -> { hipsPosition, rotations }. */
function makeClip(name, frames, fps, poseFn) {
  const b = new GltfBuilder();
  const nodes = addSkeletonNodes(b);
  const times = new Float32Array(frames);
  const rot = {};
  const hips = new Float32Array(frames * 3);
  for (let f = 0; f < frames; f++) {
    times[f] = f / fps;
    const pose = poseFn(f / fps);
    hips.set(pose.hipsPosition, f * 3);
    for (const [bone, e] of Object.entries(pose.rotations)) {
      (rot[bone] ||= new Float32Array(frames * 4)).set(e.length === 4 ? e : eulerXYZ(...e), f * 4); // quaternion or Euler
    }
  }

  const input = b.addAccessor(times, 'SCALAR', { minMax: true });
  const samplers = [];
  const channels = [];
  const add = (node, path, data, type) => {
    samplers.push({ input, output: b.addAccessor(data, type), interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node, path } });
  };
  add(nodes.hips, 'translation', hips, 'VEC3');
  for (const [bone, data] of Object.entries(rot)) add(nodes[bone], 'rotation', data, 'VEC4');
  b.json.animations = [{ name, samplers, channels }];

  b.json.extensionsUsed = ['VRMC_vrm_animation'];
  b.json.extensions = {
    VRMC_vrm_animation: {
      specVersion: '1.0',
      humanoid: { humanBones: Object.fromEntries(BONES.map(([n]) => [n, { node: nodes[n] }])) },
    },
  };
  return b.toGlb();
}

write('assets/characters/mannequin.vrm', makeMannequin());
function makeDance() {
  // last frame == first frame for a clean loop
  return makeClip('sample-dance', LOOP_SECONDS * FPS + 1, FPS, (t) => poseAt(t % LOOP_SECONDS, BONE_MAP.hips.pos[1]));
}

/** A still pose: two identical keys one second apart (the app adds breathing). */
function makePose(name, { hipsY = null, rotations }) {
  const hipsPosition = [0, hipsY ?? BONE_MAP.hips.pos[1], 0];
  return makeClip(name, 2, 1, () => ({ hipsPosition, rotations }));
}

write('assets/motions/sample-dance.vrma', makeDance());
for (const [name, pose] of Object.entries(POSES)) write(`assets/motions/${name}.pose.vrma`, makePose(name, pose));
