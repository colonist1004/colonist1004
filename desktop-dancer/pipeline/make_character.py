#!/usr/bin/env python3
"""Character mesh (GLB) -> VRM 1.0 avatar for Desktop Dancer.

Rigged GLBs (e.g. UniRig output) keep their skeleton; plain meshes (TRELLIS, web generators, ...)
are rigged locally on the CPU, so no NVIDIA GPU is needed.

  python make_character.py rigged.glb --name 내캐릭터
  python make_character.py rigged.glb --flip            # if it ends up facing backwards

Steps: find humanoid bones by geometry → face +Z → straighten into a T-pose → scale/ground
→ write VRM 1.0 with toon (MToon) shading into the app's character library.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dancer_pipeline.char.gltf_read import read_glb  # noqa: E402
from dancer_pipeline.char.gltf_write import write_glb  # noqa: E402
from dancer_pipeline.char.humanoid import MappingError, find_humanoid  # noqa: E402
from dancer_pipeline.char.normalize import normalize  # noqa: E402
from dancer_pipeline.library import app_data_dir  # noqa: E402
from dancer_pipeline.progress import Progress  # noqa: E402

STAGES = {"read": (0, 0.15), "map": (0.15, 0.3), "pose": (0.3, 0.85), "save": (0.85, 1.0)}

MTOON = {
    "toon": {
        "shadingToonyFactor": 0.9, "shadingShiftFactor": -0.05, "giEqualizationFactor": 0.9, "shadeScale": 0.72,
        "outlineWidthMode": "worldCoordinates", "outlineWidthFactor": 0.0015, "outlineColorFactor": [0.15, 0.12, 0.12],
        "outlineLightingMixFactor": 1.0,
    },
    "soft": {"shadingToonyFactor": 0.5, "shadingShiftFactor": 0.0, "giEqualizationFactor": 0.9, "shadeScale": 0.8},
}


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="리깅된 GLB → VRM 캐릭터 (Desktop Dancer)")
    p.add_argument("input", help="캐릭터 .glb (리깅된 것도, 뼈대 없는 메시도 됨)")
    p.add_argument("--name", help="캐릭터 이름 (기본: 파일 이름)")
    p.add_argument("--out", help="출력 .vrm 경로 또는 폴더 (기본: 앱 캐릭터 라이브러리)")
    p.add_argument("--height", type=float, default=1.6, help="키 (m, 기본 1.6)")
    p.add_argument("--flip", action="store_true", help="앞뒤 반대로 (결과가 뒤돌아 있을 때)")
    p.add_argument("--no-tpose", action="store_true", help="T포즈로 펴지 않음")
    p.add_argument("--shading", choices=["toon", "soft"], default="toon", help="toon: 애니풍(외곽선 포함) / soft: 부드러운 음영")
    p.add_argument("--no-springs", action="store_true", help="자동 리깅 때 머리카락·치마 흔들림 뼈를 넣지 않음")
    p.add_argument("--autorig", action="store_true", help="기존 뼈대를 무시하고 내 PC에서 자동 리깅 (뼈대 없는 GLB는 항상 자동)")
    p.add_argument("--author", default="Desktop Dancer user")
    p.add_argument("--progress-json", action="store_true")
    return p.parse_args(argv)


def main(argv=None):
    a = parse_args(argv)
    pr = Progress(a.progress_json, STAGES)
    try:
        return _main(a, pr)
    except (MappingError, ValueError) as e:
        pr.error(str(e))
        raise SystemExit(1) from None
    except SystemExit:
        raise
    except Exception as e:
        if a.progress_json:
            pr.error(f"{type(e).__name__}: {e}")
            raise SystemExit(1) from None
        raise


def _main(a, pr):
    src = Path(a.input)
    if not src.exists():
        raise ValueError(f"파일이 없습니다: {src}")
    if src.suffix.lower() not in (".glb", ".vrm"):
        raise ValueError("GLB 파일만 지원합니다 (FBX는 Blender에서 GLB로 내보내 주세요)")
    pr.stage("read", 0, "모델 읽는 중")
    model = read_glb(src)
    tris = sum(len(p.indices) // 3 for p in model.prims)
    pr.log(f"{len(model.joint_names)} bones, {tris} triangles, {len(model.images)} textures")

    autorigged = bool(a.autorig or model.extras.get("unrigged"))
    mapping = None
    if not autorigged:
        pr.stage("map", 0, "뼈대 분석 중 (머리·팔·다리 찾기)")
        try:
            mapping = find_humanoid(model)
        except MappingError as e:
            # e.g. the photo did not show the legs, so the rig has none: rig it again here instead
            pr.log(f"기존 뼈대를 쓸 수 없어 자동 리깅으로 다시 합니다 ({e})")
            autorigged = True
    if autorigged:
        from dancer_pipeline.char.autorig import autorig
        from dancer_pipeline.char.humanoid import Mapping

        pr.stage("map", 0, "뼈대 넣는 중 (내 PC에서 자동 리깅)")
        model, bones, _, _ = autorig(model, log=pr.log)
        mapping = Mapping(bones, np.array([0.0, 0.0, 1.0]), [])
    for w in mapping.warnings:
        pr.log("주의: " + w)

    pr.stage("pose", 0, "T포즈로 펴는 중")
    model = normalize(model, mapping, height=a.height, flip=a.flip, tpose=not a.no_tpose,
                      on_step=lambda f: pr.stage("pose", f))

    spring = None
    if autorigged and not a.no_springs:
        from dancer_pipeline.char.springs import add_springs

        pr.stage("save", 0, "머리카락·치마 흔들림 넣는 중")
        model, spring = add_springs(model, mapping.bones, log=pr.log)

    pr.stage("save", 0, "VRM 저장 중")
    name = a.name or src.stem
    out = Path(a.out) if a.out else app_data_dir() / "library" / "characters"
    if out.suffix.lower() != ".vrm":
        out.mkdir(parents=True, exist_ok=True)
        out = out / f"{name}.vrm"
    else:
        out.parent.mkdir(parents=True, exist_ok=True)
    meta = {
        "name": name,
        "version": "1.0",
        "authors": [a.author],
        "licenseUrl": "https://vrm.dev/licenses/1.0/",
        "avatarPermission": "onlyAuthor",
        "commercialUsage": "personalNonProfit",
        "creditNotation": "required",
        "allowRedistribution": False,
        "modification": "allowModification",
        "allowExcessivelyViolentUsage": False,
        "allowExcessivelySexualUsage": False,
        "allowPoliticalOrReligiousUsage": False,
        "allowAntisocialOrHateUsage": False,
    }
    write_glb(model, out, name=name, vrm={"humanBones": mapping.bones, "meta": meta}, mtoon=dict(MTOON[a.shading]),
              spring=spring)
    info = {
        "name": name,
        "source": str(src),
        "created": dt.datetime.now().isoformat(timespec="seconds"),
        "bones": {k: model.joint_names[v] for k, v in mapping.bones.items()},
        "triangles": tris,
        "warnings": mapping.warnings,
        "options": {"height": a.height, "flip": a.flip, "tpose": not a.no_tpose, "shading": a.shading,
                    "autorig": autorigged, "springs": len(spring["springs"]) if spring else 0},
    }
    out.with_suffix(".json").write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    pr.log(f"saved {out}")
    pr.done(out=str(out), triangles=tris, warnings=mapping.warnings)
    return out


if __name__ == "__main__":
    main()
