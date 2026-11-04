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


def synthetic_model(prop=True):
    extra = {k: v for k, v in EXTRA.items() if prop or not k.startswith("prop")}
    names = BONES + list(extra)
    parent = {**PARENT, **{k: v[0] for k, v in extra.items()}}
    pos = {**REST_POS, **{k: np.array(v[1], float) for k, v in extra.items()}}
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
            if n == "head":
                half = np.maximum(half, 0.09)  # a head is wider than the neck
            if n in ("hips", "spine", "chest"):
                half = np.maximum(half, [0.13, 0.0, 0.08])  # and the torso is wider than both
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


def make_fixture(yaw_deg, arm_down_deg=40, prop=True):
    m, idx = synthetic_model(prop)
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


def test_autorig_unrigged_mesh():
    """A plain mesh (no skeleton) is rigged locally. Without MediaPipe (numpy-only CI) this uses the
    geometric fit; with MediaPipe installed it uses the multi-view pose detection."""
    import make_character
    from dancer_pipeline.char.autorig import autorig

    # (no one-sided prop here: the geometric fallback cannot see past a prop crossing the neck;
    #  the MediaPipe multi-view path handles that case, see tests/make_char_fixture.py --unrigged)
    m, truth = make_fixture(-70, arm_down_deg=20, prop=False)
    idx = {v: k for k, v in enumerate(m.joint_names)}
    true_pos = {b: m.joint_world[idx[truth[b]]][:3, 3] for b in ("hips", "head", "leftHand", "rightFoot", "leftLowerLeg", "rightUpperArm")}
    with tempfile.TemporaryDirectory() as d:
        src = Path(d) / "mesh.glb"
        write_glb(m, src, skinned=False)
        plain = read_glb(src)
        assert plain.extras.get("unrigged")
        rm, bones, J, (R, shift) = autorig(plain)
        H = np.ptp(np.concatenate([p.positions for p in plain.prims])[:, 1])
        for b, p in true_pos.items():
            err = np.linalg.norm(R @ p - shift - J[b]) / H
            assert err < 0.08, f"{b}: {err:.3f} H"
        out = make_character.main([str(src), "--name", "plain", "--out", str(Path(d) / "plain.vrm")])
        info = json.loads(out.with_suffix(".json").read_text(encoding="utf-8"))
        assert info["options"]["autorig"] and info["bones"]["leftHand"] == "leftHand"


def _cut_body(min_y, drop_left_hand=False):
    """Surface points and joints of the synthetic body, with everything below min_y removed (a model made
    from a photo that ends at the shins or the waist) and optionally the left hand cut off."""
    from dancer_pipeline.char.autorig import sample_surface

    m, idx = synthetic_model(prop=False)
    p = m.prims[0]
    S = sample_surface(p.positions, p.indices.reshape(-1, 3), n=60000)
    J = {n: REST_POS[n].astype(float).copy() for n in BONES}
    J["upperChest"] = (J["chest"] + J["neck"]) / 2  # (not in the reference skeleton)
    for s in ("left", "right"):
        J[f"{s}HandTip"] = J[f"{s}Hand"] + 0.5 * (J[f"{s}Hand"] - J[f"{s}LowerArm"])
    keep = S[:, 1] >= min_y
    if drop_left_hand:
        keep &= S[:, 0] < (J["leftLowerArm"][0] + J["leftHand"][0]) / 2
    H = np.ptp(S[:, 1])  # the whole body: the pose detector "sees" these joints whatever is cut
    return S[keep], J, H


def test_fit_to_mesh_legs_cut_at_the_shins():
    from dancer_pipeline.char.autorig import fit_to_mesh

    cut = (REST_POS["leftLowerLeg"][1] + REST_POS["leftFoot"][1]) / 2
    S, J, H = _cut_body(cut)
    knee = J["leftLowerLeg"].copy()
    loose = fit_to_mesh(S, J, H)
    assert {"leftFoot", "rightFoot", "leftToes", "rightToes"} <= loose, loose
    assert not loose & {"leftUpperLeg", "leftLowerLeg", "hips"}, loose
    for s in ("left", "right"):
        assert J[f"{s}Foot"][1] >= cut - 0.03, J[f"{s}Foot"]  # ankle pulled up into the model
        assert J[f"{s}LowerLeg"][1] > J[f"{s}Foot"][1] + 0.05  # knee stays above the ankle
    assert J["leftLowerLeg"][1] > knee[1]  # knee moved up with the shorter leg


def test_fit_to_mesh_upper_body_only_and_cut_hand():
    from dancer_pipeline.char.autorig import fit_to_mesh, skin_weights

    S, J, H = _cut_body(REST_POS["hips"][1] - 0.02, drop_left_hand=True)
    loose = fit_to_mesh(S, J, H)
    legs = {f"{s}{b}" for s in ("left", "right") for b in ("UpperLeg", "LowerLeg", "Foot", "Toes")}
    assert legs <= loose, loose
    assert "leftHand" in loose and "rightHand" not in loose, loose
    assert J["leftHand"][0] < REST_POS["leftHand"][0] - 0.02  # pulled back into the forearm
    # the mesh a missing bone would have taken goes to a bone that is there
    from dancer_pipeline.char.autorig import BONE_ORDER

    F = np.zeros((0, 3), np.int64)
    J["leftToes"], J["rightToes"] = J["leftFoot"] + [0, 0, 0.05], J["rightFoot"] + [0, 0, 0.05]
    for s in ("left", "right"):
        J[f"{s}ToeTip"] = J[f"{s}Toes"] + [0, 0, 0.05]
    J["headTop"] = J["head"] + [0, 0.15, 0]
    W, I = skin_weights(S[::20], F, J, iters=1, loose=loose)
    names = [n for n, _ in BONE_ORDER]
    used = {names[i] for i in np.unique(I[W > 0])}
    assert not used & loose, used & loose
    assert {"hips", "leftLowerArm", "rightHand"} <= used, used


def _grid(rows, cols, point, joint):
    """A connected quad grid: point(i, j) -> xyz for i in rows, j in cols (cols wrap if point says so)."""
    P = np.array([point(i, j) for i in range(rows) for j in range(cols)], float)
    tris = []
    for i in range(rows - 1):
        for j in range(cols - 1):
            a, b, c, d = i * cols + j, i * cols + j + 1, (i + 1) * cols + j, (i + 1) * cols + j + 1
            tris += [a, b, d, a, d, c]
    J = np.zeros((len(P), 4), np.int64)
    J[:, 0] = joint
    W = np.zeros((len(P), 4))
    W[:, 0] = 1
    return Prim(P, None, None, J, W, np.array(tris), None)


def test_springs_for_long_hair_and_a_skirt():
    """A body with a skirt around the hips and long hair hanging down the back gets spring chains;
    the hem and the hair ends move with them, and the hands do not."""
    from dancer_pipeline.char.springs import add_springs

    m, idx = synthetic_model(prop=False)
    hips_y, knee_y = REST_POS["hips"][1], REST_POS["leftLowerLeg"][1]
    # skirt: a closed cone from the waist to above the knees, clear of the legs
    skirt = _grid(12, 25, lambda i, j: (
        (0.15 + 0.12 * i / 11) * np.sin(2 * np.pi * j / 24), hips_y + 0.05 - i / 11 * (hips_y + 0.05 - knee_y - 0.05),
        (0.15 + 0.12 * i / 11) * np.cos(2 * np.pi * j / 24)), idx["hips"])
    # hair: from the crown over the back of the head down to the middle of the back
    top = REST_POS["head"][1] + 0.15
    hair = _grid(30, 9, lambda i, j: (-0.1 + 0.025 * j, top - i * (top - 1.08) / 29,
                                      -0.1 - 0.06 * min(1, i / 8)), idx["head"])
    m.prims += [skirt, hair]
    mp = find_humanoid(m)
    n = normalize(m, mp, height=1.6)
    out, ext = add_springs(n, mp.bones)
    assert ext, "no springs"
    names = [s_["name"] for s_ in ext["springs"]]
    assert sum(x.startswith("skirt") for x in names) >= 6, names
    assert any(x.startswith("hair") for x in names), names
    assert all(len(s_["joints"]) >= 3 for s_ in ext["springs"])
    J = len(out.joint_names)
    spring_nodes = {j["node"] for s_ in ext["springs"] for j in s_["joints"]}
    assert max(spring_nodes) < J and min(spring_nodes) >= len(n.joint_names)
    first_spring = len(n.joint_names)

    def share(prim_i, rows):
        p = out.prims[prim_i]
        w = p.weights[rows]
        return float((w * (p.joints[rows] >= first_spring)).sum(1).mean())

    n_body = len(n.prims) - 2
    sk, hr = n_body, n_body + 1
    hem = np.arange(11 * 25, 12 * 25)
    waist = np.arange(0, 25)
    assert share(sk, hem) > 0.9, share(sk, hem)  # the hem swings
    assert share(sk, waist) < 0.2, share(sk, waist)  # the waistband stays on the hips
    ends = np.arange(25 * 9, 30 * 9)
    assert share(hr, ends) > 0.8, share(hr, ends)
    body = out.prims[0]
    front = body.positions[:, 2] > -0.1  # (the fixture's own little hair-tip box hangs behind the head)
    assert (body.joints[front][body.weights[front] > 0] < first_spring).all(), "the body must not get spring weights"
    # written into the VRM
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "s.vrm"
        write_glb(out, f, name="s", vrm={"humanBones": mp.bones, "meta": {"name": "s", "authors": ["t"], "licenseUrl": "x"}},
                  mtoon={}, spring=ext)
        data = f.read_bytes()
        j = json.loads(data[20 : 20 + struct.unpack_from("<I", data, 12)[0]])
        assert "VRMC_springBone" in j["extensionsUsed"]
        assert len(j["extensions"]["VRMC_springBone"]["springs"]) == len(ext["springs"])
        assert j["extensions"]["VRMC_springBone"]["colliderGroups"]


def test_no_springs_without_hair_or_skirt():
    from dancer_pipeline.char.springs import add_springs

    m, _ = synthetic_model(prop=False)
    mp = find_humanoid(m)
    n = normalize(m, mp, height=1.6)
    out, ext = add_springs(n, mp.bones)
    assert ext is None and len(out.joint_names) == len(n.joint_names)


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
