#!/usr/bin/env python3
"""Checks a character image before the (paid) cloud generation step.

  python check_image.py character.png [--json]

Looks for: enough resolution, a full body in view, facing the camera, arms away from the body
(T- or A-pose works best for rigging), and a simple background. Results are advice, not errors:
stylized drawings can fool the pose detector.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))


def check(path, log=lambda *_: None):
    import cv2

    res = []
    add = lambda level, msg: res.append({"level": level, "msg": msg})  # noqa: E731
    img = cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None:
        return [{"level": "error", "msg": "이미지를 열 수 없습니다"}]
    h, w = img.shape[:2]
    if min(h, w) < 512:
        add("warn", f"해상도가 낮습니다 ({w}×{h}). 짧은 쪽 512px 이상이 좋아요")
    else:
        add("ok", f"해상도 {w}×{h}")

    has_alpha = img.ndim == 3 and img.shape[2] == 4 and img[:, :, 3].min() < 250
    rgb = cv2.cvtColor(img[:, :, :3] if img.ndim == 3 else cv2.cvtColor(img, cv2.COLOR_GRAY2BGR), cv2.COLOR_BGR2RGB)
    if has_alpha:
        add("ok", "배경이 투명합니다")
    else:
        border = np.concatenate([rgb[:8].reshape(-1, 3), rgb[-8:].reshape(-1, 3), rgb[:, :8].reshape(-1, 3), rgb[:, -8:].reshape(-1, 3)])
        if border.std(axis=0).mean() > 30:
            add("warn", "배경이 복잡해 보여요. 단색 배경이면 결과가 더 좋아집니다 (배경은 자동으로 지워집니다)")
        else:
            add("ok", "배경이 단순합니다")

    try:
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision

        from dancer_pipeline.pose_mediapipe import model_path

        opts = vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path=str(model_path("heavy", log))),
                                            running_mode=vision.RunningMode.IMAGE, num_poses=2)
        with vision.PoseLandmarker.create_from_options(opts) as lm:
            r = lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)))
    except Exception as e:  # mediapipe missing or failed: skip pose advice
        add("info", f"자세 확인을 건너뜀 ({type(e).__name__})")
        return res

    if not r.pose_landmarks:
        add("info", "자세를 자동으로 확인하지 못했어요 (그림체 때문일 수 있어요). 전신·정면·팔 벌린 포즈인지 직접 확인하세요")
        return res
    if len(r.pose_landmarks) > 1:
        add("warn", "사람이 여러 명 보여요. 한 명만 있는 이미지를 쓰세요")
    L = np.array([[p.x, p.y, p.visibility] for p in r.pose_landmarks[0]])
    inside = lambda i: L[i, 2] > 0.15 and -0.02 <= L[i, 0] <= 1.02 and -0.02 <= L[i, 1] <= 1.02  # noqa: E731
    # MediaPipe's visibility for feet is often low even when they are in view: any of ankle/heel/toe will do.
    foot_ok = lambda ids: any(inside(i) for i in ids)  # noqa: E731
    if inside(0) and foot_ok((27, 29, 31)) and foot_ok((28, 30, 32)):
        add("ok", "머리부터 발끝까지 보입니다")
    else:
        add("warn", "전신이 다 보이지 않아요. 머리부터 발끝까지 나온 이미지가 필요합니다")
    px = L[:, :2] * [w, h]
    sh = np.linalg.norm(px[11] - px[12])
    torso = np.linalg.norm((px[11] + px[12]) / 2 - (px[23] + px[24]) / 2)
    if torso > 0 and sh / torso < 0.45:
        add("warn", "옆이나 비스듬히 서 있는 것 같아요. 정면을 보는 이미지가 좋습니다")
    else:
        add("ok", "정면을 보고 있습니다")
    angles = []
    for s, e in ((11, 13), (12, 14)):
        v = px[e] - px[s]
        angles.append(np.degrees(np.arctan2(abs(v[0]), v[1])))  # 0 = arm straight down, 90 = horizontal
    a = min(angles)
    if max(angles) > 125:
        add("warn", "팔을 위로 들고 있어요. 팔을 옆으로 벌린 T/A 포즈가 리깅에 좋습니다")
    elif a >= 60:
        add("ok", "팔을 옆으로 벌린 T포즈입니다")
    elif a >= 20:
        add("ok", "팔을 살짝 벌린 A포즈입니다")
    else:
        add("warn", "팔이 몸에 붙어 있어요. 팔을 벌린 T/A 포즈여야 리깅이 잘 됩니다")
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    res = check(a.image)
    if a.json:
        print("@@" + json.dumps({"type": "done", "checks": res}, ensure_ascii=False))
    else:
        for c in res:
            print({"ok": "✓", "warn": "!", "info": "·", "error": "✗"}[c["level"]], c["msg"])


if __name__ == "__main__":
    main()
