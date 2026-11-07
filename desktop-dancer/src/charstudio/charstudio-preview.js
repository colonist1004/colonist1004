// 3D preview of the converted character: slow turntable, optional sample dance.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, VRMLookAtQuaternionProxy, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import { DEFAULTS, SLIDERS, applyCustomization, listMaterials, markAlphaData } from '../renderer/customize.js';
import { Toon } from '../renderer/toon/toon.js';

const api = window.charStudio;
const canvas = document.getElementById('preview');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 4 / 3, 0.05, 50);
const hemi = new THREE.HemisphereLight(0xffffff, 0x8888aa, 1.2);
scene.add(hemi);
const toon = new Toon(); // the same look as on the taskbar
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(1, 2, 3);
scene.add(sun);
const floor = new THREE.Mesh(new THREE.CircleGeometry(0.6, 48), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.12 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

const loader = new GLTFLoader();
loader.register((p) => new VRMLoaderPlugin(p));
loader.register((p) => new VRMAnimationLoaderPlugin(p));

let vrm = null;
let currentFile = null;
let custom = { ...DEFAULTS, colors: {} };
let mixer = null;
let dancing = false;
let danceClip = null;
const turntable = new THREE.Group();
scene.add(turntable);

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);

async function load(file) {
  const buf = await api.readLibraryFile(file);
  const gltf = await loader.parseAsync(buf, '');
  if (vrm) {
    toon.remove();
    turntable.remove(vrm.scene);
    VRMUtils.deepDispose(vrm.scene);
  }
  mixer = null;
  dancing = false;
  vrm = gltf.userData.vrm;
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse((o) => (o.frustumCulled = false));
  if (vrm.lookAt) {
    const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
    proxy.name = 'lookAtQuaternionProxy';
    vrm.scene.add(proxy);
  }
  turntable.add(vrm.scene);
  turntable.rotation.y = 0;
  vrm.update(0);
  const view = (await api.getViewSettings?.()) || {};
  const opts = { enabled: view.toonShader !== false, strength: view.toonStrength ?? 1, hairShadow: view.toonHairShadow !== false, light: view.light };
  try {
    await toon.apply(vrm, gltf, opts);
  } catch (e) {
    console.warn('toon: not applied', e);
  }
  toon.setLights(hemi, sun, toon.enabled && toon.patched.length > 0);
  currentFile = file;
  custom = { ...DEFAULTS, colors: {}, opaque: {}, ...((await api.getCustom(file)) || {}) };
  custom.opaque ??= {};
  markAlphaData(vrm);
  applyCustomization(vrm, custom);
  buildTweakUI();
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const h = box.max.y - box.min.y;
  floor.scale.setScalar(h / 1.6);
  camera.position.set(0, h * 0.55, h * 2.4);
  camera.lookAt(0, h * 0.5, 0);
  resize();
  window.__previewLoaded = true; // for tests
}

async function toggleDance() {
  if (!vrm) return false;
  if (!danceClip) {
    const anim = (await loader.parseAsync(await api.readSampleMotion(), '')).userData.vrmAnimations[0];
    danceClip = anim;
  }
  dancing = !dancing;
  if (dancing) {
    mixer = new THREE.AnimationMixer(vrm.scene);
    mixer.clipAction(createVRMAnimationClip(danceClip, vrm)).play();
  } else {
    mixer?.stopAllAction();
    mixer = null;
    vrm.humanoid.resetNormalizedPose();
  }
  return dancing;
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (vrm) {
    if (!dancing) turntable.rotation.y += dt * 0.6;
    else turntable.rotation.y *= 0.9; // ease back to the front while dancing
    mixer?.update(dt);
    vrm.update(dt);
    toon.update(renderer, scene, camera, sun);
  }
  renderer.render(scene, camera);
});

// ------------------------------------------------------------ tweak UI
function buildTweakUI() {
  const box = document.getElementById('sliders');
  box.innerHTML = '';
  for (const sl of SLIDERS) {
    const label = document.createElement('label');
    label.textContent = sl.label;
    const wrap = document.createElement('div');
    wrap.className = 'slider';
    const input = Object.assign(document.createElement('input'), { type: 'range', min: sl.min, max: sl.max, step: sl.step });
    input.value = custom[sl.key];
    input.dataset.key = sl.key;
    const val = document.createElement('span');
    val.textContent = `${Math.round(custom[sl.key] * 100)}%`;
    input.addEventListener('input', () => {
      custom[sl.key] = Number(input.value);
      val.textContent = `${Math.round(custom[sl.key] * 100)}%`;
      applyCustomization(vrm, custom);
    });
    wrap.append(input, val);
    box.append(label, wrap);
  }
  const colors = document.getElementById('colors');
  colors.innerHTML = '';
  for (const [name, mats] of [...listMaterials(vrm)].slice(0, 40)) {
    const label = document.createElement('label');
    label.title = name;
    const input = Object.assign(document.createElement('input'), { type: 'color', value: custom.colors[name] || '#ffffff' });
    input.addEventListener('input', () => {
      custom.colors[name] = input.value;
      applyCustomization(vrm, custom);
    });
    label.append(input, document.createTextNode(name));
    // see-through materials: a switch to draw them opaque (pre-set when the alpha looks like data)
    const base = mats[0].userData.dancerAlphaBase;
    if (base && (base.transparent || base.alphaTest > 0)) {
      const auto = !!mats[0].userData.alphaData;
      const op = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'opaque', checked: custom.opaque[name] ?? auto });
      op.title = auto ? '텍스처 알파가 투명도가 아닌 데이터로 보여 자동으로 불투명 처리했어요' : '이 재질을 불투명하게 그리기';
      op.addEventListener('change', () => {
        custom.opaque[name] = op.checked;
        applyCustomization(vrm, custom);
      });
      const tag = Object.assign(document.createElement('span'), { className: 'opaque-tag', textContent: auto ? '불투명(자동)' : '불투명' });
      label.append(op, tag);
    }
    colors.appendChild(label);
  }
}

function resetCustom() {
  custom = { ...DEFAULTS, colors: {}, opaque: {} };
  if (vrm) applyCustomization(vrm, custom);
  buildTweakUI();
}

async function saveCustom() {
  if (currentFile) await api.setCustom(currentFile, custom);
}

window.charPreview = { load, toggleDance, resetCustom, saveCustom, getCustom: () => custom };
