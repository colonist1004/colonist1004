"""Tiny orthographic software renderer (numpy) for looking at a character mesh: used to run a 2D pose
detector on views of the model. Point-splat with a depth buffer; colors from the base color texture."""
from __future__ import annotations

import numpy as np

from .gltf_read import Model


def vertex_colors(model: Model):
    """Per-vertex RGB (0..1) from each primitive's base color texture/factor."""
    cols = []
    cache = {}
    for p in model.prims:
        n = len(p.positions)
        col = np.full((n, 3), 0.8)
        mat = model.materials[p.material] if p.material is not None and p.material < len(model.materials) else None
        if mat is not None:
            col[:] = np.array(mat["baseColorFactor"][:3])
            ti = mat.get("baseColorTexture")
            if ti is not None and p.uvs is not None and ti < len(model.images) and model.images[ti][0]:
                if ti not in cache:
                    import cv2

                    img = cv2.imdecode(np.frombuffer(model.images[ti][0], np.uint8), cv2.IMREAD_COLOR)
                    cache[ti] = None if img is None else img[:, :, ::-1].astype(np.float64) / 255
                tex = cache[ti]
                if tex is not None:
                    h, w = tex.shape[:2]
                    u = np.mod(p.uvs[:, 0], 1.0) * (w - 1)
                    v = np.mod(p.uvs[:, 1], 1.0) * (h - 1)
                    col = col * tex[v.astype(int), u.astype(int)]
        cols.append(col)
    return np.concatenate(cols)


def densify(model: Model, colors):
    """Vertices + triangle centroids + edge midpoints (fills gaps between splats). Returns (P, C, N or None)."""
    P, C = [], []
    offs = 0
    allpos = np.concatenate([p.positions for p in model.prims])
    for p in model.prims:
        t = p.indices.reshape(-1, 3)
        a, b, c = (p.positions[t[:, k]] for k in range(3))
        ca, cb, cc = (colors[offs + t[:, k]] for k in range(3))
        P += [p.positions, (a + b + c) / 3, (a + b) / 2, (b + c) / 2, (c + a) / 2]
        C += [colors[offs : offs + len(p.positions)], (ca + cb + cc) / 3, (ca + cb) / 2, (cb + cc) / 2, (cc + ca) / 2]
        offs += len(p.positions)
    del allpos
    return np.concatenate(P), np.concatenate(C)


def render(P, C, yaw, size=512, light=True):
    """Orthographic view from direction `yaw` (radians, 0 = looking at the +Z face from +Z).
    Returns (rgb uint8 image, pixel->world mapping function, depth image)."""
    c, s = np.cos(yaw), np.sin(yaw)
    # camera axes: right, up, toward-camera
    right = np.array([c, 0, -s])
    fwd = np.array([s, 0, c])
    x = P @ right
    y = P[:, 1]
    z = P @ fwd
    lo = np.array([x.min(), y.min()])
    span = max(x.max() - x.min(), y.max() - y.min()) * 1.1
    pad = (np.array([span, span]) - np.array([x.max() - x.min(), y.max() - y.min()])) / 2
    origin = lo - pad
    px = ((x - origin[0]) / span * (size - 1)).astype(int)
    py = ((1 - (y - origin[1]) / span) * (size - 1)).astype(int)
    img = np.full((size, size, 3), 0.55)
    depth = np.full((size, size), -np.inf)
    shade = np.ones(len(P))
    if light:
        # fake lighting from depth so overlapping parts stay distinguishable
        zn = (z - z.min()) / max(np.ptp(z), 1e-9)
        shade = 0.65 + 0.35 * zn
    col = C * shade[:, None]
    r = max(1, size // 256)
    offsets = [(dx, dy) for dy in range(-r, r + 1) for dx in range(-r, r + 1)]
    # pass 1: depth buffer (nearest = largest z); pass 2: colors of the points that pass the depth test
    for dx, dy in offsets:
        qx = np.clip(px + dx, 0, size - 1)
        qy = np.clip(py + dy, 0, size - 1)
        np.maximum.at(depth, (qy, qx), z)
    eps = np.ptp(z) * 0.004
    for dx, dy in offsets:
        qx = np.clip(px + dx, 0, size - 1)
        qy = np.clip(py + dy, 0, size - 1)
        ok = z >= depth[qy, qx] - eps
        img[qy[ok], qx[ok]] = col[ok]

    def to_world(u, v):
        """pixel (u, v) -> (point on the camera plane, right axis, toward-camera axis)."""
        wx = origin[0] + u / (size - 1) * span
        wy = origin[1] + (1 - v / (size - 1)) * span
        return right * wx + np.array([0, wy, 0]), right, fwd

    return (np.clip(img, 0, 1) * 255).astype(np.uint8), to_world, depth, (origin, span, right, fwd)
