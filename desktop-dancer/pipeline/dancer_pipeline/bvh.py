"""BVH motion files (Rokoko Vision/Studio, Plask, DeepMotion, QuickMagic, Mixamo, CMU, ...) -> VRM local rotations.

Bones are matched by name (common naming schemes are covered). The BVH rest pose (all channels zero)
may differ from the VRM T-pose (A-pose arms, other bone directions): each bone gets a constant
correction that maps the VRM rest direction onto the BVH rest direction. Units (cm/m), up axis
(Y or Z) and facing direction (+Z or -Z) are detected from the rest skeleton.
"""
from __future__ import annotations

import re

import numpy as np

from .rot import axis_angle_to_matrix, normalize, rotation_between
from .skeleton import BONES, PARENT, REST_HIPS_Y, REST_POS

# VRM bone -> name patterns (normalized: lowercase, no separators, prefixes like "mixamorig:" removed).
# Side is handled separately: "{s}" is replaced by left/l and right/r variants.
PATTERNS = {
    "hips": ["hips", "hip", "pelvis", "root"],
    "spine": ["spine", "spine0", "spine1", "abdomen", "lowerback", "torso", "waist"],
    "chest": ["spine1", "spine2", "chest", "upperback"],
    "upperChest": ["spine2", "spine3", "upperchest", "chest2"],
    "neck": ["neck", "neck1", "lowerneck"],
    "head": ["head"],
    "{s}Shoulder": ["{s}shoulder", "{s}clavicle", "{s}collar", "shoulder{s}", "clavicle{s}", "collar{s}"],
    "{s}UpperArm": ["{s}arm", "{s}upperarm", "{s}uparm", "upperarm{s}", "arm{s}", "{s}humerus"],
    "{s}LowerArm": ["{s}forearm", "{s}lowerarm", "{s}elbow", "forearm{s}", "lowerarm{s}"],
    "{s}Hand": ["{s}hand", "{s}wrist", "hand{s}", "wrist{s}"],
    "{s}UpperLeg": ["{s}upleg", "{s}upperleg", "{s}thigh", "{s}hip", "thigh{s}", "upperleg{s}", "{s}femur"],
    "{s}LowerLeg": ["{s}leg", "{s}lowerleg", "{s}knee", "{s}shin", "{s}calf", "shin{s}", "calf{s}", "lowerleg{s}", "{s}tibia"],
    "{s}Foot": ["{s}foot", "{s}ankle", "foot{s}", "ankle{s}"],
    "{s}Toes": ["{s}toebase", "{s}toe", "{s}toes", "{s}ball", "toe{s}", "toes{s}"],
}
SIDES = {"left": ["left", "l"], "right": ["right", "r"]}


class BVH:
    def __init__(self, names, parents, offsets, channels, frames, frame_time):
        self.names = names
        self.parents = parents
        self.offsets = np.array(offsets, dtype=np.float64)
        self.channels = channels  # per joint: list of channel names
        self.frames = np.array(frames, dtype=np.float64)
        self.frame_time = frame_time


def parse_bvh(text: str) -> BVH:
    tok = text.split()
    i = 0
    names, parents, offsets, channels = [], [], [], []
    stack = []
    last = -1
    if tok[0].upper() != "HIERARCHY":
        raise ValueError("BVH 파일이 아닙니다 (HIERARCHY 없음)")
    i = 1
    while i < len(tok):
        t = tok[i]
        u = t.upper()
        if u in ("ROOT", "JOINT"):
            names.append(tok[i + 1])
            parents.append(stack[-1] if stack else -1)
            offsets.append([0, 0, 0])
            channels.append([])
            last = len(names) - 1
            i += 2
        elif u == "END":  # End Site { OFFSET x y z }
            depth = 0
            while True:
                i += 1
                if tok[i] == "{":
                    depth += 1
                elif tok[i] == "}":
                    depth -= 1
                    if depth == 0:
                        break
            i += 1
        elif t == "{":
            stack.append(last)
            i += 1
        elif t == "}":
            stack.pop()
            i += 1
        elif u == "OFFSET":
            offsets[last] = [float(x) for x in tok[i + 1 : i + 4]]
            i += 4
        elif u == "CHANNELS":
            n = int(tok[i + 1])
            channels[last] = tok[i + 2 : i + 2 + n]
            i += 2 + n
        elif u == "MOTION":
            i += 1
            break
        else:
            i += 1
    # MOTION
    n_frames = int(tok[i + 1]) if tok[i].upper().startswith("FRAMES") else int(tok[i + 2])
    while tok[i].upper() != "TIME:":
        i += 1
    frame_time = float(tok[i + 1])
    i += 2
    nch = sum(len(c) for c in channels)
    vals = np.array(tok[i : i + n_frames * nch], dtype=np.float64)
    if len(vals) < n_frames * nch:
        n_frames = len(vals) // nch
        vals = vals[: n_frames * nch]
    return BVH(names, parents, offsets, channels, vals.reshape(n_frames, nch), frame_time)


def _norm(name: str) -> str:
    name = name.split(":")[-1].split("|")[-1]
    return re.sub(r"[^a-z0-9]", "", name.lower())


def map_bones(names: list[str]) -> dict[str, int]:
    """VRM bone -> BVH joint index, by name."""
    normed = [_norm(n) for n in names]
    out: dict[str, int] = {}
    taken: set[int] = set()
    order = ["hips", "{s}UpperLeg", "{s}LowerLeg", "{s}Foot", "{s}Toes", "{s}Shoulder", "{s}UpperArm",
             "{s}LowerArm", "{s}Hand", "neck", "head", "spine", "chest", "upperChest"]
    for key in order:
        sides = [("left", SIDES["left"]), ("right", SIDES["right"])] if "{s}" in key else [("", [""])]
        for side, variants in sides:
            bone = key.replace("{s}", side)
            for pat in PATTERNS[key]:
                hit = None
                for v in variants:
                    target = pat.replace("{s}", v)
                    for j, n in enumerate(normed):
                        if j not in taken and n == target:
                            hit = j
                            break
                    if hit is not None:
                        break
                if hit is not None:
                    out[bone] = hit
                    taken.add(hit)
                    break
    return out


def _euler(channel_names, values):
    """Rotation matrices (F,3,3) from BVH rotation channels, applied in the listed order (degrees)."""
    n = len(values)
    R = np.broadcast_to(np.eye(3), (n, 3, 3)).copy()
    for k, ch in enumerate(channel_names):
        axis = {"X": [1, 0, 0], "Y": [0, 1, 0], "Z": [0, 0, 1]}[ch[0].upper()]
        R = R @ axis_angle_to_matrix(np.outer(np.radians(values[:, k]), axis))
    return R


def bvh_to_rotations(b: BVH):
    """Returns (fps, local_rot: VRM bone -> (F,3,3), root_pos (F,3) in reference-skeleton meters, warnings)."""
    warnings = []
    J = len(b.names)
    n = len(b.frames)
    bones = map_bones(b.names)
    required = ["hips", "leftUpperLeg", "leftLowerLeg", "rightUpperLeg", "rightLowerLeg",
                "leftUpperArm", "leftLowerArm", "rightUpperArm", "rightLowerArm", "head"]
    missing = [r for r in required if r not in bones]
    if missing:
        raise ValueError(f"BVH에서 찾지 못한 뼈: {', '.join(missing)} (뼈 이름: {', '.join(b.names[:12])}…)")

    # per-joint local rotation + root translation
    col = 0
    local = np.broadcast_to(np.eye(3), (J, n, 3, 3)).copy()
    root_t = np.zeros((n, 3))
    for j, chs in enumerate(b.channels):
        rot_ch = [c for c in chs if "rotation" in c.lower()]
        rot_idx = [col + k for k, c in enumerate(chs) if "rotation" in c.lower()]
        if rot_ch:
            local[j] = _euler([c[0] for c in rot_ch], b.frames[:, rot_idx])
        for k, c in enumerate(chs):
            if "position" in c.lower() and b.parents[j] < 0:
                root_t[:, "XYZ".index(c[0].upper())] = b.frames[:, col + k]
        col += len(chs)

    # rest positions and world rotations
    rest = np.zeros((J, 3))
    world = np.zeros((J, n, 3, 3))
    for j in range(J):
        p = b.parents[j]
        rest[j] = b.offsets[j] + (rest[p] if p >= 0 else 0)
        world[j] = local[j] if p < 0 else world[p] @ local[j]

    # Orientation of the file: up axis and facing, from the rest skeleton.
    hips = rest[bones["hips"]]
    up = normalize(rest[bones["head"]] - hips)
    A = rotation_between(up, np.array([0.0, 1.0, 0.0]))
    left = A @ (rest[bones["leftUpperArm"]] - rest[bones["rightUpperArm"]])
    yaw = np.arctan2(left[2], left[0])  # rotate so the character's left points +X (faces +Z)
    c, s = np.cos(yaw), np.sin(yaw)
    A = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]]) @ A
    restA = rest @ A.T
    feet = [bones.get(f"{s_}Foot", bones[f"{s_}LowerLeg"]) for s_ in ("left", "right")]
    floor = min(restA[f][1] for f in feet)
    hips_h = restA[bones["hips"]][1] - floor
    if hips_h <= 0:
        raise ValueError("BVH 뼈대의 높이를 알 수 없습니다")
    scale = (REST_HIPS_Y - REST_POS["leftFoot"][1]) / hips_h

    # VRM world rotation = A · W_bvh · A^T (frame change) · C (rest correction)
    def vrm_dir(bone):
        child = next((c for c in BONES if PARENT[c] == bone and c in bones), None)
        if child is None:
            return None, None
        return REST_POS[child] - REST_POS[bone], child

    Wv = {}
    for bone in BONES:
        if bone not in bones:
            continue
        Wb = np.einsum("ij,fjk,kl->fil", A, world[bones[bone]], A.T)
        d_vrm, child = vrm_dir(bone)
        if d_vrm is not None and bone != "hips":
            d_bvh = restA[bones[child]] - restA[bones[bone]]
            C = rotation_between(normalize(d_vrm), normalize(d_bvh)) if np.linalg.norm(d_bvh) > 1e-6 else np.eye(3)
        else:
            C = np.eye(3)
        Wv[bone] = Wb @ C

    # local rotations relative to the nearest mapped ancestor
    out = {}
    for bone in BONES:
        if bone not in Wv:
            continue
        p = PARENT[bone]
        while p is not None and p not in Wv:
            p = PARENT[p]
        out[bone] = Wv[bone] if p is None else np.swapaxes(Wv[p], -1, -2) @ Wv[bone]

    # Root motion relative to the first frame, in reference-skeleton meters, starting at rest hips height.
    # (The vertical part is re-grounded later from the feet.)
    root = (root_t - root_t[:1]) @ A.T * scale + np.array([0, REST_HIPS_Y, 0])
    fps = 1.0 / b.frame_time if b.frame_time > 0 else 30.0
    unmapped = [x for x in ("spine", "chest", "neck", "leftShoulder", "leftHand", "leftFoot") if x not in bones]
    if unmapped:
        warnings.append("일부 뼈를 찾지 못해 그 부분은 움직이지 않습니다: " + ", ".join(unmapped))
    return fps, out, root, warnings


def load_bvh(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        return bvh_to_rotations(parse_bvh(f.read()))
