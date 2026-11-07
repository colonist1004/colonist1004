// Renders a VRM character playing a VRMA motion on a transparent canvas.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { applyCustomization, markAlphaData } from './customize.js';
import { Life, vrmAxisSign } from './life.js';
import { Music } from './music.js';
import { motionTempo, syncRate } from './beat.js';
import { Toon } from './toon/toon.js';
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

const hemi = new THREE.HemisphereLight(0xffffff, 0x8888aa, 1.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(1, 2, 3);
scene.add(sun);

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));
loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

let settings = { fps: 30, speed: 1 };
const toon = new Toon(); // the Desktop Dancer toon look (patched MToon), see toon/toon.js
let lastCustom = null; // the character's tweaks, re-applied when the toon look swaps materials
const toonOptions = (s) => ({ enabled: s.toonShader !== false, strength: s.toonStrength ?? 1, hairShadow: s.toonHairShadow !== false, light: s.light });
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
  toon.remove();
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
      try {
        const info = await toon.apply(vrm, charGltf, toonOptions(settings));
        console.log('toon materials', JSON.stringify(info));
      } catch (e) {
        console.warn('toon: not applied', e); // the character still shows with plain MToon
      }
      toon.setLights(hemi, sun, toon.enabled && toon.patched.length > 0); // plain (non-MToon) models keep the old lights
      const flagged = markAlphaData(vrm);
      if (flagged.length) console.log('opaque (alpha looks like data):', flagged.join(', '));
      lastCustom = await api.getCustom(character);
      applyCustomization(vrm, lastCustom);
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
  if (grabbing) {
    // pointermove does it
  } else if (dragging) {
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
// Alt+drag: pull a hand, a foot or the chest; letting go eases back into the dance.
let grabbing = null; // { pointerId, z }
const raycaster = new THREE.Raycaster();
const GRAB_SEGS = {
  leftHand: ['leftLowerArm', 'leftHand'], rightHand: ['rightLowerArm', 'rightHand'],
  leftFoot: ['leftLowerLeg', 'leftFoot', 'leftToes'], rightFoot: ['rightLowerLeg', 'rightFoot', 'rightToes'],
  chest: ['spine', 'chest', 'upperChest'],
  // not grabbable, but they win the "nearest part" test so a click on them is not a hand/foot
  _: ['hips', 'neck', 'head', 'leftUpperArm', 'rightUpperArm', 'leftUpperLeg', 'rightUpperLeg'],
};
function screenToWorld(cx, cy, z) {
  return new THREE.Vector3(
    camera.left + (cx / window.innerWidth) * (camera.right - camera.left),
    camera.top - (cy / window.innerHeight) * (camera.top - camera.bottom),
    z,
  );
}
/** The grabbable part under window point (cx, cy), with the 3D point hit; null if none. */
function grabPartAt(cx, cy) {
  if (!vrm) return null;
  raycaster.setFromCamera(new THREE.Vector2((cx / window.innerWidth) * 2 - 1, 1 - (cy / window.innerHeight) * 2), camera);
  // skinned meshes cache their bounds from the first frame; a raised arm would fall outside them
  vrm.scene.traverse((o) => o.isSkinnedMesh && o.computeBoundingSphere());
  const hit = raycaster.intersectObject(vrm.scene, true).find((h) => h.object.isMesh && h.object.visible);
  if (!hit) return null;
  const p = hit.point;
  const h = vrm.humanoid;
  const segDist = (a, b) => {
    const ab = b.clone().sub(a);
    const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-9), 0, 1);
    return a.clone().addScaledVector(ab, t).distanceTo(p);
  };
  let best = null, bestD = Infinity;
  for (const [part, names] of Object.entries(GRAB_SEGS)) {
    for (const n of names) {
      const node = h.getRawBoneNode(n);
      if (!node) continue;
      const a = node.getWorldPosition(new THREE.Vector3());
      const kid = node.children.find((c) => c.isBone || c.type === 'Bone' || c.type === 'Object3D');
      // the head reaches up from its joint; children of other bones (hair, eyes) do not tell its length
      const b = n === 'head' ? a.clone().add(new THREE.Vector3(0, 0.2, 0)) : kid ? kid.getWorldPosition(new THREE.Vector3()) : a;
      const d = segDist(a, b);
      if (d < bestD) (bestD = d), (best = part);
    }
  }
  return best && best !== '_' ? { part: best, point: p.clone() } : null;
}

canvas.addEventListener('pointerdown', (e) => {
  if (!hovering || e.button !== 0) return;
  if (e.altKey && vrm) {
    const g = grabPartAt(e.clientX, e.clientY);
    if (g && life.grabStart(g.part, g.point)) {
      grabbing = { pointerId: e.pointerId, z: g.point.z, part: g.part };
      dragging = true; // keeps hover on while the cursor leaves the character
      canvas.setPointerCapture(e.pointerId);
      document.body.classList.add('grabbing');
      e.preventDefault();
      return;
    }
  }
  dragging = true;
  press = { x: e.screenX, y: e.screenY, t: performance.now(), cx: e.clientX, cy: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
  document.body.classList.add('dragging');
  api.drag('start', e.screenX, e.screenY);
});
// A press that barely moves is a click (a reaction); anything else is a drag (dangling legs).
let press = null;
canvas.addEventListener('pointermove', (e) => {
  if (grabbing) return life.grabMove(screenToWorld(e.clientX, e.clientY, grabbing.z));
  if (!dragging || !press || press.moved) return;
  if (Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) {
    press.moved = true;
    life.dragStart(e.screenX, e.screenY);
  }
});
const endDrag = (e) => {
  if (grabbing) {
    life.grabEnd(e.shiftKey); // Shift on release: the limb stays where it was put
    grabbing = null;
    dragging = false;
    canvas.releasePointerCapture?.(e.pointerId);
    document.body.classList.remove('grabbing');
    return;
  }
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
  toon.update(renderer, scene, camera, sun);
  renderer.render(scene, camera);
  api.devFrame(recordIndex, canvas.toDataURL('image/png'));
  recordIndex++;
}

function idlePose(t) {
  // Gentle breathing when no motion is loaded.
  const h = vrm.humanoid;
  const s = vrmAxisSign(vrm); // x/z turns go the other way on VRM 0.x
  const chest = h.getNormalizedBoneNode('chest') || h.getNormalizedBoneNode('spine');
  if (chest) chest.rotation.x = s * 0.03 * Math.sin(t * 2);
  for (const [bone, z] of [
    ['leftUpperArm', -1.2],
    ['rightUpperArm', 1.2],
  ]) {
    const n = h.getNormalizedBoneNode(bone);
    if (n) n.rotation.z = s * z;
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
    const alive = freezeT == null || !!life.grab || life.pins.size > 0; // frozen dev screenshots stay deterministic
    if (alive) life.reset();
    if (mixer && freezeT != null) mixer.setTime(freezeT);
    else if (mixer) {
      mixer.timeScale = playbackSpeed(delta);
      mixer.update(delta);
    } else idlePose(clock.elapsedTime);
    if (alive) {
      const now = performance.now() / 1000;
      life.setSit(sitMode());
      life.update(delta, clock.elapsedTime, {
        camera, width: window.innerWidth, height: window.innerHeight,
        dancing: !!mixer && !holdingPose, still: holdingPose,
        beat: { active: music.active, phase: music.phase(now) },
      });
    }
    reportSitting();
    vrm.update(delta);
    toon.update(renderer, scene, camera, sun); // after vrm.update: life.js has moved the head
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
  lastCustom = custom;
  applyCustomization(vrm, custom);
  frameCharacter();
});
api.onSettings((s) => {
  const t = toonOptions(s);
  if (t.enabled !== toon.enabled) {
    toon.setEnabled(t.enabled);
    toon.setLights(hemi, sun, t.enabled && toon.patched.length > 0);
    if (vrm) {
      markAlphaData(vrm); // stand-in materials (plain models) are new objects
      applyCustomization(vrm, lastCustom);
    }
  }
  toon.setStrength(t.strength);
  toon.hairShadow = t.hairShadow;
  toon.setLight(t.light);
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
  grab: life.grab ? { part: life.grab.part, w: life.grab.w, releasing: life.grab.releasing } : null,
  pins: [...life.pins.keys()],
  sit: { mode: life.sit.mode, w: life.sit.w, sitting: life.sitting, hang: sentHang },
  springs: springState(),
});
// "지금 포즈 저장": the normalized bones as they are on screen, in VRM 1.0 space (VRM 0.x mirrored back)
function capturePose() {
  const h = vrm.humanoid;
  const s = vrmAxisSign(vrm);
  const byNode = new Map();
  for (const name of Object.keys(h.humanBones)) {
    const n = h.getNormalizedBoneNode(name);
    if (n) byNode.set(n, name);
  }
  const bones = {};
  for (const [n, name] of byNode) {
    let p = n.parent;
    while (p && !byNode.has(p)) p = p.parent;
    const t = h.normalizedRestPose[name]?.position || n.position.toArray();
    const q = n.quaternion;
    bones[name] = { parent: p ? byNode.get(p) : null, t: [s * t[0], t[1], s * t[2]], q: [s * q.x, q.y, s * q.z, q.w] };
  }
  const hp = h.getNormalizedBoneNode('hips').position;
  return { bones, hips: [s * hp.x, hp.y, s * hp.z] };
}
// ---------------------------------------------------------------- sitting

let perched = false; // sitting on another window (main moves the window there)
api.onPerch?.((on) => {
  perched = on;
});
let restUntil = 0; // a rest on the taskbar's edge after a walk (performance.now() ms)
api.onRestSit?.((sec) => {
  restUntil = performance.now() + sec * 1000;
});
function sitMode() {
  if (life.walk.on) restUntil = 0; // a new walk ends the rest
  if (perched) return mixer && !holdingPose ? 'dance' : 'rest';
  if (performance.now() < restUntil) return 'rest';
  if (settings.sitDance && mixer && !holdingPose) return 'dance';
  return null;
}
// Seated, the hanging lower legs need the window to reach below the floor: tell main how far.
let sentHang = 0;
function reportSitting() {
  const hips = vrm.humanoid.normalizedRestPose.hips?.position?.[1] || 0.9;
  const want = life.sitting ? Math.min(0.6, (hips * 0.75) / viewHeight) : 0;
  if (Math.abs(want - sentHang) > 0.01) api.setSitting?.((sentHang = want));
}

api.onCapturePose?.(() => {
  if (vrm) api.sendPose(capturePose());
});
api.onReleasePins?.(() => life.releasePins());

// dev/test hook: where a humanoid bone is drawn, in window CSS px
window.__dancerGrabAt = (x, y) => grabPartAt(x, y)?.part || null;
window.__dancerFloorPx = () => ((camera.top - 0) / (camera.top - camera.bottom)) * window.innerHeight;
window.__dancerBonePx = (name) => {
  const n = vrm?.humanoid.getRawBoneNode(name);
  if (!n) return null;
  const v = n.getWorldPosition(new THREE.Vector3()).project(camera);
  return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight };
};
// spring bones (hair, skirt): how many joints, and how far their tips are from where they rest
function springState() {
  const mgr = vrm?.springBoneManager;
  if (!mgr) return null;
  let n = 0, bend = 0;
  for (const j of mgr.joints) {
    n++;
    const q = j.bone.quaternion;
    bend = Math.max(bend, 2 * Math.acos(Math.min(1, Math.abs(q.w))));
  }
  return { joints: n, maxBendDeg: (bend * 180) / Math.PI };
}
window.__dancerSync = () =>
  tempo && music.active && action ? syncRate(tempo, action.time, music.tracker, performance.now() / 1000, settings.speed)?.error : null;

window.addEventListener('error', (e) => api.reportError(e.message));
window.addEventListener('unhandledrejection', (e) => api.reportError(e.reason?.stack || e.reason));

(async () => {
  const init = await api.getInitial();
  settings = init.settings;
  toon.setLight(settings.light);
  toon.setLights(hemi, sun, settings.toonShader !== false);
  syncMusic();
  resize();
  tick();
  await load(init);
})();
