"""Builds a "UniRig-like" rigged GLB from a VRM, for testing the character pipeline without a GPU:
bones renamed bone_N, A-pose, arbitrary heading, unit-cube scale. Writes the true VRM bone map as JSON.

  python tests/make_char_fixture.py Seed-san.vrm out_dir [--yaw 180] [--arm-down 40]
"""
import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dancer_pipeline.char.gltf_read import read_glb  # noqa: E402
from dancer_pipeline.char.gltf_write import write_glb  # noqa: E402
from dancer_pipeline.char.rig import joint_pos, pose_and_bake, transform  # noqa: E402
from dancer_pipeline.rot import axis_angle_to_matrix, yaw_matrix  # noqa: E402


CORE = ["hips", "spine", "chest", "upperChest", "neck", "head", "leftShoulder", "rightShoulder",
        "leftUpperArm", "rightUpperArm", "leftLowerArm", "rightLowerArm", "leftHand", "rightHand",
        "leftUpperLeg", "rightUpperLeg", "leftLowerLeg", "rightLowerLeg", "leftFoot", "rightFoot",
        "leftToes", "rightToes"]


def _core_only(m, idx, truth_names, no_neck):
    import copy

    keep_b = [b for b in CORE if b in truth_names]
    if no_neck:
        keep_b = [b for b in keep_b if b not in ("neck", "upperChest", "leftShoulder", "rightShoulder", "leftToes", "rightToes")]
    keep = sorted(idx[truth_names[b]] for b in keep_b)
    # end bones (like UniRig leaf tips) for head, hands and feet
    ch = [[] for _ in m.joint_names]
    for k, p in enumerate(m.joint_parent):
        if p >= 0:
            ch[p].append(k)
    for b in ("head", "leftHand", "rightHand"):
        j = idx[truth_names[b]]
        # deepest descendant along the first child chain = a tip bone
        k = j
        while ch[k]:
            k = ch[k][0] if b == "head" else max(ch[k], key=lambda c: len(ch[c]))
        if k != j:
            keep.append(k)
    keep = sorted(set(keep))
    new = {old: i for i, old in enumerate(keep)}

    def kept_ancestor(j):
        while j >= 0 and j not in new:
            j = m.joint_parent[j]
        return j

    out = copy.deepcopy(m)
    out.joint_names = [m.joint_names[k] for k in keep]
    out.joint_world = m.joint_world[keep]
    out.joint_parent = [new.get(kept_ancestor(m.joint_parent[k]), -1) for k in keep]
    remap = np.array([new.get(kept_ancestor(j), 0) for j in range(len(m.joint_names))])
    for p in out.prims:
        p.joints = remap[p.joints]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("vrm")
    ap.add_argument("out")
    ap.add_argument("--yaw", type=float, default=180)
    ap.add_argument("--arm-down", type=float, default=40)
    ap.add_argument("--core-only", action="store_true",
                    help="keep only main body bones (like a simple auto-rig); others' weights go to the kept ancestor")
    ap.add_argument("--no-neck", action="store_true", help="also drop neck/upperChest/shoulders/toes")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    data = open(a.vrm, "rb").read()
    jl = struct.unpack_from("<I", data, 12)[0]
    gj = json.loads(data[20 : 20 + jl])
    hb = gj["extensions"]["VRMC_vrm"]["humanoid"]["humanBones"]
    truth_names = {b: gj["nodes"][v["node"]]["name"] for b, v in hb.items()}

    m = read_glb(a.vrm)
    idx = {n: k for k, n in enumerate(m.joint_names)}
    rots = {}
    d = np.radians(a.arm_down)
    rots[idx[truth_names["leftUpperArm"]]] = axis_angle_to_matrix(np.array([0, 0, -d]))
    rots[idx[truth_names["rightUpperArm"]]] = axis_angle_to_matrix(np.array([0, 0, d]))
    rots[idx[truth_names["leftLowerArm"]]] = axis_angle_to_matrix(np.array([0, -0.2, 0]))
    rots[idx[truth_names["rightLowerArm"]]] = axis_angle_to_matrix(np.array([0, 0.2, 0]))
    rots[idx[truth_names["leftUpperLeg"]]] = axis_angle_to_matrix(np.array([0, 0, 0.06]))
    rots[idx[truth_names["rightUpperLeg"]]] = axis_angle_to_matrix(np.array([0, 0, -0.06]))
    m = pose_and_bake(m, rots)

    if a.core_only:
        m = _core_only(m, idx, truth_names, a.no_neck)
        idx = {n: k for k, n in enumerate(m.joint_names)}

    # Unit cube like TRELLIS: centered, max extent 1, arbitrary heading.
    allp = np.concatenate([p.positions for p in m.prims])
    c = (allp.min(0) + allp.max(0)) / 2
    s = 1.0 / (allp.max(0) - allp.min(0)).max()
    M = np.eye(4)
    M[:3, :3] = yaw_matrix(np.radians(a.yaw)) * s
    M[:3, 3] = -(yaw_matrix(np.radians(a.yaw)) * s) @ c
    m = transform(m, M)

    # Anonymous bone names, like UniRig's output.
    old = list(m.joint_names)
    m.joint_names = [f"bone_{k}" for k in range(len(old))]
    truth = {b: m.joint_names[idx[n]] for b, n in truth_names.items() if n in idx}
    if a.core_only:
        truth = {b: v for b, v in truth.items() if b in CORE}
    write_glb(m, out / "rigged.glb")
    (out / "truth.json").write_text(json.dumps(truth, indent=1))
    print(f"wrote {out/'rigged.glb'} ({len(old)} joints, yaw {a.yaw}, scale {s:.3f}); hips at {joint_pos(m, idx[truth_names['hips']]).round(3)}")


if __name__ == "__main__":
    main()
