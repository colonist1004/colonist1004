// Checks the bundled still poses (assets/motions/*.pose.vrma) on the sample character:
// each loads as a VRMA, does not move, and stands on the floor (or sits on it).
//   node scripts/check-poses.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import { POSES } from './poses.mjs';

globalThis.self ??= globalThis;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const loader = new GLTFLoader();
loader.register((p) => new VRMLoaderPlugin(p));
loader.register((p) => new VRMAnimationLoaderPlugin(p));
const parse = (f) => {
  const b = readFileSync(f);
  return loader.parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '');
};

let failed = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
};

const dir = join(root, 'assets/motions');
const files = readdirSync(dir).filter((f) => f.endsWith('.pose.vrma'));
check(files.length === Object.keys(POSES).length, 'every built-in pose was generated', files.join(', '));
for (const f of files) {
  const name = f.replace(/\.pose\.vrma$/, '');
  const vrm = (await parse(join(root, 'assets/characters/mannequin.vrm'))).userData.vrm;
  const anim = (await parse(join(dir, f))).userData.vrmAnimations?.[0];
  if (!anim) {
    check(false, `${name}: is a VRMA`);
    continue;
  }
  const clip = createVRMAnimationClip(anim, vrm);
  const still = clip.tracks.every((t) => {
    const n = t.getValueSize();
    return t.values.every((v, i) => Math.abs(v - t.values[i % n]) < 1e-4);
  });
  const mixer = new THREE.AnimationMixer(vrm.scene);
  mixer.clipAction(clip).play();
  mixer.setTime(0.5);
  vrm.update(0);
  vrm.scene.updateMatrixWorld(true);
  const y = (b) => vrm.humanoid.getRawBoneNode(b).getWorldPosition(new THREE.Vector3()).y;
  const foot = Math.min(y('leftFoot'), y('rightFoot'));
  const sitting = POSES[name]?.hipsY != null;
  check(still, `${name}: holds still`);
  if (sitting) check(Math.abs(y('hips') - POSES[name].hipsY) < 0.05, `${name}: sits on the floor line`, `hips ${(y('hips') * 100).toFixed(0)} cm`);
  else check(foot > 0.02 && foot < 0.15, `${name}: stands on the floor`, `ankle ${(foot * 100).toFixed(1)} cm`);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall pose checks passed');
process.exit(failed ? 1 : 0);
