"""Fuse MediaPipe's accurate 2D image landmarks with its less accurate 3D world landmarks.

x/y come from the image (weak perspective, scaled to meters per frame). Depth differences
along each bone are rebuilt from the bone's length (median over the clip) and its projected
2D length. MediaPipe's own depth only decides whether a joint is in front of or behind its
parent. That decision is softened near zero so the sign cannot flip back and forth.
"""
from __future__ import annotations

import numpy as np

from .post import gaussian_smooth

# parent -> child, roots first. The torso is hung from the hip center.
TREE = [
    ("_hip", "left_hip"), ("_hip", "right_hip"),
    ("left_hip", "left_shoulder"), ("right_hip", "right_shoulder"),
    ("left_shoulder", "left_elbow"), ("left_elbow", "left_wrist"),
    ("left_wrist", "left_index"), ("left_wrist", "left_pinky"), ("left_wrist", "left_thumb"),
    ("right_shoulder", "right_elbow"), ("right_elbow", "right_wrist"),
    ("right_wrist", "right_index"), ("right_wrist", "right_pinky"), ("right_wrist", "right_thumb"),
    ("left_hip", "left_knee"), ("left_knee", "left_ankle"),
    ("left_ankle", "left_heel"), ("left_ankle", "left_foot_index"),
    ("right_hip", "right_knee"), ("right_knee", "right_ankle"),
    ("right_ankle", "right_heel"), ("right_ankle", "right_foot_index"),
    ("_shoulder", "nose"), ("_shoulder", "left_ear"), ("_shoulder", "right_ear"),
    ("_shoulder", "left_eye"), ("_shoulder", "right_eye"),
    ("_shoulder", "mouth_left"), ("_shoulder", "mouth_right"),
    ("left_eye", "left_eye_inner"), ("left_eye", "left_eye_outer"),
    ("right_eye", "right_eye_inner"), ("right_eye", "right_eye_outer"),
]
CORE = ["left_shoulder", "right_shoulder", "left_hip", "right_hip", "left_knee", "right_knee"]


def lift(world: dict, image: dict, fps: float, sign_softness: float = 0.5, length_mode: str = "max", pct: float = 90) -> dict:
    w = dict(world)
    im = dict(image)
    for d in (w, im):
        d["_hip"] = (d["left_hip"] + d["right_hip"]) / 2
        d["_shoulder"] = (d["left_shoulder"] + d["right_shoulder"]) / 2

    # Meters per pixel for each frame: fit the image skeleton to the world skeleton (x/y, hip-centered).
    a = np.stack([im[k] - im["_hip"] for k in CORE], axis=1)  # (F,J,2)
    b = np.stack([w[k][:, :2] - w["_hip"][:, :2] for k in CORE], axis=1)
    scale = (a * b).sum(axis=(1, 2)) / np.maximum((a * a).sum(axis=(1, 2)), 1e-9)
    scale = gaussian_smooth(scale, 0.5 * fps)  # body size changes slowly

    out = {"_hip": np.zeros_like(w["_hip"])}
    xy = {k: (im[k] - im["_hip"]) * scale[:, None] for k in im}
    for k in xy:
        if not k.startswith("_"):
            out[k] = None
    out["_hip"] = np.concatenate([xy["_hip"], np.zeros((len(scale), 1))], axis=1)

    for parent, child in TREE:
        if child not in w:
            continue
        if parent == "_shoulder" and "_shoulder" not in out:
            out["_shoulder"] = (out["left_shoulder"] + out["right_shoulder"]) / 2
        d2 = xy[child] - xy[parent]
        l2 = np.linalg.norm(d2, axis=1)
        Lw = np.median(np.linalg.norm(w[child] - w[parent], axis=1))
        L2 = np.percentile(l2, pct)  # a projection is never longer than the bone
        L = {"world": Lw, "max": max(Lw, L2), "p2d": L2}[length_mode]
        mag = np.sqrt(np.maximum(L * L - l2 * l2, 0))
        wdz = w[child][:, 2] - w[parent][:, 2]
        dz = mag * np.tanh(wdz / (sign_softness * L + 1e-9))
        out[child] = out[parent] + np.concatenate([d2, dz[:, None]], axis=1)

    return {k: v for k, v in out.items() if not k.startswith("_") and v is not None}
