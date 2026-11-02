// Renders a VRM character playing a VRMA motion on a transparent canvas.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, VRMLookAtQuaternionProxy, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

const api = window.dancer;
const canvas = document.getElementById('view');
const msgEl = document.getElementById('msg');

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
camera.position.set(0, 0, 10);

scene.add(new THREE.HemisphereLight(0xffffff, 0x8888aa, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(1, 2, 3);
scene.add(sun);

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));
loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

let settings = { fps: 30, speed: 1 };
let vrm = null;
let mixer = null;
let vrmAnimation = null;
let viewHeight = 2;
let loadToken = 0;

function showMessage(text) {
  msgEl.textContent = text;
  msgEl.style.display = text ? 'block' : 'none';
}

function reportError(context, e) {
  console.error(context, e);
  api.reportError(`${context}: ${e?.stack || e}`);
  showMessage(`${context}: ${e?.message || e}`);
}

async function parseFile(file) {
  const buf = await api.readAsset(file);
  return loader.parseAsync(buf, '');
}

// ---------------------------------------------------------------- framing

function frameCharacter() {
  if (!vrm) return;
  // Height from the rest pose so the camera does not jump while dancing.
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const height = Math.max(0.5, box.max.y);
  // Leave headroom for raised arms.
  viewHeight = height * 1.3;
  resize();
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(w, h, false);
  const aspect = w / h;
  const pad = viewHeight * 0.01; // keep the soles visible right at the bottom edge
  camera.left = (-viewHeight * aspect) / 2;
  camera.right = (viewHeight * aspect) / 2;
  camera.top = viewHeight - pad;
  camera.bottom = -pad;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------- loading

function disposeCharacter() {
  if (!vrm) return;
  mixer?.stopAllAction();
  mixer = null;
  scene.remove(vrm.scene);
  VRMUtils.deepDispose(vrm.scene);
  vrm = null;
}

function applyMotion() {
  if (!vrm) return;
  mixer?.stopAllAction();
  mixer = null;
  if (!vrmAnimation) return;
  mixer = new THREE.AnimationMixer(vrm.scene);
  const clip = createVRMAnimationClip(vrmAnimation, vrm);
  mixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
  mixer.timeScale = settings.speed;
}

async function load({ character, motion }) {
  const token = ++loadToken;
  showMessage('');
  try {
    const [charGltf, motionGltf] = await Promise.all([
      character ? parseFile(character) : null,
      motion ? parseFile(motion) : null,
    ]);
    if (token !== loadToken) return; // a newer request superseded this one

    const nextVrm = charGltf?.userData.vrm;
    if (character && !nextVrm) throw new Error('VRM 데이터가 없는 파일입니다');
    const nextAnimation = motionGltf?.userData.vrmAnimations?.[0] ?? null;
    if (motion && !nextAnimation) throw new Error('VRMA 데이터가 없는 파일입니다');

    disposeCharacter();
    vrmAnimation = nextAnimation;
    if (nextVrm) {
      vrm = nextVrm;
      VRMUtils.removeUnnecessaryVertices(vrm.scene);
      VRMUtils.combineSkeletons(vrm.scene);
      VRMUtils.rotateVRM0(vrm); // VRM 0.x faces -Z; turn it toward the camera
      vrm.scene.traverse((o) => (o.frustumCulled = false));
      if (vrm.lookAt) {
        const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
        proxy.name = 'lookAtQuaternionProxy';
        vrm.scene.add(proxy);
      }
      scene.add(vrm.scene);
      vrm.update(0);
      frameCharacter();
      applyMotion();
    }
    if (!character) showMessage('캐릭터가 없습니다. 트레이 메뉴 → 캐릭터에서 VRM을 추가하세요.');
  } catch (e) {
    reportError('불러오기 실패', e);
  }
}

// ---------------------------------------------------- hover & click-through

// The window ignores mouse events except where the character is drawn.
// Hit test = alpha of the rendered pixel under the cursor, read right after rendering.
let pointer = null; // {x, y} in CSS px, or null when outside
let hovering = false;
let dragging = false;
const pixel = new Uint8Array(4);

function setHover(v) {
  if (v === hovering) return;
  hovering = v;
  document.body.classList.toggle('hover', v);
  api.setHover(v);
}

function hitTest() {
  if (dragging) return;
  if (!pointer) return setHover(false);
  const gl = renderer.getContext();
  const dpr = renderer.getPixelRatio();
  const x = Math.floor(pointer.x * dpr);
  const y = Math.floor((window.innerHeight - pointer.y) * dpr);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  setHover(pixel[3] > 16);
}

window.addEventListener('mousemove', (e) => {
  pointer = { x: e.clientX, y: e.clientY };
  if (dragging) api.drag('move', e.screenX);
});
window.addEventListener('mouseleave', () => {
  pointer = null;
  if (!dragging) setHover(false);
});
canvas.addEventListener('pointerdown', (e) => {
  if (!hovering || e.button !== 0) return;
  dragging = true;
  canvas.setPointerCapture(e.pointerId);
  document.body.classList.add('dragging');
  api.drag('start', e.screenX);
});
const endDrag = (e) => {
  if (!dragging) return;
  dragging = false;
  canvas.releasePointerCapture?.(e.pointerId);
  document.body.classList.remove('dragging');
  api.drag('end', e.screenX);
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ------------------------------------------------------------- main loop

const clock = new THREE.Clock();
let acc = 0;
let frameNo = 0;
const freezeParam = new URLSearchParams(location.search).get('t');
const freezeT = freezeParam == null ? null : Number(freezeParam);
const recordFrames = Number(new URLSearchParams(location.search).get('record') || 0);
let recordIndex = -1; // starts once the character and motion are loaded

function recordStep() {
  // Dev: deterministic 30 fps frames of the motion, written to disk by main.
  if (recordIndex >= recordFrames) return api.devRecordDone();
  mixer.setTime(recordIndex / 30);
  vrm.update(1 / 30);
  renderer.render(scene, camera);
  api.devFrame(recordIndex, canvas.toDataURL('image/png'));
  recordIndex++;
}

function idlePose(t) {
  // Gentle breathing when no motion is loaded.
  const h = vrm.humanoid;
  const chest = h.getNormalizedBoneNode('chest') || h.getNormalizedBoneNode('spine');
  if (chest) chest.rotation.x = 0.03 * Math.sin(t * 2);
  for (const [bone, z] of [
    ['leftUpperArm', -1.2],
    ['rightUpperArm', 1.2],
  ]) {
    const n = h.getNormalizedBoneNode(bone);
    if (n) n.rotation.z = z;
  }
}

function tick() {
  requestAnimationFrame(tick);
  if (recordFrames && mixer) {
    if (recordIndex < 0) recordIndex = 0;
    return recordStep();
  }
  acc += clock.getDelta();
  const step = 1 / settings.fps;
  if (acc < step) return;
  const delta = Math.min(acc, 0.1);
  acc %= step;

  if (vrm) {
    if (mixer && freezeT != null) mixer.setTime(freezeT);
    else if (mixer) mixer.update(delta);
    else idlePose(clock.elapsedTime);
    vrm.update(delta);
  }
  renderer.render(scene, camera);
  // readPixels stalls the GPU a little, so only hit-test while the cursor is over the window, ~10x/s.
  if (pointer && ++frameNo % Math.max(1, Math.round(settings.fps / 10)) === 0) hitTest();
  else if (!pointer && hovering && !dragging) setHover(false);
}

// ---------------------------------------------------------------- startup

api.onLoad(load);
api.onSettings((s) => {
  settings = s;
  if (mixer) mixer.timeScale = s.speed;
});

window.addEventListener('error', (e) => api.reportError(e.message));
window.addEventListener('unhandledrejection', (e) => api.reportError(e.reason?.stack || e.reason));

(async () => {
  const init = await api.getInitial();
  settings = init.settings;
  resize();
  tick();
  await load(init);
})();
