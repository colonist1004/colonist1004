// 3D preview of the converted character: slow turntable, optional sample dance.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, VRMLookAtQuaternionProxy, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import { DEFAULTS, SLIDERS, applyCustomization, listMaterials } from '../renderer/customize.js';

const api = window.charStudio;
const canvas = document.getElementById('preview');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 4 / 3, 0.05, 50);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8888aa, 1.2));
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
  currentFile = file;
  custom = { ...DEFAULTS, colors: {}, ...((await api.getCustom(file)) || {}) };
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
  for (const name of [...listMaterials(vrm).keys()].slice(0, 40)) {
    const label = document.createElement('label');
    label.title = name;
    const input = Object.assign(document.createElement('input'), { type: 'color', value: custom.colors[name] || '#ffffff' });
    input.addEventListener('input', () => {
      custom.colors[name] = input.value;
      applyCustomization(vrm, custom);
    });
    label.append(input, document.createTextNode(name));
    colors.appendChild(label);
  }
}

function resetCustom() {
  custom = { ...DEFAULTS, colors: {} };
  if (vrm) applyCustomization(vrm, custom);
  buildTweakUI();
}

async function saveCustom() {
  if (currentFile) await api.setCustom(currentFile, custom);
}

window.charPreview = { load, toggleDance, resetCustom, saveCustom, getCustom: () => custom };
