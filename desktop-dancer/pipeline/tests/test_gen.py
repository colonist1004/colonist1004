"""Local 3D generation post-processing (no GPU, no model weights): python tests/test_gen.py
Needs: numpy, opencv-python-headless, trimesh, xatlas, fast-simplification, scipy.

A known body mesh is turned into "generator output" (another axis convention, scale and offset),
then cleaned, turned upright to match the picture, unwrapped and baked. Checks: the orientation is
recovered, floaters are dropped, the picture's colors land on the front, a model's own color field
is looked up in the model's own coordinates, and the GLB reads back.
"""
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from dancer_pipeline.char import bake as B  # noqa: E402
from dancer_pipeline.char.gltf_read import read_glb  # noqa: E402
from test_character import synthetic_model  # noqa: E402


def body():
    """The synthetic humanoid (boxes) as one mesh, +Y up, facing +Z, with toes pointing forward."""
    m, _ = synthetic_model(prop=False)
    p = m.prims[0]
    V, F = p.positions.astype(np.float64), p.indices.reshape(-1, 3).astype(np.int64)
    # toes: a box in front of each ankle so front and back can be told apart
    extra_v, extra_f = [], []
    for x in (0.1, -0.1):
        c = np.array([x, 0.03, 0.08])
        corners = np.array([[sx, sy, sz] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]) * [0.04, 0.03, 0.07] + c
        base = len(V) + len(extra_v) * 8
        extra_v.append(corners)
        for f in ([0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]):
            extra_f += [[base + f[0], base + f[1], base + f[2]], [base + f[0], base + f[2], base + f[3]]]
    V = np.concatenate([V, *extra_v])
    F = np.concatenate([F, np.array(extra_f)])
    return V, F


def picture(V, F, size=400):
    """Front view of the body: mask + an image whose left half is red and right half is blue."""
    import cv2

    H = np.ptp(V[:, 1])
    s = 0.9 * size / H
    u0, v0 = size / 2 - s * (V[:, 0].min() + V[:, 0].max()) / 2, size * 0.95 + s * V[:, 1].min()
    mask = B._silhouette(V, F, (size, size), (s, u0, v0))
    img = np.zeros((size, size, 3), np.uint8)
    img[:, : size // 2] = (220, 30, 30)
    img[:, size // 2 :] = (30, 30, 220)
    img[~mask] = 0
    return img, mask, (s, u0, v0), cv2


def generator_output(V, F):
    """Same body in a z-up / facing +x convention, scaled and moved, plus a floating speck."""
    R = np.array([[0, 0, 1], [1, 0, 0], [0, 1, 0]], float)
    Vg = (V - V.mean(0)) @ R.T * 2.5 + [0.3, -0.2, 0.1]
    speck = np.array([[3, 3, 3], [3.01, 3, 3], [3, 3.01, 3]], float)
    return np.concatenate([Vg, speck]), np.concatenate([F, [[len(Vg), len(Vg) + 1, len(Vg) + 2]]]), R


def test_orientation_and_floaters():
    V, F = body()
    img, mask, _, _ = picture(V, F)
    Vg, Fg, R0 = generator_output(V, F)
    Vc, Fc = B.cleanup(Vg, Fg)
    assert len(Fc) == len(F), "the floating speck is dropped"
    R, fit, iou = B.orient(Vc, Fc, mask)
    assert iou > 0.5, iou  # (thin box limbs: a pixel off costs a lot of IoU)
    assert np.allclose(R, R0.T), f"orientation not recovered:\n{R}"


def test_projected_colors_land_on_the_front_sides():
    V, F = body()
    img, mask, _, _ = picture(V, F)
    Vg, Fg, _ = generator_output(V, F)
    Vc, Fc = B.cleanup(Vg, Fg)
    R, fit, _ = B.orient(Vc, Fc, mask)
    Vo = Vc @ R.T
    V2, F2, UV, _ = B.unwrap(Vo, Fc)
    tex = B.bake(V2, F2, UV, B.projector(img, mask, fit), size=256)
    # sample the texture at the UV of front-facing points on the left and right of the body
    fn = np.cross(V2[F2[:, 1]] - V2[F2[:, 0]], V2[F2[:, 2]] - V2[F2[:, 0]])
    front = fn[:, 2] / np.maximum(np.linalg.norm(fn, axis=1), 1e-12) > 0.9
    cx = (Vo[:, 0].min() + Vo[:, 0].max()) / 2
    for side, want in ((-1, 0), (1, 2)):  # picture left = red channel, right = blue
        sel = front & (np.sign(V2[F2].mean(1)[:, 0] - cx) == side)
        uv = UV[F2[sel]].mean(1)
        px = tex[(uv[:, 1] * 255).astype(int), (uv[:, 0] * 255).astype(int)].astype(float)
        share = (px.argmax(1) == want).mean()
        assert share > 0.85, f"side {side}: {share:.2f}"


def test_color_field_is_queried_in_model_space():
    V, F = body()
    _, mask, _, _ = picture(V, F)
    Vg, Fg, _ = generator_output(V, F)
    Vc, Fc = B.cleanup(Vg, Fg)
    R, _, _ = B.orient(Vc, Fc, mask)
    V2, F2, UV, vmap = B.unwrap(Vc @ R.T, Fc)
    # the model's field: green above its own z = 0.5 (its "up" is +z), red below
    field = lambda P: np.where((P[:, 2] > 0.5)[:, None], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0])  # noqa: E731
    tex = B.bake(V2, F2, UV, lambda P, N: field(P @ R), size=256)
    head = Vc[vmap][:, 2] > 1.0  # clearly above in model space
    uv = UV[head]
    px = tex[(uv[:, 1] * 255).astype(int), (uv[:, 0] * 255).astype(int)]
    assert (px[:, 1] > px[:, 0]).mean() > 0.9


def test_amd_wheel_list():
    """AMD's release folder listing -> SDK files first, then torch/torchvision for Python 3.12 on Windows."""
    import gen_setup

    names = ["rocm_sdk_core-7.2.1-py3-none-win_amd64.whl", "rocm_sdk_devel-7.2.1-py3-none-win_amd64.whl",
             "rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl", "rocm-7.2.1.tar.gz",
             "torch-2.9.1+rocm7.2.1-cp312-cp312-win_amd64.whl", "torch-2.9.1+rocm7.2.1-cp311-cp311-win_amd64.whl",
             "torchaudio-2.9.1+rocm7.2.1-cp312-cp312-win_amd64.whl", "torchvision-0.24.1+rocm7.2.1-cp312-cp312-win_amd64.whl"]
    for enc in (lambda n: n, lambda n: n.replace("+", "%2B")):
        html = "<html><a href=\"../\">../</a>" + "".join(f'<a href="{enc(n)}">{n}</a>' for n in names) + "</html>"
        gen_setup.fetch = lambda url, html=html: html.encode()
        sdk, torch = gen_setup.amd_wheels("https://x/")
        assert len(sdk) == 4 and sdk[-1].endswith("rocm-7.2.1.tar.gz"), sdk
        assert [t.split("/")[-1].split("-")[0] for t in torch] == ["torch", "torchvision"], torch
        assert all("cp312" in t and "%2B" in t for t in torch), torch


def test_textured_glb_reads_back():
    V, F = body()
    UV = np.random.default_rng(0).random((len(V), 2))
    tex = np.full((64, 64, 3), 200, np.uint8)
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "g.glb"
        B.write_textured_glb(p, V, F, UV, tex)
        m = read_glb(p)
        assert m.extras.get("unrigged") and m.images and m.materials[0]["baseColorTexture"] == 0
        got = np.concatenate([q.positions for q in m.prims])
        assert np.allclose(got, V, atol=1e-5)


if __name__ == "__main__":
    try:
        import cv2, trimesh, xatlas  # noqa: F401,E401
    except ImportError as e:
        print(f"SKIP  test_gen ({e})")
        sys.exit(0)
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
