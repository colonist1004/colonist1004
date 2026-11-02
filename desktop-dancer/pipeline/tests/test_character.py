"""Character pipeline tests (numpy only): python tests/test_character.py

A synthetic skinned humanoid with anonymous bone names, an A-pose, an arbitrary heading, a
one-sided prop (to fool naive arm detection) and finger/toe bones is pushed through
humanoid detection, T-pose normalization and VRM writing.
"""
import json
import struct
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dancer_pipeline.char.gltf_read import Model, Prim, read_glb  # noqa: E402
from dancer_pipeline.char.gltf_write import write_glb  # noqa: E402
from dancer_pipeline.char.humanoid import find_humanoid  # noqa: E402
from dancer_pipeline.char.normalize import normalize  # noqa: E402
from dancer_pipeline.char.rig import joint_pos, pose_and_bake, transform  # noqa: E402
from dancer_pipeline.rot import axis_angle_to_matrix, yaw_matrix  # noqa: E402
from dancer_pipeline.skeleton import BONES, PARENT, REST_POS  # noqa: E402

# reference skeleton + extra bones a real auto-rig tends to have
EXTRA = {
    "headTop": ("head", [0, 1.68, 0]),
    "leftFinger": ("leftHand", [0.76, 1.38, 0]), "leftFinger2": ("leftHand", [0.74, 1.38, 0.03]),
    "leftFinger3": ("leftHand", [0.74, 1.38, -0.03]),
    "rightFinger": ("rightHand", [-0.76, 1.38, 0]), "rightFinger2": ("rightHand", [-0.74, 1.38, 0.03]),
    "rightFinger3": ("rightHand", [-0.74, 1.38, -0.03]),
    "propBase": ("chest", [0.0, 1.3, -0.15]), "propTip": ("propBase", [0.9, 1.6, -0.3]),  # one-sided prop
    "hairTip": ("head", [0.0, 1.35, -0.12]),
}


def synthetic_model():
    names = BONES + list(EXTRA)
    parent = {**PARENT, **{k: v[0] for k, v in EXTRA.items()}}
    pos = {**REST_POS, **{k: np.array(v[1], float) for k, v in EXTRA.items()}}
    idx = {n: i for i, n in enumerate(names)}
    world = np.stack([np.eye(4) for _ in names])
    for n in names:
        world[idx[n]][:3, 3] = pos[n]
    children = {n: [c for c in names if parent[c] == n] for n in names}
    prims_pos, prims_j, tris = [], [], []
    for n in names:  # a box around each bone segment, rigidly weighted to that bone
        ends = [pos[c] for c in children[n]] or [pos[n] + np.array([0, 0.05, 0])]
        for e in ends:
            a, b = pos[n], e
            c = (a + b) / 2
            half = np.maximum(np.abs(b - a) / 2, 0.03)
            base = len(prims_pos)
            for sx in (-1, 1):
                for sy in (-1, 1):
                    for sz in (-1, 1):
                        prims_pos.append(c + half * [sx, sy, sz])
                        prims_j.append(idx[n])
            for f in ([0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]):
                tris += [base + f[0], base + f[1], base + f[2], base + f[0], base + f[2], base + f[3]]
    # feet: extend boxes forward so the toes point +Z
    P = np.array(prims_pos)
    J = np.zeros((len(P), 4), np.int64)
    J[:, 0] = prims_j
    W = np.zeros((len(P), 4))
    W[:, 0] = 1
    prim = Prim(P, None, None, J, W, np.array(tris), None)
    return Model(names, [idx[parent[n]] if parent[n] else -1 for n in names], world, [prim], [], []), idx


def make_fixture(yaw_deg, arm_down_deg=40):
    m, idx = synthetic_model()
    d = np.radians(arm_down_deg)
    m = pose_and_bake(m, {idx["leftUpperArm"]: axis_angle_to_matrix(np.array([0, 0, -d])),
                          idx["rightUpperArm"]: axis_angle_to_matrix(np.array([0, 0, d]))})
    M = np.eye(4)
    M[:3, :3] = yaw_matrix(np.radians(yaw_deg)) * 0.6
    m = transform(m, M)
    truth = {n: f"bone_{i}" for n, i in idx.items()}
    m.joint_names = [f"bone_{i}" for i in range(len(m.joint_names))]
    return m, truth


def test_mapping_any_heading():
    for yaw in (0, 90, 180, -135):
        m, truth = make_fixture(yaw)
        mp = find_humanoid(m)
        wrong = {b: m.joint_names[j] for b, j in mp.bones.items() if truth.get(b) != m.joint_names[j]}
        assert not wrong, f"yaw {yaw}: {wrong}"
        assert {"hips", "head", "leftHand", "rightFoot", "leftLowerLeg"} <= set(mp.bones)


def test_normalize_tpose_and_vrm_roundtrip():
    m, truth = make_fixture(150, arm_down_deg=45)
    mp = find_humanoid(m)
    n = normalize(m, mp, height=1.6)
    b = mp.bones
    up = joint_pos(n, b["leftLowerArm"]) - joint_pos(n, b["leftUpperArm"])
    assert up[0] > 0 and abs(up[1]) < 1e-3, up  # left upper arm points +X and is level
    lo = joint_pos(n, b["rightHand"]) - joint_pos(n, b["rightLowerArm"])
    assert lo[0] < 0 and abs(lo[1]) < 1e-3
    verts = np.concatenate([p.positions for p in n.prims])
    assert abs(verts[:, 1].min()) < 1e-6 and abs(verts[:, 1].max() - 1.6) < 1e-6
    head = joint_pos(n, b["head"])
    toes = joint_pos(n, b["leftToes"]) - joint_pos(n, b["leftFoot"])
    assert toes[2] > 0, "should face +Z (toes forward)"
    assert np.allclose(n.joint_world[:, :3, :3], np.eye(3)), "VRM rest frames must be world-aligned"
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "c.vrm"
        write_glb(n, out, name="c", vrm={"humanBones": b, "meta": {"name": "c", "authors": ["t"], "licenseUrl": "x"}},
                  mtoon={"shadingToonyFactor": 0.9})
        data = out.read_bytes()
        j = json.loads(data[20 : 20 + struct.unpack_from("<I", data, 12)[0]])
        hb = j["extensions"]["VRMC_vrm"]["humanoid"]["humanBones"]
        assert hb["hips"]["node"] == b["hips"] and "VRMC_materials_mtoon" in j["extensionsUsed"]
        again = read_glb(out)
        assert np.allclose(joint_pos(again, b["head"]), head, atol=1e-4)
        v2 = np.concatenate([p.positions for p in again.prims])
        assert np.allclose(v2, verts, atol=1e-4)


def test_cli_make_character():
    import make_character

    m, _ = make_fixture(-60)
    with tempfile.TemporaryDirectory() as d:
        src = Path(d) / "x.rigged.glb"
        write_glb(m, src)
        out = make_character.main([str(src), "--name", "x", "--out", str(Path(d) / "x.vrm")])
        info = json.loads(out.with_suffix(".json").read_text(encoding="utf-8"))
        assert out.exists() and info["bones"]["hips"]


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
