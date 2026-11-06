// The toon shader patches find their anchors in the installed three-vrm's MToon shader:
//   node scripts/check-toon.mjs
// (A three-vrm update that changes the shader text would make the app silently fall back to plain MToon.)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { patchShader, kindFromName } from '../src/renderer/toon/toon.js';

const require = createRequire(import.meta.url);
const lib = readFileSync(require.resolve('@pixiv/three-vrm').replace(/three-vrm\.[a-z.]*js$/, 'three-vrm.module.js'), 'utf8');
const frag = JSON.parse(lib.match(/var mtoon_default2 = ("(?:[^"\\]|\\.)*");/)[1]);
const vert = JSON.parse(lib.match(/var mtoon_default = ("(?:[^"\\]|\\.)*");/)[1]);

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed++;
};
for (const kind of ['skin', 'face', 'hair', 'cloth', 'eye']) {
  for (const lm of [false, true]) {
    const sh = { fragmentShader: frag, vertexShader: vert };
    const r = patchShader(sh, kind, lm);
    check(r.ok && sh.fragmentShader.includes(`#define TOON_${kind.toUpperCase()}`) && sh.fragmentShader.includes('toonShadeColor'),
      `patches the ${kind} shader${lm ? ' with a light map' : ''}${r.ok ? '' : ` (missing: ${r.missing})`}`);
  }
}
const broken = { fragmentShader: frag.replace('float getShading(', 'float getShadingX('), vertexShader: vert };
const r = patchShader(broken, 'skin', false);
check(!r.ok && broken.fragmentShader.startsWith('// #define PHONG') === frag.startsWith('// #define PHONG') && !broken.fragmentShader.includes('#define TOON_') && !broken.fragmentShader.includes('toonShadeColor'), 'a missing anchor leaves the shader untouched');
const names = { Alicia_face: 'face', Alicia_hair: 'hair', Alicia_eye_white: 'eye', body_bake: 'skin', huku_bake: 'cloth', N00_000_Hair_00_HAIR: 'hair', Face_00_SKIN: 'face', EyeIris: 'eye', eyebrow: 'face' };
for (const [n, k] of Object.entries(names)) check(kindFromName(n) === k, `kind of "${n}" = ${k} (got ${kindFromName(n)})`);
assert.ok(true);
console.log(failed ? `\n${failed} check(s) failed` : '\nall toon checks passed');
process.exit(failed ? 1 : 0);
