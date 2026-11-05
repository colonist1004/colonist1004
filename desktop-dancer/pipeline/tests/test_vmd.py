"""MMD motion (.vmd) import tests (numpy only): python tests/test_vmd.py

The bundled sample dance is written out as an MMD motion the way MMD would store it (left-handed axes,
8 cm units, an A-pose model, upper/lower body split under the center, arm twist bones) and read back.
Once with the legs as FK keys, once with the legs driven only by foot IK targets.
"""
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dancer_pipeline import vmd  # noqa: E402
from dancer_pipeline.rot import axis_angle_to_matrix, matrix_to_quat  # noqa: E402
from dancer_pipeline.skeleton import REST_POS, forward_kinematics  # noqa: E402
from dancer_pipeline.vrma import read_vrma  # noqa: E402

SAMPLE = Path(__file__).resolve().parents[2] / "assets" / "motions" / "sample-dance.vrma"
M = vmd.MIRROR
JOINTS = ["head", "leftHand", "rightHand", "leftLowerArm", "leftLowerLeg", "rightLowerLeg", "leftFoot", "rightFoot"]


def to_mmd_quat(R):
    """VRM-axes rotation -> MMD quaternion (x, y, z, w)."""
    return matrix_to_quat(M @ R @ M)


def make_vmd(path, local, hips, ik=False, arm_deg=35.0, twist=0.3):
    n = len(hips)
    _, W = forward_kinematics(local, hips)
    keys = {}

    def put(name, R, pos=None):
        q = to_mmd_quat(R)
        p = np.zeros((n, 3)) if pos is None else pos
        keys[name] = [(f, p[f], q[f]) for f in range(n)]

    eye = np.broadcast_to(np.eye(3), (n, 3, 3))
    # center carries the hips offset; the lower body is the hips, the upper body the spine's world
    off = (hips - REST_POS["hips"]) / vmd.UNIT * np.array([1, 1, -1.0])
    put("センター", eye, off)
    put("下半身", W["hips"])
    put("上半身", W["spine"])
    put("上半身2", np.swapaxes(W["spine"], -1, -2) @ W["chest"])
    put("首", np.swapaxes(W["chest"], -1, -2) @ W["neck"])
    put("頭", np.swapaxes(W["neck"], -1, -2) @ W["head"])
    for side, k, sgn in (("left", "左", 1), ("right", "右", -1)):
        Ci = vmd._rz(sgn * arm_deg)  # A-pose -> T-pose (inverse of the importer's C)
        put(f"{k}肩", np.swapaxes(W["chest"], -1, -2) @ W[f"{side}Shoulder"])
        W_arm = W[f"{side}UpperArm"] @ Ci
        W_el = W[f"{side}LowerArm"] @ Ci
        W_wr = W[f"{side}Hand"] @ Ci
        # split the upper arm into 腕 * 腕捩 (a twist about the arm's own axis in A-pose)
        axis = vmd._rz(-sgn * arm_deg) @ [sgn, 0, 0]
        T = axis_angle_to_matrix(np.tile(axis * twist, (n, 1)))
        put(f"{k}腕", np.swapaxes(W[f"{side}Shoulder"], -1, -2) @ W_arm @ np.swapaxes(T, -1, -2))
        put(f"{k}腕捩", T)
        put(f"{k}ひじ", np.swapaxes(W_arm, -1, -2) @ W_el)
        put(f"{k}手首", np.swapaxes(W_el, -1, -2) @ W_wr)
        if not ik:
            put(f"{k}足", np.swapaxes(W["hips"], -1, -2) @ W[f"{side}UpperLeg"])
            put(f"{k}ひざ", np.swapaxes(W[f"{side}UpperLeg"], -1, -2) @ W[f"{side}LowerLeg"])
            put(f"{k}足首", np.swapaxes(W[f"{side}LowerLeg"], -1, -2) @ W[f"{side}Foot"])
        else:
            pos, _ = forward_kinematics(local, hips)
            ik_off = (pos[f"{side}Foot"] - REST_POS[f"{side}Foot"]) / vmd.UNIT * np.array([1, 1, -1.0])
            put(f"{k}足ＩＫ", W[f"{side}Foot"], ik_off)
    vmd.write_vmd(path, keys)


def compare(local, hips, est_local, est_hips):
    a, _ = forward_kinematics(local, hips)
    b, _ = forward_kinematics(est_local, est_hips)
    return {j: float(np.linalg.norm(a[j] - b[j], axis=1).mean()) for j in JOINTS}


def test_fk_roundtrip():
    fps, local, hips = read_vrma(SAMPLE)
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "dance.vmd"
        make_vmd(p, local, hips)
        f2, est, est_hips, warn = vmd.load_vmd(p)
    assert f2 == 30.0 and len(est_hips) == len(hips)
    err = compare(local, hips, est, est_hips)
    print("  FK  joint error (cm):", {k: round(v * 100, 2) for k, v in err.items()})
    assert max(err.values()) < 0.005, err


def test_ik_legs():
    fps, local, hips = read_vrma(SAMPLE)
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "dance_ik.vmd"
        make_vmd(p, local, hips, ik=True)
        _, est, est_hips, _ = vmd.load_vmd(p)
    err = compare(local, hips, est, est_hips)
    print("  IK  joint error (cm):", {k: round(v * 100, 2) for k, v in err.items()})
    assert err["leftFoot"] < 0.005 and err["rightFoot"] < 0.005, err  # ankles reach their targets
    assert err["leftLowerLeg"] < 0.03 and err["rightLowerLeg"] < 0.03, err  # knees bend the same way


def test_easing_curve():
    """Keys 0 and 10 with a slow-in curve: halfway in time is less than halfway in value."""
    k0 = (0, np.zeros(3), np.array([0, 0, 0, 1.0]), vmd.LINEAR)
    curve = bytes([100] * 4 + [0] * 4 + [127] * 4 + [127] * 4) * 4  # (x1,y1)=(0.79,0), (x2,y2)=(1,1)
    k1 = (10, np.array([10.0, 0, 0]), np.array([0, 0, 0, 1.0]), curve)
    pos, _ = vmd.sample([k0, k1], 11)
    assert pos[5, 0] < 3.0 and abs(pos[10, 0] - 10) < 1e-9 and pos[0, 0] == 0, pos[:, 0]


def test_cli_vmd():
    import extract_dance

    fps, local, hips = read_vrma(SAMPLE)
    with tempfile.TemporaryDirectory() as d:
        src = Path(d) / "m.vmd"
        make_vmd(src, local, hips, ik=True)
        out = extract_dance.main([str(src), "--out", str(Path(d) / "m.vrma"), "--root", "inplace", "--smooth", "0"])
        f2, est, est_hips = read_vrma(out)
        assert len(est_hips) > 10 and set(JOINTS) <= set(forward_kinematics(est, est_hips)[0])


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
