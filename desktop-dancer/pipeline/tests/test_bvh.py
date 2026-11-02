"""BVH import tests (numpy only): python tests/test_bvh.py

Writes the bundled sample dance as BVH in an unfriendly flavour (Mixamo bone names, centimeters,
facing -Z, A-pose rest, ZXY channels, extra unmapped bones), imports it back and compares.
"""
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dancer_pipeline.bvh import load_bvh, map_bones  # noqa: E402
from dancer_pipeline.rot import axis_angle_to_matrix, yaw_matrix  # noqa: E402
from dancer_pipeline.skeleton import BONES, PARENT, REST_POS, forward_kinematics  # noqa: E402
from dancer_pipeline.vrma import read_vrma  # noqa: E402

SAMPLE = Path(__file__).resolve().parents[2] / "assets" / "motions" / "sample-dance.vrma"
MIXAMO = {
    "hips": "Hips", "spine": "Spine", "chest": "Spine1", "neck": "Neck", "head": "Head",
    "leftShoulder": "LeftShoulder", "leftUpperArm": "LeftArm", "leftLowerArm": "LeftForeArm", "leftHand": "LeftHand",
    "rightShoulder": "RightShoulder", "rightUpperArm": "RightArm", "rightLowerArm": "RightForeArm", "rightHand": "RightHand",
    "leftUpperLeg": "LeftUpLeg", "leftLowerLeg": "LeftLeg", "leftFoot": "LeftFoot", "leftToes": "LeftToeBase",
    "rightUpperLeg": "RightUpLeg", "rightLowerLeg": "RightLeg", "rightFoot": "RightFoot", "rightToes": "RightToeBase",
}
JOINTS = ["head", "leftHand", "rightHand", "leftLowerArm", "rightLowerArm", "leftFoot", "rightFoot", "leftLowerLeg", "rightLowerLeg"]


def euler_zxy(R):
    """R = Rz(a) Rx(b) Ry(c) -> degrees (a, b, c)."""
    b = np.arcsin(np.clip(R[..., 2, 1], -1, 1))
    a = np.arctan2(-R[..., 0, 1], R[..., 1, 1])
    c = np.arctan2(-R[..., 2, 0], R[..., 2, 2])
    return np.degrees(np.stack([a, b, c], -1))


def write_bvh(path, fps, local, hips, a_pose_deg=45, yaw_deg=180, unit=100.0, prefix="mixamorig:"):
    n = len(hips)
    Y = yaw_matrix(np.radians(yaw_deg))
    # A-pose rest: arms rotated down. C_cum(b) = rest world rotation of each VRM bone.
    rest_local = {b: np.eye(3) for b in BONES}
    d = np.radians(a_pose_deg)
    rest_local["leftUpperArm"] = axis_angle_to_matrix(np.array([0, 0, -d]))
    rest_local["rightUpperArm"] = axis_angle_to_matrix(np.array([0, 0, d]))
    one = np.zeros((1, 3))
    one[0, 1] = REST_POS["hips"][1]
    rpos, rrot = forward_kinematics({b: m[None] for b, m in rest_local.items()}, one)
    # motion world rotations
    _, W = forward_kinematics(local, hips)
    bones = [b for b in BONES if b in MIXAMO]
    lines = ["HIERARCHY"]
    world_bvh = {b: Y @ W[b] @ np.swapaxes(rrot[b], -1, -2) @ Y.T for b in bones}

    def emit(b, depth):
        ind = "  " * depth
        kind = "ROOT" if PARENT[b] is None else "JOINT"
        off = (Y @ (rpos[b][0] - (rpos[PARENT[b]][0] if PARENT[b] else 0))) * unit
        lines.append(f"{ind}{kind} {prefix}{MIXAMO[b]}")
        lines.append(ind + "{")
        lines.append(f"{ind}  OFFSET {off[0]:.5f} {off[1]:.5f} {off[2]:.5f}")
        ch = "6 Xposition Yposition Zposition Zrotation Xrotation Yrotation" if kind == "ROOT" else "3 Zrotation Xrotation Yrotation"
        lines.append(f"{ind}  CHANNELS {ch}")
        kids = [c for c in bones if PARENT[c] == b]
        if b == "head":  # an extra, unmapped bone
            lines.extend([f"{ind}  JOINT {prefix}HeadTop_End", ind + "  {", f"{ind}    OFFSET 0 18 0", f"{ind}    CHANNELS 3 Zrotation Xrotation Yrotation",
                      f"{ind}    End Site", ind + "    {", f"{ind}      OFFSET 0 5 0", ind + "    }", ind + "  }"])
        for c in kids:
            emit(c, depth + 1)
        if not kids and b != "head":
            lines.extend([f"{ind}  End Site", ind + "  {", f"{ind}    OFFSET 0 -3 0", ind + "  }"])
        lines.append(ind + "}")

    emit("hips", 0)
    order = []

    def walk(b):
        order.append(b)
        if b == "head":
            order.append("_headtop")
        for c in [c for c in bones if PARENT[c] == b]:
            walk(c)

    walk("hips")
    cols = []
    for b in order:
        if b == "_headtop":
            cols.append(np.zeros((n, 3)))
            continue
        p = PARENT[b]
        L = world_bvh[b] if p is None else np.swapaxes(world_bvh[p], -1, -2) @ world_bvh[b]
        if p is None:
            cols.append((hips @ Y.T) * unit)
        cols.append(euler_zxy(L))
    data = np.concatenate(cols, axis=1)
    lines += ["MOTION", f"Frames: {n}", f"Frame Time: {1 / fps:.6f}"]
    lines += [" ".join(f"{v:.5f}" for v in row) for row in data]
    Path(path).write_text("\n".join(lines))


def joint_error(la, lb):
    n = len(next(iter(la.values())))
    h = np.tile([0, 0.95, 0], (n, 1))
    pa, _ = forward_kinematics(la, h)
    pb, _ = forward_kinematics(lb, h)
    return np.stack([np.linalg.norm(pa[j] - pb[j], axis=-1) for j in JOINTS]).mean()


def test_name_mapping_schemes():
    for names in (["mixamorig:Hips", "mixamorig:LeftUpLeg", "mixamorig:LeftLeg", "mixamorig:LeftArm", "mixamorig:LeftForeArm"],
                  ["Hips", "LeftThigh", "LeftShin", "LeftUpperArm", "LeftForeArm"],       # Rokoko-like
                  ["pelvis", "l_thigh", "l_calf", "l_upperarm", "l_forearm"],             # UE-like
                  ["hip", "lThigh", "lShin", "lShldr", "lForeArm"]):                      # DAZ/CMU-like (partial)
        m = map_bones(names)
        assert m.get("hips") == 0 and m.get("leftUpperLeg") == 1 and m.get("leftLowerLeg") == 2, (names, m)


def test_bvh_roundtrip():
    fps, local, hips = read_vrma(SAMPLE)
    for kw in ({}, {"a_pose_deg": 0, "yaw_deg": 0, "unit": 1.0, "prefix": ""}):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.bvh"
            write_bvh(p, fps, local, hips, **kw)
            f2, est, root, warn = load_bvh(p)
        err = joint_error(local, est)
        print(f"BVH {kw or 'mixamo/cm/-Z/A-pose'}: mean joint error {err * 100:.2f} cm, fps {f2:.1f}")
        assert abs(f2 - fps) < 0.1 and err < 0.01
        dy = root[:, 1] - root[0, 1]
        assert np.allclose(dy, hips[:, 1] - hips[0, 1], atol=0.01), "root bounce should carry over"


def test_cli_bvh():
    import extract_dance

    fps, local, hips = read_vrma(SAMPLE)
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "dance.bvh"
        write_bvh(p, fps, local, hips)
        out = extract_dance.main([str(p), "--out", str(Path(d) / "y.vrma"), "--root", "inplace", "--smooth", "0", "--loop"])
        _, est, _ = read_vrma(out)
    n = len(next(iter(est.values())))
    err = joint_error({b: m[:n] for b, m in local.items()}, est)
    print(f"CLI .bvh -> .vrma: mean joint error {err * 100:.2f} cm")
    assert err < 0.03


if __name__ == "__main__":
    failed = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
                print(f"PASS  {name}")
            except AssertionError as e:
                failed += 1
                print(f"FAIL  {name}  {e}")
    sys.exit(1 if failed else 0)
