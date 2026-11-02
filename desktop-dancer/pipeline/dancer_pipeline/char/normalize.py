"""Bring a mapped character into VRM 1.0 rest conventions: faces +Z, feet on y=0, chosen height,
arms straight out to the sides and legs straight down (T-pose), world-aligned joint frames."""
from __future__ import annotations

import numpy as np

from ..rot import rotation_between, yaw_matrix
from .gltf_read import Model
from .humanoid import Mapping
from .rig import clear_joint_rotations, joint_pos, pose_and_bake, transform

T_POSE = [  # bone, the bone its direction points to, target direction
    ("leftUpperArm", "leftLowerArm", (1, 0, 0)),
    ("leftLowerArm", "leftHand", (1, 0, 0)),
    ("rightUpperArm", "rightLowerArm", (-1, 0, 0)),
    ("rightLowerArm", "rightHand", (-1, 0, 0)),
    ("leftUpperLeg", "leftLowerLeg", (0, -1, 0)),
    ("leftLowerLeg", "leftFoot", (0, -1, 0)),
    ("rightUpperLeg", "rightLowerLeg", (0, -1, 0)),
    ("rightLowerLeg", "rightFoot", (0, -1, 0)),
]


def normalize(model: Model, mapping: Mapping, height: float = 1.6, flip: bool = False, tpose: bool = True,
              on_step=None) -> Model:
    b = mapping.bones
    # 1) face +Z
    f = mapping.forward
    angle = np.arctan2(f[0], f[2]) + (np.pi if flip else 0.0)
    M = np.eye(4)
    M[:3, :3] = yaw_matrix(-angle)
    m = transform(model, M)

    # 2) T-pose, one bone at a time (each rotation moves the bones below it)
    if tpose:
        for i, (bone, child, target) in enumerate(T_POSE):
            if bone not in b or child not in b:
                continue
            d = joint_pos(m, b[child]) - joint_pos(m, b[bone])
            R = rotation_between(d / np.linalg.norm(d), np.array(target, dtype=float))
            if np.degrees(np.arccos(np.clip((np.trace(R) - 1) / 2, -1, 1))) > 0.5:
                m = pose_and_bake(m, {b[bone]: R})
            if on_step:
                on_step((i + 1) / len(T_POSE))

    # 3) feet on the floor, hips above the origin, requested height
    verts = np.concatenate([p.positions for p in m.prims])
    lo, hi = verts[:, 1].min(), verts[:, 1].max()
    s = height / max(hi - lo, 1e-9)
    hips = joint_pos(m, b["hips"])
    M = np.eye(4) * s
    M[3, 3] = 1
    M[:3, 3] = -s * np.array([hips[0], lo, hips[2]])
    m = transform(m, M)

    # 4) VRM 1.0: joints carry no rest rotation
    return clear_joint_rotations(m)
