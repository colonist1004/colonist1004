// Renders the character dancing. One page, three modes (?mode=...):
//   overlay   – floating window on top of other apps: transparent, feet at the bottom of the window
//   wallpaper – live wallpaper: background color, character sized/placed relative to the screen
//   preview   – the settings screen's preview (like overlay)
// Configuration comes from the Android side: window.Android.getConfig(mode) -> JSON.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, VRMLookAtQuaternionProxy, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import { applyCustomization } from './customize.js';

const mode = new URLSearchParams(location.search).get('mode') || 'overlay';
const canvas = document.getElementById('view');
const msg = document.getElementById('msg');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: mode !== 'wallpaper', antialias: true, powerPreference: 'low-power' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
camera.position.set(0, 0, 10);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8888aa, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(1, 2, 3);
scene.add(sun);

const loader = new GLTFLoader();
loader.register((p) => new VRMLoaderPlugin(p));
loader.register((p) => new VRMAnimationLoaderPlugin(p));

let cfg = null;
let vrm = null;
let mixer = null;
let modelHeight = 1.6;
let paused = false;
let loadToken = 0;

function readConfig() {
  try {
    return JSON.parse(window.Android?.getConfig(mode) || '{}');
  } catch {
    return {};
  }
}

function show(text) {
  msg.textContent = text || '';
  msg.style.display = text ? 'block' : 'none';
}

function frame() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, mode === 'wallpaper' ? 2 : 3));
  renderer.setSize(w, h, false);
  if (mode === 'wallpaper') {
    renderer.setClearColor(new THREE.Color(cfg?.bg || '#20242e'), 1);
    // character height = wpScale of the screen height, feet at wpY from the bottom, centered at wpX
    const charPx = Math.max(40, (cfg?.wpScale ?? 0.6) * h);
    const upp = (modelHeight * 1.05) / charPx; // world units per pixel
    const feetPx = h * (1 - (cfg?.wpY ?? 0.08));
    const cx = w * (cfg?.wpX ?? 0.5);
    camera.left = -cx * upp;
    camera.right = (w - cx) * upp;
    camera.top = feetPx * upp;
    camera.bottom = -(h - feetPx) * upp;
  } else {
    renderer.setClearColor(0x000000, 0);
    const viewH = modelHeight * 1.3; // headroom for raised arms
    const pad = viewH * 0.01;
    const aspect = w / h;
    camera.left = (-viewH * aspect) / 2;
    camera.right = (viewH * aspect) / 2;
    camera.top = viewH - pad;
    camera.bottom = -pad;
  }
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', frame);

async function fetchGltf(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return loader.parseAsync(await res.arrayBuffer(), '');
}

async function load() {
  const token = ++loadToken;
  cfg = readConfig();
  show('');
  try {
    const [g, m] = await Promise.all([
      cfg.character ? fetchGltf(cfg.character) : null,
      cfg.motion ? fetchGltf(cfg.motion) : null,
    ]);
    if (token !== loadToken) return;
    if (vrm) {
      scene.remove(vrm.scene);
      VRMUtils.deepDispose(vrm.scene);
      vrm = null;
    }
    mixer = null;
    if (!g?.userData.vrm) throw new Error('캐릭터(VRM)를 불러오지 못했습니다');
    vrm = g.userData.vrm;
    VRMUtils.removeUnnecessaryVertices(vrm.scene);
    VRMUtils.combineSkeletons(vrm.scene);
    VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse((o) => (o.frustumCulled = false));
    if (vrm.lookAt) {
      const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
      proxy.name = 'lookAtQuaternionProxy';
      vrm.scene.add(proxy);
    }
    scene.add(vrm.scene);
    vrm.update(0);
    applyCustomization(vrm, cfg.custom || null);
    modelHeight = Math.max(0.3, new THREE.Box3().setFromObject(vrm.scene).max.y);
    const anim = m?.userData.vrmAnimations?.[0];
    if (anim) {
      mixer = new THREE.AnimationMixer(vrm.scene);
      mixer.clipAction(createVRMAnimationClip(anim, vrm)).play();
      mixer.timeScale = cfg.speed || 1;
    }
    frame();
    window.__dancerReady = true; // for tests
  } catch (e) {
    show(String(e.message || e));
    window.Android?.log?.(String(e.stack || e));
  }
}

// ------------------------------------------------------------ loop
const clock = new THREE.Clock();
let acc = 0;
function tick() {
  if (paused) return;
  requestAnimationFrame(tick);
  acc += clock.getDelta();
  const step = 1 / (cfg?.fps || 30);
  if (acc < step) return;
  const dt = Math.min(acc, 0.1);
  acc %= step;
  if (vrm) {
    mixer?.update(dt);
    vrm.update(dt);
  }
  renderer.render(scene, camera);
}

// Called from Android (evaluateJavascript)
window.dancer = {
  reload: load,
  refresh() {
    // settings changed that need no reload (wallpaper layout, speed, fps, colors)
    const old = cfg;
    cfg = readConfig();
    if (old && (old.character !== cfg.character || old.motion !== cfg.motion)) return load();
    if (mixer) mixer.timeScale = cfg.speed || 1;
    if (vrm) applyCustomization(vrm, cfg.custom || null);
    frame();
  },
  pause() {
    paused = true;
  },
  resume() {
    if (!paused) return;
    paused = false;
    clock.getDelta();
    tick();
  },
};

frame();
tick();
load();
