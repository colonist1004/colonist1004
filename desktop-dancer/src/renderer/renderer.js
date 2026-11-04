// Renders a VRM character playing a VRMA motion on a transparent canvas.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { applyCustomization } from './customize.js';
import { Life } from './life.js';
import { Music } from './music.js';
import { motionTempo, syncRate } from './beat.js';
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
let holdingPose = false; // the motion is a still pose: add breathing so it does not look frozen
let action = null;
let tempo = null; // { bpm, beatAt } of the dance, for music sync
let timeScale = 1;
let syncI = 0;
const life = new Life();
const holder = new THREE.Group(); // lifts the character for little hops (the VRM root is used by customize.js)
scene.add(holder);
const music = new Music((st) => {
  if (st.error) {
    api.reportError(st.error);
    showMessage(st.error);
    setTimeout(() => showMessage(''), 6000);
  }
});
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
  holder.position.set(0, 0, 0);
  holder.rotation.set(0, 0, 0);
  // Height from the rest pose so the camera does not jump while dancing.
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const height = Math.max(0.5, box.max.y);
  // Leave headroom for raised arms.
  viewHeight = height * 1.3;
  resize();
}

// The character's true frame size in px (from main). At big sizes the window is cut at the screen
// edges; the camera keeps the same scale so the character stays its size, feet at the bottom.
let frame = null;

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(w, h, false);
  const pad = viewHeight * 0.01; // keep the soles visible right at the bottom edge
  // Full frame in world units: feet at y = -pad (bottom), centered on x = 0. The window shows the
  // slice starting at (cropLeft, cropTop) of that frame.
  const fw = frame?.nominalWidth || w;
  const fh = frame?.nominalHeight || h;
  const upp = viewHeight / fh; // world units per pixel
  const left = (-fw / 2 + (frame?.cropLeft || 0)) * upp;
  const top = -pad + (fh - (frame?.cropTop || 0)) * upp;
  camera.left = left;
  camera.right = left + w * upp;
  camera.top = top;
  camera.bottom = top - h * upp;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------- loading

function disposeCharacter() {
  if (!vrm) return;
  mixer?.stopAllAction();
  mixer = null;
  action = null;
  life.detach();
  holder.remove(vrm.scene);
  VRMUtils.deepDispose(vrm.scene);
  vrm = null;
}

function applyMotion() {
  if (!vrm) return;
  life.reset();
  mixer?.stopAllAction();
  mixer = null;
  action = null;
  tempo = null;
  if (!vrmAnimation) return;
  mixer = new THREE.AnimationMixer(vrm.scene);
  const clip = createVRMAnimationClip(vrmAnimation, vrm);
  holdingPose = isStill(clip);
  action = mixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
  if (!holdingPose) tempo = clipTempo(clip);
  mixer.timeScale = timeScale = settings.speed;
}

/** True when no track of the clip changes over time (a pose made from a photo). */
function isStill(clip) {
  return clip.tracks.every((t) => {
    const n = t.getValueSize();
    for (let i = n; i < t.values.length; i++) if (Math.abs(t.values[i] - t.values[i % n]) > 1e-4) return false;
    return true;
  });
}

/** Beat of a dance clip from how it moves: hips going down (knee bounces) plus overall joint speed. */
function clipTempo(clip) {
  if (clip.duration < 1.5) return null;
  const m = new THREE.AnimationMixer(vrm.scene);
  const act = m.clipAction(clip).play();
  const hips = vrm.humanoid.getNormalizedBoneNode('hips');
  const nodes = ['leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftUpperLeg', 'rightUpperLeg', 'spine', 'head']
    .map((b) => vrm.humanoid.getNormalizedBoneNode(b)).filter(Boolean);
  const rate = 60;
  const n = Math.floor(clip.duration * rate);
  const down = new Float64Array(n), speed = new Float64Array(n);
  let prev = null;
  for (let i = 0; i < n; i++) {
    m.setTime(i / rate);
    down[i] = -hips.position.y;
    const qs = nodes.map((x) => x.quaternion.clone());
    if (prev) speed[i] = qs.reduce((acc, q, k) => acc + q.angleTo(prev[k]), 0);
    prev = qs;
  }
  speed[0] = speed[1] || 0;
  act.stop();
  m.uncacheRoot(vrm.scene);
  vrm.humanoid.resetNormalizedPose();
  const z = (a) => {
    const mean = a.reduce((x, y) => x + y, 0) / a.length;
    const sd = Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / a.length) || 1;
    return a.map((v) => (v - mean) / sd);
  };
  const zd = z(down), zs = z(speed);
  return motionTempo(zd.map((v, i) => v + 0.5 * zs[i]), rate);
}

let currentCharacter = null;

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
      holder.add(vrm.scene);
      vrm.update(0);
      applyCustomization(vrm, await api.getCustom(character));
      currentCharacter = character;
      frameCharacter();
      life.attach(vrm, holder, scene);
      life.setOptions({ lookAt: settings.lookAt !== false, reactions: settings.reactions !== false });
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
  if (dragging) {
    api.drag('move', e.screenX, e.screenY);
    life.dragMove(e.screenX, e.screenY);
  } else if (hovering && vrm) {
    life.hover(e.clientX, life.partAt(e.clientX, e.clientY, camera, window.innerWidth, window.innerHeight) === 'head');
  }
});
window.addEventListener('mouseleave', () => {
  pointer = null;
  if (!dragging) setHover(false);
});
canvas.addEventListener('pointerdown', (e) => {
  if (!hovering || e.button !== 0) return;
  dragging = true;
  press = { x: e.screenX, y: e.screenY, t: performance.now(), cx: e.clientX, cy: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
  document.body.classList.add('dragging');
  api.drag('start', e.screenX, e.screenY);
});
// A press that barely moves is a click (a reaction); anything else is a drag (dangling legs).
let press = null;
canvas.addEventListener('pointermove', (e) => {
  if (!dragging || !press || press.moved) return;
  if (Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) {
    press.moved = true;
    life.dragStart(e.screenX, e.screenY);
  }
});
const endDrag = (e) => {
  if (!dragging) return;
  dragging = false;
  canvas.releasePointerCapture?.(e.pointerId);
  document.body.classList.remove('dragging');
  api.drag('end', e.screenX, e.screenY);
  if (press?.moved) life.dragEnd();
  else if (press && e.type === 'pointerup' && performance.now() - press.t < 500 && vrm) {
    life.click(life.partAt(press.cx, press.cy, camera, window.innerWidth, window.innerHeight));
  }
  press = null;
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

/** Normal speed, or lined up with the music's beat; nearly paused while held by the mouse. */
function playbackSpeed(delta) {
  let target = settings.speed;
  if (tempo && music.active && action) {
    const r = syncRate(tempo, action.time, music.tracker, performance.now() / 1000, settings.speed);
    if (r) {
      // integral part: removes a steady lag (slow frames lose time, the song's tempo is a bit off)
      syncI = Math.max(-0.3, Math.min(0.3, syncI + r.error * delta * 0.8));
      target = r.scale * (1 + syncI);
    }
  } else syncI *= 0.95;
  timeScale += (target - timeScale) * Math.min(1, delta * 4);
  return timeScale * (1 - 0.85 * life.holdFactor);
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
    const alive = freezeT == null; // frozen dev screenshots stay deterministic
    if (alive) life.reset();
    if (mixer && freezeT != null) mixer.setTime(freezeT);
    else if (mixer) {
      mixer.timeScale = playbackSpeed(delta);
      mixer.update(delta);
    } else idlePose(clock.elapsedTime);
    if (alive) {
      const now = performance.now() / 1000;
      life.update(delta, clock.elapsedTime, {
        camera, width: window.innerWidth, height: window.innerHeight,
        dancing: !!mixer && !holdingPose, still: holdingPose,
        beat: { active: music.active, phase: music.phase(now) },
      });
    }
    vrm.update(delta);
  }
  renderer.render(scene, camera);
  // readPixels stalls the GPU a little, so only hit-test while the cursor is over the window, ~10x/s.
  if (pointer && ++frameNo % Math.max(1, Math.round(settings.fps / 10)) === 0) hitTest();
  else if (!pointer && hovering && !dragging) setHover(false);
}

// ---------------------------------------------------------------- startup

api.onLoad(load);
api.onFrame((f) => {
  frame = f;
  resize();
});
// Ctrl + mouse wheel over the character: bigger / smaller.
window.addEventListener('wheel', (e) => {
  if (!hovering || !e.ctrlKey) return;
  e.preventDefault();
  api.resizeBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });
api.onCustom(({ character, custom }) => {
  if (!vrm || character !== currentCharacter) return;
  applyCustomization(vrm, custom);
  frameCharacter();
});
api.onSettings((s) => {
  settings = s;
  life.setOptions({ lookAt: s.lookAt !== false, reactions: s.reactions !== false });
  syncMusic();
});
api.onCursor?.((p) => life.setCursor(p));
api.onWalk?.((w) => life.setWalk(w.phase === 'start', w.dir));
// tell main when dancing to music (no walks then)
let wasBusy = false;
setInterval(() => {
  const busy = music.active && !!tempo;
  if (busy !== wasBusy) api.setBusy?.((wasBusy = busy));
}, 1000);

const fakeMusic = Number(new URLSearchParams(location.search).get('fakeMusic') || 0);
function syncMusic() {
  if (fakeMusic) {
    if (!music.running) music.startFake(fakeMusic);
    return;
  }
  if (settings.music && !music.running) music.start();
  else if (!settings.music && music.running) music.stop();
}
// dev/test hook: state of the alive layer and the beat
window.__dancer = () => ({
  music: { running: music.running, active: music.active, bpm: music.tracker.bpm, confidence: music.tracker.confidence },
  tempo, timeScale, holdingPose, look: { ...life.look }, react: life.react?.kind || null, drag: life.drag.w,
  walk: { on: life.walk.on, w: life.walk.w, yaw: life.walk.yaw },
  expr: { ...life.expr },
  head: life.headPx(camera, window.innerWidth, window.innerHeight),
  hovering,
});
window.__dancerSync = () =>
  tempo && music.active && action ? syncRate(tempo, action.time, music.tracker, performance.now() / 1000, settings.speed)?.error : null;

window.addEventListener('error', (e) => api.reportError(e.message));
window.addEventListener('unhandledrejection', (e) => api.reportError(e.reason?.stack || e.reason));

(async () => {
  const init = await api.getInitial();
  settings = init.settings;
  syncMusic();
  resize();
  tick();
  await load(init);
})();
