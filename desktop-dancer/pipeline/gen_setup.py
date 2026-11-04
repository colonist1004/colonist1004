#!/usr/bin/env python3
"""Sets up the local 3D generation environment (run with that environment's Python; stdlib only).

  python gen_setup.py --uv <uv> --vendor amd|nvidia|cpu

1. PyTorch for the graphics card:
   - amd:    AMD's official Windows wheels (ROCm 7.2.1, Python 3.12, RX 7000/9000 series), read from
             the release folder's listing so new file names are picked up
   - nvidia: download.pytorch.org CUDA 12.8 wheels
   - cpu:    download.pytorch.org CPU wheels (TripoSR only, slow)
2. requirements-gen.txt
3. the pinned TripoSG / TripoSR sources (MIT) from GitHub into <data>/gen-src
"""
from __future__ import annotations

import argparse
import io
import os
import re
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from dancer_pipeline.gen_sources import SOURCES, data_dir  # noqa: E402

AMD_INDEX = "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/"
TORCH_INDEX = {"nvidia": "https://download.pytorch.org/whl/cu128", "cpu": "https://download.pytorch.org/whl/cpu"}


def log(msg):
    print(msg, flush=True)


def uv_install(uv, *args):
    cmd = [uv, "pip", "install", "--python", sys.executable, *args]
    log("$ " + " ".join(a if len(a) < 120 else a[:117] + "..." for a in cmd))
    subprocess.run(cmd, check=True)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "desktop-dancer-setup"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def amd_wheels(index=AMD_INDEX, py="cp312"):
    """(sdk files, torch files) from AMD's release folder listing."""
    html = fetch(index).decode("utf-8", "replace")
    from urllib.parse import quote, unquote

    names = sorted({unquote(n.split("/")[-1]) for n in re.findall(r'href="([^"?][^"]*\.(?:whl|tar\.gz))"', html)})
    sdk = [n for n in names if n.startswith(("rocm_sdk_core", "rocm_sdk_devel", "rocm_sdk_libraries_custom"))
           and (n.endswith(".tar.gz") or "win_amd64" in n or "py3-none" in n)]
    sdk += [n for n in names if re.match(r"rocm-\d[\d.]*\.tar\.gz$", n)]
    torch = [n for n in names if re.match(r"(torch|torchvision)-", n) and py in n and "win_amd64" in n]
    if not sdk or len(torch) < 2:
        raise SystemExit(f"AMD 설치 파일 목록을 읽지 못했습니다 ({index}). 인터넷 연결을 확인하세요.")
    return [index + quote(n) for n in sdk], [index + quote(n) for n in torch]


def install_torch(uv, vendor):
    if vendor == "amd":
        if sys.platform != "win32":
            raise SystemExit("AMD 설치는 Windows용입니다 (리눅스는 ROCm PyTorch를 직접 설치하세요)")
        sdk, torch = amd_wheels()
        log("AMD ROCm 구성 요소 설치 중 (수 GB, 시간이 걸립니다)")
        uv_install(uv, *sdk)
        log("PyTorch (ROCm) 설치 중")
        uv_install(uv, *torch)
    else:
        log(f"PyTorch ({'CUDA' if vendor == 'nvidia' else 'CPU'}) 설치 중")
        uv_install(uv, "torch", "torchvision", "--index-url", TORCH_INDEX[vendor])


def get_sources():
    for name, (repo, commit) in SOURCES.items():
        dest = data_dir() / "gen-src" / name
        stamp = dest / ".commit"
        if stamp.exists() and stamp.read_text().strip() == commit:
            continue
        log(f"{repo} 내려받는 중")
        data = fetch(f"https://github.com/{repo}/archive/{commit}.zip")
        shutil.rmtree(dest, ignore_errors=True)
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            root = z.namelist()[0].split("/")[0]
            for m in z.infolist():
                if m.is_dir() or not m.filename.startswith(root + "/"):
                    continue
                rel = m.filename[len(root) + 1 :]
                if not rel.endswith((".py", ".yaml", ".json", ".txt", "LICENSE", "NOTICE")):
                    continue  # code and configs only (no sample assets)
                out = dest / rel
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(z.read(m))
        stamp.write_text(commit)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--uv", required=True)
    ap.add_argument("--vendor", choices=["amd", "nvidia", "cpu"], required=True)
    ap.add_argument("--skip-torch", action="store_true")
    a = ap.parse_args(argv)
    if not a.skip_torch:
        install_torch(a.uv, a.vendor)
    log("나머지 패키지 설치 중")
    # keep the graphics card's PyTorch: nothing below may swap it for a plain PyPI build
    ver = subprocess.run([sys.executable, "-c", "import torch, torchvision; print(torch.__version__, torchvision.__version__)"],
                         check=True, capture_output=True, text=True).stdout.split()
    pins = data_dir() / "gen-constraints.txt"
    pins.parent.mkdir(parents=True, exist_ok=True)
    pins.write_text(f"torch=={ver[0]}\ntorchvision=={ver[1]}\n")
    uv_install(a.uv, "-r", str(HERE / "requirements-gen.txt"), "--constraint", str(pins))
    get_sources()
    log("확인 중")
    code = ("import torch, diffusers, transformers, xatlas, rembg;"
            "print('torch', torch.__version__, 'GPU:', torch.cuda.is_available(),"
            " torch.cuda.get_device_name(0) if torch.cuda.is_available() else '-')")
    subprocess.run([sys.executable, "-c", code], check=True)
    log("설치 완료")


if __name__ == "__main__":
    main()
