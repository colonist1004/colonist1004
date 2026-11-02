// Headless sanity check of the character/motion pipeline (no window needed):
//   node scripts/check-assets.mjs [character.vrm] [motion.vrma]
// Loads both with the same loaders the app uses, plays the motion and checks that
// the feet stay on the floor (little sliding), nothing sinks below the floor and the loop is seamless.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

// Textures are irrelevant here; let GLTFLoader fail them quietly in Node.
globalThis.self ??= globalThis;
for (const k of ['warn', 'error']) {
  const orig = console[k];
  console[k] = (...a) => (/texture/i.test(String(a[0])) ? undefined : orig(...a));
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const charPath = process.argv[2] || join(root, 'assets/characters/mannequin.vrm');
const motionPath = process.argv[3] || join(root, 'assets/motions/sample-dance.vrma');

const loader = new GLTFLoader();
loader.register((p) => new VRMLoaderPlugin(p));
loader.register((p) => new VRMAnimationLoaderPlugin(p));

async function parse(file) {
  const b = readFileSync(file);
  return loader.parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '');
}

let failed = 0;
function check(ok, label, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}

const vrm = (await parse(charPath)).userData.vrm;
check(!!vrm, 'character is a VRM', charPath);
const anim = (await parse(motionPath)).userData.vrmAnimations?.[0];
check(!!anim, 'motion is a VRMA', motionPath);
if (!vrm || !anim) process.exit(1);

VRMUtils.rotateVRM0(vrm);
const required = ['hips', 'spine', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm',
  'rightLowerArm', 'rightHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
const missing = required.filter((b) => !vrm.humanoid.getRawBoneNode(b));
check(missing.length === 0, 'required humanoid bones present', missing.join(', ') || `${required.length} bones`);

const clip = createVRMAnimationClip(anim, vrm);
check(clip.tracks.length > 0, 'clip has tracks', `${clip.tracks.length} tracks, ${clip.duration.toFixed(2)} s`);

const mixer = new THREE.AnimationMixer(vrm.scene);
mixer.clipAction(clip).play();

const pos = (bone) => vrm.humanoid.getRawBoneNode(bone).getWorldPosition(new THREE.Vector3());
const sample = (t) => {
  mixer.setTime(t);
  vrm.update(0);
  vrm.scene.updateMatrixWorld(true);
  return Object.fromEntries(required.map((b) => [b, pos(b)]));
};

const rest = sample(0);
const footRestY = Math.min(rest.leftFoot.y, rest.rightFoot.y);
let maxSlide = 0, maxLift = 0, minY = Infinity;
const steps = 120;
for (let i = 0; i <= steps; i++) {
  const p = sample((clip.duration * i) / steps);
  for (const f of ['leftFoot', 'rightFoot']) {
    maxSlide = Math.max(maxSlide, Math.hypot(p[f].x - rest[f].x, p[f].z - rest[f].z));
    maxLift = Math.max(maxLift, p[f].y - rest[f].y);
  }
  for (const v of Object.values(p)) minY = Math.min(minY, v.y);
}
const height = rest.head.y;
check(maxSlide < height * 0.05, 'feet do not slide', `max ${(maxSlide * 100).toFixed(1)} cm`);
check(maxLift < height * 0.08, 'feet stay near the floor', `max lift ${(maxLift * 100).toFixed(1)} cm`);
check(minY > footRestY - height * 0.02, 'nothing sinks below the floor', `lowest joint ${(minY * 100).toFixed(1)} cm`);

const a = sample(0), b = sample(clip.duration - 1e-4);
const seam = Math.max(...required.map((k) => a[k].distanceTo(b[k])));
check(seam < height * 0.01, 'loop is seamless', `max jump ${(seam * 1000).toFixed(1)} mm`);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
