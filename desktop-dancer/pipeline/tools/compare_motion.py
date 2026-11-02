"""Compare an extracted motion with a reference motion (both .vrma), joint by joint.

  python tools/compare_motion.py extracted.vrma reference.vrma [--offset SEC] [--mirror]

Poses are compared on the reference skeleton with the hips pinned, so the numbers say
how far each joint lands from where it should (cm). Reference is looped if shorter.
"""
import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dancer_pipeline.skeleton import forward_kinematics  # noqa: E402
from dancer_pipeline.vrma import read_vrma  # noqa: E402

JOINTS = {
    "손": ["leftHand", "rightHand"], "팔꿈치": ["leftLowerArm", "rightLowerArm"],
    "머리": ["head"], "무릎": ["leftLowerLeg", "rightLowerLeg"], "발": ["leftFoot", "rightFoot"],
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("extracted")
    ap.add_argument("reference")
    ap.add_argument("--offset", type=float, default=0.0, help="reference time at extracted t=0")
    a = ap.parse_args()
    fe, le, he = read_vrma(a.extracted)
    fr, lr, hr = read_vrma(a.reference)
    n = len(he)
    t = np.arange(n) / fe + a.offset
    period = (len(hr) - 1) / fr
    idx = np.round((t % period) * fr).astype(int)
    lr = {b: m[idx] for b, m in lr.items()}
    hips = np.tile([0, 0.95, 0], (n, 1))
    pe, _ = forward_kinematics(le, hips)
    pr, _ = forward_kinematics(lr, hips)
    allj = []
    for label, js in JOINTS.items():
        e = np.concatenate([np.linalg.norm(pe[j] - pr[j], axis=1) for j in js])
        allj.append(e)
        print(f"{label:4s} mean {e.mean()*100:5.1f} cm   p90 {np.percentile(e, 90)*100:5.1f} cm")
    e = np.concatenate(allj)
    print(f"전체  mean {e.mean()*100:5.1f} cm   p90 {np.percentile(e, 90)*100:5.1f} cm")
    return e.mean()


if __name__ == "__main__":
    main()
