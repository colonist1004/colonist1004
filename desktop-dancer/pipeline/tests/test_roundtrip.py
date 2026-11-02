"""Round-trip tests that need no video or model: python -m pytest -q tests  (or python tests/test_roundtrip.py)"""
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dancer_pipeline.retarget import keypoints_to_rotations  # noqa: E402
from dancer_pipeline.rot import axis_angle_to_matrix, matrix_to_quat, yaw_matrix  # noqa: E402
from dancer_pipeline.skeleton import forward_kinematics  # noqa: E402
from dancer_pipeline.smpl import SMPL_TO_VRM, smpl_to_rotations  # noqa: E402
from dancer_pipeline.vrma import read_vrma, write_vrma  # noqa: E402
from dancer_pipeline import post  # noqa: E402

from synth import keypoints_from_motion  # noqa: E402

SAMPLE = Path(__file__).resolve().parents[2] / "assets" / "motions" / "sample-dance.vrma"
JOINTS = ["head", "leftHand", "rightHand", "leftLowerArm", "rightLowerArm", "leftFoot", "rightFoot",
          "leftLowerLeg", "rightLowerLeg", "leftToes", "rightToes"]


def joint_error(local_a, hips_a, local_b, hips_b):
    """Mean / max joint position error (m), both with hips fixed at the same spot."""
    h = np.zeros_like(hips_a)
    h[:, 1] = 0.95
    pa, _ = forward_kinematics(local_a, h)
    pb, _ = forward_kinematics(local_b, h)
    e = np.stack([np.linalg.norm(pa[j] - pb[j], axis=-1) for j in JOINTS])
    return e.mean(), e.max()


def load_gt():
    fps, local, hips = read_vrma(SAMPLE)
    return fps, local, hips


def test_vrma_write_read():
    fps, local, hips = load_gt()
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "x.vrma"
        write_vrma(p, fps, local, hips)
        fps2, local2, hips2 = read_vrma(p)
    assert abs(fps - fps2) < 1e-3
    assert np.allclose(hips, hips2, atol=1e-5)
    for b in local:
        assert np.allclose(local[b], local2[b], atol=1e-5), b


def test_keypoint_retarget_recovers_motion():
    fps, local, hips = load_gt()
    kp, _ = keypoints_from_motion(local, hips)
    est = keypoints_to_rotations(kp)
    mean, mx = joint_error(local, hips, est, hips)
    print(f"keypoint retarget: mean {mean*100:.2f} cm, max {mx*100:.2f} cm")
    assert mean < 0.01 and mx < 0.04


def test_retarget_is_camera_tilt_robust():
    fps, local, hips = load_gt()
    kp, _ = keypoints_from_motion(local, hips)
    tilt = axis_angle_to_matrix(np.array([0.25, 0, 0.1]))  # camera pitched/rolled
    kp = post.align_gravity({k: v @ tilt.T for k, v in kp.items()})
    est = keypoints_to_rotations(kp)
    mean, _ = joint_error(local, hips, est, hips)
    print(f"tilted camera: mean {mean*100:.2f} cm")
    assert mean < 0.03


def test_noisy_keypoints_smoothing_helps():
    fps, local, hips = load_gt()
    kp, _ = keypoints_from_motion(local, hips)
    rng = np.random.default_rng(0)
    noisy = {k: v + rng.normal(0, 0.015, v.shape) for k, v in kp.items()}
    raw = keypoints_to_rotations(noisy)
    smooth = keypoints_to_rotations({k: post.gaussian_smooth(v, 2.0) for k, v in noisy.items()})
    e_raw, _ = joint_error(local, hips, raw, hips)
    e_s, _ = joint_error(local, hips, smooth, hips)
    print(f"noise 1.5 cm: raw {e_raw*100:.2f} cm -> smoothed {e_s*100:.2f} cm")
    assert e_s < e_raw


def test_smpl_conversion():
    fps, local, hips = load_gt()
    n = len(hips)
    # Build SMPL params from the motion, in a Z-up world with an arbitrary heading.
    W = axis_angle_to_matrix(np.array([np.pi / 2, 0, 0])) @ yaw_matrix(1.1)  # source world
    eye = np.broadcast_to(np.eye(3), (n, 3, 3))
    body = np.zeros((n, 21, 3))
    to_aa = lambda m: _matrix_to_axis_angle(m)  # noqa: E731
    for j, bone in SMPL_TO_VRM.items():
        body[:, j - 1] = to_aa(local.get(bone, eye))
    body[:, 5] = to_aa(local["chest"])  # spine2 carries chest, spine3 identity
    go = to_aa(W @ local["hips"])
    transl = (W @ hips.T).T
    est, root = smpl_to_rotations(go, body, transl)
    mean, mx = joint_error(local, hips, est, hips)
    # facing normalization may rotate the whole motion; compare hips-relative pose
    print(f"SMPL conversion: mean {mean*100:.2f} cm")
    assert mean < 0.01
    assert np.allclose(root[:, 1] - root[:, 1].mean(), hips[:, 1] - hips[:, 1].mean(), atol=1e-3)


def test_cli_gvhmr_path():
    """extract_dance.py --engine gvhmr on a synthetic SMPL npz reproduces the motion."""
    import extract_dance

    fps, local, hips = load_gt()
    n = len(hips)
    eye = np.broadcast_to(np.eye(3), (n, 3, 3))
    body = np.zeros((n, 21, 3))
    for j, bone in SMPL_TO_VRM.items():
        body[:, j - 1] = _matrix_to_axis_angle(local.get(bone, eye))
    body[:, 5] = _matrix_to_axis_angle(local["chest"])
    W = axis_angle_to_matrix(np.array([-np.pi / 2, 0, 0]))  # pretend the source is Z-up
    with tempfile.TemporaryDirectory() as d:
        npz = Path(d) / "x.npz"
        np.savez(npz, global_orient=_matrix_to_axis_angle(W @ local["hips"]), body_pose=body.reshape(n, 63),
                 transl=(W @ hips.T).T, fps=fps)
        out = extract_dance.main(["unused.mp4", "--engine", "gvhmr", "--gvhmr-result", str(npz),
                                  "--out", str(Path(d) / "y.vrma"), "--root", "inplace", "--smooth", "0"])
        _, est, root = read_vrma(out)
        assert out.with_suffix(".json").exists()
    mean, _ = joint_error(local, hips, est, hips)
    print(f"CLI gvhmr path: mean {mean*100:.2f} cm, hips y range {np.ptp(root[:, 1])*100:.1f} cm")
    assert mean < 0.02


def test_loop_is_seamless():
    fps, local, hips = load_gt()
    # take 1.5 loops so a cut point exists, then loop it
    idx = np.r_[0 : len(hips), 1 : len(hips) // 2]
    l2 = {b: m[idx] for b, m in local.items()}
    lp, rp, n = post.make_loop(l2, hips[idx], fps)
    jump = max(np.abs(m[0] - m[-1]).max() for m in lp.values())
    assert jump < 1e-6 and np.allclose(rp[0], rp[-1])


def _matrix_to_axis_angle(m):
    q = matrix_to_quat(m)
    q[q[..., 3] < 0] *= -1
    w = np.clip(q[..., 3], -1, 1)
    angle = 2 * np.arccos(w)
    s = np.sqrt(np.maximum(1 - w * w, 1e-12))
    return q[..., :3] / s[..., None] * angle[..., None]


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
