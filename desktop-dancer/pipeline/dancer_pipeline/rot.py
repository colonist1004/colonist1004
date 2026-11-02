"""Rotation helpers. Matrices are (..., 3, 3); quaternions are (..., 4) as [x, y, z, w] (glTF order)."""
from __future__ import annotations

import numpy as np


def normalize(v, eps=1e-9):
    v = np.asarray(v, dtype=np.float64)
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, eps)


def frame(primary, secondary):
    """Orthonormal frame with columns [e1, e2, e3]: e1 along `primary`, e2 = `secondary` made orthogonal."""
    e1 = normalize(primary)
    s = np.asarray(secondary, dtype=np.float64)
    e2 = normalize(s - np.sum(s * e1, axis=-1, keepdims=True) * e1)
    e3 = np.cross(e1, e2)
    return np.stack([e1, e2, e3], axis=-1)


def axis_angle_to_matrix(aa):
    aa = np.asarray(aa, dtype=np.float64)
    theta = np.linalg.norm(aa, axis=-1, keepdims=True)
    k = aa / np.maximum(theta, 1e-12)
    kx, ky, kz = k[..., 0], k[..., 1], k[..., 2]
    zero = np.zeros_like(kx)
    K = np.stack([zero, -kz, ky, kz, zero, -kx, -ky, kx, zero], axis=-1).reshape(aa.shape[:-1] + (3, 3))
    t = theta[..., None]
    eye = np.broadcast_to(np.eye(3), K.shape)
    return eye + np.sin(t) * K + (1 - np.cos(t)) * (K @ K)


def matrix_to_quat(m):
    m = np.asarray(m, dtype=np.float64)
    shape = m.shape[:-2]
    m = m.reshape(-1, 3, 3)
    q = np.empty((m.shape[0], 4))
    for i, r in enumerate(m):
        tr = r[0, 0] + r[1, 1] + r[2, 2]
        if tr > 0:
            s = np.sqrt(tr + 1.0) * 2
            q[i] = [(r[2, 1] - r[1, 2]) / s, (r[0, 2] - r[2, 0]) / s, (r[1, 0] - r[0, 1]) / s, 0.25 * s]
        elif r[0, 0] > r[1, 1] and r[0, 0] > r[2, 2]:
            s = np.sqrt(1.0 + r[0, 0] - r[1, 1] - r[2, 2]) * 2
            q[i] = [0.25 * s, (r[0, 1] + r[1, 0]) / s, (r[0, 2] + r[2, 0]) / s, (r[2, 1] - r[1, 2]) / s]
        elif r[1, 1] > r[2, 2]:
            s = np.sqrt(1.0 + r[1, 1] - r[0, 0] - r[2, 2]) * 2
            q[i] = [(r[0, 1] + r[1, 0]) / s, 0.25 * s, (r[1, 2] + r[2, 1]) / s, (r[0, 2] - r[2, 0]) / s]
        else:
            s = np.sqrt(1.0 + r[2, 2] - r[0, 0] - r[1, 1]) * 2
            q[i] = [(r[0, 2] + r[2, 0]) / s, (r[1, 2] + r[2, 1]) / s, 0.25 * s, (r[1, 0] - r[0, 1]) / s]
    return normalize(q).reshape(shape + (4,))


def quat_to_matrix(q):
    q = normalize(q)
    x, y, z, w = q[..., 0], q[..., 1], q[..., 2], q[..., 3]
    m = np.stack(
        [
            1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
            2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
            2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
        ],
        axis=-1,
    )
    return m.reshape(q.shape[:-1] + (3, 3))


def quat_continuous(q):
    """Flip signs along time (axis 0) so consecutive quaternions stay in the same hemisphere."""
    q = np.array(q, dtype=np.float64)
    for i in range(1, len(q)):
        if np.dot(q[i], q[i - 1]) < 0:
            q[i] = -q[i]
    return q


def slerp_matrix(a, b, t):
    """Rotation a -> b by fraction t (per-frame arrays allowed)."""
    rel = np.swapaxes(a, -1, -2) @ b
    return a @ matrix_power(rel, t)


def matrix_power(r, t):
    """r^t for rotation matrices via axis-angle."""
    q = quat_continuous_single(matrix_to_quat(r))
    w = np.clip(q[..., 3], -1, 1)
    angle = 2 * np.arccos(w)
    s = np.sqrt(np.maximum(1 - w * w, 1e-12))
    axis = q[..., :3] / s[..., None]
    t = np.asarray(t, dtype=np.float64)
    return axis_angle_to_matrix(axis * (angle * t)[..., None])


def quat_continuous_single(q):
    """Make w >= 0 so the rotation angle is in [0, pi]."""
    q = np.array(q)
    neg = q[..., 3] < 0
    q[neg] = -q[neg]
    return q


def yaw_matrix(angle):
    c, s = np.cos(angle), np.sin(angle)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rotation_between(a, b):
    """Smallest rotation taking unit vector a to unit vector b."""
    a, b = normalize(a), normalize(b)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if c < -0.999999:
        axis = normalize(np.cross(a, [1, 0, 0]) if abs(a[0]) < 0.9 else np.cross(a, [0, 1, 0]))
        return axis_angle_to_matrix(axis * np.pi)
    K = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + K + K @ K / (1 + c)
