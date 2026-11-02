"""Finds VRM humanoid bones in an arbitrary skeleton (e.g. UniRig's bone_0..bone_N) from geometry
and hierarchy alone, and works out which way the character faces.

Assumes +Y up and a roughly upright character in T- or A-pose. Steps:
  feet      the two groups of leaf joints near the floor
  hips      the joint where both leg chains meet
  head      the highest leaf near the body's vertical axis (props held out to the side are skipped)
  arms      the most mirror-symmetric pair of leaves that branch off the spine (one-sided props lose)
  facing    the toes point forward (foot mesh in front of the ankle)
  joints    knee, elbow and wrist are found from proportions along each chain
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .gltf_read import Model
from .rig import children_of


class MappingError(Exception):
    pass


@dataclass
class Mapping:
    bones: dict[str, int]  # VRM bone -> joint index
    forward: np.ndarray  # unit horizontal vector the character faces (before normalization)
    warnings: list[str] = field(default_factory=list)


def _path_to_root(parent, j):
    out = []
    while j >= 0:
        out.append(j)
        j = parent[j]
    return out


def _lca(parent, a, b):
    pa = _path_to_root(parent, a)
    sb = set(_path_to_root(parent, b))
    for k in pa:
        if k in sb:
            return k
    return -1


def _path(parent, top, bottom):
    """Joints from top (exclusive) down to bottom (inclusive)."""
    p = []
    k = bottom
    while k >= 0 and k != top:
        p.append(k)
        k = parent[k]
    if k != top:
        raise MappingError("뼈대 계층이 예상과 다릅니다")
    return p[::-1]


def find_humanoid(model: Model) -> Mapping:
    P = model.joint_world[:, :3, 3]
    parent = model.joint_parent
    ch = children_of(model)
    verts = np.concatenate([p.positions for p in model.prims])
    floor, top = verts[:, 1].min(), verts[:, 1].max()
    H = top - floor
    if H <= 0:
        raise MappingError("모델 높이를 알 수 없습니다")
    leaves = [j for j in range(len(P)) if not ch[j]]
    warn = []

    # ---- feet: leaves near the floor, split into two groups
    low = [j for j in leaves if P[j, 1] < floor + 0.15 * H]
    if len(low) < 2:
        raise MappingError("발 위치의 뼈를 찾지 못했습니다 (전신이 서 있는 모델이 필요합니다)")
    xz = P[low][:, [0, 2]]
    # two clusters along the axis of largest spread
    c = xz - xz.mean(0)
    axis = np.linalg.svd(c, full_matrices=False)[2][0]
    side = c @ axis
    g1 = [j for j, s in zip(low, side) if s > 0]
    g2 = [j for j, s in zip(low, side) if s <= 0]
    if not g1 or not g2:
        raise MappingError("두 발을 구분하지 못했습니다")
    foot_a = min(g1, key=lambda j: P[j, 1])
    foot_b = min(g2, key=lambda j: P[j, 1])
    hips = _lca(parent, foot_a, foot_b)
    if hips < 0:
        raise MappingError("두 다리가 연결된 엉덩이 뼈를 찾지 못했습니다")
    if P[hips, 1] < floor + 0.3 * H:
        raise MappingError("엉덩이 뼈 위치가 너무 낮습니다 (사람 형태가 아닌 것 같습니다)")

    leg_a = _path(parent, hips, foot_a)
    leg_b = _path(parent, hips, foot_b)
    leg_set = set(leg_a) | set(leg_b)
    for leg in (leg_a, leg_b):
        for j in leg:
            stack = list(ch[j])
            while stack:
                k = stack.pop()
                leg_set.add(k)
                stack.extend(ch[k])

    # ---- head: highest non-leg leaf below hips' subtree, close to the vertical axis through the hips
    def subtree(j):
        out, stack = [], [j]
        while stack:
            k = stack.pop()
            out.append(k)
            stack.extend(ch[k])
        return out

    upper = [j for j in subtree(hips) if j not in leg_set and j != hips]
    near_axis = [j for j in upper if not ch[j] and np.linalg.norm(P[j][[0, 2]] - P[hips][[0, 2]]) < 0.12 * H]
    if not near_axis:
        raise MappingError("머리 쪽 뼈를 찾지 못했습니다")
    head_leaf = max(near_axis, key=lambda j: P[j, 1])
    spine_path = _path(parent, hips, head_leaf)
    on_spine = set(spine_path)

    # ---- facing: toes in front of the ankles. Use the mesh near the floor around each foot chain.
    fwd = np.zeros(2)
    for leg in (leg_a, leg_b):
        ankle_xz = _ankle_guess(P, leg, floor, H)[[0, 2]]
        foot_pts = verts[(verts[:, 1] < floor + 0.04 * H)
                         & (np.linalg.norm(verts[:, [0, 2]] - ankle_xz, axis=1) < 0.15 * H)]
        if len(foot_pts):
            fwd += foot_pts[:, [0, 2]].mean(0) - ankle_xz
    if np.linalg.norm(fwd) < 1e-6:
        warn.append("앞쪽 방향을 발 모양으로 판단하지 못해 +Z를 앞으로 가정했습니다")
        fwd = np.array([0.0, 1.0])
    fwd = fwd / np.linalg.norm(fwd)
    forward = np.array([fwd[0], 0.0, fwd[1]])
    left_dir = np.cross([0, 1, 0], forward)  # character's left = up × forward
    lat = lambda j: float(np.dot(P[j] - P[hips], left_dir))  # noqa: E731 (+ = character's left)

    # ---- arms: the most mirror-symmetric pair of leaves branching off the spine
    arm_leaves = [j for j in upper if not ch[j] and j not in on_spine
                  and floor + 0.35 * H < P[j, 1] < top + 0.05 * H]
    lefts = [j for j in arm_leaves if lat(j) > 0.06 * H]
    rights = [j for j in arm_leaves if lat(j) < -0.06 * H]
    best, best_score = None, -1e9
    fwd_of = lambda j: float(np.dot(P[j] - P[hips], forward))  # noqa: E731
    for a in lefts:
        for b in rights:
            br = _lca(parent, a, b)
            if br not in on_spine:
                continue
            asym = abs(lat(a) + lat(b)) + abs(P[a, 1] - P[b, 1]) + abs(fwd_of(a) - fwd_of(b))
            reach = min(lat(a), -lat(b))
            # arm length along the chain: arms are long (~0.4 H), dangling straps and hair are short
            arm_len = min(_chain_len(P, parent, br, a), _chain_len(P, parent, br, b))
            if arm_len < 0.2 * H:
                continue
            score = reach + 0.5 * arm_len - 3 * asym
            if score > best_score:
                best, best_score = (a, b), score
    if best is None:
        raise MappingError("양팔을 찾지 못했습니다 (팔을 벌린 T/A 포즈가 필요합니다)")
    hand_l_leaf, hand_r_leaf = best
    branch = _lca(parent, hand_l_leaf, hand_r_leaf)

    bones = {"hips": hips}

    # ---- spine / chest / upperChest / neck / head
    bi = spine_path.index(branch)
    torso = spine_path[: bi + 1]
    above = spine_path[bi + 1 :]
    if not torso:
        raise MappingError("척추 뼈가 없습니다")
    bones["spine"] = torso[0]
    if len(torso) >= 2:
        bones["chest"] = torso[1]
    if len(torso) >= 3:
        bones["upperChest"] = torso[-1]
    if not above:
        raise MappingError("목/머리 뼈를 찾지 못했습니다")
    # Neck + head, or just head? The head bone is the one that moves the head: compare how much
    # skin weight each candidate carries on the vertices above the second candidate.
    bones_above = above[:2]
    if len(bones_above) == 2:
        head_y = P[bones_above[1], 1]
        mass = _weight_mass(model, verts, bones_above, head_y)
        if mass[1] > 0.25 * mass.sum():
            bones["neck"], bones["head"] = bones_above
        else:
            bones["head"] = bones_above[0]
    else:
        bones["head"] = above[0]

    # ---- arms
    for side, leaf in (("left", hand_l_leaf), ("right", hand_r_leaf)):
        chain = _path(parent, branch, leaf)
        lat_abs = [abs(lat(j)) for j in chain]
        ua = next((k for k, d in enumerate(lat_abs) if d >= 0.06 * H), None)
        if ua is None or ua >= len(chain) - 2:
            raise MappingError(f"{side} 팔 뼈가 부족합니다 (어깨-팔꿈치-손목이 필요)")
        if ua > 0:
            bones[f"{side}Shoulder"] = chain[ua - 1]
        rest = chain[ua:]
        bones[f"{side}UpperArm"] = rest[0]
        elbow, hand = _split_limb(P, rest, ch, (0.42, 0.77))
        bones[f"{side}LowerArm"] = elbow
        bones[f"{side}Hand"] = hand

    # ---- legs (assign sides by lateral position of the knee area)
    for leg in (leg_a, leg_b):
        side = "left" if lat(leg[-1]) > 0 else "right"
        if f"{side}UpperLeg" in bones:
            raise MappingError("두 다리가 같은 쪽에 있습니다")
        chain = [j for j in leg if abs(lat(j)) > 0.02 * H or P[j, 1] < P[hips, 1] - 0.05 * H]
        if len(chain) < 3:
            raise MappingError(f"{side} 다리 뼈가 부족합니다 (허벅지-무릎-발목이 필요)")
        bones[f"{side}UpperLeg"] = chain[0]
        ankle_k = _ankle_index(P, chain, floor, H)
        if ankle_k < 2:
            raise MappingError(f"{side} 무릎 뼈를 찾지 못했습니다")
        ankle = chain[ankle_k]
        mid_y = (P[chain[0], 1] + P[ankle, 1]) / 2
        knee = min(chain[1:ankle_k], key=lambda j: abs(P[j, 1] - mid_y))
        bones[f"{side}LowerLeg"] = knee
        bones[f"{side}Foot"] = ankle
        if ankle_k + 1 < len(chain) and np.dot(P[chain[ankle_k + 1]] - P[ankle], forward) > 0.02 * H:
            bones[f"{side}Toes"] = chain[ankle_k + 1]

    _check(P, bones, H, warn)
    return Mapping(bones, forward, warn)


def _weight_mass(model, verts, joints, min_y):
    """Total skin weight of each joint (including its descendants) over vertices higher than min_y."""
    ch = children_of(model)
    groups = []
    for j in joints:
        sub, stack = set(), [j]
        while stack:
            k = stack.pop()
            sub.add(k)
            stack.extend(c for c in ch[k] if c not in joints)
        groups.append(sub)
    mass = np.zeros(len(joints))
    for p in model.prims:
        sel = p.positions[:, 1] > min_y
        if not sel.any():
            continue
        J, Wt = p.joints[sel], p.weights[sel]
        for gi, sub in enumerate(groups):
            mass[gi] += Wt[np.isin(J, list(sub))].sum()
    return mass


def _chain_len(P, parent, top, leaf):
    pts = [leaf]
    k = leaf
    while k >= 0 and k != top:
        k = parent[k]
        pts.append(k)
    return float(np.linalg.norm(np.diff(P[pts], axis=0), axis=1).sum())


def _ankle_index(P, chain, floor, H):
    """Ankle = the last joint on the leg chain that is clearly above the sole."""
    above = [k for k, j in enumerate(chain) if P[j, 1] > floor + 0.03 * H]
    return above[-1] if above else len(chain) - 1


def _ankle_guess(P, leg, floor, H):
    return P[leg[_ankle_index(P, leg, floor, H)]]


def _split_limb(P, chain, ch, ratios):
    """Pick (elbow, wrist) on a chain starting at the upper arm.
    The wrist is preferably the joint where several fingers branch; otherwise use proportions."""
    seg = np.r_[0, np.cumsum(np.linalg.norm(np.diff(P[chain], axis=0), axis=1))]
    L = seg[-1] if seg[-1] > 0 else 1
    t = seg / L
    if len(chain) == 3:
        return chain[1], chain[2]
    # wrist candidates: first joint after 55% of the chain with >= 3 children (finger roots)
    hand = next((chain[k] for k in range(2, len(chain)) if t[k] > 0.55 and len(ch[chain[k]]) >= 3), None)
    if hand is None:
        k = min(range(2, len(chain)), key=lambda k: abs(t[k] - ratios[1]))
        hand = chain[k]
    hk = chain.index(hand)
    ek = min(range(1, hk), key=lambda k: abs(t[k] - ratios[0] * t[hk] / ratios[1]))
    return chain[ek], hand


def _check(P, bones, H, warn):
    def length(a, b):
        return np.linalg.norm(P[bones[a]] - P[bones[b]])

    for limb in (("UpperArm", "LowerArm"), ("LowerArm", "Hand"), ("UpperLeg", "LowerLeg"), ("LowerLeg", "Foot")):
        l = length("left" + limb[0], "left" + limb[1])
        r = length("right" + limb[0], "right" + limb[1])
        if abs(l - r) > 0.25 * max(l, r):
            warn.append(f"좌우 {limb[0]} 길이 차이가 큽니다 ({l:.2f} / {r:.2f})")
    if P[bones["head"], 1] < P[bones["hips"], 1]:
        raise MappingError("머리가 엉덩이보다 아래에 있습니다")
