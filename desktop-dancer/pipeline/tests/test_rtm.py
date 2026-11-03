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


def test_legs_out_of_the_picture_stand_still():
    """A dancer filmed from the waist up: the detector guesses the legs and they flail. Legs that are
    not in the picture (or not confident) stand straight under the hips instead, easing in and out."""
    from dancer_pipeline.pose_rtm import legs_in_view
    from dancer_pipeline.rot import axis_angle_to_matrix

    n, w, h = 60, 640, 480
    k2 = np.zeros((n, 133, 2)) + [320, 200]
    sc = np.ones((n, 133))
    k2[20:40, [13, 15], 1] = 520  # left knee/ankle below the picture
    sc[44:56, 14] = 0.1  # right knee unsure for 0.4 s
    sc[5:8, 16] = 0.1  # right ankle blurred for 0.1 s: too short to count
    seen_pts = legs_in_view(k2, sc, np.tile([w, h], (n, 1)).astype(float))
    seen = post.legs_seen(seen_pts, np.ones(n, bool))
    assert not seen["left"][20:40].any() and seen["left"][:20].all() and seen["left"][40:].all()
    assert not seen["right"][44:56].any() and seen["right"][:44].all()

    rng = np.random.default_rng(1)
    rand = lambda: axis_angle_to_matrix(rng.normal(0, 0.6, (n, 3)))  # noqa: E731
    yaw = np.stack([yaw_matrix(a) for a in np.linspace(0, 1.5, n)])
    local = {"hips": yaw @ axis_angle_to_matrix(np.tile([0.2, 0, 0], (n, 1)))}
    for s in ("left", "right"):
        for b in ("UpperLeg", "LowerLeg", "Foot"):
            local[s + b] = rand()
    out, replaced = post.stand_unseen_legs(local, seen, fps=30)
    assert abs(replaced["left"] - 20 / 60) < 1e-9
    up = local["hips"] @ out["leftUpperLeg"]  # thigh in world space
    for i in range(20, 40):
        assert np.allclose(up[i] @ [0, -1, 0], [0, -1, 0], atol=1e-6), "thigh straight down"
        assert np.allclose(up[i] @ [0, 0, 1], yaw[i] @ [0, 0, 1], atol=1e-6), "knee faces where the hips face"
        assert np.allclose(out["leftLowerLeg"][i], np.eye(3), atol=1e-6)
    assert np.allclose(out["leftUpperLeg"][:5], local["leftUpperLeg"][:5])  # seen legs keep their motion
    assert np.allclose(out["rightFoot"][:30], local["rightFoot"][:30])
    # eases in: the frame right before the gap is already partly standing, but not fully
    d = lambda a, b: np.linalg.norm(a - b)  # noqa: E731
    assert 0 < d(out["leftLowerLeg"][18], local["leftLowerLeg"][18]) < d(np.eye(3), local["leftLowerLeg"][18])


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
