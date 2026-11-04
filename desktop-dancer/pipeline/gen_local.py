#!/usr/bin/env python3
"""Picture -> 3D model on this PC's own graphics card (AMD via ROCm, NVIDIA via CUDA, or the CPU).

  python gen_local.py character.png --model triposg --out character.glb
  python gen_local.py character.png --model triposr --out character.glb --device cpu

Models (both MIT licensed, downloaded from Hugging Face on first use):
  triposg  VAST-AI TripoSG: detailed shapes. Needs a GPU. Colors are projected from the picture.
  triposr  Tripo/Stability TripoSR: rougher shapes but predicts its own colors; also runs on the CPU.

The result is an unrigged, textured GLB standing up and facing +Z; make_character.py rigs it.
Runs in its own environment (userData/gen-env, set up by gen_setup.py), not the dance pipeline's.
"""
from __future__ import annotations

import argparse
import os
import sys
import types
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dancer_pipeline.progress import Progress  # noqa: E402

from dancer_pipeline.gen_sources import SOURCES, WEIGHTS, data_dir, src_dir  # noqa: E402,F401

progress = Progress()


def log(msg):
    progress.log(msg)


# ------------------------------------------------------------------ picture

def cutout(path, anime=True):
    """Picture -> RGBA with the background removed (kept if the picture already has transparency)."""
    from PIL import Image

    img = Image.open(path)
    img.load()
    if img.mode == "RGBA" and np.asarray(img)[:, :, 3].min() < 250:
        return np.asarray(img).copy()
    import rembg

    progress.stage("cutout", 0, "배경 지우는 중")
    session = rembg.new_session("isnet-anime" if anime else "isnet-general-use")
    out = rembg.remove(img.convert("RGB"), session=session)
    return np.asarray(out.convert("RGBA")).copy()


def square(rgba, ratio, bg):
    """Crop to the person, pad to a square where the person fills `ratio`, flatten onto bg (0..1)."""
    a = rgba[:, :, 3]
    ys, xs = np.nonzero(a > 127)
    if not len(ys):
        raise SystemExit("그림에서 캐릭터를 찾지 못했습니다 (배경 지우기 결과가 비었습니다)")
    crop = rgba[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1].astype(np.float32) / 255
    h, w = crop.shape[:2]
    size = int(max(h, w) / ratio)
    out = np.empty((size, size, 3), np.float32)
    out[:] = bg
    y0, x0 = (size - h) // 2, (size - w) // 2
    al = crop[:, :, 3:4]
    out[y0 : y0 + h, x0 : x0 + w] = crop[:, :, :3] * al + bg * (1 - al)
    return (out * 255).astype(np.uint8)


# ------------------------------------------------------------------ devices

def pick_device(want="auto"):
    import torch

    if want == "cpu":
        return "cpu"
    if torch.cuda.is_available():  # ROCm builds of PyTorch answer here too
        name = torch.cuda.get_device_name(0)
        rocm = getattr(torch.version, "hip", None)
        log(f"그래픽카드: {name} ({'ROCm ' + rocm if rocm else 'CUDA ' + str(torch.version.cuda)})")
        return "cuda"
    if want == "cuda":
        raise SystemExit("그래픽카드를 쓸 수 없습니다 (PyTorch가 GPU를 찾지 못함). 드라이버를 확인하거나 CPU로 실행하세요.")
    log("그래픽카드를 찾지 못해 CPU로 실행합니다 (느립니다)")
    return "cpu"


def _stub_modules():
    """CUDA-only extras the upstream code imports but this path never needs."""
    if "diso" not in sys.modules:  # TripoSG: only its flash decoder uses DiffDMC; we decode with marching cubes
        diso = types.ModuleType("diso")

        class DiffDMC:  # noqa: D401
            def __init__(self, *a, **k):
                raise RuntimeError("DiffDMC is not available")

        diso.DiffDMC = DiffDMC
        sys.modules["diso"] = diso
    if "torchmcubes" not in sys.modules:  # TripoSR: marching cubes on the CPU with scikit-image
        import torch

        mc = types.ModuleType("torchmcubes")

        def marching_cubes(vol, level):
            from skimage import measure

            v, f, _, _ = measure.marching_cubes(vol.detach().float().cpu().numpy(), level)
            # torchmcubes returns (x, y, z) = (axis 2, axis 1, axis 0); TripoSR swaps them back
            return torch.from_numpy(np.ascontiguousarray(v[:, ::-1].copy())).float(), torch.from_numpy(f.astype(np.int64))

        mc.marching_cubes = marching_cubes
        sys.modules["torchmcubes"] = mc


def weights(name):
    from huggingface_hub import snapshot_download

    progress.stage("weights", 0, "모델 내려받는 중 (처음 한 번, 수 GB)")
    return snapshot_download(repo_id=WEIGHTS[name])


# ------------------------------------------------------------------ models

def run_triposg(rgba, device, steps, seed):
    import torch
    from PIL import Image

    _stub_modules()
    sys.path.insert(0, str(src_dir("triposg")))
    from triposg.pipelines.pipeline_triposg import TripoSGPipeline

    if device == "cpu":
        raise SystemExit("TripoSG는 그래픽카드가 필요합니다. CPU에서는 TripoSR을 쓰세요.")
    path = weights("triposg")
    progress.stage("load", 0, "TripoSG 불러오는 중")
    pipe = TripoSGPipeline.from_pretrained(path).to(device, torch.float16)
    img = Image.fromarray(square(rgba, 0.9, 1.0))

    def on_step(p, i, t, kw):
        progress.stage("generate", (i + 1) / steps, f"3D 모양 만드는 중 ({i + 1}/{steps})")
        return kw

    progress.stage("generate", 0, "3D 모양 만드는 중")
    with torch.no_grad():
        out = pipe(image=img, num_inference_steps=steps, guidance_scale=7.0,
                   generator=torch.Generator(device=device).manual_seed(seed),
                   use_flash_decoder=False, callback_on_step_end=on_step).samples[0]
    if out[0] is None:
        raise SystemExit("모양을 만들지 못했습니다 (빈 결과). 다른 그림이나 seed로 다시 해 보세요.")
    return np.asarray(out[0], np.float64), np.asarray(out[1], np.int64), None


def run_triposr(rgba, device, resolution=256):
    import torch

    _stub_modules()
    sys.path.insert(0, str(src_dir("triposr")))
    from tsr.system import TSR

    path = weights("triposr")
    progress.stage("load", 0, "TripoSR 불러오는 중")
    model = TSR.from_pretrained(path, config_name="config.yaml", weight_name="model.ckpt")
    model.renderer.set_chunk_size(8192)
    model.to(device)
    from PIL import Image

    img = Image.fromarray(square(rgba, 0.85, 0.5))
    progress.stage("generate", 0.2, "3D 모양 만드는 중")
    with torch.no_grad():
        codes = model([img], device=device)
        progress.stage("generate", 0.6, "표면 뽑는 중")
        mesh = model.extract_mesh(codes, False, resolution=resolution)[0]

    def colors(P):
        out = []
        with torch.no_grad():
            for i in range(0, len(P), 65536):
                x = torch.from_numpy(P[i : i + 65536].astype(np.float32)).to(device)
                out.append(model.renderer.query_triplane(model.decoder, x, codes[0])["color"].float().cpu().numpy())
        return np.concatenate(out) if out else np.zeros((0, 3))

    V, F = np.asarray(mesh.vertices, np.float64), np.asarray(mesh.faces, np.int64)
    return V, F, colors


# ------------------------------------------------------------------ main

def main(argv=None):
    ap = argparse.ArgumentParser(description="그림 → 3D 모델 (이 PC의 그래픽카드)")
    ap.add_argument("image")
    ap.add_argument("--out", required=True, help="출력 .glb")
    ap.add_argument("--model", choices=["triposg", "triposr"], default="triposg")
    ap.add_argument("--device", choices=["auto", "cuda", "cpu"], default="auto")
    ap.add_argument("--steps", type=int, default=50, help="TripoSG 단계 수 (적을수록 빠르고 거칠게)")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--faces", type=int, default=50000, help="최대 삼각형 수")
    ap.add_argument("--texture", type=int, default=1024, help="텍스처 크기")
    ap.add_argument("--realistic", action="store_true", help="실사 사진 (배경 지우기 모델을 일반용으로)")
    ap.add_argument("--progress-json", action="store_true")
    a = ap.parse_args(argv)
    global progress
    progress = Progress(json_mode=a.progress_json)
    try:
        return _main(a)
    except SystemExit as e:
        if a.progress_json and e.code not in (0, None) and not isinstance(e.code, int):
            progress.error(str(e.code))
            raise SystemExit(1) from None
        raise
    except Exception as e:
        if a.progress_json:
            msg = f"{type(e).__name__}: {e}"
            if "out of memory" in str(e).lower():
                msg = "그래픽카드 메모리가 부족합니다. --steps를 줄이거나 TripoSR을 써 보세요.\n" + msg
            progress.error(msg)
            raise SystemExit(1) from None
        raise


def _main(a):
    from dancer_pipeline.char import bake as B

    rgba = cutout(a.image, anime=not a.realistic)
    fake = os.environ.get("DANCER_GEN_FAKE")  # tests: a mesh file stands in for the model
    if fake:
        import trimesh

        m = trimesh.load(fake, force="mesh")
        V, F, color_field = np.asarray(m.vertices, np.float64), np.asarray(m.faces, np.int64), None
    elif a.model == "triposg":
        V, F, color_field = run_triposg(rgba, pick_device(a.device), a.steps, a.seed)
    else:
        V, F, color_field = run_triposr(rgba, pick_device(a.device))
    progress.stage("mesh", 0, "다듬는 중 (조각 지우기, 줄이기)")
    V, F = B.cleanup(V, F, max_faces=a.faces)
    log(f"삼각형 {len(F)}개")
    rgb, mask = B.mask_and_rgb(rgba)
    progress.stage("mesh", 0.4, "방향 맞추는 중")
    R, fit, iou = B.orient(V, F, mask, log=log)
    log(f"그림과 겹침 {iou:.2f}")
    if iou < 0.4:
        log("주의: 만든 모양이 그림 윤곽과 많이 다릅니다")
    Vc = V @ R.T
    progress.stage("mesh", 0.6, "펼치는 중 (UV)")
    V2, F2, UV, vmap = B.unwrap(Vc, F)
    progress.stage("mesh", 0.8, "색 입히는 중")
    if color_field is not None:
        def color(P, N):  # P: canonical points -> back to the model's own space for its color field
            return color_field(P @ R)

        fn = color
    else:
        fn = B.projector(rgb, mask, fit)
    tex = B.bake(V2, F2, UV, fn, size=a.texture)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    B.write_textured_glb(out, V2, F2, UV, tex, name=out.stem)
    log(f"saved {out}")
    progress.done(out=str(out), faces=int(len(F2)), iou=round(iou, 3))
    return out


if __name__ == "__main__":
    main()
