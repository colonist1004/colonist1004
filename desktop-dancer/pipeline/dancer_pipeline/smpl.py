"""SMPL pose parameters (e.g. from GVHMR) -> VRM humanoid local rotations.

In the SMPL rest pose, as in the VRM normalized T-pose, every joint frame is aligned with the
world axes, +Y is up, the body faces +Z and its left is +X. A joint rotation therefore carries
over to the VRM bone directly. No SMPL body model file is needed.
"""
from __future__ import annotations

import numpy as np

from .rot import axis_angle_to_matrix, normalize, rotation_between, yaw_matrix

# SMPL joint index -> VRM bone. 6 (spine2) and 9 (spine3) are both folded into chest.
SMPL_TO_VRM = {
    1: "leftUpperLeg", 2: "rightUpperLeg", 3: "spine", 4: "leftLowerLeg", 5: "rightLowerLeg",
    7: "leftFoot", 8: "rightFoot", 10: "leftToes", 11: "rightToes", 12: "neck",
    13: "leftShoulder", 14: "rightShoulder", 15: "head", 16: "leftUpperArm", 17: "rightUpperArm",
    18: "leftLowerArm", 19: "rightLowerArm", 20: "leftHand", 21: "rightHand",
}


def load_smpl_npz(path):
    """Accepts our exported .npz or GVHMR's hmr4d_results.pt directly (the latter needs torch)."""
    if str(path).endswith(".pt"):
        import torch  # only for .pt input

        g = torch.load(path, map_location="cpu")["smpl_params_global"]
        d = {k: v.detach().cpu().numpy() for k, v in g.items() if hasattr(v, "detach")}
        d["body_pose"] = d["body_pose"][:, :63]
    else:
        d = np.load(path)
    go = np.asarray(d["global_orient"], dtype=np.float64).reshape(-1, 3)
    bp = np.asarray(d["body_pose"], dtype=np.float64).reshape(len(go), -1, 3)
    transl = np.asarray(d["transl"], dtype=np.float64).reshape(-1, 3) if "transl" in d else np.zeros_like(go)
    fps = float(d["fps"]) if "fps" in d else 30.0
    return go, bp, transl, fps


def smpl_to_rotations(global_orient, body_pose, transl):
    """Returns (local_rot, root_translation) in the VRM frame, gravity-aligned and facing +Z on average."""
    R_root = axis_angle_to_matrix(global_orient)
    J = axis_angle_to_matrix(body_pose[:, :21])  # (F,21,3,3); joint j is body_pose[j-1]

    # Whatever axis the source treats as "up", turn the average torso direction to +Y.
    torso_up = np.einsum("fij,j->fi", R_root, [0, 1, 0]).mean(axis=0)
    A = rotation_between(normalize(torso_up), np.array([0.0, 1.0, 0.0]))
    # Then turn the average facing direction to +Z.
    fwd = np.einsum("ij,fjk,k->fi", A, R_root, [0, 0, 1])
    yaw = np.arctan2(fwd[:, 0].mean(), fwd[:, 2].mean())
    A = yaw_matrix(-yaw) @ A

    local = {"hips": A @ R_root}
    for j, bone in SMPL_TO_VRM.items():
        local[bone] = J[:, j - 1]
    local["chest"] = J[:, 5] @ J[:, 8]
    return local, np.einsum("ij,fj->fi", A, transl)
