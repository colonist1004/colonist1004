"""3D body keypoints -> VRM humanoid local rotations.

Keypoints use MediaPipe Pose names, already converted to the VRM frame:
meters, +Y up, the person faces +Z, the person's left is +X.

Every bone's world rotation is built from two observed directions (a primary axis along the
bone and a secondary axis that fixes the twist) and compared with the same two directions in
the T-pose. Elbows and knees take the twist from the bend plane. When the limb is almost
straight that plane is undefined, so the twist then comes from the parent or the foot.
"""
from __future__ import annotations

import numpy as np

from .rot import frame, matrix_power, normalize

MP_NAMES = [
    "nose", "left_eye_inner", "left_eye", "left_eye_outer", "right_eye_inner", "right_eye", "right_eye_outer",
    "left_ear", "right_ear", "mouth_left", "mouth_right", "left_shoulder", "right_shoulder", "left_elbow",
    "right_elbow", "left_wrist", "right_wrist", "left_pinky", "right_pinky", "left_index", "right_index",
    "left_thumb", "right_thumb", "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle",
    "left_heel", "right_heel", "left_foot_index", "right_foot_index",
]

X, Y, Z = np.eye(3)


def _rest_frame(p, s):
    return frame(np.asarray(p, float), np.asarray(s, float))


def _world(primary, secondary, rest_p, rest_s):
    """World rotation W with W @ rest_p ∥ primary and the twist fixed by secondary."""
    return frame(primary, secondary) @ _rest_frame(rest_p, rest_s).T


def _blend_dirs(a, b, w):
    return normalize(w[:, None] * a + (1 - w[:, None]) * b)


def _limb(upper_dir, lower_dir, rest_dir, rest_hinge, fallback_hinge):
    """World rotations of a two-segment limb (upper, lower) that bends about a hinge."""
    cross = np.cross(lower_dir, upper_dir)
    s = np.linalg.norm(cross, axis=-1)
    bend_hinge = cross / np.maximum(s, 1e-9)[:, None]
    # Bend plane is reliable above ~15 degrees; below that fade to the fallback twist.
    w = np.clip((s - 0.05) / 0.2, 0, 1)
    # Keep the fallback on the same side as the bend hinge where both exist.
    hinge = _blend_dirs(bend_hinge, fallback_hinge, w)
    upper = _world(upper_dir, hinge, rest_dir, rest_hinge)
    lower = _world(lower_dir, hinge, rest_dir, rest_hinge)
    return upper, lower


def _flatten_foot_bias(fwd):
    """MediaPipe's heel point sits above the real heel, so heel->toe slopes down even on a flat
    foot. Remove the clip's median pitch: on average the foot is taken to be flat."""
    fwd = normalize(fwd)
    horiz = np.linalg.norm(fwd[:, [0, 2]], axis=1)
    pitch = np.arctan2(fwd[:, 1], horiz)
    p = pitch - np.median(pitch)
    hdir = fwd[:, [0, 2]] / np.maximum(horiz, 1e-9)[:, None]
    return np.stack([hdir[:, 0] * np.cos(p), np.sin(p), hdir[:, 1] * np.cos(p)], axis=1)


def keypoints_to_rotations(kp: dict[str, np.ndarray], hand_weight: float = 1.0) -> dict[str, np.ndarray]:
    """kp: name -> (F,3). Returns bone -> (F,3,3) local rotations."""
    g = lambda n: np.asarray(kp[n], dtype=np.float64)  # noqa: E731
    n = len(g("left_hip"))
    eye = np.broadcast_to(np.eye(3), (n, 3, 3))

    hip_mid = (g("left_hip") + g("right_hip")) / 2
    sh_mid = (g("left_shoulder") + g("right_shoulder")) / 2
    torso_up = sh_mid - hip_mid

    W = {}
    W["hips"] = _world(g("left_hip") - g("right_hip"), torso_up, X, Y)
    W_chest = _world(g("left_shoulder") - g("right_shoulder"), torso_up, X, Y)

    ear_mid = (g("left_ear") + g("right_ear")) / 2
    # In the T-pose the nose sits a little below the ears, hence the tilted rest secondary.
    W_head = _world(g("left_ear") - g("right_ear"), g("nose") - ear_mid, X, [0, -0.25, 1])

    local = {}
    rel = np.swapaxes(W["hips"], -1, -2) @ W_chest
    half = matrix_power(rel, 0.5)
    local["hips"] = W["hips"]
    local["spine"] = half
    local["chest"] = half
    W["chest"] = W["hips"] @ half @ half

    rel = np.swapaxes(W["chest"], -1, -2) @ W_head
    half = matrix_power(rel, 0.5)
    local["neck"] = half
    local["head"] = half

    for side, sx in (("left", 1.0), ("right", -1.0)):
        # Arms: T-pose points along ±X. The elbow bends the forearm forward (+Z).
        rest_dir = np.array([sx, 0, 0])
        rest_bent = normalize(np.array([sx * np.cos(0.5), 0, np.sin(0.5)]))
        rest_hinge = normalize(np.cross(rest_bent, rest_dir))
        up_dir = normalize(g(f"{side}_elbow") - g(f"{side}_shoulder"))
        lo_dir = normalize(g(f"{side}_wrist") - g(f"{side}_elbow"))
        fb = np.einsum("fij,j->fi", W["chest"], rest_hinge)
        ua, la = _limb(up_dir, lo_dir, rest_dir, rest_hinge, fb)
        local[f"{side}Shoulder"] = eye
        local[f"{side}UpperArm"] = np.swapaxes(W["chest"], -1, -2) @ ua
        local[f"{side}LowerArm"] = np.swapaxes(ua, -1, -2) @ la

        hand_dir = (g(f"{side}_index") + g(f"{side}_pinky")) / 2 - g(f"{side}_wrist")
        hand_side = g(f"{side}_index") - g(f"{side}_pinky")
        hand = _world(hand_dir, hand_side, rest_dir, Z)
        hand_local = np.swapaxes(la, -1, -2) @ hand
        local[f"{side}Hand"] = matrix_power(hand_local, hand_weight) if hand_weight != 1 else hand_local

        # Legs: T-pose points down (-Y). The knee bends the shin backward (-Z).
        rest_dir = -Y
        rest_bent = normalize(np.array([0, -np.cos(0.5), -np.sin(0.5)]))
        rest_hinge = normalize(np.cross(rest_bent, rest_dir))
        up_dir = normalize(g(f"{side}_knee") - g(f"{side}_hip"))
        lo_dir = normalize(g(f"{side}_ankle") - g(f"{side}_knee"))
        foot_fwd = _flatten_foot_bias(g(f"{side}_foot_index") - g(f"{side}_heel"))
        fb = normalize(np.cross(up_dir, foot_fwd))  # knee axis ⟂ leg and foot direction (= -X at rest)
        ul, ll = _limb(up_dir, lo_dir, rest_dir, rest_hinge, fb)
        local[f"{side}UpperLeg"] = np.swapaxes(W["hips"], -1, -2) @ ul
        local[f"{side}LowerLeg"] = np.swapaxes(ul, -1, -2) @ ll
        foot = _world(foot_fwd, g(f"{side}_ankle") - g(f"{side}_heel"), Z, Y)
        local[f"{side}Foot"] = np.swapaxes(ll, -1, -2) @ foot
        local[f"{side}Toes"] = eye

    return local
