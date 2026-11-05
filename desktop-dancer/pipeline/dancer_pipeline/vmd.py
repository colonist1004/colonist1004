"""MikuMikuDance motion (.vmd) -> rotations for the reference skeleton.

VMD stores, per bone name (Shift-JIS), sparse keyframes at 30 fps: a translation offset from the rest
position and a rotation, both in world-aligned axes (like VRM normalized bones), plus Bezier easing
curves between keys. Differences from VRM handled here:
- coordinates: MMD is left-handed (z mirrored): rotation (x, y, z, w) -> (-x, -y, z, w), position z -> -z
- units: 1 MMD unit ~ 8 cm
- rest pose: arms in an A-pose (~35 deg down) -> conjugate the arm chain onto the T-pose
- body: upper body (上半身) and lower body (下半身) both hang from the center; VRM hips = lower body,
  spine = the upper body relative to it
- twist bones (腕捩, 手捩) fold into the arm / forearm
- legs driven by foot IK (足ＩＫ, つま先ＩＫ) are solved with two-bone IK onto the reference legs
"""
from __future__ import annotations

import struct

import numpy as np

from .rot import axis_angle_to_matrix, frame, matrix_to_quat, normalize, quat_to_matrix
from .skeleton import BONES, PARENT, REST_POS, local_offset

UNIT = 0.08  # meters per MMD unit
FPS = 30.0
MIRROR = np.diag([1.0, 1.0, -1.0])

# MMD bone names (full-width and half-width variants seen in the wild)
N = {
    "root": ["全ての親"], "center": ["センター"], "groove": ["グルーブ"], "waist": ["腰"],
    "upper": ["上半身"], "upper2": ["上半身2", "上半身２"], "lower": ["下半身"], "neck": ["首"], "head": ["頭"],
}
for s, k in (("left", "左"), ("right", "右")):
    N.update({
        f"{s}Shoulder": [f"{k}肩"], f"{s}Arm": [f"{k}腕"], f"{s}ArmTwist": [f"{k}腕捩"], f"{s}Elbow": [f"{k}ひじ"],
        f"{s}HandTwist": [f"{k}手捩"], f"{s}Wrist": [f"{k}手首"],
        f"{s}Leg": [f"{k}足"], f"{s}Knee": [f"{k}ひざ"], f"{s}Ankle": [f"{k}足首"],
        f"{s}LegIK": [f"{k}足ＩＫ", f"{k}足IK"], f"{s}ToeIK": [f"{k}つま先ＩＫ", f"{k}つま先IK"],
    })


def _rz(deg):
    a = np.radians(deg)
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1.0]])


def parse_vmd(data: bytes):
    """-> (model name, {bone name: list of (frame, pos(3), quat(4) xyzw, interp(64 bytes))})."""
    if not data.startswith(b"Vocaloid Motion Data"):
        raise ValueError("VMD 파일이 아닙니다 (헤더가 다릅니다)")
    new = data[:30].startswith(b"Vocaloid Motion Data 0002")
    off = 30
    name_len = 20 if new else 10
    model = data[off : off + name_len].split(b"\0")[0].decode("cp932", "replace")
    off += name_len
    (count,) = struct.unpack_from("<I", data, off)
    off += 4
    if off + count * 111 > len(data):
        raise ValueError("VMD 파일이 잘렸습니다")
    keys: dict[str, list] = {}
    for _ in range(count):
        raw = data[off : off + 15].split(b"\0")[0]
        name = raw.decode("cp932", "replace")
        fr, px, py, pz, qx, qy, qz, qw = struct.unpack_from("<I3f4f", data, off + 15)
        interp = data[off + 47 : off + 111]
        keys.setdefault(name, []).append((fr, np.array([px, py, pz]), np.array([qx, qy, qz, qw]), interp))
        off += 111
    for v in keys.values():
        v.sort(key=lambda k: k[0])
    return model, keys


def _ease(x1, y1, x2, y2, s):
    """Cubic Bezier easing (0,0)-(x1,y1)-(x2,y2)-(1,1): y at x = s (vectorized over s)."""
    lo, hi = np.zeros_like(s), np.ones_like(s)
    for _ in range(18):  # bisection on t for x(t) = s
        t = (lo + hi) / 2
        x = 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3
        lo = np.where(x < s, t, lo)
        hi = np.where(x < s, hi, t)
    t = (lo + hi) / 2
    return 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3


def _slerp(a, b, t):
    d = np.sum(a * b, axis=-1, keepdims=True)
    b = np.where(d < 0, -b, b)
    d = np.abs(d)
    om = np.arccos(np.clip(d, -1, 1))
    so = np.sin(om)
    small = so < 1e-6
    wa = np.where(small, 1 - t, np.sin((1 - t) * om) / np.where(small, 1, so))
    wb = np.where(small, t, np.sin(t * om) / np.where(small, 1, so))
    return normalize(wa * a + wb * b)


def sample(keys, n):
    """Keyframes -> per-frame (positions (n,3), quaternions (n,4)) in MMD axes, with the easing curves."""
    f = np.arange(n, dtype=np.float64)
    frames = np.array([k[0] for k in keys], np.float64)
    P = np.stack([k[1] for k in keys])
    Q = np.stack([normalize(k[2]) for k in keys])
    if len(keys) == 1:
        return np.repeat(P, n, 0), np.repeat(Q, n, 0)
    i1 = np.clip(np.searchsorted(frames, f, side="right"), 1, len(keys) - 1)
    i0 = i1 - 1
    span = np.maximum(frames[i1] - frames[i0], 1)
    s = np.clip((f - frames[i0]) / span, 0, 1)
    # easing curves are stored on the key at the end of the span: x1[4], y1[4], x2[4], y2[4] for X, Y, Z, rotation
    cur = np.array([[k[3][j] / 127.0 for j in range(16)] for k in keys])[i1]
    eased = np.stack([_ease(cur[:, c], cur[:, 4 + c], cur[:, 8 + c], cur[:, 12 + c], s) for c in range(4)], axis=1)
    pos = P[i0] + eased[:, :3] * (P[i1] - P[i0])
    rot = _slerp(Q[i0], Q[i1], eased[:, 3:4])
    before, after = f <= frames[0], f >= frames[-1]
    pos[before], rot[before] = P[0], Q[0]
    pos[after], rot[after] = P[-1], Q[-1]
    return pos, rot


def rotation_between(a, b):
    """Smallest rotations taking vectors a to b, per row: (F,3), (F,3) -> (F,3,3)."""
    a, b = normalize(a), normalize(b)
    axis = np.cross(a, b)
    s = np.linalg.norm(axis, axis=-1, keepdims=True)
    c = np.sum(a * b, axis=-1, keepdims=True)
    ang = np.arctan2(s, c)
    alt = normalize(np.cross(a, np.where(np.abs(a[..., :1]) < 0.9, [[1.0, 0, 0]], [[0, 1.0, 0]])))
    axis = np.where(s > 1e-9, axis / np.maximum(s, 1e-12), np.where(c < 0, alt, 0.0))
    return axis_angle_to_matrix(axis * ang)


def _two_bone_world(H, T, l1, l2, fwd):
    """Knee position for hip H, ankle target T and forward hint (the knee points forward)."""
    ht = T - H
    dist = np.linalg.norm(ht, axis=1, keepdims=True)
    d = np.clip(dist, abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4)
    u = ht / np.maximum(dist, 1e-9)
    v = fwd - np.sum(fwd * u, axis=1, keepdims=True) * u
    v = normalize(v)
    a = np.arccos(np.clip((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1))
    return H + l1 * (np.cos(a) * u + np.sin(a) * v), H + d * u


def vmd_to_rotations(model, keys, arm_deg=35.0):
    """-> (fps, local rotations {VRM bone: (F,3,3)}, hips positions (F,3) in meters, warnings)."""
    warnings = []
    found = {}
    for k, names in N.items():
        for nm in names:
            if nm in keys:
                found[k] = keys[nm]
                break
    if not any(k in found for k in ("center", "upper", "lower", "leftArm", "rightArm")):
        raise ValueError("사람 뼈 이름(センター, 上半身, 腕…)이 없는 VMD입니다. 카메라나 표정 전용 모션일 수 있습니다.")
    n = int(max(v[-1][0] for v in found.values())) + 1
    n = max(n, 2)
    eye = np.broadcast_to(np.eye(3), (n, 3, 3)).copy()

    def R(k):  # world-aligned local rotation of an MMD bone, converted to VRM axes
        if k not in found:
            return eye.copy()
        _, q = sample(found[k], n)
        return MIRROR @ quat_to_matrix(q) @ MIRROR

    def Pz(k):  # translation offset (meters, VRM axes)
        if k not in found:
            return np.zeros((n, 3))
        p, _ = sample(found[k], n)
        return p * np.array([1, 1, -1.0]) * UNIT

    W_root = R("root")
    W_center = W_root @ R("center")
    W_groove = W_center @ R("groove")
    W_waist = W_groove @ R("waist")
    W_upper = W_waist @ R("upper")
    W_upper2 = W_upper @ R("upper2")
    W_neck = W_upper2 @ R("neck")
    W_head = W_neck @ R("head")
    W_lower = W_waist @ R("lower")

    # hips position: the rest height plus the root/center/groove offsets carried through their parents
    off = Pz("root") + np.einsum("fij,fj->fi", W_root, Pz("center"))
    off += np.einsum("fij,fj->fi", W_center, Pz("groove"))
    hips = REST_POS["hips"] + off

    W = {"hips": W_lower, "spine": W_upper, "chest": W_upper2, "neck": W_neck, "head": W_head}
    for side, sgn in (("left", 1), ("right", -1)):
        C = _rz(-sgn * arm_deg)  # T-pose -> MMD's A-pose for this arm
        W_sh = W_upper2 @ R(f"{side}Shoulder")
        W_arm = W_sh @ R(f"{side}Arm") @ R(f"{side}ArmTwist")
        W_el = W_arm @ R(f"{side}Elbow") @ R(f"{side}HandTwist")
        W_wr = W_el @ R(f"{side}Wrist")
        W[f"{side}Shoulder"] = W_sh
        W[f"{side}UpperArm"], W[f"{side}LowerArm"], W[f"{side}Hand"] = W_arm @ C, W_el @ C, W_wr @ C

        uses_ik = f"{side}LegIK" in found and any(
            np.abs(k[1]).max() > 1e-4 or abs(abs(k[2][3]) - 1) > 1e-5 for k in found[f"{side}LegIK"])
        if not uses_ik:
            W_leg = W_lower @ R(f"{side}Leg")
            W_knee = W_leg @ R(f"{side}Knee")
            W[f"{side}UpperLeg"], W[f"{side}LowerLeg"], W[f"{side}Foot"] = W_leg, W_knee, W_knee @ R(f"{side}Ankle")
            continue
        # foot IK: the ankle goes to the IK bone (a child of the root), the knee bends forward
        ul, ll, ft = f"{side}UpperLeg", f"{side}LowerLeg", f"{side}Foot"
        H = hips + np.einsum("fij,j->fi", W_lower, local_offset(ul))
        T = REST_POS[ft] + Pz("root") + np.einsum("fij,fj->fi", W_root, Pz(f"{side}LegIK"))
        l1, l2 = np.linalg.norm(local_offset(ll)), np.linalg.norm(local_offset(ft))
        fwd = np.einsum("fij,j->fi", W_lower, [0.0, 0.0, 1.0])
        K, A = _two_bone_world(H, T, l1, l2, fwd)
        down = np.array([0.0, -1.0, 0.0])
        # thigh: rest "down" onto hip->knee, its forward axis toward the knee's forward
        W_ul = frame(normalize(K - H), fwd) @ frame(down, np.array([0.0, 0.0, 1.0])).swapaxes(-1, -2)
        cur = np.einsum("fij,j->fi", W_ul, down)
        W_ll = rotation_between(cur, normalize(A - K)) @ W_ul
        # foot: the IK bone's rotation; the toe IK (if moved) tips it toward the toe target
        W_ik = W_root @ R(f"{side}LegIK")
        toes = f"{side}Toes"
        rest_dir = REST_POS[toes] - REST_POS[ft]
        if f"{side}ToeIK" in found:
            tip = A + np.einsum("fij,fj->fi", W_ik, rest_dir + Pz(f"{side}ToeIK"))
            have = np.einsum("fij,j->fi", W_ik, rest_dir)
            W_ft = rotation_between(have, tip - A) @ W_ik
        else:
            W_ft = W_ik
        W[ul], W[ll], W[ft] = W_ul, W_ll, W_ft

    local = {}
    for b in BONES:
        if b not in W:
            continue
        p = PARENT[b]
        local[b] = W[b] if p is None else np.swapaxes(W[p], -1, -2) @ W[b]
    # bones the skeleton has but MMD does not drive stay at rest (toes); hips world == W_lower
    if n > 20000:
        warnings.append("아주 긴 모션입니다 (11분 이상)")
    return FPS, local, hips, warnings


def load_vmd(path, arm_deg=35.0):
    with open(path, "rb") as f:
        model, keys = parse_vmd(f.read())
    return vmd_to_rotations(model, keys, arm_deg)


# ------------------------------------------------------------------ writer (tests, round trips)

LINEAR = bytes([20] * 4 + [20] * 4 + [107] * 4 + [107] * 4) * 4


def write_vmd(path, bone_frames, model="desktop-dancer"):
    """bone_frames: {mmd bone name: list of (frame, pos(3) MMD units, quat xyzw MMD axes)}. Linear easing."""
    rows = [(nm, fr, p, q) for nm, keys in bone_frames.items() for fr, p, q in keys]
    out = bytearray(b"Vocaloid Motion Data 0002".ljust(30, b"\0"))
    out += model.encode("cp932")[:20].ljust(20, b"\0")
    out += struct.pack("<I", len(rows))
    for nm, fr, p, q in rows:
        out += nm.encode("cp932")[:15].ljust(15, b"\0")
        out += struct.pack("<I3f4f", fr, *map(float, p), *map(float, q))
        out += LINEAR
    out += struct.pack("<IIII", 0, 0, 0, 0)  # morphs, cameras, lights, shadows
    with open(path, "wb") as f:
        f.write(out)


__all__ = ["parse_vmd", "vmd_to_rotations", "load_vmd", "write_vmd", "sample", "N", "UNIT", "matrix_to_quat"]
