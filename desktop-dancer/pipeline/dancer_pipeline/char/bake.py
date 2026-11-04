"""From a raw generated mesh to a clean, textured, upright GLB (no GPU needed).

- cleanup: drop floaters, decimate to a size the auto-rig and the app handle comfortably
- orient: turn the mesh so it stands up (+Y) and faces the viewer (+Z) the way the picture shows it
  (silhouette match against the picture's mask; toes decide front vs back)
- unwrap + bake: UV atlas (xatlas) and a texture, either from a color function (a model that predicts
  colors, e.g. TripoSR) or by projecting the picture onto the model (front from the picture, back from
  the silhouette outline colors of the same height, so the back of the head gets hair, not a face)
"""
from __future__ import annotations

import io
import itertools

import numpy as np


# ------------------------------------------------------------------ cleanup

def cleanup(V, F, max_faces=50000, min_part=0.02):
    """Largest pieces only (floaters out), then quadric decimation to max_faces."""
    import trimesh
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    m = trimesh.Trimesh(V, F, process=True)  # merges duplicate vertices so pieces are really connected
    V, F = np.asarray(m.vertices, np.float64), np.asarray(m.faces, np.int64)
    # pieces = connected components of the vertex graph (scipy; trimesh's split would need networkx)
    e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    n = len(V)
    _, label = connected_components(coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n)), directed=False)
    face_label = label[F[:, 0]]
    counts = np.bincount(face_label)
    keep = counts >= min_part * len(F)
    if not keep.any():
        keep[counts.argmax()] = True
    F = F[keep[face_label]]
    used = np.unique(F)
    remap = np.full(n, -1, np.int64)
    remap[used] = np.arange(len(used))
    V, F = V[used], remap[F]
    if len(F) > max_faces:
        import fast_simplification

        V, F = fast_simplification.simplify(V.astype(np.float32), F.astype(np.int32), 1 - max_faces / len(F))
        V, F = np.asarray(V, np.float64), np.asarray(F, np.int64)
    return V, F


# ------------------------------------------------------------------ orientation

def _rotations():
    """The 24 proper rotations that map axes onto axes."""
    out = []
    for perm in itertools.permutations(range(3)):
        for signs in itertools.product((1, -1), repeat=3):
            R = np.zeros((3, 3))
            for i, (p, s) in enumerate(zip(perm, signs)):
                R[i, p] = s
            if np.linalg.det(R) > 0:
                out.append(R)
    return out


def _silhouette(P, F, size, fit):
    """Mask of the projected triangles (x right, y up) placed by fit = (scale, u0, v0)."""
    import cv2

    s, u0, v0 = fit
    uv = np.stack([u0 + s * P[:, 0], v0 - s * P[:, 1]], axis=1)
    img = np.zeros(size, np.uint8)
    tri = np.round(uv[F]).astype(np.int32)
    cv2.fillPoly(img, list(tri), 1)
    return img.astype(bool)


def _fit(P, box):
    """Scale and offset that put P's x/y extent onto the mask box (x0, y0, x1, y1), by height."""
    x0, y0, x1, y1 = box
    lo, hi = P[:, :2].min(0), P[:, :2].max(0)
    s = (y1 - y0) / max(hi[1] - lo[1], 1e-9)
    u0 = (x0 + x1) / 2 - s * (lo[0] + hi[0]) / 2
    v0 = y1 + s * lo[1]
    return s, u0, v0


def _toes_forward(P):
    """+: the lowest part of the mesh (the feet/toes) sticks out toward +Z compared with the shins."""
    y = P[:, 1]
    H = np.ptp(y)
    feet = P[y < y.min() + 0.04 * H]
    shins = P[(y > y.min() + 0.07 * H) & (y < y.min() + 0.14 * H)]
    if len(feet) < 5 or len(shins) < 5:
        return 0.0
    return float((np.percentile(feet[:, 2], 90) - np.percentile(shins[:, 2], 90)) / H)


def _place(P, F, small, sbox):
    """Fit by height, then slide sideways to where the silhouette overlaps the mask best (a prop in
    the picture that the mesh lost widens the box, so the box center is not reliable). Returns (fit, iou)."""
    s, u0, v0 = _fit(P, sbox)
    sil = _silhouette(P, F, small.shape, (s, u0, v0))
    a = small.sum(0).astype(np.float64)
    b = sil.sum(0).astype(np.float64)
    w = len(a)
    shifts = np.arange(-w // 3, w // 3 + 1)
    best = max(shifts, key=lambda d: float(np.dot(a, np.roll(b, d))))
    fit = (s, u0 + best, v0)
    sil = _silhouette(P, F, small.shape, fit)
    return fit, (sil & small).sum() / max((sil | small).sum(), 1)


def orient(V, F, mask, log=lambda *_: None):
    """Rotation R (canonical = V @ R.T), the picture fit (scale, u0, v0) and the IoU with the mask."""
    import cv2

    ys, xs = np.nonzero(mask)
    box = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
    k = 256 / max(mask.shape)  # a small working copy of the mask keeps this fast
    small = cv2.resize(mask.astype(np.uint8), (max(1, round(mask.shape[1] * k)), max(1, round(mask.shape[0] * k))),
                       interpolation=cv2.INTER_NEAREST).astype(bool)
    sbox = tuple(b * k for b in box)
    scored = []
    for R in _rotations():
        fit, iou = _place(V @ R.T, F, small, sbox)
        scored.append((iou, R, fit))
    scored.sort(key=lambda t: -t[0])
    iou, R, fit = scored[0]
    # front or back: the silhouettes are mirror images; trust the toes when they say something
    flip = np.diag([-1.0, 1.0, -1.0]) @ R
    alt = next(t for t in scored if np.allclose(t[1], flip))
    if _toes_forward(V @ R.T) < -0.01 and alt[0] > 0.8 * iou:
        iou, R, fit = alt
        log("발끝 방향으로 앞뒤를 바로잡았습니다")
    s, u0, v0 = fit
    return R, (s / k, u0 / k, v0 / k), float(iou)


# ------------------------------------------------------------------ UV bake

def unwrap(V, F):
    """xatlas UV atlas: returns (V2, F2, UV, vmap) with V2 = V[vmap]."""
    import xatlas

    vmap, F2, uv = xatlas.parametrize(V.astype(np.float32), F.astype(np.uint32))
    return V[vmap], F2.astype(np.int64), uv.astype(np.float64), vmap


def raster_uv(UV, F, size):
    """Per texel: face index (-1 = empty) and barycentric weights, rasterizing the triangles in UV space."""
    face = np.full((size, size), -1, np.int64)
    bary = np.zeros((size, size, 3), np.float32)
    P = UV * (size - 1)  # glTF UVs start at the top-left of the image, like image rows
    T = P[F]
    lo = np.floor(T.min(1)).astype(int).clip(0, size - 1)
    hi = np.ceil(T.max(1)).astype(int).clip(0, size - 1)
    for f in range(len(F)):
        (x0, y0), (x1, y1) = lo[f], hi[f]
        a, b, c = T[f]
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.0, np.arange(y0, y1 + 1) + 0.0)
        v0, v1 = b - a, c - a
        d = v0[0] * v1[1] - v1[0] * v0[1]
        if abs(d) < 1e-12:
            continue
        px, py = gx - a[0], gy - a[1]
        w1 = (px * v1[1] - v1[0] * py) / d
        w2 = (v0[0] * py - px * v0[1]) / d
        w0 = 1 - w1 - w2
        e = -0.5 / max(abs(d) ** 0.5, 1)  # a little slack so edges are covered
        inside = (w0 >= e) & (w1 >= e) & (w2 >= e)
        if not inside.any():
            continue
        yy, xx = gy[inside].astype(int), gx[inside].astype(int)
        face[yy, xx] = f
        bary[yy, xx] = np.stack([w0[inside], w1[inside], w2[inside]], axis=1)
    return face, bary


def _pad(tex, filled, px=8):
    """Grow the islands' colors into the empty texels so seams do not show."""
    import cv2

    out = tex.copy()
    known = filled.copy()
    k = np.ones((3, 3), np.uint8)
    for _ in range(px):
        grown = cv2.dilate(known.astype(np.uint8), k).astype(bool) & ~known
        if not grown.any():
            break
        acc = np.zeros_like(out, dtype=np.float32)
        cnt = np.zeros(out.shape[:2], np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                sh = np.roll(np.roll(out, dy, 0), dx, 1).astype(np.float32)
                m = np.roll(np.roll(known, dy, 0), dx, 1)
                acc += sh * m[..., None]
                cnt += m
        out[grown] = (acc[grown] / np.maximum(cnt[grown], 1)[:, None]).astype(out.dtype)
        known |= grown
    return out


def bake(V, F, UV, color_fn, size=1024):
    """Texture (size x size x 3 uint8) where each texel gets color_fn(points (N,3), normals (N,3)) -> (N,3) 0..1."""
    face, bary = raster_uv(UV, F, size)
    filled = face >= 0
    fi = face[filled]
    w = bary[filled].astype(np.float64)
    pts = np.einsum("nk,nkd->nd", w, V[F[fi]])
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
    cols = np.clip(color_fn(pts, fn[fi]), 0, 1)
    tex = np.zeros((size, size, 3), np.uint8)
    tex[filled] = (cols * 255 + 0.5).astype(np.uint8)
    return _pad(tex, filled)


def projector(image, mask, fit):
    """color_fn for a model without colors: the picture projected from the front onto canonical
    (upright, facing +Z) points; surfaces facing away get the outline colors of their height."""
    import cv2

    h, w = mask.shape
    img = image.astype(np.float32) / 255
    # fill the background with nearby foreground colors so samples near the outline do not pick it up
    m8 = (~mask).astype(np.uint8)
    small = 512 / max(h, w)
    sz = (max(1, round(w * small)), max(1, round(h * small)))
    filled = cv2.inpaint((cv2.resize(img, sz) * 255).astype(np.uint8), cv2.resize(m8, sz, interpolation=cv2.INTER_NEAREST), 5,
                         cv2.INPAINT_TELEA)
    filled = cv2.resize(filled, (w, h)).astype(np.float32) / 255
    img = np.where(mask[..., None], img, filled)
    # per row: the colors just inside the left and right outline (hair at head height, clothes below)
    edge_l = np.zeros((h, 3), np.float32)
    edge_r = np.zeros((h, 3), np.float32)
    rows = np.flatnonzero(mask.any(1))
    inset = max(2, w // 100)
    for y in rows:
        xs = np.flatnonzero(mask[y])
        edge_l[y] = img[y, min(xs[0] + inset, xs[-1])]
        edge_r[y] = img[y, max(xs[-1] - inset, xs[0])]
    for arr in (edge_l, edge_r):  # rows without mask: nearest row's colors
        if len(rows):
            idx = np.interp(np.arange(h), rows, rows).round().astype(int)
            arr[:] = arr[idx]
    s, u0, v0 = fit

    def color(P, N):
        u = np.clip(u0 + s * P[:, 0], 0, w - 1)
        v = np.clip(v0 - s * P[:, 1], 0, h - 1)
        front = img[v.astype(int), u.astype(int)]
        vi = v.astype(int)
        lo, hi = np.zeros(len(P)), np.ones(len(P))
        xs_any = mask.any(0)
        if xs_any.any():
            cols = np.flatnonzero(xs_any)
            lo[:], hi[:] = cols[0], cols[-1]
        t = np.clip((u - lo) / np.maximum(hi - lo, 1), 0, 1)[:, None]
        back = (1 - t) * edge_l[vi] + t * edge_r[vi]
        wb = np.clip((-N[:, 2] - 0.1) / 0.5, 0, 1)[:, None]
        wb = wb * wb * (3 - 2 * wb)
        return (1 - wb) * front + wb * back

    return color


def write_textured_glb(path, V, F, UV, tex, name="model"):
    """Plain (unskinned) GLB with one textured material, through the pipeline's own writer."""
    import cv2

    from .gltf_read import Model, Prim
    from .gltf_write import write_glb

    ok, png = cv2.imencode(".png", tex[:, :, ::-1])
    if not ok:
        raise RuntimeError("PNG 인코딩 실패")
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    N = np.zeros_like(V)
    for k in range(3):
        np.add.at(N, F[:, k], fn)
    N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)
    n = len(V)
    prim = Prim(V.astype(np.float32), N.astype(np.float32), UV.astype(np.float32), np.zeros((n, 4), np.uint16),
                np.tile([1.0, 0, 0, 0], (n, 1)).astype(np.float32), F.reshape(-1).astype(np.uint32), 0)
    mat = {"name": name, "baseColorFactor": [1.0, 1.0, 1.0, 1.0], "baseColorTexture": 0, "alphaMode": "OPAQUE",
           "alphaCutoff": 0.5, "doubleSided": False}
    model = Model(["root"], [-1], np.eye(4)[None], [prim], [mat], [(png.tobytes(), "image/png")])
    write_glb(model, path, name=name, skinned=False)


def mask_and_rgb(rgba):
    """(H,W,4) uint8 -> (rgb, bool mask) from the alpha channel."""
    return rgba[:, :, :3], rgba[:, :, 3] > 127


__all__ = ["cleanup", "orient", "unwrap", "raster_uv", "bake", "projector", "write_textured_glb", "mask_and_rgb", "io"]
