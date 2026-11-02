// Headless sanity check of the character/motion pipeline (no window needed):
//   node scripts/check-assets.mjs [character.vrm] [motion.vrma] [--no-loop]
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
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const charPath = args[0] || join(root, 'assets/characters/mannequin.vrm');
const motionPath = args[1] || join(root, 'assets/motions/sample-dance.vrma');

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

// Floor = foot height in the character's rest pose (before any motion is applied).
mixer.stopAllAction();
vrm.humanoid.resetNormalizedPose();
vrm.update(0);
vrm.scene.updateMatrixWorld(true);
const restPose = Object.fromEntries(required.map((b) => [b, pos(b)]));
const floorY = Math.min(restPose.leftFoot.y, restPose.rightFoot.y);
const height = restPose.head.y;
mixer.clipAction(clip).play();

// Sample at 30 fps. Sliding = horizontal speed of whichever foot is on the floor (the support foot).
const dt = 1 / 30;
const frames = Math.max(2, Math.round(clip.duration / dt));
let minY = Infinity, prev = null, slideSum = 0, slideN = 0, slideMax = 0;
const lowest = [];
for (let i = 0; i <= frames; i++) {
  const p = sample(Math.min(i * dt, clip.duration - 1e-4));
  for (const v of Object.values(p)) minY = Math.min(minY, v.y);
  const support = p.leftFoot.y < p.rightFoot.y ? 'leftFoot' : 'rightFoot';
  lowest.push(p[support].y - floorY);
  if (prev && p[support].y - floorY < height * 0.03) {
    const v = Math.hypot(p[support].x - prev[support].x, p[support].z - prev[support].z) / dt;
    slideSum += v;
    slideN++;
    slideMax = Math.max(slideMax, v);
  }
  prev = p;
}
const slide = slideN ? slideSum / slideN : 0;
lowest.sort((a, b) => a - b);
const p90 = lowest[Math.floor(lowest.length * 0.9)];
check(slide < 0.15, 'support foot does not slide', `mean ${(slide * 100).toFixed(1)} cm/s, max ${(slideMax * 100).toFixed(0)} cm/s`);
check(p90 < height * 0.06, 'a foot stays on the floor', `p90 ${(p90 * 100).toFixed(1)} cm above floor`);
check(minY > floorY - height * 0.02, 'nothing sinks below the floor', `lowest joint ${((minY - floorY) * 100).toFixed(1)} cm vs floor`);

if (!process.argv.includes('--no-loop')) {
  const a = sample(0), b = sample(clip.duration - 1e-4);
  const seam = Math.max(...required.map((k) => a[k].distanceTo(b[k])));
  check(seam < height * 0.01, 'loop is seamless', `max jump ${(seam * 1000).toFixed(1)} mm`);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
