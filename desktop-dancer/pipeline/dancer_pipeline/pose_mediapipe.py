"""MediaPipe Pose Landmarker backend (CPU, works on any OS, no CUDA).

Produces per-frame 3D keypoints in the VRM frame plus per-frame validity.
MediaPipe world landmarks are in meters, centered between the hips, camera oriented
(x right, y down, z away from the camera). Rotating 180° about X gives +Y up with
the person facing +Z when they face the camera, and their left stays +X.
"""
from __future__ import annotations

import urllib.request

import numpy as np

from .library import cache_dir
from .retarget import MP_NAMES

MODEL_URLS = {
    "lite": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
    "full": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task",
    "heavy": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task",
}

MP_TO_VRM = np.diag([1.0, -1.0, -1.0])


def model_path(variant: str, log=print):
    """Downloads the model into the cache on first use."""
    path = cache_dir() / "models" / f"pose_landmarker_{variant}.task"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        log(f"downloading MediaPipe model ({variant}) ...")
        tmp = path.with_suffix(".part")
        urllib.request.urlretrieve(MODEL_URLS[variant], tmp)
        tmp.replace(path)
    return path


def _center_and_size(lms):
    """2D hip center and torso size (normalized image coords) of one detected pose."""
    p = np.array([[l.x, l.y] for l in lms])
    hip = (p[23] + p[24]) / 2
    sh = (p[11] + p[12]) / 2
    return hip, np.linalg.norm(sh - hip)


def estimate(frames, fps, variant="heavy", person=None, max_people=4, min_visibility=0.3, log=print, on_frame=None):
    """frames: iterable of (t, rgb). person: None = largest person, or an index counted left to right
    in the first frame where people are found. Returns (world keypoints name->(F,3), image keypoints
    name->(F,2) in pixels with +y up, valid (F,))."""
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision

    opts = vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(model_path(variant, log))),
        running_mode=vision.RunningMode.VIDEO,
        num_poses=max_people if person is not None or max_people > 1 else 1,
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    world, image, valid = [], [], []
    prev_center = None
    last_ts = -1
    with vision.PoseLandmarker.create_from_options(opts) as lm:
        for i, (t, rgb) in enumerate(frames):
            ts = max(int(round(t * 1000)), last_ts + 1)  # strictly increasing timestamps
            last_ts = ts
            res = lm.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)), ts)
            chosen = None
            if res.pose_landmarks:
                cands = [(_center_and_size(p), k) for k, p in enumerate(res.pose_landmarks)]
                if prev_center is None:
                    if person is None:
                        chosen = max(cands, key=lambda c: c[0][1])[1]  # largest torso
                    else:
                        order = sorted(cands, key=lambda c: c[0][0][0])  # left to right
                        if person >= len(order):
                            raise SystemExit(f"--person {person}: 첫 장면에서 {len(order)}명만 감지됐습니다")
                        chosen = order[person][1]
                else:  # follow the same person: nearest hip center to the previous frame
                    chosen = min(cands, key=lambda c: np.linalg.norm(c[0][0] - prev_center))[1]
                    if np.linalg.norm(_center_and_size(res.pose_landmarks[chosen])[0] - prev_center) > 0.25:
                        chosen = None  # jumped to somebody else; treat as missing
            if chosen is None:
                world.append(np.zeros((33, 3)))
                image.append(np.zeros((33, 2)))
                valid.append(False)
            else:
                w = np.array([[l.x, l.y, l.z] for l in res.pose_world_landmarks[chosen]]) @ MP_TO_VRM.T
                vis = np.array([l.visibility for l in res.pose_world_landmarks[chosen]])
                center, _ = _center_and_size(res.pose_landmarks[chosen])
                prev_center = center
                h, wd = rgb.shape[:2]
                img = np.array([[l.x * wd, -l.y * h] for l in res.pose_landmarks[chosen]])
                world.append(w)
                image.append(img)
                # core joints must be seen; hands/feet can be filled from neighbors
                valid.append(bool(np.all(vis[[11, 12, 23, 24]] > min_visibility)))
            if on_frame and i % 5 == 0:
                on_frame(i)
    world, image = np.array(world), np.array(image)
    kp = {name: world[:, k] for k, name in enumerate(MP_NAMES)}
    kp2d = {name: image[:, k] for k, name in enumerate(MP_NAMES)}
    return kp, kp2d, np.array(valid)
