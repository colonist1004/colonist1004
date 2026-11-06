// Desktop Dancer toon look: patches three-vrm's MToonMaterial instead of replacing it, so skinning,
// morphs, outlines, expressions, UV animation and customize.js (color, shadeColorFactor) keep working.
//
// - two-step cel shading with a crisp terminator (getShading)
// - a shadow color even for models whose shade color equals the lit color
// - face: shaded from the head bone as if it were a sphere (smooth, follows the light as the head turns)
// - hair: a highlight band that slides as the head moves; skin: a warm shade and a thin warm terminator
// - cloth: an optional light map's G channel shifts the shading (extras.dancerToon.lightmap)
// - hair shadows on the face: hair-only depth pass at half resolution, sampled toward the light
// - rim light per kind; outlines untouched (outline materials are never patched)
//
// Material info comes from glTF material extras `dancerToon` ({ version, kind, lightmap, faceShadow,
// shadeWarm }) written by a converter, else from the material name. Everything is reversible:
// removeToon() restores the original shader hooks and uniform values.
import * as THREE from 'three';
import { CHUNKS } from './toon-chunks.js';

const KINDS = ['skin', 'face', 'hair', 'cloth', 'eye'];
const RIM = { skin: [0.12, 0.08, 0.08], face: [0.06, 0.04, 0.04], hair: [0.06, 0.06, 0.08], cloth: [0.08, 0.08, 0.1], eye: [0, 0, 0] };
const SHADE_WARM = { skin: [0.88, 0.76, 0.8], face: [0.9, 0.78, 0.8], hair: [0.82, 0.8, 0.92], cloth: [0.84, 0.82, 0.9], eye: [1, 1, 1] };

// Lighting presets (spec 6.1): the strong hemisphere light filled the shade with ambient light.
// The camera looks straight at the character, so a light from almost straight ahead (1, 2, 3) leaves
// hardly any surface in shade: the toon light comes more from the side and above.
const LIGHTS = {
  normal: { sky: 0xffffff, ground: 0x8888aa, hemi: 1.1, sun: 0xffffff, sunI: 1.4, pos: [1, 2, 3] },
  toon: { sky: 0xffffff, ground: 0xc8c8d8, hemi: 0.6, sun: 0xfff4e8, sunI: 2.1, pos: [2.2, 2.4, 1.4] },
};

/** Guess the kind of a material from its name (Avatar Studio writes extras instead). */
export function kindFromName(name = '') {
  const n = name.toLowerCase();
  if (/eye|iris|hitomi|pupil|目|瞳|白目/.test(n) && !/eyebrow|mayu|brow|lash|mastuge|matsuge/.test(n)) return 'eye';
  if (/face|kao|顔|mouth|cheek|brow|mayu|lash|mastuge|matsuge/.test(n)) return 'face';
  if (/hair|kami|髪|bang|ponytail/.test(n)) return 'hair';
  if (/skin|body(?!_?wear)|hada|肌|arm(?!o?r)|leg_?skin|hand/.test(n)) return 'skin';
  return 'cloth';
}

export class Toon {
  constructor() {
    this.uniforms = {
      uToonStrength: { value: 1 },
      uHeadForward: { value: new THREE.Vector3(0, 0, 1) },
      uHeadRight: { value: new THREE.Vector3(1, 0, 0) },
      uHeadUp: { value: new THREE.Vector3(0, 1, 0) },
      uHeadCenter: { value: new THREE.Vector3() },
      uHeadRadius: { value: 0.1 },
      uLightDirView: { value: new THREE.Vector3(0, 0, 1) },
      uHairDepth: { value: null },
      uHairShadowOn: { value: 0 },
      uHairShadowOffset: { value: new THREE.Vector2() },
      uResolution: { value: new THREE.Vector2(1, 1) },
    };
    this.patched = [];
    this.enabled = false;
    this.hairShadow = true;
    this.hairMeshes = [];
    this.depthTarget = null;
    this.depthMaterial = new THREE.MeshDepthMaterial();
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix3();
  }

  /** Lights to the toon preset (or back). */
  setLights(hemi, sun, on) {
    const p = on ? LIGHTS.toon : LIGHTS.normal;
    hemi.color.set(p.sky);
    hemi.groundColor.set(p.ground);
    hemi.intensity = p.hemi;
    sun.color.set(p.sun);
    sun.intensity = p.sunI;
    sun.position.set(...p.pos);
  }

  /**
   * Patch every MToon surface material of a loaded VRM. gltf: the GLTFLoader result (for extras and
   * extra textures). opts: { enabled, strength, hairShadow }.
   */
  async apply(vrm, gltf, opts = {}) {
    this.remove();
    this.vrm = vrm;
    const parser = gltf?.parser;
    const jobs = [];
    const seen = new Set(); // materials shared by several meshes are patched once
    this.hairMeshes = [];
    vrm.scene.traverse((obj) => {
      if (!obj.isMesh) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (!mat?.isMToonMaterial || mat.isOutline || /\(Outline\)$/.test(mat.name) || mat.userData.toonApplied || seen.has(mat)) continue;
        seen.add(mat);
        mat.userData.toonApplied = true; // before any await
        jobs.push(this._patch(mat, parser));
      }
      if (mats.some((m) => m?.isMToonMaterial && !m.isOutline && kindOf(m, parser) === 'hair')) this.hairMeshes.push(obj);
    });
    await Promise.all(jobs);
    this.setStrength(opts.strength ?? 1);
    this.hairShadow = opts.hairShadow !== false;
    this.setEnabled(opts.enabled !== false);
    return this.patched.map((p) => ({ name: p.mat.name, kind: p.kind, lightmap: !!p.lightmap }));
  }

  async _patch(mat, parser) {
    const def = extrasOf(mat, parser);
    const kind = KINDS.includes(def?.kind) ? def.kind : kindFromName(mat.name);
    let lightmap = null;
    if (def?.lightmap != null && parser) {
      try {
        lightmap = await parser.getDependency('texture', def.lightmap);
        lightmap.colorSpace = THREE.NoColorSpace;
        lightmap.flipY = false;
        lightmap.needsUpdate = true;
      } catch (e) {
        console.warn('toon: light map', mat.name, e);
      }
    }
    const extra = {
      uShadeWarm: { value: new THREE.Vector3(...(def?.shadeWarm || SHADE_WARM[kind])) },
      uToonLightmap: { value: lightmap },
    };
    const orig = {
      onBeforeCompile: mat.onBeforeCompile,
      key: mat.customProgramCacheKey,
      rim: mat.parametricRimColorFactor?.clone?.(),
      gi: mat.giEqualizationFactor,
    };
    const shared = this.uniforms;
    const entry = { mat, kind, lightmap, orig, extra, ok: true };
    mat.onBeforeCompile = (shader, renderer) => {
      orig.onBeforeCompile.call(mat, shader, renderer);
      if (!this.enabled) return;
      Object.assign(shader.uniforms, shared, extra);
      const res = patchShader(shader, kind, !!lightmap);
      entry.ok = res.ok;
      if (!res.ok) console.warn(`toon: shader of "${mat.name}" not patched (${res.missing}); kept as is`);
    };
    mat.customProgramCacheKey = () => orig.key.call(mat) + `|toon:${this.enabled ? kind : 'off'}${lightmap ? '+lm' : ''}`;
    this.patched.push(entry);
  }

  setEnabled(on) {
    this.enabled = !!on;
    for (const { mat, kind, orig } of this.patched) {
      if (mat.parametricRimColorFactor && orig.rim) {
        mat.parametricRimColorFactor.copy(orig.rim);
        if (on && orig.rim.r + orig.rim.g + orig.rim.b < 0.01) mat.parametricRimColorFactor.setRGB(...RIM[kind]);
      }
      if (orig.gi != null) mat.giEqualizationFactor = on ? 0.3 : orig.gi;
      mat.needsUpdate = true;
    }
  }

  setStrength(s) {
    this.uniforms.uToonStrength.value = Math.min(1, Math.max(0, Number(s) || 0));
  }

  /** Undo every patch on the current VRM. */
  remove() {
    for (const { mat, orig } of this.patched) {
      mat.onBeforeCompile = orig.onBeforeCompile;
      mat.customProgramCacheKey = orig.key;
      if (orig.rim) mat.parametricRimColorFactor?.copy(orig.rim);
      if (orig.gi != null) mat.giEqualizationFactor = orig.gi;
      delete mat.userData.toonApplied;
      mat.needsUpdate = true;
    }
    this.patched = [];
    this.hairMeshes = [];
    this.vrm = null;
  }

  /**
   * Per frame, after vrm.update() (life.js moves the head) and before rendering:
   * head frame and light direction in view space, then the hair depth pass.
   */
  update(renderer, scene, camera, sun) {
    const vrm = this.vrm;
    if (!vrm || !this.enabled) return;
    const u = this.uniforms;
    camera.updateMatrixWorld();
    const view = camera.matrixWorldInverse;
    const viewRot = this._m.setFromMatrix4(view);
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    if (head) {
      head.updateWorldMatrix(true, false);
      head.getWorldQuaternion(this._q);
      // VRM 0.x is turned 180° at load: its bones' own axes point the other way
      const s = vrm.meta?.metaVersion === '0' ? -1 : 1;
      u.uHeadForward.value.set(0, 0, s).applyQuaternion(this._q).applyMatrix3(viewRot).normalize();
      u.uHeadRight.value.set(-s, 0, 0).applyQuaternion(this._q).applyMatrix3(viewRot).normalize();
      u.uHeadUp.value.set(0, 1, 0).applyQuaternion(this._q).applyMatrix3(viewRot).normalize();
      // head center: a little above the head bone along the head's up axis, scaled with the model
      const scale = vrm.scene.getWorldScale(this._v).y;
      const r = 0.1 * scale;
      u.uHeadRadius.value = r;
      head.getWorldPosition(this._v);
      this._v.addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(this._q), 0.07 * scale).applyMatrix4(view);
      u.uHeadCenter.value.copy(this._v);
    }
    // light direction (toward the light) in view space
    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    const dir = this._v.setFromMatrixPosition(sun.matrixWorld).sub(new THREE.Vector3().setFromMatrixPosition(sun.target.matrixWorld));
    u.uLightDirView.value.copy(dir).applyMatrix3(viewRot).normalize();
    this._hairPass(renderer, scene, camera);
  }

  _hairPass(renderer, scene, camera) {
    const u = this.uniforms;
    const on = this.hairShadow && this.hairMeshes.length > 0 && this.patched.some((p) => p.kind === 'face');
    u.uHairShadowOn.value = on ? 1 : 0;
    if (!on) return;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    u.uResolution.value.copy(size);
    const w = Math.max(1, Math.floor(size.x / 2));
    const h = Math.max(1, Math.floor(size.y / 2));
    if (!this.depthTarget || this.depthTarget.width !== w || this.depthTarget.height !== h) {
      this.depthTarget?.dispose();
      this.depthTarget = new THREE.WebGLRenderTarget(w, h, { depthTexture: new THREE.DepthTexture(w, h) });
      this.depthTarget.depthTexture.type = THREE.UnsignedIntType;
    }
    // shadow offset: ~2.5 cm toward the light, as a share of the view (uv units)
    const lx = u.uLightDirView.value.x;
    const ly = u.uLightDirView.value.y;
    const len = Math.hypot(lx, ly) || 1;
    const scale = this.vrm.scene.getWorldScale(this._v).y;
    const d = 0.025 * scale;
    let viewW, viewH; // world size of the view at the head
    if (camera.isOrthographicCamera) {
      viewW = camera.right - camera.left;
      viewH = camera.top - camera.bottom;
    } else {
      viewH = 2 * Math.max(0.01, -u.uHeadCenter.value.z) * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      viewW = viewH * camera.aspect;
    }
    u.uHairShadowOffset.value.set(((lx / len) * d) / viewW, ((ly / len) * d) / viewH);
    // hair only, depth only; then back to the main framebuffer untouched
    const hidden = [];
    scene.traverse((o) => {
      if ((o.isMesh || o.isLine || o.isPoints || o.isSprite) && o.visible && !this.hairMeshes.includes(o)) {
        hidden.push(o);
        o.visible = false;
      }
    });
    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevClear = renderer.getClearAlpha();
    scene.overrideMaterial = this.depthMaterial;
    renderer.setRenderTarget(this.depthTarget);
    renderer.setClearAlpha(0);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearAlpha(prevClear);
    scene.overrideMaterial = prevOverride;
    for (const o of hidden) o.visible = true;
    u.uHairDepth.value = this.depthTarget.depthTexture;
  }

  dispose() {
    this.remove();
    this.depthTarget?.dispose();
    this.depthTarget = null;
  }
}

function extrasOf(mat, parser) {
  const fromUser = mat.userData?.dancerToon;
  if (fromUser) return fromUser;
  const index = parser?.associations?.get(mat)?.materials;
  return index != null ? parser.json.materials?.[index]?.extras?.dancerToon || null : null;
}

function kindOf(mat, parser) {
  const def = extrasOf(mat, parser);
  return KINDS.includes(def?.kind) ? def.kind : kindFromName(mat.name);
}

/** String patches on the MToon shaders. Any missing anchor: leave the shader as it is. */
export function patchShader(shader, kind, hasLightmap) {
  const defines = `#define TOON_${kind.toUpperCase()}\n${hasLightmap ? '#define TOON_LIGHTMAP\n' : ''}`;
  let fs = shader.fragmentShader;
  let vs = shader.vertexShader;
  const missing = [];
  const rep = (src, from, to, label) => {
    if (!src.includes(from)) {
      missing.push(label);
      return src;
    }
    return src.replace(from, to);
  };
  fs = rep(fs, CHUNKS.anchorUniforms, CHUNKS.uniforms + CHUNKS.anchorUniforms, 'uniforms');
  fs = rep(fs, CHUNKS.getShadingOrig, CHUNKS.getShadingToon, 'getShading');
  fs = rep(fs, CHUNKS.getDiffuseMix, CHUNKS.getDiffuseMixToon, 'getDiffuse');
  fs = rep(fs, CHUNKS.dotNL, CHUNKS.dotNLToon, 'dotNL');
  fs = rep(fs, CHUNKS.shadingShift, CHUNKS.shadingShiftToon, 'shadingShift');
  fs = rep(fs, CHUNKS.colSum, CHUNKS.colSumToon, 'col');
  if (missing.length) return { ok: false, missing: missing.join(', ') };
  shader.fragmentShader = defines + fs;
  shader.vertexShader = vs;
  return { ok: true };
}
