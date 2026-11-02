"""RTMW3D engine conversion tests (numpy only; the ONNX models themselves are not needed):
python tests/test_rtm.py

Fake RTMW3D output is made from a known motion: COCO-WholeBody 2D pixels (y down) plus a
root-relative depth with an arbitrary sign convention and noise. The conversion must recover the
motion after lifting and retargeting, whatever the sign convention is.
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from dancer_pipeline import post  # noqa: E402
from dancer_pipeline.lift import lift  # noqa: E402
from dancer_pipeline.pose_rtm import WB, to_keypoints  # noqa: E402
from dancer_pipeline.retarget import keypoints_to_rotations  # noqa: E402
from dancer_pipeline.rot import yaw_matrix  # noqa: E402
from dancer_pipeline.skeleton import forward_kinematics  # noqa: E402
from dancer_pipeline.vrma import read_vrma  # noqa: E402
from synth import keypoints_from_motion  # noqa: E402

SAMPLE = Path(__file__).resolve().parents[2] / "assets" / "motions" / "sample-dance.vrma"
JOINTS = ["head", "leftHand", "rightHand", "leftLowerArm", "rightLowerArm", "leftFoot", "rightFoot"]


def fake_rtm(kp, depth_sign, noise_px=0.0, rng=None):
    n = len(kp["left_hip"])
    k2 = np.zeros((n, 133, 2))
    z = np.zeros((n, 133))
    for name, idx in WB.items():
        if name not in kp:
            continue
        p = kp[name]
        k2[:, idx, 0] = p[:, 0] * 400 + 640
        k2[:, idx, 1] = -p[:, 1] * 400 + 700
        z[:, idx] = depth_sign * p[:, 2] * 0.9  # RTMW3D depth is "roughly meters", unknown sign
    if noise_px:
        k2 += rng.normal(0, noise_px, k2.shape)
        z += rng.normal(0, noise_px / 400, z.shape)
    return k2, z


def joint_error(la, lb):
    n = len(next(iter(la.values())))
    h = np.tile([0, 0.95, 0], (n, 1))
    pa, _ = forward_kinematics(la, h)
    pb, _ = forward_kinematics(lb, h)
    return np.stack([np.linalg.norm(pa[j] - pb[j], axis=-1) for j in JOINTS]).mean()


def run(kp, sign, noise=0.0):
    rng = np.random.default_rng(1)
    k2, z = fake_rtm(kp, sign, noise, rng)
    valid = np.ones(len(k2), bool)
    w, i, _ = to_keypoints(k2, z, valid)
    kp3 = post.align_gravity(w)  # the CLI skips lifting for RTMW3D
    lifted = {k: post.gaussian_smooth(v, 1.5) for k, v in kp3.items()} if noise else kp3
    return keypoints_to_rotations(lifted), w


def test_any_depth_convention():
    fps, local, hips = read_vrma(SAMPLE)
    kp, _ = keypoints_from_motion(local, hips)
    for sign in (1, -1):
        est, _ = run(kp, sign)
        err = joint_error(local, est)
        print(f"depth sign {sign:+d}: mean joint error {err * 100:.2f} cm")
        assert err < 0.01


def test_depth_scale_is_calibrated():
    fps, local, hips = read_vrma(SAMPLE)
    kp, _ = keypoints_from_motion(local, hips)
    errs = []
    for zscale in (0.5, 1.0, 2.0):  # RTMW3D's depth unit is only roughly meters
        k2, z = fake_rtm(kp, -1)
        w, i, _ = to_keypoints(k2, z * zscale, np.ones(len(k2), bool))
        errs.append(joint_error(local, keypoints_to_rotations(post.align_gravity(w))))
    print("depth scale x0.5/1/2:", [f"{e * 100:.2f} cm" for e in errs])
    assert max(errs) < 0.01


def test_noise():
    fps, local, hips = read_vrma(SAMPLE)
    kp, _ = keypoints_from_motion(local, hips)
    est, _ = run(kp, -1, noise=3.0)
    err = joint_error(local, est)
    print(f"3 px noise: mean joint error {err * 100:.2f} cm")
    assert err < 0.04


def test_facing_away_keeps_toes_forward():
    fps, local, hips = read_vrma(SAMPLE)
    local = dict(local)
    local["hips"] = yaw_matrix(np.pi) @ local["hips"]  # dancer turned around
    kp, _ = keypoints_from_motion(local, hips)
    for sign in (1, -1):
        _, w = run(kp, sign)
        toe_minus_heel = np.median(w["left_foot_index"][:, 2] - w["left_heel"][:, 2])
        assert toe_minus_heel < 0, f"facing away, sign {sign}: toes should point away from the camera"


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
