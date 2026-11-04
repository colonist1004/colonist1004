"""Swaying hair and skirts for auto-rigged characters (VRMC_springBone).

Runs on the normalized model (VRM rest: faces +Z, feet on y=0, T-pose, world-aligned joints).

- Long hair: mesh connected to the head that hangs down behind the back. It gets 1-3 chains of
  3 bones (left / middle / right) under the head.
- Skirt: mesh around the hips, below the waist, that stands clear of the legs and goes most of the way
  around. It gets up to 8 chains of 2 bones under the hips, and its weights move off the legs.
- Colliders on the head, torso, hips and thighs keep the hair and skirt from going through the body.

The VRM viewer (three-vrm) simulates the springs. Nothing here needs more than numpy.
"""
from __future__ import annotations

import copy

import numpy as np

from .gltf_read import Model


def _smooth(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def _weld_graph(V, F):
    """Edges between vertex positions (UV seams split vertices; merge by position)."""
    key = np.round(V / (np.ptp(V, axis=0).max() * 1e-5)).astype(np.int64)
    _, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.ravel()
    tri = inv[F.reshape(-1, 3)]
    e = np.concatenate([tri[:, [0, 1]], tri[:, [1, 2]], tri[:, [2, 0]]])
    e = e[e[:, 0] != e[:, 1]]
    return inv, np.unique(np.sort(e, axis=1), axis=0)


def _flood(n, edges, seeds, allowed):
    """Nodes reachable from seeds through allowed nodes (welded indices)."""
    reached = np.zeros(n, bool)
    reached[seeds & allowed] = True
    e = edges[allowed[edges[:, 0]] & allowed[edges[:, 1]]]
    while True:
        a, b = reached[e[:, 0]], reached[e[:, 1]]
        new = np.zeros(n, bool)
        new[e[a & ~b, 1]] = True
        new[e[b & ~a, 0]] = True
        if not new.any():
            return reached
        reached |= new


def _seg_dist(P, a, b):
    ab = b - a
    t = np.clip(((P - a) @ ab) / max(ab @ ab, 1e-12), 0, 1)
    return np.linalg.norm(P - (a + np.outer(t, ab)), axis=1)


class _Builder:
    def __init__(self, model: Model, bones: dict):
        self.m = model
        self.bones = bones
        self.V = np.concatenate([p.positions for p in model.prims])
        self.offs = np.cumsum([0] + [len(p.positions) for p in model.prims])
        self.F = np.concatenate([p.indices.reshape(-1, 3) + self.offs[i] for i, p in enumerate(model.prims)])
        self.Wd = np.zeros((len(self.V), len(model.joint_names)))  # dense weights (V, J)
        for i, p in enumerate(model.prims):
            rows = np.arange(self.offs[i], self.offs[i + 1])
            for k in range(4):
                np.add.at(self.Wd, (rows, p.joints[:, k].astype(int)), p.weights[:, k])
        self.Wd /= np.maximum(self.Wd.sum(1, keepdims=True), 1e-9)
        self.springs, self.colliders, self.groups = [], [], []

    def pos(self, bone):
        return self.m.joint_world[self.bones[bone]][:3, 3].copy()

    def add_joint(self, name, parent_idx, world_pos):
        M = np.eye(4)
        M[:3, 3] = world_pos
        self.m.joint_names.append(name)
        self.m.joint_parent.append(parent_idx)
        self.m.joint_world = np.concatenate([self.m.joint_world, M[None]])
        self.Wd = np.concatenate([self.Wd, np.zeros((len(self.Wd), 1))], axis=1)
        return len(self.m.joint_names) - 1

    def chain(self, prefix, parent_bone, points):
        """Joints at `points` (top to tip), the first one parented to parent_bone. Returns indices."""
        idx, parent = [], self.bones[parent_bone]
        for k, p in enumerate(points):
            parent = self.add_joint(f"{prefix}_{k}", parent, p)
            idx.append(parent)
        return idx

    def collider(self, bone, radius, offset=(0, 0, 0), tail=None):
        node = self.bones[bone]
        shape = {"offset": [float(x) for x in offset], "radius": float(radius)}
        if tail is None:
            c = {"node": node, "shape": {"sphere": shape}}
        else:
            c = {"node": node, "shape": {"capsule": {**shape, "tail": [float(x) for x in tail]}}}
        self.colliders.append(c)
        return len(self.colliders) - 1

    def finish(self):
        """Back to 4 influences per vertex."""
        idx = np.argsort(-self.Wd, axis=1)[:, :4]
        w = np.take_along_axis(self.Wd, idx, axis=1)
        w[w < 0.01] = 0
        w /= np.maximum(w.sum(1, keepdims=True), 1e-9)
        for i, p in enumerate(self.m.prims):
            sl = slice(self.offs[i], self.offs[i + 1])
            p.joints = idx[sl].astype(p.joints.dtype if p.joints.dtype.kind in "iu" else np.uint16)
            p.weights = w[sl].astype(np.float32)


def _blend_onto_chains(b: _Builder, sel, t, chains, side_w, base=None, start=0.15):
    """Vertices `sel` (bool) hang along chains. t: 0 at the attachment .. 1 at the tip (per vertex),
    side_w: (n_sel, n_chains) how much each chain owns the vertex (rows sum to 1).
    base: if set, the part that stays put goes to this joint instead of the old weights."""
    rows = np.flatnonzero(sel)
    nb = len(chains[0])  # bones per chain (the last point is the tip)
    s = _smooth(t / start)[:, None]  # near the attachment the old weights stay
    old = b.Wd[rows].copy()
    if base is not None:
        old[:] = 0
        old[:, base] = 1
    new = np.zeros_like(old)
    # bone k runs from point k to point k+1 (the last point is the tip, not a bone); blend between the
    # middles of neighbouring bones so the bend is smooth
    nbones = nb - 1
    u = np.clip(t * nbones - 0.5, 0, nbones - 1)
    k0 = np.minimum(np.floor(u).astype(int), nbones - 1)
    f = np.where(k0 < nbones - 1, u - k0, 0.0)
    for c, ch in enumerate(chains):
        for k in range(nbones):
            wk = np.where(k0 == k, 1 - f, 0) + np.where(k0 == k - 1, f, 0)
            new[:, ch[k]] += side_w[:, c] * wk
    b.Wd[rows] = (1 - s) * old + s * new


def add_springs(model: Model, bones: dict, log=lambda *_: None):
    """Returns (model with spring joints and weights, VRMC_springBone extension dict or None)."""
    m = copy.deepcopy(model)
    need = ("hips", "spine", "head", "neck", "leftUpperLeg", "rightUpperLeg", "leftLowerLeg", "rightLowerLeg",
            "leftUpperArm", "rightUpperArm")
    if any(n not in bones for n in need):
        return model, None
    b = _Builder(m, bones)
    V, H = b.V, max(np.ptp(b.V[:, 1]), 1e-6)
    inv, edges = _weld_graph(V, b.F)
    nW = inv.max() + 1
    hips, head, neck = b.pos("hips"), b.pos("head"), b.pos("neck")
    lsh, rsh = b.pos("leftUpperArm"), b.pos("rightUpperArm")
    sh_half = abs(lsh[0] - rsh[0]) / 2
    legs = [(b.pos(f"{s}UpperLeg"), b.pos(f"{s}LowerLeg")) for s in ("left", "right")]
    knee_y = (legs[0][1][1] + legs[1][1][1]) / 2
    leg_d = np.minimum(_seg_dist(V, *legs[0]), _seg_dist(V, *legs[1]))
    # Leg thickness from the shins (a skirt rarely reaches below the knee; weights cannot be trusted
    # here, the auto-rig gives a skirt to the thighs): a thigh is about 1.6x a shin.
    shin_d = np.minimum(_seg_dist(V, legs[0][1], b.pos("leftFoot")) if "leftFoot" in bones else leg_d,
                        _seg_dist(V, legs[1][1], b.pos("rightFoot")) if "rightFoot" in bones else leg_d)
    foot_y = min(b.pos("leftFoot")[1], b.pos("rightFoot")[1]) if "leftFoot" in bones else 0.0
    shin = (V[:, 1] > foot_y + 0.05 * H) & (V[:, 1] < knee_y - 0.03 * H) & (shin_d < 0.1 * H)
    r_shin = np.percentile(shin_d[shin], 90) if shin.sum() > 8 else 0.035 * H
    r_out = float(np.clip(1.6 * r_shin, 0.04 * H, 0.1 * H))
    r_leg = 0.8 * r_out
    springs_made = []
    # distance to the whole leg (thigh, shin, foot, toes): toes stick out and are not a skirt
    whole_leg = leg_d.copy()
    for s_ in ("left", "right"):
        chain = [f"{s_}LowerLeg", f"{s_}Foot", f"{s_}Toes"]
        pts = [b.pos(n) for n in chain if n in bones]
        for a_, b_ in zip(pts, pts[1:]):
            whole_leg = np.minimum(whole_leg, _seg_dist(V, a_, b_))
    hand_bones = [bones[n] for n in bones if any(t in n for t in ("Hand", "LowerArm", "UpperArm", "Thumb", "Index",
                                                                  "Middle", "Ring", "Little"))]
    on_arm = b.Wd[:, hand_bones].sum(1) > 0.5 if hand_bones else np.zeros(len(V), bool)

    # torso depth: front surface vs the spine, per height (for "behind the back")
    def back_limit(y):
        band = (np.abs(V[:, 1] - y) < 0.02 * H) & (np.abs(V[:, 0] - hips[0]) < 0.6 * sh_half)
        if band.sum() < 5:
            return hips[2] - 0.08 * H
        zf = np.percentile(V[band, 2], 95)
        depth = max(zf - hips[2], 0.03 * H)
        return hips[2] - 1.15 * depth

    # ------------------------------------------------------------- hair
    chin = neck[1]
    hang = (V[:, 1] < chin - 0.02 * H) & (V[:, 1] > hips[1] - 0.1 * H) & (np.abs(V[:, 0] - hips[0]) < 1.4 * sh_half) & ~on_arm
    ys = np.unique(np.round(V[hang, 1] / (0.02 * H)))
    limits = {y: back_limit(y * 0.02 * H) for y in ys}
    lim = np.array([limits.get(y, -np.inf) for y in np.round(V[:, 1] / (0.02 * H))])
    behind = hang & (V[:, 2] < lim - 0.01 * H)
    near_head = V[:, 1] > chin - 0.03 * H  # overlaps the hanging part, so the flood can cross the nape
    allowed = np.zeros(nW, bool)
    allowed[inv[behind | near_head]] = True
    seedw = np.zeros(nW, bool)
    # seeds: the back of the head itself (props reaching up past the head do not count)
    crown = head + np.array([0, 0.05 * H, 0])
    on_head = np.linalg.norm(V - crown, axis=1) < 0.11 * H
    seedw[inv[(V[:, 1] > chin + 0.02 * H) & (V[:, 2] < head[2]) & on_head]] = True
    reach = _flood(nW, edges, seedw, allowed)
    hair = behind & reach[inv]
    if hair.sum() > 40 and np.ptp(V[hair, 1]) > 0.08 * H:
        hx = V[hair, 0]
        width = np.ptp(hx)
        n = 3 if width > 0.12 * H else 1
        centers = np.linspace(np.percentile(hx, 15), np.percentile(hx, 85), n) if n > 1 else np.array([np.median(hx)])
        y0, y1 = chin, V[hair, 1].min()
        chains = []
        for c, cx in enumerate(centers):
            near = hair & (np.abs(V[:, 0] - cx) < max(width / (2 * n), 0.03 * H))
            pts = []
            for f in (0.0, 1 / 3, 2 / 3, 1.0):
                y = y0 + f * (y1 - y0)
                band = near & (np.abs(V[:, 1] - y) < 0.04 * H)
                z = np.median(V[band, 2]) if band.sum() > 3 else (np.median(V[near, 2]) if near.any() else head[2] - 0.05 * H)
                pts.append(np.array([cx, y, z]))
            pts[0][2] = min(pts[0][2], head[2])  # attach under the back of the head
            chains.append(b.chain(f"hair{c}", "head", pts))
        sigma = max(width / (2 * n), 0.02 * H)
        side = np.exp(-0.5 * ((V[hair, 0][:, None] - centers[None]) / sigma) ** 2)
        side /= side.sum(1, keepdims=True)
        t = (y0 - V[hair, 1]) / max(y0 - y1, 1e-6)
        _blend_onto_chains(b, hair, t, chains, side, start=0.12)
        springs_made.append(("hair", chains, 0.55, 0.25))
        log(f"긴 머리카락: 흔들림 뼈 {len(chains)}줄")

    # ------------------------------------------------------------- skirt
    top_y = hips[1] + 0.03 * H
    band = (V[:, 1] < top_y) & (V[:, 1] > knee_y - 0.1 * H) & ~on_arm & ~hair
    clear = whole_leg > max(1.4 * r_out, r_out + 0.02 * H)
    rad = np.hypot(V[:, 0] - hips[0], V[:, 2] - hips[2])
    skirt = band & clear & (rad < 0.35 * H) & (V[:, 1] < hips[1])
    ang = np.arctan2(V[:, 0] - hips[0], V[:, 2] - hips[2])
    covered = np.unique(np.floor((ang[skirt] + np.pi) / (2 * np.pi) * 12).astype(int)).size if skirt.any() else 0
    if skirt.sum() > 40 and covered >= 7 and np.ptp(V[skirt, 1]) > 0.06 * H:
        # the whole skirt from the waist down, including the part still close to the legs at the top
        y_bot = V[skirt, 1].min()
        allowed = np.zeros(nW, bool)
        allowed[inv[(V[:, 1] < top_y) & (V[:, 1] >= y_bot - 0.01 * H) & ~on_arm & ~hair & (rad < 0.35 * H)
                    & (whole_leg > 1.1 * r_out)]] = True
        seeds = np.zeros(nW, bool)
        seeds[inv[skirt]] = True
        whole = _flood(nW, edges, seeds, allowed)[inv]  # the skirt cloth, not the body next to it
        n = 8
        centers = np.linspace(-np.pi, np.pi, n, endpoint=False) + np.pi / n
        chains = []
        y0 = min(hips[1], V[whole, 1].max())
        for c, a in enumerate(centers):
            d = np.abs((ang - a + np.pi) % (2 * np.pi) - np.pi)
            sec = whole & (d < np.pi / n)
            if sec.sum() < 5:
                sec = whole & (d < 2 * np.pi / n)
            pts = []
            for f in (0.0, 0.5, 1.0):
                y = y0 + f * (y_bot - y0)
                bnd = sec & (np.abs(V[:, 1] - y) < 0.03 * H)
                r = np.median(rad[bnd]) if bnd.sum() > 3 else (np.median(rad[sec]) if sec.any() else 0.12 * H)
                pts.append(np.array([hips[0] + r * np.sin(a), y, hips[2] + r * np.cos(a)]))
            chains.append(b.chain(f"skirt{c}", "hips", pts))
        d = np.abs((ang[whole][:, None] - centers[None] + np.pi) % (2 * np.pi) - np.pi)
        side = np.exp(-0.5 * (d / (np.pi / n)) ** 2)
        side /= side.sum(1, keepdims=True)
        t = (y0 - V[whole, 1]) / max(y0 - y_bot, 1e-6)
        _blend_onto_chains(b, whole, t, chains, side, base=bones["hips"], start=0.25)
        springs_made.append(("skirt", chains, 0.9, 0.35))
        log(f"치마: 흔들림 뼈 {len(chains)}줄")

    if not springs_made:
        return model, None

    # ------------------------------------------------------------- colliders
    def depth_at(y):
        return max(hips[2] - back_limit(y), 0.04 * H) / 1.15

    torso = []
    for bone in ("spine", "chest", "upperChest"):
        if bone in bones:
            torso.append(b.collider(bone, 0.9 * depth_at(b.pos(bone)[1])))
    torso.append(b.collider("hips", 0.9 * depth_at(hips[1])))
    head_r = 0.06 * H
    torso.append(b.collider("head", head_r, offset=(0, 0.04 * H, 0)))
    leg_cs = []
    for s in ("left", "right"):
        a, k = b.pos(f"{s}UpperLeg"), b.pos(f"{s}LowerLeg")
        leg_cs.append(b.collider(f"{s}UpperLeg", 1.1 * r_leg, tail=k - a))
    groups = [{"name": "body", "colliders": torso}, {"name": "legs", "colliders": leg_cs + [torso[-2]]}]
    springs = []
    for kind, chains, stiff, drag in springs_made:
        gi = [0] if kind == "hair" else [1]
        for ch in chains:
            springs.append({
                "name": f"{kind}{len(springs)}",
                "joints": [{"node": int(j), "hitRadius": float(0.012 * H), "stiffness": stiff, "gravityPower": 0.15,
                            "gravityDir": [0.0, -1.0, 0.0], "dragForce": drag} for j in ch],
                "colliderGroups": gi,
            })
    b.finish()
    ext = {"specVersion": "1.0", "colliders": b.colliders, "colliderGroups": groups, "springs": springs}
    return m, ext
