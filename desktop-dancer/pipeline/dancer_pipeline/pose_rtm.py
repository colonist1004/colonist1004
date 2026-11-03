"""RTMW3D engine (OpenMMLab RTMPose family, Apache-2.0) through ONNX Runtime.

Runs on any GPU on Windows through DirectML (AMD, Intel, NVIDIA), on CUDA/ROCm when available,
or on the CPU. Person detection: YOLOX-m (human-art). Pose: RTMW3D-x, 133 whole-body keypoints with
accurate image positions and a root-relative depth per keypoint.

The output matches the MediaPipe engine (MediaPipe keypoint names, +Y up) so the same lifting,
retargeting and post-processing apply. RTMW3D's depth sign convention is calibrated per clip:
in frames where the dancer faces the camera, the toes are closer to the camera than the heels.
"""
from __future__ import annotations

import numpy as np

from .retarget import MP_NAMES

DET_URL = "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/yolox_m_8xb8-300e_humanart-c2c7a14a.zip"
POSE_URL = "https://huggingface.co/Soykaf/RTMW3D-x/resolve/main/onnx/rtmw3d-x_8xb64_cocktail14-384x288-b0a0eab7_20240626.onnx"

# MediaPipe name -> COCO-WholeBody index (133 keypoints: 0-16 body, 17-22 feet, 23-90 face, 91-111 left hand, 112-132 right hand)
WB = {
    "nose": 0, "left_eye_inner": 1, "left_eye": 1, "left_eye_outer": 1, "right_eye_inner": 2, "right_eye": 2,
    "right_eye_outer": 2, "left_ear": 3, "right_ear": 4, "mouth_left": 23 + 54, "mouth_right": 23 + 48,
    "left_shoulder": 5, "right_shoulder": 6, "left_elbow": 7, "right_elbow": 8, "left_wrist": 9, "right_wrist": 10,
    "left_pinky": 91 + 17, "right_pinky": 112 + 17, "left_index": 91 + 5, "right_index": 112 + 5,
    "left_thumb": 91 + 4, "right_thumb": 112 + 4, "left_hip": 11, "right_hip": 12, "left_knee": 13, "right_knee": 14,
    "left_ankle": 15, "right_ankle": 16, "left_heel": 19, "right_heel": 22, "left_foot_index": 17, "right_foot_index": 20,
}
CORE = [5, 6, 11, 12]


def pick_device(log=print):
    import onnxruntime as ort

    avail = ort.get_available_providers()
    for dev, prov in (("dml", "DmlExecutionProvider"), ("cuda", "CUDAExecutionProvider"), ("rocm", "ROCMExecutionProvider")):
        if prov in avail:
            return dev
    return "cpu"


def load_models(device, log=print):
    from rtmlib import YOLOX, RTMPose3d
    from rtmlib.tools import base

    base.RTMLIB_SETTINGS["onnxruntime"]["dml"] = "DmlExecutionProvider"
    log(f"RTMW3D 모델 준비 (장치: {device}) — 처음에는 약 300MB를 내려받습니다")
    det = YOLOX(DET_URL, model_input_size=(640, 640), backend="onnxruntime", device=device)
    pose = RTMPose3d(POSE_URL, model_input_size=(288, 384), backend="onnxruntime", device=device)
    return det, pose


def _bbox_from_kpts(k2, sc, w, h):
    m = sc[:23] > 0.3
    if m.sum() < 4:
        return None
    p = k2[:23][m]
    lo, hi = p.min(0), p.max(0)
    c, s = (lo + hi) / 2, (hi - lo) * 1.25 + 20
    return np.array([max(0, c[0] - s[0] / 2), max(0, c[1] - s[1] / 2), min(w, c[0] + s[0] / 2), min(h, c[1] + s[1] / 2)])


def estimate(frames, fps, person=None, log=print, on_frame=None, models=None, det_every=8):
    """Same contract as pose_mediapipe.estimate: (world kp, image kp (+Y up, px), valid)."""
    det, pose = models or load_models(pick_device(log), log)
    k2s, zs, scs, valid, sizes = [], [], [], [], []
    prev_box, prev_center = None, None
    for i, (t, rgb) in enumerate(frames):
        img = np.ascontiguousarray(rgb[:, :, ::-1])  # rtmlib expects BGR like OpenCV
        h, w = img.shape[:2]
        sizes.append((w, h))
        box = None
        if prev_box is None or i % det_every == 0:
            boxes = det(img)
            if len(boxes):
                boxes = np.asarray(boxes)[:, :4]
                centers = (boxes[:, :2] + boxes[:, 2:]) / 2
                if prev_center is not None:
                    box = boxes[np.argmin(np.linalg.norm(centers - prev_center, axis=1))]
                elif person is not None:
                    order = np.argsort(centers[:, 0])
                    if person >= len(order):
                        raise SystemExit(f"--person {person}: 첫 장면에서 {len(order)}명만 감지됐습니다")
                    box = boxes[order[person]]
                else:
                    box = boxes[np.argmax((boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1]))]
        if box is None:
            box = prev_box
        if box is None:
            k2s.append(np.zeros((133, 2)))
            zs.append(np.zeros(133))
            scs.append(np.zeros(133))
            valid.append(False)
        else:
            k3, sc, _, k2 = pose(img, bboxes=[box])
            k2, z, sc = k2[0], k3[0, :, 2], sc[0]
            ok = bool(np.all(sc[CORE] > 0.3))
            k2s.append(k2)
            zs.append(z)
            scs.append(sc)
            valid.append(ok)
            prev_box = _bbox_from_kpts(k2, sc, w, h) if ok else None
            prev_center = k2[[11, 12]].mean(0) if ok else prev_center
        if on_frame and i % 5 == 0:
            on_frame(i)
    k2s, scs = np.array(k2s), np.array(scs)
    return (*to_keypoints(k2s, np.array(zs), np.array(valid)), legs_in_view(k2s, scs, np.array(sizes, float)))


def legs_in_view(k2, sc, sizes, min_score=0.3):
    """side -> (F, 2) bool: knee and ankle detected with confidence and inside the picture."""
    out = {}
    for side, ks in (("left", (13, 15)), ("right", (14, 16))):
        p = k2[:, ks]  # (F, 2, 2) px
        inside = (p[..., 0] > -0.02 * sizes[:, None, 0]) & (p[..., 0] < 1.02 * sizes[:, None, 0]) \
            & (p[..., 1] > -0.02 * sizes[:, None, 1]) & (p[..., 1] < sizes[:, None, 1])
        out[side] = inside & (sc[:, ks] > min_score)
    return out


BONES_WB = [(5, 7), (7, 9), (6, 8), (8, 10), (11, 13), (13, 15), (12, 14), (14, 16), (5, 11), (6, 12), (5, 6), (11, 12)]


def _depth_scale(img, z):
    """Factor for z that minimizes the relative variation of bone lengths over time."""
    best, best_cost = 1.0, np.inf
    for f in np.exp(np.linspace(np.log(0.4), np.log(2.5), 41)):
        cost = 0.0
        for a, b in BONES_WB:
            L = np.sqrt(((img[:, a] - img[:, b]) ** 2).sum(1) + (f * (z[:, a] - z[:, b])) ** 2)
            cost += L.std() / max(L.mean(), 1e-9)
        if cost < best_cost:
            best, best_cost = f, cost
    return best


def to_keypoints(k2, z, valid):
    """COCO-WholeBody 2D (px, y down) + relative depth -> MediaPipe-named world/image keypoints (+Y up).
    World units are pixels; the depth is rescaled to pixels and its sign calibrated."""
    img = k2 * np.array([1.0, -1.0])
    v = valid if valid.any() else np.ones(len(valid), bool)
    # Depth scale: bones keep their length, so pick the depth scale that makes the 3D bone lengths
    # most constant over the clip (a rough "torso = 0.5 m" guess is only the starting point).
    torso_px = np.median(np.linalg.norm((img[v][:, 5] + img[v][:, 6]) / 2 - (img[v][:, 11] + img[v][:, 12]) / 2, axis=1))
    zs = z * (torso_px / 0.5) * _depth_scale(img[v], z[v] * (torso_px / 0.5))
    # sign: facing the camera <=> the person's left shoulder is on the image right
    facing = v & (k2[:, 5, 0] > k2[:, 6, 0])
    sel = facing if facing.sum() >= 3 else v
    toe_minus_heel = np.concatenate([zs[sel, 17] - zs[sel, 19], zs[sel, 20] - zs[sel, 22]])
    sign = 1.0
    d = np.median(toe_minus_heel) if len(toe_minus_heel) else 0.0
    if abs(d) < 1e-6:  # fall back to the face: the nose is in front of the ears
        d = np.median(zs[sel, 0] - (zs[sel, 3] + zs[sel, 4]) / 2) if sel.any() else 1.0
    if facing.sum() >= 3:
        sign = 1.0 if d > 0 else -1.0  # want: toes nearer the camera = larger +Z (VRM: faces +Z toward camera)
    else:
        sign = -1.0 if d > 0 else 1.0  # mostly facing away: toes point away from the camera
    world = np.concatenate([img, (sign * zs)[..., None]], axis=-1)
    kp = {name: world[:, WB[name]] for name in MP_NAMES}
    kp2d = {name: img[:, WB[name]] for name in MP_NAMES}
    return kp, kp2d, valid
