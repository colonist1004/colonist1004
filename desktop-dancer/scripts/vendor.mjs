// Copies the browser ES modules the renderer imports from node_modules into
// src/renderer/vendor/ (git-ignored). Needed because electron-builder drops
// node_modules/*/examples/ — where three's GLTFLoader lives — from packaged apps.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src/renderer/vendor');
const files = {
  'three/build/three.module.js': 'three.module.js',
  'three/examples/jsm/loaders/GLTFLoader.js': 'jsm/loaders/GLTFLoader.js',
  'three/examples/jsm/utils/BufferGeometryUtils.js': 'jsm/utils/BufferGeometryUtils.js',
  '@pixiv/three-vrm/lib/three-vrm.module.js': 'three-vrm.module.js',
  '@pixiv/three-vrm-animation/lib/three-vrm-animation.module.js': 'three-vrm-animation.module.js',
};

rmSync(out, { recursive: true, force: true });
for (const [src, dest] of Object.entries(files)) {
  const to = join(out, dest);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join(root, 'node_modules', src), to);
}
console.log(`vendored ${Object.keys(files).length} modules into src/renderer/vendor`);
