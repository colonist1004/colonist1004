"""Motion post-processing: gap filling, smoothing, grounding, root motion and looping."""
from __future__ import annotations

import numpy as np

from .rot import matrix_power, matrix_to_quat, normalize, quat_continuous, quat_to_matrix, rotation_between
from .skeleton import REST_HIPS_Y, REST_POS, forward_kinematics, local_offset

FOOT_POINTS = ["leftFoot", "rightFoot", "leftToes", "rightToes"]


def _clearance(pos):
    """Per frame: how far the lowest foot point is above where it rests in the T-pose
    (ankle and toes each compared with their own rest height, so neither sinks)."""
    return np.min(np.stack([pos[b][:, 1] - REST_POS[b][1] for b in FOOT_POINTS]), axis=0)


# ------------------------------------------------------------------ signals

def gaussian_smooth(x: np.ndarray, sigma: float) -> np.ndarray:
    """Zero-phase Gaussian smoothing along axis 0 (edges reflected)."""
    if sigma <= 0 or len(x) < 3:
        return np.asarray(x, dtype=np.float64)
    r = int(np.ceil(3 * sigma))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    x = np.asarray(x, dtype=np.float64)
    pad = min(r, len(x) - 1)
    xp = np.concatenate([x[pad:0:-1], x, x[-2 : -pad - 2 : -1]], axis=0)
    if pad < r:  # very short clip: pad with edge values
        extra = r - pad
        xp = np.concatenate([np.repeat(xp[:1], extra, 0), xp, np.repeat(xp[-1:], extra, 0)], axis=0)
    out = np.empty_like(x)
    flat = xp.reshape(len(xp), -1)
    res = np.stack([np.convolve(flat[:, i], k, mode="valid") for i in range(flat.shape[1])], axis=1)
    out[:] = res.reshape(x.shape)
    return out


def fill_gaps(x: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """Linear interpolation over frames where valid is False (edges hold the nearest value)."""
    x = np.array(x, dtype=np.float64)
    idx = np.flatnonzero(valid)
    if len(idx) == 0:
        raise ValueError("no valid frames")
    if len(idx) == len(x):
        return x
    t = np.arange(len(x))
    flat = x.reshape(len(x), -1)
    for i in range(flat.shape[1]):
        flat[:, i] = np.interp(t, idx, flat[idx, i])
    return flat.reshape(x.shape)


def smooth_rotations_adaptive(local: dict, fps: float, strength: float, fast: float = 3.0) -> dict:
    """Extra smoothing that follows the speed (for "매우 부드럽게").
    Slow or still parts, where tracking jitter shows the most, are smoothed hard (a window of up to
    ~0.7 s at strength 2); fast moves (beat hits, arm swings) blend back to the motion as it is, so
    they are not washed out. strength 0..2; `fast` = joint speed (rad/s) that counts as fully fast."""
    if strength <= 0 or len(next(iter(local.values()))) < 3:
        return local
    strength = min(strength, 2.0)
    heavy_sigma = 0.35 * strength * fps
    out = {}
    for b, m in local.items():
        q = quat_continuous(matrix_to_quat(m))
        # angular speed of the motion itself, measured on a lightly smoothed copy so that frame-to-frame
        # jitter does not count as movement; the speed is smoothed too so the weights do not flicker
        qs = gaussian_smooth(q, 0.1 * fps)
        dq = np.linalg.norm(np.diff(qs, axis=0), axis=1)
        speed = 2 * np.concatenate([dq[:1], dq]) * fps
        speed = gaussian_smooth(speed, 0.08 * fps)
        w = np.clip(speed / fast, 0, 1)[:, None]
        w = w * w * (3 - 2 * w)
        # the heavy average only uses the slow frames, so a fast move does not smear into the still
        # parts around it
        slow = 1 - w
        num = gaussian_smooth(q * slow, heavy_sigma)
        den = gaussian_smooth(slow, heavy_sigma)
        heavy = np.where(den > 1e-3, num / np.maximum(den, 1e-3), q)
        out[b] = quat_to_matrix(normalize((1 - w) * heavy + w * q))
    return out


def smooth_rotations(local: dict, sigma: float) -> dict:
    if sigma <= 0:
        return local
    out = {}
    for b, m in local.items():
        q = gaussian_smooth(quat_continuous(matrix_to_quat(m)), sigma)
        out[b] = quat_to_matrix(normalize(q))
    return out


def legs_seen(points: dict, valid: np.ndarray, fps: float = 30.0, min_gap: float = 0.3) -> dict:
    """points: side -> (F, k) bool (knee/ankle confidently detected inside the picture).
    Returns side -> (F,) bool; frames without a person take the nearest frame's answer, and dips
    shorter than `min_gap` seconds (fast moves blur a foot for a moment) count as seen."""
    out = {}
    for side, ok in points.items():
        seen = np.all(ok, axis=1).astype(np.float64)
        seen = fill_gaps(seen, valid) > 0.5 if valid.any() else seen > 0.5
        for a, b in _intervals(~seen):
            if b - a < min_gap * fps:
                seen[a:b] = True
        out[side] = seen
    return out


def stand_unseen_legs(local: dict, seen: dict, fps: float, fade: float = 0.25) -> tuple[dict, dict]:
    """While a leg is out of the picture (or hidden), the detector only guesses it, and the guess flails.
    Ease that leg into standing straight under the hips instead (facing where the hips face), and back
    when it is seen again. Returns (local, share of frames where each leg was replaced)."""
    out = dict(local)
    hips = local["hips"]
    # standing: thigh straight down in world space, turned with the hips around the vertical only
    f = hips[:, :, 2] * np.array([1.0, 0.0, 1.0])
    f = normalize(np.where(np.linalg.norm(f, axis=1, keepdims=True) < 1e-6, [0.0, 0.0, 1.0], f))
    yaw = np.stack([np.cross([0.0, 1.0, 0.0], f), np.broadcast_to([0.0, 1.0, 0.0], f.shape), f], axis=-1)
    stand_upper = np.swapaxes(hips, -1, -2) @ yaw
    eye = np.broadcast_to(np.eye(3), hips.shape)
    replaced = {}
    for side, ok in seen.items():
        w = gaussian_smooth((~ok).astype(np.float64), fade * fps / 2)
        w = np.clip(np.where(~ok, 1.0, 2 * w), 0, 1)  # fully standing whenever unseen, easing in around it
        w[w < 0.02] = 0
        replaced[side] = float((~ok).mean())
        if not (~ok).any():
            continue
        for bone, target in ((f"{side}UpperLeg", stand_upper), (f"{side}LowerLeg", eye), (f"{side}Foot", eye)):
            a = local[bone]
            rel = np.swapaxes(a, -1, -2) @ target
            out[bone] = a @ matrix_power(rel, w)
    return out, replaced


# --------------------------------------------------------------- alignment

def align_gravity(kp: dict, min_deg: float = 12.0) -> dict:
    """Tilt keypoints so that the clip-average torso direction points straight up, when the tilt is
    large enough to come from a tilted camera (dancers lean a little on purpose; that is kept).
    Keeps the camera-relative facing."""
    hip = (kp["left_hip"] + kp["right_hip"]) / 2
    sh = (kp["left_shoulder"] + kp["right_shoulder"]) / 2
    up = normalize(normalize(sh - hip).mean(axis=0))
    if np.degrees(np.arccos(np.clip(up[1], -1, 1))) < min_deg:
        return kp
    R = rotation_between(up, np.array([0.0, 1.0, 0.0]))
    return {k: v @ R.T for k, v in kp.items()}


# ----------------------------------------------------------------- grounding

def foot_heights(local: dict, hips_y: np.ndarray):
    """World foot points for hips at (0, hips_y, 0)."""
    hips = np.zeros((len(hips_y), 3))
    hips[:, 1] = hips_y
    pos, _ = forward_kinematics(local, hips)
    return pos


def ground_per_frame(local: dict, fps: float) -> np.ndarray:
    """Hips height that keeps the lowest foot point on the floor in every frame (no jumps)."""
    n = len(local["hips"])
    pos = foot_heights(local, np.full(n, REST_HIPS_Y))
    return gaussian_smooth(REST_HIPS_Y - _clearance(pos), 0.5 * fps / 30)


def ground_trajectory(local: dict, root_y: np.ndarray) -> np.ndarray:
    """Keeps a measured vertical trajectory (jumps survive); shifts it so the feet stand on the floor."""
    pos = foot_heights(local, root_y - root_y.mean() + REST_HIPS_Y)
    floor = np.percentile(_clearance(pos), 10)  # robust "standing" level
    return root_y - root_y.mean() + REST_HIPS_Y - floor


# ----------------------------------------------------------------- root motion

def planted_root_xz(local: dict, hips_y: np.ndarray, fps: float, max_range: float) -> np.ndarray:
    """Horizontal root motion that keeps the supporting foot from sliding.
    Long-term drift is removed and the result is clamped to ±max_range meters (stays near its spot)."""
    n = len(hips_y)
    pos = foot_heights(local, hips_y)
    feet = {s: pos[f"{s}Foot"] for s in ("left", "right")}
    floor = np.minimum(feet["left"][:, 1], feet["right"][:, 1])
    vel = np.zeros((n, 2))
    count = np.zeros(n)
    for p in feet.values():
        v = np.gradient(p[:, [0, 2]], axis=0) * fps  # foot velocity relative to the hips
        planted = ((p[:, 1] - floor) < 0.03) & (np.linalg.norm(v, axis=1) < 1.0)
        vel -= v * planted[:, None]  # the body moves opposite to the planted foot
        count += planted
    vel /= np.maximum(count, 1)[:, None]  # no foot planted (jump) -> no horizontal push
    xz = np.cumsum(vel, axis=0) / fps
    xz -= gaussian_smooth(xz, 1.5 * fps)  # remove slow drift: dance around the spot
    xz = max_range * np.tanh(xz / max(max_range, 1e-6))  # soft clamp
    return xz


def compose_root(xz: np.ndarray, y: np.ndarray) -> np.ndarray:
    return np.stack([xz[:, 0], y, xz[:, 1]], axis=1)


# ------------------------------------------------------------------ foot lock

def _intervals(mask):
    """[start, end) runs of True."""
    m = np.concatenate([[False], mask, [False]])
    d = np.diff(m.astype(int))
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))


def _two_bone(H, K, T, l1, l2):
    """New knee position for hip H, current knee K (pole), ankle target T."""
    ht = T - H
    d = np.clip(np.linalg.norm(ht), abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4)
    u = ht / max(np.linalg.norm(ht), 1e-9)
    v = (K - H) - np.dot(K - H, u) * u
    nv = np.linalg.norm(v)
    v = v / nv if nv > 1e-6 else np.array([0.0, 0.0, 1.0])
    a = np.arccos(np.clip((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1))
    return H + l1 * (np.cos(a) * u + np.sin(a) * v), H + d * u


def foot_lock(local: dict, root: np.ndarray, fps: float, height_tol=0.03, speed_tol=0.4, blend=5):
    """Detect planted feet (low and slow), pin each to one spot for the whole contact,
    and re-solve hip->knee->ankle with two-bone IK. The foot's world orientation is kept."""
    local = {b: m.copy() for b, m in local.items()}
    pos, rot = forward_kinematics(local, root)
    n = len(root)
    min_len = max(2, int(0.1 * fps))
    for side in ("left", "right"):
        ul, ll, ft = f"{side}UpperLeg", f"{side}LowerLeg", f"{side}Foot"
        l1 = np.linalg.norm(local_offset(ll))
        l2 = np.linalg.norm(local_offset(ft))
        P = pos[ft]
        speed = np.linalg.norm(np.gradient(P[:, [0, 2]], axis=0), axis=1) * fps
        low = (P[:, 1] - REST_POS[ft][1]) < height_tol
        contact = low & (speed < speed_tol)
        for a, b in _intervals(~contact):  # bridge short lifts so one contact keeps one spot
            if a > 0 and b < n and b - a <= int(0.15 * fps):
                contact[a:b] = True
        target = P.copy()
        weight = np.zeros(n)
        for a, b in _intervals(contact):
            if b - a < min_len:
                continue
            spot = P[a].copy()  # pin where the foot touched down: no jump on entry
            spot[1] = max(spot[1], REST_POS[ft][1])
            target[a:b] = spot
            weight[a:b] = 1
            for k in range(1, blend + 1):  # ease in/out around the contact
                w = 1 - k / (blend + 1)
                if a - k >= 0 and weight[a - k] < w:
                    target[a - k] = spot
                    weight[a - k] = w
                if b - 1 + k < n and weight[b - 1 + k] < w:
                    target[b - 1 + k] = spot
                    weight[b - 1 + k] = w
        for f in np.flatnonzero(weight > 0):
            H, K, A = pos[ul][f], pos[ll][f], P[f]
            T = A + weight[f] * (target[f] - A)
            K2, A2 = _two_bone(H, K, T, l1, l2)
            W_ul = rot[ul][f]
            R1 = rotation_between(K - H, K2 - H)
            W_ul2 = R1 @ W_ul
            W_ll_tmp = R1 @ rot[ll][f]
            cur_lower = W_ll_tmp @ (local_offset(ft) / l2)
            R2 = rotation_between(cur_lower, (A2 - K2) / np.linalg.norm(A2 - K2))
            W_ll2 = R2 @ W_ll_tmp
            W_hips = rot["hips"][f]
            local[ul][f] = W_hips.T @ W_ul2
            local[ll][f] = W_ul2.T @ W_ll2
            local[ft][f] = W_ll2.T @ rot[ft][f]
    return local


# ------------------------------------------------------------------- looping

def _pose_distance(local: dict, a: int, b_idx: np.ndarray) -> np.ndarray:
    d = np.zeros(len(b_idx))
    for m in local.values():
        rel = np.swapaxes(m[a][None], -1, -2) @ m[b_idx]
        tr = np.clip((np.trace(rel, axis1=-2, axis2=-1) - 1) / 2, -1, 1)
        d += np.arccos(tr)
    return d


def make_loop(local: dict, root: np.ndarray, fps: float, blend_seconds: float = 0.5):
    """Cut the clip where the pose best matches the first frame (searching the last half), then
    fade the remaining difference out over `blend_seconds` so the last frame equals the first."""
    n = len(root)
    cand = np.arange(max(int(n * 0.5), 2), n)
    if len(cand) == 0:
        return local, root, n
    d = _pose_distance(local, 0, cand)
    # also compare velocities so the motion flows through the seam
    d += 0.5 * _pose_distance(local, 1, np.minimum(cand + 1, n - 1))
    e = int(cand[np.argmin(d)])
    local = {b: m[: e + 1].copy() for b, m in local.items()}
    root = root[: e + 1].copy()
    k = min(int(blend_seconds * fps), e)
    w = (1 - np.cos(np.linspace(0, np.pi, k + 1))) / 2  # 0 -> 1 ease
    idx = np.arange(e - k, e + 1)
    for b, m in local.items():
        delta = np.swapaxes(m[e], -1, -2) @ m[0]  # what the last frame is missing
        m[idx] = m[idx] @ matrix_power(np.broadcast_to(delta, (k + 1, 3, 3)), w)
    root[idx] += w[:, None] * (root[0] - root[e])
    return local, root, e + 1
