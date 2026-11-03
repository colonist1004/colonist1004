"""Local auto-rigging for an unrigged humanoid mesh in T- or A-pose (CPU only, numpy).

Replaces the CUDA-only UniRig step so characters can be made on any PC (AMD/Intel/NVIDIA/no GPU).

1. Axes: up is +Y (glTF). Left/right is the widest horizontal direction at arm height
   (arms are spread in T/A pose); the front is where the toes stick out.
2. Skeleton from the body shape: crotch = where the legs split, neck = narrowest part of the
   central column, shoulders from the torso width, hands = farthest arm points (a mirror-symmetric
   pair, so one-sided props do not count), elbows/wrists/knees by body proportions along the limb.
3. Skin weights: each vertex starts on its nearest bone, with the distance scaled by that limb's
   thickness (so a hand hanging next to a thigh does not grab the thigh), then heat diffusion over
   the mesh smooths the weights across joints.
"""
from __future__ import annotations

import numpy as np

from ..rot import normalize
from .gltf_read import Model, Prim
from .humanoid import MappingError

BONE_ORDER = [  # (name, parent)
    ("hips", None), ("spine", "hips"), ("chest", "spine"), ("upperChest", "chest"), ("neck", "upperChest"),
    ("head", "neck"),
    ("leftShoulder", "upperChest"), ("leftUpperArm", "leftShoulder"), ("leftLowerArm", "leftUpperArm"), ("leftHand", "leftLowerArm"),
    ("rightShoulder", "upperChest"), ("rightUpperArm", "rightShoulder"), ("rightLowerArm", "rightUpperArm"), ("rightHand", "rightLowerArm"),
    ("leftUpperLeg", "hips"), ("leftLowerLeg", "leftUpperLeg"), ("leftFoot", "leftLowerLeg"), ("leftToes", "leftFoot"),
    ("rightUpperLeg", "hips"), ("rightLowerLeg", "rightUpperLeg"), ("rightFoot", "rightLowerLeg"), ("rightToes", "rightFoot"),
]
# Bone segment ends for leaves (used for skinning): name -> key in the tips dict
LEAF_TIPS = {"head": "headTop", "leftHand": "leftHandTip", "rightHand": "rightHandTip", "leftToes": "leftToeTip", "rightToes": "rightToeTip"}


def _clusters_1d(x, gap):
    """Split sorted 1D values into clusters separated by more than `gap`. Returns list of (lo, hi, idx)."""
    if len(x) == 0:
        return []
    o = np.argsort(x)
    xs = x[o]
    cuts = np.flatnonzero(np.diff(xs) > gap)
    out, start = [], 0
    for c in list(cuts) + [len(xs) - 1]:
        out.append((xs[start], xs[c], o[start : c + 1]))
        start = c + 1
    return out


def sample_surface(V, F, n=200000, seed=0):
    """Points spread evenly over the surface (vertex density varies a lot between meshes)."""
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    if area.sum() <= 0:
        return V
    rng = np.random.default_rng(seed)
    t = rng.choice(len(F), size=n, p=area / area.sum())
    r1, r2 = rng.random(n), rng.random(n)
    s1 = np.sqrt(r1)
    return (1 - s1)[:, None] * a[t] + (s1 * (1 - r2))[:, None] * b[t] + (s1 * r2)[:, None] * c[t]


def find_axes(V):
    """Returns (forward, left) unit vectors in the horizontal plane."""
    y = V[:, 1]
    lo, hi = y.min(), y.max()
    H = hi - lo
    band = V[(y > lo + 0.55 * H) & (y < lo + 0.92 * H)][:, [0, 2]]
    c = band - band.mean(0)
    lat = np.linalg.svd(c, full_matrices=False)[2][0]  # widest direction = arms
    fwd = np.array([-lat[1], lat[0]])
    # toes: the lowest part of the mesh sticks out in front of the ankles
    feet = V[y < lo + 0.04 * H][:, [0, 2]]
    shins = V[(y > lo + 0.07 * H) & (y < lo + 0.12 * H)][:, [0, 2]]
    if len(feet) and len(shins):
        d = float(np.dot(feet.mean(0) - shins.mean(0), fwd))
        if d < 0:
            fwd = -fwd
    forward = np.array([fwd[0], 0.0, fwd[1]])
    left = np.cross([0.0, 1.0, 0.0], forward)
    return normalize(forward), normalize(left)


def fit_skeleton(V):
    """V in canonical frame (x = character's left, y up, z forward). Returns joint positions and tips."""
    y = V[:, 1]
    floor, top = y.min(), y.max()
    H = top - floor
    gap = 0.012 * H

    def band(y0, y1):
        return V[(y >= floor + y0 * H) & (y < floor + y1 * H)]

    # --- crotch: highest height where the central region splits into two leg columns
    crotch = None
    for f in np.arange(0.2, 0.6, 0.01):
        b = band(f, f + 0.012)
        b = b[np.abs(b[:, 0]) < 0.2 * H]
        cl = [c for c in _clusters_1d(b[:, 0], gap) if len(c[2]) > 5]
        near = [c for c in cl if c[0] < 0.18 * H and c[1] > -0.18 * H]
        lefts = [c for c in near if (c[0] + c[1]) / 2 > 0]
        rights = [c for c in near if (c[0] + c[1]) / 2 < 0]
        if lefts and rights:
            crotch = f
        elif crotch is not None:
            break
    if crotch is None:
        raise MappingError("다리 두 개를 찾지 못했습니다 (서 있는 전신 모델이 필요합니다)")
    crotch_y = floor + crotch * H

    def leg_center(side, f):
        b = band(f - 0.01, f + 0.01)
        b = b[(np.sign(b[:, 0]) == side) & (np.abs(b[:, 0]) < 0.2 * H)]
        cl = [c for c in _clusters_1d(b[:, 0] * side, gap) if len(c[2]) > 3]
        if not cl:
            return None
        inner = min(cl, key=lambda c: c[0])  # the column nearest the center is the leg
        pts = b[inner[2]]
        return np.array([pts[:, 0].mean(), floor + f * H, (pts[:, 2].min() + pts[:, 2].max()) / 2])

    J = {}
    hips_y = crotch_y + 0.05 * H
    for side, name in ((1, "left"), (-1, "right")):
        up = leg_center(side, crotch - 0.04)
        shin = leg_center(side, 0.09)
        if up is None or shin is None:
            raise MappingError(f"{name} 다리를 따라가지 못했습니다")
        J[f"{name}UpperLeg"] = np.array([up[0], crotch_y + 0.02 * H, up[2]])
        ankle = np.array([shin[0], floor + 0.045 * H, shin[2]])
        J[f"{name}Foot"] = ankle
        knee_f = (crotch + 0.02 - 0.045) / 2 + 0.045
        kc = leg_center(side, knee_f)
        J[f"{name}LowerLeg"] = kc if kc is not None else (J[f"{name}UpperLeg"] + ankle) / 2
        foot = V[(y < floor + 0.05 * H) & (np.abs(V[:, 0] - ankle[0]) < 0.08 * H)]
        toe_z = np.percentile(foot[:, 2], 95) if len(foot) else ankle[2] + 0.08 * H
        J[f"{name}Toes"] = np.array([ankle[0], floor + 0.015 * H, ankle[2] + 0.6 * (toe_z - ankle[2])])
        J[f"{name}ToeTip"] = np.array([ankle[0], floor + 0.01 * H, toe_z])

    # --- central column (torso, neck, head): the x-cluster around the body center
    hip_x = (J["leftUpperLeg"][0] + J["rightUpperLeg"][0]) / 2

    def central(f):
        b = band(f - 0.006, f + 0.006)
        cl = [c for c in _clusters_1d(b[:, 0], gap) if len(c[2]) > 3]
        mid = [c for c in cl if c[0] <= hip_x + 0.02 * H and c[1] >= hip_x - 0.02 * H]
        if not mid:
            return None, None
        c = mid[0]
        pts = b[c[2]]
        return pts, c[1] - c[0]

    widths = []
    for f in np.arange(0.74, 0.94, 0.005):
        pts, wdt = central(f)
        if pts is not None:
            widths.append((wdt, f, pts))
    if not widths:
        raise MappingError("목 위치를 찾지 못했습니다")
    _, neck_f, neck_pts = min(widths, key=lambda t: t[0])
    neck_y = floor + neck_f * H
    nc = np.array([neck_pts[:, 0].mean(), neck_y, (neck_pts[:, 2].min() + neck_pts[:, 2].max()) / 2])
    J["neck"] = nc - np.array([0, 0.015 * H, 0])
    J["head"] = nc + np.array([0, 0.02 * H, 0])
    J["headTop"] = np.array([nc[0], top, nc[2]])

    hips_pts, _ = central((hips_y - floor) / H)
    hz = (hips_pts[:, 2].min() + hips_pts[:, 2].max()) / 2 if hips_pts is not None else nc[2]
    J["hips"] = np.array([hip_x, hips_y, hz])
    span = neck_y - hips_y
    for name, t in (("spine", 0.18), ("chest", 0.45), ("upperChest", 0.7)):
        pts, _ = central((hips_y + t * span - floor) / H)
        z = (pts[:, 2].min() + pts[:, 2].max()) / 2 if pts is not None else hz
        J[name] = np.array([hip_x + (nc[0] - hip_x) * t, hips_y + t * span, z])

    # --- shoulders and arms
    sh_y = neck_y - 0.06 * H
    chest_pts, _ = central((neck_y - 0.12 * H - floor) / H)
    half = (chest_pts[:, 0].max() - chest_pts[:, 0].min()) / 2 if chest_pts is not None else 0.1 * H
    tips = {}
    for side, name in ((1, "left"), (-1, "right")):
        ua = np.array([J["upperChest"][0] + side * 0.85 * half, sh_y, J["upperChest"][2]])
        arm = V[(V[:, 0] * side > ua[0] * side) & (V[:, 1] > hips_y - 0.18 * H)]
        if len(arm) < 10:
            raise MappingError(f"{name} 팔을 찾지 못했습니다 (팔을 벌린 T/A 포즈가 필요합니다)")
        d = np.linalg.norm(arm - ua, axis=1)
        tips[name] = (ua, arm, d)
    # mirror-consistent hand tips: a one-sided prop makes one side much longer
    reach = {k: v[2].max() for k, v in tips.items()}
    short = min(reach.values())
    for side, name in ((1, "left"), (-1, "right")):
        ua, arm, d = tips[name]
        other = "right" if name == "left" else "left"
        if reach[name] > 1.25 * short:  # likely a prop: pick the point mirroring the other hand
            o_ua, o_arm, o_d = tips[other]
            mirror = o_arm[np.argmax(o_d)] * np.array([-1, 1, 1])
            tip = arm[np.argmin(np.linalg.norm(arm - mirror, axis=1))]
        else:
            tip = arm[np.argmax(d)]
        axis = tip - ua
        L = np.linalg.norm(axis)
        u = axis / L
        t = (arm - ua) @ u
        radial = np.linalg.norm((arm - ua) - np.outer(t, u), axis=1)
        on_arm = radial < 0.12 * H

        def along(frac):
            sel = on_arm & (np.abs(t - frac * L) < 0.03 * H)
            return arm[sel].mean(0) if sel.sum() > 3 else ua + u * frac * L

        J[f"{name}Shoulder"] = np.array([J["upperChest"][0] + side * 0.03 * H, sh_y, J["upperChest"][2]])
        J[f"{name}UpperArm"] = ua
        J[f"{name}LowerArm"] = along(0.42)
        J[f"{name}Hand"] = along(0.76)
        J[f"{name}HandTip"] = tip
    return J


def _detector(log):
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision

    from ..pose_mediapipe import model_path

    opts = vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path=str(model_path("heavy", log))),
                                        running_mode=vision.RunningMode.IMAGE, num_poses=1)
    lm = vision.PoseLandmarker.create_from_options(opts)
    detect = lambda img: lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(img)))  # noqa: E731
    detect.close = lm.close  # close explicitly: MediaPipe's own cleanup at exit prints a traceback
    return detect


def _sweep(P, C, detect, yaws, size, frame=None):
    from .render import render

    out = []
    for yaw in yaws:
        img, _, depth, view = render(P, C, yaw, size=size, frame=frame)
        r = detect(img)
        if r.pose_landmarks:
            L = np.array([[l.x * size, l.y * size, l.visibility] for l in r.pose_landmarks[0]])
            out.append((yaw, L, view, depth))
    return out


def _body_axis(found, size):
    """Vertical line (x, z) through the torso, triangulated from the shoulder/hip centers seen in
    several views: lateral = x cos(yaw) - z sin(yaw)."""
    A, b = [], []
    for yaw, L, (origin, span, right, fwd), _ in found:
        u = (L[11, 0] + L[12, 0] + L[23, 0] + L[24, 0]) / 4
        A.append([np.cos(yaw), -np.sin(yaw)])
        b.append(origin[0] + u / (size - 1) * span)
    if len(A) < 2:
        return None
    sol, *_ = np.linalg.lstsq(np.array(A), np.array(b), rcond=None)
    return sol


def best_view(P, C, detect, log=lambda *_: None, step_deg=15, size=512):
    """Render around the model; the front is the view where a person is detected facing the camera
    with the widest shoulders. Returns (yaw, landmarks (33,3: x,y px + visibility), view info) or None.

    Two passes: the first fits the whole model in each view. Big props (wings, weapons) can make the
    person small there, and a model without legs leaves the detector guessing, so the second pass
    zooms every view onto the person's own vertical axis (found from the first pass) with the same
    framing, which keeps the shoulder widths comparable between views."""
    yaws = [np.radians(d) for d in range(0, 360, step_deg)]
    found = _sweep(P, C, detect, yaws, size)
    axis = _body_axis(found, size)
    if axis is not None:
        H = np.ptp(P[:, 1])
        d = np.hypot(P[:, 0] - axis[0], P[:, 2] - axis[1])
        reach = np.percentile(d, 90)  # arms and nearby clothes; a long prop sticks out past this
        span = max(H, 2.2 * reach) * 1.08
        frame = (axis, P[:, 1].min() - 0.04 * span, span)
        zoomed = _sweep(P, C, detect, yaws, size, frame)
        if zoomed:
            found = zoomed
    best = None
    for yaw, L, view, depth in found:
        facing = L[11, 0] > L[12, 0] and L[0, 2] > 0.5  # person's left shoulder on the image right, face seen
        width = (L[11, 0] - L[12, 0]) / (size - 1) * view[1]  # world units (views can be framed differently)
        score = width / np.ptp(P[:, 1]) + (1.0 if facing else 0.0)
        if best is None or score > best[0]:
            best = (score, yaw, L, view, depth)
    if best is None or best[0] < 1.0:
        return None
    log(f"정면 방향 찾음 ({np.degrees(best[1]):.0f}°)")
    return best[1:]


def joints_from_landmarks(P, L, view, H):
    """MediaPipe landmarks on the front view -> 3D joints (canonical frame of that view)."""
    origin, span, right, fwd = view
    size = 512

    def to_xy(i):
        u, v = L[i, 0], L[i, 1]
        return np.array([origin[0] + u / (size - 1) * span, origin[1] + (1 - v / (size - 1)) * span])

    X = P @ right
    Y = P[:, 1]
    Z = P @ fwd

    def depth_at(xy, radius):
        sel = (np.abs(X - xy[0]) < radius) & (np.abs(Y - xy[1]) < radius)
        if sel.sum() < 3:
            return None
        zf = Z[sel].max()
        zb = max(Z[sel].min(), zf - 0.15 * H)  # a backpack/tail behind does not count
        return (zf + zb) / 2

    def p3(xy, radius=0.03 * H):
        z = depth_at(xy, radius)
        if z is None:
            z = depth_at(xy, 2.5 * radius)
        return np.array([xy[0], xy[1], z if z is not None else np.median(Z)])

    J = {}
    lm = {n: to_xy(i) for n, i in (("lsh", 11), ("rsh", 12), ("lel", 13), ("rel", 14), ("lwr", 15), ("rwr", 16),
                                     ("lhip", 23), ("rhip", 24), ("lkn", 25), ("rkn", 26), ("lan", 27), ("ran", 28),
                                     ("lear", 7), ("rear", 8), ("lidx", 19), ("ridx", 20), ("lpk", 17), ("rpk", 18))}
    # canonical: +x = character's left. In the front view the character's left is on the image right = +right.
    J["leftUpperLeg"], J["rightUpperLeg"] = p3(lm["lhip"]), p3(lm["rhip"])
    J["leftLowerLeg"], J["rightLowerLeg"] = p3(lm["lkn"]), p3(lm["rkn"])
    J["leftFoot"], J["rightFoot"] = p3(lm["lan"]), p3(lm["ran"])
    J["leftUpperArm"], J["rightUpperArm"] = p3(lm["lsh"]), p3(lm["rsh"])
    J["leftLowerArm"], J["rightLowerArm"] = p3(lm["lel"], 0.02 * H), p3(lm["rel"], 0.02 * H)
    J["leftHand"], J["rightHand"] = p3(lm["lwr"], 0.02 * H), p3(lm["rwr"], 0.02 * H)
    for s in ("left", "right"):
        k = s[0]
        mid = (lm[f"{k}idx"] + lm[f"{k}pk"]) / 2
        J[f"{s}HandTip"] = p3(lm[f"{k}wr"] + 1.6 * (mid - lm[f"{k}wr"]), 0.02 * H)
    hips_xy = (lm["lhip"] + lm["rhip"]) / 2 + np.array([0, 0.02 * H])
    neck_base = (lm["lsh"] + lm["rsh"]) / 2
    ears = (lm["lear"] + lm["rear"]) / 2
    J["hips"] = p3(hips_xy, 0.04 * H)
    for name, t in (("spine", 0.25), ("chest", 0.55), ("upperChest", 0.8)):
        J[name] = p3(hips_xy + t * (neck_base - hips_xy), 0.04 * H)
    J["neck"] = p3(neck_base + 0.15 * (ears - neck_base), 0.03 * H)
    J["head"] = p3(neck_base + 0.55 * (ears - neck_base), 0.04 * H)
    J["headTop"] = np.array([J["head"][0], Y.max(), J["head"][2]])
    for s in ("left", "right"):
        J[f"{s}Shoulder"] = J["upperChest"] + 0.25 * (J[f"{s}UpperArm"] - J["upperChest"]) * np.array([1, 0, 1]) \
            + np.array([0, J[f"{s}UpperArm"][1] - J["upperChest"][1], 0])
    return J


def _near_mesh(S, pts, r):
    """For each point: is it on the model's front silhouette (mesh within r in x and y)? Joints sit
    inside the body, often far from the surface, so depth is ignored."""
    out = np.zeros(len(pts), bool)
    for i, p in enumerate(pts):
        out[i] = ((np.abs(S[:, 0] - p[0]) < r) & (np.abs(S[:, 1] - p[1]) < r)).any()
    return out


def _fit_chain(S, J, names, r, steps=40):
    """Pull a limb chain (joint names from the body outward) back inside the mesh when the photo did not
    show all of it: the pose detector still guesses knees/ankles/hands outside the model then.
    Joints keep their share of the limb along the part that exists. Returns the share that exists (0..1)."""
    pts = [J[n] for n in names]
    seg = [np.linalg.norm(b - a) for a, b in zip(pts, pts[1:])]
    total = sum(seg)
    if total < 1e-9:
        return 1.0
    cum = np.concatenate([[0.0], np.cumsum(seg)])

    def at(d):
        k = min(np.searchsorted(cum, d, side="right") - 1, len(seg) - 1)
        t = (d - cum[k]) / max(seg[k], 1e-12)
        return pts[k] + np.clip(t, 0, 1) * (pts[k + 1] - pts[k])

    ds = np.linspace(0, total, steps + 1)
    ok = _near_mesh(S, np.array([at(d) for d in ds]), r)
    # the root joint sits in the body; the first real gap (two samples in a row) ends the limb
    gap = np.flatnonzero(~ok[1:-1] & ~ok[2:])
    if not len(gap) and ok[-1]:
        return 1.0
    reach = ds[gap[0]] if len(gap) else ds[-2]  # last sample with mesh
    share = reach / total
    if share > 0.97:
        return 1.0
    for n, c in zip(names[1:], cum[1:]):
        J[n] = at(c * share)
    return share


def fit_to_mesh(S, J, H, log=lambda *_: None):
    """Make the joints agree with a model that does not have the whole body (legs cut off at the knees or
    the waist, a missing hand...). Returns the bones that should not move any of the mesh."""
    # Sizes from the shoulders: H is only the part of the body the model has.
    sw = np.linalg.norm(J["leftUpperArm"] - J["rightUpperArm"])
    r = 0.1 * sw
    loose = set()
    # A bust: the hips the detector guessed are below the model. Move the hips up into the body.
    if not _near_mesh(S, J["hips"][None], r)[0]:
        top = (J["leftUpperArm"] + J["rightUpperArm"]) / 2
        for t in np.linspace(0, 0.8, 41):
            p = J["hips"] + t * (top - J["hips"])
            if _near_mesh(S, p[None], r)[0]:
                break
        J["hips"] = p
        for name, t in (("spine", 0.25), ("chest", 0.55), ("upperChest", 0.8)):
            J[name] = p + t * (top - p)
        for s in ("left", "right"):
            J[f"{s}UpperLeg"] = J[f"{s}UpperLeg"] + (p - J[f"{s}UpperLeg"]) * np.array([0, 1, 1])
        log("허리 아래가 없는 모델: 엉덩이 뼈를 몸 안으로 옮겼습니다")
    for s, side in (("left", "왼"), ("right", "오른")):
        leg = [f"{s}UpperLeg", f"{s}LowerLeg", f"{s}Foot"]
        share = _fit_chain(S, J, leg, r)
        if share < 0.3:  # (almost) no leg: the leg bones stay, but the hips carry that part of the mesh
            loose |= set(leg) | {f"{s}Toes"}
            J[f"{s}LowerLeg"] = J[f"{s}UpperLeg"] - np.array([0, 0.2 * sw, 0])
            J[f"{s}Foot"] = J[f"{s}UpperLeg"] - np.array([0, 0.4 * sw, 0])
            log(f"{side}쪽 다리가 없습니다: 다리 뼈는 움직여도 몸을 끌지 않게 합니다")
        elif share < 1:
            loose |= {f"{s}Foot", f"{s}Toes"}
            log(f"{side}쪽 다리가 잘려 있습니다 ({share:.0%}): 무릎·발목을 모델 안으로 맞췄습니다")
        arm = [f"{s}UpperArm", f"{s}LowerArm", f"{s}Hand", f"{s}HandTip"]
        share = _fit_chain(S, J, arm, r)
        if share < 1:
            if share < 0.35:
                loose |= {f"{s}LowerArm", f"{s}Hand"}
            elif share < 0.75:
                loose |= {f"{s}Hand"}
            log(f"{side}쪽 팔이 잘려 있습니다 ({share:.0%}): 팔 관절을 모델 안으로 맞췄습니다")
    return loose


def _add_toes(V, J, H, loose=()):
    floor = V[:, 1].min()
    for s in ("left", "right"):
        if f"{s}Foot" in loose:  # no foot in the model: small toes in front of the ankle, moving nothing
            a = J[f"{s}Foot"]
            J[f"{s}Toes"] = a + np.array([0, -0.02 * H, 0.04 * H])
            J[f"{s}ToeTip"] = a + np.array([0, -0.02 * H, 0.07 * H])
            continue
        ankle = J[f"{s}Foot"]
        ankle[1] = max(ankle[1], floor + 0.035 * H)
        foot = V[(V[:, 1] < floor + 0.05 * H) & (np.linalg.norm(V[:, [0, 2]] - ankle[[0, 2]], axis=1) < 0.1 * H)]
        toe_z = np.percentile(foot[:, 2], 95) if len(foot) else ankle[2] + 0.08 * H
        toe_z = max(toe_z, ankle[2] + 0.03 * H)
        J[f"{s}Toes"] = np.array([ankle[0], floor + 0.015 * H, ankle[2] + 0.6 * (toe_z - ankle[2])])
        J[f"{s}ToeTip"] = np.array([ankle[0], floor + 0.01 * H, toe_z])


def _bone_segments(J):
    segs = {}
    children = {}
    for name, parent in BONE_ORDER:
        if parent:
            children.setdefault(parent, []).append(name)
    for name, _ in BONE_ORDER:
        ends = [J[c] for c in children.get(name, []) if not c.endswith("Shoulder") and not c.endswith("UpperLeg")]
        if name == "upperChest":
            ends = [J["neck"]]
        if name == "hips":
            ends = [J["spine"]]
        if name in LEAF_TIPS:
            ends = [J[LEAF_TIPS[name]]]
        segs[name] = (J[name], np.mean(ends, axis=0) if ends else J[name])
    return segs


def _seg_dist(P, a, b):
    ab = b - a
    t = np.clip(((P - a) @ ab) / max(ab @ ab, 1e-12), 0, 1)
    return np.linalg.norm(P - (a + np.outer(t, ab)), axis=1)


def skin_weights(V, F, J, iters=200, log=lambda *_: None, loose=()):
    """Heat-diffusion style weights (Pinocchio-like) on a welded vertex graph. Returns (W (V,4), I (V,4)).
    `loose` bones get no weight (limbs the model does not have)."""
    names = [n for n, _ in BONE_ORDER]
    segs = _bone_segments(J)
    D = np.stack([_seg_dist(V, *segs[n]) for n in names], axis=1)  # (V,B)
    # limb thickness: median distance of the vertices closest to each bone
    raw_near = D.argmin(1)
    # Body size for the limb radii: the model height, or (for a model without legs) what the shoulders
    # say a whole body would measure.
    sw = np.linalg.norm(J["leftUpperArm"] - J["rightUpperArm"])
    H = max(np.ptp(V[:, 1]), 5.2 * sw)
    # Robust thickness: a low percentile of the closest vertices (props hanging near a limb would inflate a
    # median), clamped to human-like limb radii.
    radius = np.array([np.percentile(D[raw_near == b, b], 30) if (raw_near == b).sum() > 10 else 0.03 * H
                       for b in range(len(names))])
    radius = np.clip(radius, 0.015 * H, 0.08 * H)
    # Arms are thin. Arms hanging against a loose shirt would otherwise measure the shirt and take it
    # along when they are lifted into the T-pose.
    for k, nm in enumerate(names):
        if any(t in nm for t in ("UpperArm", "LowerArm", "Hand")):
            radius[k] = min(radius[k], 0.2 * sw)
    Dn = D / radius
    # Arms may only claim vertices close to their own axis or outside the shoulders. Loose clothing at the
    # armpit, long hair and props hanging next to the arms belong to the torso/head instead.
    center_x = J["upperChest"][0]
    shoulder_half = (abs(J["leftUpperArm"][0] - center_x) + abs(J["rightUpperArm"][0] - center_x)) / 2
    outside = np.abs(V[:, 0] - center_x) > shoulder_half
    for k, nm in enumerate(names):
        if any(t in nm for t in ("UpperArm", "LowerArm", "Hand")):
            ok = (D[:, k] < 1.6 * radius[k]) | outside
            Dn[~ok, k] *= 4.0
    near = Dn.argmin(1)
    dmin = D[np.arange(len(V)), near]  # (anchor strength: as close as the bone it would have had)
    if loose:  # the mesh a missing limb would have taken stays with the nearest bone that is there
        parent = dict(BONE_ORDER)
        keep = []
        for nm in names:
            while nm in loose:
                nm = parent[nm]
            keep.append(names.index(nm))
        near = np.array(keep)[near]
    # welded graph (UV seams split vertices; merge by position so heat crosses seams)
    key = np.round(V / (np.ptp(V, axis=0).max() * 1e-5)).astype(np.int64)
    _, weld, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inv = inv.ravel()
    n = len(weld)
    tri = inv[F.reshape(-1, 3)]
    e = np.concatenate([tri[:, [0, 1]], tri[:, [1, 2]], tri[:, [2, 0]]])
    e = e[e[:, 0] != e[:, 1]]
    e = np.unique(np.sort(e, axis=1), axis=0)
    deg = np.bincount(e.ravel(), minlength=n).astype(np.float64)
    # anchor strength like Pinocchio: c / d^2 toward the nearest bone
    wv_near = near[weld]
    h = 1.0 / np.maximum(dmin[weld] / np.median(radius), 0.05) ** 2
    h = np.clip(h, 0.5, 50.0)  # strong anchors: diffusion only blends across joints
    Wt = np.zeros((n, len(names)))
    Wt[np.arange(n), wv_near] = 1.0
    target = Wt * h[:, None]
    for it in range(iters):
        acc = np.zeros_like(Wt)
        np.add.at(acc, e[:, 0], Wt[e[:, 1]])
        np.add.at(acc, e[:, 1], Wt[e[:, 0]])
        Wt = (acc + target) / (deg + h)[:, None]
        if it % 50 == 0:
            log(f"skin {it}/{iters}")
    Wfull = Wt[inv]
    idx = np.argsort(-Wfull, axis=1)[:, :4]
    w = np.take_along_axis(Wfull, idx, axis=1)
    w[w < 0.02] = 0
    w = w / np.maximum(w.sum(1, keepdims=True), 1e-9)
    return w, idx


def autorig(model: Model, log=lambda *_: None):
    """Unrigged (or badly rigged) humanoid mesh -> Model with a VRM skeleton and skin weights,
    already turned to face +Z. Returns (model, bones: VRM name -> joint index, joint positions,
    (R, shift) with canonical = V @ R.T - shift)."""
    from .render import densify, vertex_colors

    V = np.concatenate([p.positions for p in model.prims])
    H = np.ptp(V[:, 1])
    found = None
    try:
        log("여러 방향에서 보며 사람 자세 찾는 중")
        P, C = densify(model, vertex_colors(model))
        detect = _detector(log)
        try:
            found = best_view(P, C, detect, log)
        finally:
            detect.close()
    except Exception as e:  # mediapipe missing or failed
        log(f"자세 인식을 건너뜀 ({type(e).__name__}: {e})")
    if found is not None:
        yaw, L, view, _ = found
        J = joints_from_landmarks(P, L, view, H)
        right, fwd = view[2], view[3]
        R = np.stack([right, [0.0, 1.0, 0.0], fwd])  # front view's right = character's left
        J = {k: v for k, v in J.items()}  # already in (right, up, toward-camera) coordinates
        # The views are 15° apart: turn the last bit so the shoulder and hip lines (3D, with depth from
        # the mesh) run straight left-right.
        lat = sum(J[f"left{b}"] - J[f"right{b}"] for b in ("UpperArm", "UpperLeg"))
        ang = np.arctan2(lat[2], lat[0])
        if abs(ang) < np.radians(20):
            c, s_ = np.cos(ang), np.sin(ang)
            Ry = np.array([[c, 0, s_], [0, 1, 0], [-s_, 0, c]])  # maps lat onto +x
            J = {k: Ry @ v for k, v in J.items()}
            R = Ry @ R
            log(f"방향 보정 {np.degrees(ang):+.1f}°")
        Vc = V @ R.T
        shift = np.zeros(3)
        Sc = P[np.random.default_rng(0).choice(len(P), min(len(P), 60000), replace=False)] @ R.T
        loose = fit_to_mesh(Sc, J, H, log)
        _add_toes(Vc, J, H, loose)
    else:
        log("자세 인식 실패: 몸 모양으로 뼈대를 추정합니다")
        offs0 = np.cumsum([0] + [len(p.positions) for p in model.prims])
        F0 = np.concatenate([p.indices.reshape(-1, 3) + offs0[i] for i, p in enumerate(model.prims)])
        S = sample_surface(V, F0)
        forward, left = find_axes(S)
        R = np.stack([left, [0.0, 1.0, 0.0], forward])  # rows: canonical axes
        Sc = S @ R.T
        legs = Sc[Sc[:, 1] < Sc[:, 1].min() + 0.3 * np.ptp(Sc[:, 1])]
        shift = np.array([np.median(legs[:, 0]), 0.0, np.median(legs[:, 2])])
        Vc = V @ R.T - shift
        J = fit_skeleton(Sc - shift)
        loose = set()
    names = [n for n, _ in BONE_ORDER]
    parent = {n: p for n, p in BONE_ORDER}
    # faces with global vertex indices
    offs = np.cumsum([0] + [len(p.positions) for p in model.prims])
    F = np.concatenate([p.indices.reshape(-1, 3) + offs[i] for i, p in enumerate(model.prims)])
    log("스키닝 웨이트 계산 중")
    W, I = skin_weights(Vc, F, J, log=log, loose=loose)
    world = np.stack([np.eye(4) for _ in names])
    for k, nm in enumerate(names):
        world[k][:3, 3] = J[nm]
    prims = []
    for i, p in enumerate(model.prims):
        sl = slice(offs[i], offs[i + 1])
        nrm = p.normals @ R.T if p.normals is not None else None
        prims.append(Prim(Vc[sl], nrm, p.uvs, I[sl], W[sl], p.indices, p.material))
    m = Model(names, [names.index(parent[n]) if parent[n] else -1 for n in names], world, prims, model.materials, model.images)
    return m, {n: k for k, n in enumerate(names)}, J, (R, shift)
