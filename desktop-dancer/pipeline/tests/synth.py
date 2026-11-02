"""Synthetic keypoints / SMPL parameters generated from a known motion (for tests)."""
import numpy as np

from dancer_pipeline.skeleton import forward_kinematics


def keypoints_from_motion(local, hips):
    """MediaPipe-style keypoints (VRM frame) for a motion on the reference skeleton."""
    pos, rot = forward_kinematics(local, hips)
    at = lambda bone, off: pos[bone] + np.einsum("fij,j->fi", rot[bone], off)  # noqa: E731
    kp = {
        "nose": at("head", [0, 0.075, 0.1]),
        "left_ear": at("head", [0.075, 0.1, 0]),
        "right_ear": at("head", [-0.075, 0.1, 0]),
    }
    for side, sx in (("left", 1), ("right", -1)):
        kp[f"{side}_shoulder"] = pos[f"{side}UpperArm"]
        kp[f"{side}_elbow"] = pos[f"{side}LowerArm"]
        kp[f"{side}_wrist"] = pos[f"{side}Hand"]
        kp[f"{side}_index"] = at(f"{side}Hand", [sx * 0.08, 0, 0.03])
        kp[f"{side}_pinky"] = at(f"{side}Hand", [sx * 0.08, 0, -0.03])
        kp[f"{side}_hip"] = pos[f"{side}UpperLeg"]
        kp[f"{side}_knee"] = pos[f"{side}LowerLeg"]
        kp[f"{side}_ankle"] = pos[f"{side}Foot"]
        kp[f"{side}_heel"] = at(f"{side}Foot", [0, -0.06, -0.05])
        kp[f"{side}_foot_index"] = at(f"{side}Foot", [0, -0.07, 0.15])
    return kp, pos
