#!/usr/bin/env python3
"""Dance video -> VRMA motion for Desktop Dancer.

  python extract_dance.py dance.mp4 --start 12 --end 40 --name my-dance
  python extract_dance.py "https://www.youtube.com/watch?v=..." --start 5 --end 25 --loop
  python extract_dance.py dance.mp4 --engine gvhmr --gvhmr-result gvhmr_dance.npz

The result goes into the app's motion library by default, so it shows up in the tray menu.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dancer_pipeline import post  # noqa: E402
from dancer_pipeline.library import motions_dir  # noqa: E402
from dancer_pipeline.progress import Progress  # noqa: E402
from dancer_pipeline.retarget import keypoints_to_rotations  # noqa: E402
from dancer_pipeline.skeleton import BONES  # noqa: E402
from dancer_pipeline.vrma import write_vrma  # noqa: E402

MIRROR = np.diag([-1.0, 1.0, 1.0])


progress = Progress()


def log(msg="", end="\n"):
    progress.log(msg, end=end)


def swap_side(name: str) -> str:
    for a, b in (("left", "right"), ("right", "left")):
        if name.startswith(a):
            return b + name[len(a):]
    return name


def mirror_keypoints(kp):
    return {swap_side(k): v @ MIRROR for k, v in kp.items()}


def mirror_rotations(local):
    return {swap_side(b): MIRROR @ m @ MIRROR for b, m in local.items()}


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="춤 영상 → VRMA 모션 (Desktop Dancer)")
    p.add_argument("input", help="영상 파일 경로, URL(yt-dlp로 내려받음) 또는 다른 모캡 도구의 .bvh 파일")
    p.add_argument("--start", type=float, help="시작 시간(초)")
    p.add_argument("--end", type=float, help="끝 시간(초)")
    p.add_argument("--name", help="모션 이름 (파일 이름). 기본: 영상 파일 이름")
    p.add_argument("--out", help="출력 .vrma 경로 또는 폴더. 기본: 앱 모션 라이브러리")
    p.add_argument("--engine", choices=["rtm", "mediapipe", "gvhmr"], default="rtm",
                   help="rtm: RTMW3D, 그래픽카드(DirectML·AMD 가능) 또는 CPU (기본, 안 되면 MediaPipe로 자동 전환) / "
                        "mediapipe: 가벼운 CPU 인식 / gvhmr: 클라우드 GPU에서 만든 결과(npz) 변환")
    p.add_argument("--gvhmr-result", help="cloud/run_gvhmr.sh 가 만든 .npz (engine=gvhmr)")
    p.add_argument("--model", choices=["lite", "full", "heavy"], default="heavy", help="MediaPipe 모델 크기")
    p.add_argument("--person", type=int, help="여러 명일 때 대상 (첫 장면 기준 왼쪽부터 0,1,2…). 기본: 가장 큰 사람")
    p.add_argument("--fps", type=float, default=30, help="처리/출력 프레임레이트 상한 (기본 30)")
    p.add_argument("--smooth", type=float, default=1.0, help="떨림 제거 강도 (0=끔, 1=기본, 2=강하게)")
    p.add_argument("--root", choices=["inplace", "planted", "original"], default="planted",
                   help="inplace: 제자리 고정 / planted: 디딘 발 기준으로 조금씩 이동 (기본) / original: 원본 이동 (gvhmr)")
    p.add_argument("--range", type=float, default=0.25, help="planted/original 이동 범위 제한(m, 기본 0.25)")
    p.add_argument("--loop", action="store_true", help="끝과 시작이 이어지게 잘라서 반복 재생용으로 만듦")
    p.add_argument("--mirror", action="store_true", help="좌우 반전 (거울 모드 안무 영상용)")
    p.add_argument("--hands", type=float, default=0.7, help="손목 회전 반영 비율 (0~1, 기본 0.7)")
    p.add_argument("--no-foot-lock", action="store_true", help="발 고정(IK) 끄기")
    p.add_argument("--no-lift", action="store_true", help="2D+뼈 길이 보정 끄기 (MediaPipe 3D 좌표만 사용)")
    p.add_argument("--progress-json", action="store_true", help="진행 상황을 JSON 줄로 출력 (앱용)")
    p.add_argument("--download-only", action="store_true", help="URL을 내려받기만 하고 경로를 알려줌 (앱 미리보기용)")
    p.add_argument("--save-keypoints", action="store_true", help="디버그용 키포인트 npz도 저장")
    return p.parse_args(argv)


def run_video(args, video):
    from dancer_pipeline.lift import lift
    from dancer_pipeline.pose_mediapipe import estimate
    from dancer_pipeline.video import read_frames

    frames = read_frames(video, args.start, args.end, args.fps)
    _, info = next(frames)
    fps, total = info["fps"], info["total"]
    on_frame = lambda i: progress.stage("pose", i / total)  # noqa: E731
    engine = "mediapipe"
    if args.engine == "rtm":
        progress.stage("model", 0, "RTMW3D 모델 준비 (그래픽카드 사용)")
        try:
            from dancer_pipeline import pose_rtm

            models = pose_rtm.load_models(pose_rtm.pick_device(log), log)
            engine = "rtm"
        except Exception as e:  # missing package, download blocked, GPU driver problem...
            log(f"RTMW3D를 쓸 수 없어 MediaPipe로 진행합니다 ({type(e).__name__}: {e})")
    if engine == "rtm":
        progress.stage("pose", 0, f"동작 인식 중 · RTMW3D ({total} 프레임)")
        kp, kp2d, valid, legs = pose_rtm.estimate(frames, fps, person=args.person, log=log, on_frame=on_frame, models=models)
    else:
        progress.stage("model", 0, "MediaPipe 모델 준비")
        from dancer_pipeline.pose_mediapipe import model_path

        model_path(args.model, log)
        progress.stage("pose", 0, f"동작 인식 중 · MediaPipe ({total} 프레임)")
        kp, kp2d, valid, legs = estimate(frames, fps, variant=args.model, person=args.person, log=log, on_frame=on_frame)
    args.engine_used = engine
    n = len(valid)
    if n < 2:
        raise SystemExit("처리할 프레임이 없습니다 (시간 범위를 확인하세요)")
    ratio = valid.mean()
    log(f"frames: {n}, person found in {ratio * 100:.0f}%")
    progress.stage("post", 0, "다듬는 중 (떨림 제거, 발 고정)")
    if ratio < 0.5:
        raise SystemExit("사람이 감지된 프레임이 50% 미만입니다. 전신이 잘 보이는 구간을 고르거나, 여러 명이 나오면 대상 사람(--person) 설정을 확인하세요.")
    kp = {k: post.fill_gaps(v, valid) for k, v in kp.items()}
    kp2d = {k: post.fill_gaps(v, valid) for k, v in kp2d.items()}
    raw = {**{f"w_{k}": v for k, v in kp.items()}, **{f"i_{k}": v for k, v in kp2d.items()}, "fps": fps}
    if not args.no_lift and engine == "mediapipe":  # RTMW3D depth is already consistent (calibrated)
        kp = lift(kp, kp2d, fps)
    # MediaPipe world landmarks lean systematically: always straighten. RTMW3D: only a clearly tilted camera.
    kp = post.align_gravity(kp, min_deg=0 if engine == "mediapipe" else 12)
    if args.mirror:
        kp = mirror_keypoints(kp)
    sigma = 1.5 * args.smooth * fps / 30
    kp = {k: post.gaussian_smooth(v, sigma) for k, v in kp.items()}
    local = keypoints_to_rotations(kp, hand_weight=args.hands)
    local = post.smooth_rotations(local, 0.75 * args.smooth * fps / 30)
    seen = post.legs_seen(legs, valid, fps)
    if args.mirror:
        seen = {"left": seen["right"], "right": seen["left"]}
    local, replaced = post.stand_unseen_legs(local, seen, fps)
    for side, share in replaced.items():
        if share > 0.02:
            log(f"{'왼' if side == 'left' else '오른'}다리가 화면에 안 보이는 구간 {share * 100:.0f}%: 그동안은 서 있는 자세로 둡니다")

    if args.root == "original":
        raise SystemExit("--root original 은 gvhmr 엔진에서만 됩니다 (MediaPipe는 전역 이동을 모름)")
    hips_y = post.ground_per_frame(local, fps)
    if args.root == "planted":
        xz = post.planted_root_xz(local, hips_y, fps, args.range)
    else:
        xz = np.zeros((n, 2))
    root = post.compose_root(xz, hips_y)
    if not args.no_foot_lock:
        local = post.foot_lock(local, root, fps)
    extra = {"detected_ratio": round(float(ratio), 3)}
    if args.save_keypoints:
        extra["keypoints"] = raw
    return fps, local, root, extra


def run_bvh(args, path):
    """Motion capture file from another tool (Rokoko Vision, Plask, DeepMotion, QuickMagic, ...)."""
    from dancer_pipeline.bvh import load_bvh

    progress.stage("model", 0, "BVH 읽는 중")
    try:
        fps, local, root, warnings = load_bvh(path)
    except ValueError as e:
        raise SystemExit(str(e)) from None
    for w in warnings:
        log("주의: " + w)
    a = int(round((args.start or 0) * fps))
    b = int(round(args.end * fps)) + 1 if args.end is not None else len(root)
    local = {k: v[a:b] for k, v in local.items()}
    root = root[a:b]
    if args.mirror:
        local = mirror_rotations(local)
        root = root @ MIRROR
    progress.stage("post", 0, "다듬는 중")
    local = post.smooth_rotations(local, 0.5 * args.smooth * fps / 30)
    n = len(root)
    hips_y = post.gaussian_smooth(post.ground_trajectory(local, root[:, 1]), 0.3 * args.smooth * fps / 30)
    if args.root == "original":
        xz = root[:, [0, 2]] - root[:, [0, 2]].mean(axis=0)
        xz = args.range * np.tanh(xz / max(args.range, 1e-6)) if args.range > 0 else xz
    elif args.root == "planted":
        xz = post.planted_root_xz(local, hips_y, fps, args.range)
    else:
        xz = np.zeros((n, 2))
    root = post.compose_root(xz, hips_y)
    if not args.no_foot_lock:
        local = post.foot_lock(local, root, fps)
    return fps, local, root, {"warnings": warnings}


def run_gvhmr(args):
    from dancer_pipeline.smpl import load_smpl_npz, smpl_to_rotations

    if not args.gvhmr_result:
        raise SystemExit(
            "GVHMR은 NVIDIA GPU가 필요해서 클라우드에서 실행합니다.\n"
            "  1) pipeline/cloud/README.md 대로 RunPod/Colab에서 run_gvhmr.sh 실행 → <이름>.npz\n"
            "  2) python extract_dance.py <영상> --engine gvhmr --gvhmr-result <이름>.npz"
        )
    go, bp, transl, fps = load_smpl_npz(args.gvhmr_result)
    local, root = smpl_to_rotations(go, bp, transl)
    # Optional time range on the result (seconds of the processed video)
    a = int(round((args.start or 0) * fps))
    b = int(round(args.end * fps)) + 1 if args.end is not None else len(root)
    local = {k: v[a:b] for k, v in local.items()}
    root = root[a:b]
    if args.mirror:
        local = mirror_rotations(local)
        root = root @ MIRROR
    local = post.smooth_rotations(local, 0.5 * args.smooth * fps / 30)
    n = len(root)
    hips_y = post.gaussian_smooth(post.ground_trajectory(local, root[:, 1]), 0.5 * args.smooth * fps / 30)
    if args.root == "original":
        xz = root[:, [0, 2]] - root[:, [0, 2]].mean(axis=0)
        xz = args.range * np.tanh(xz / max(args.range, 1e-6)) if args.range > 0 else xz
    elif args.root == "planted":
        xz = post.planted_root_xz(local, hips_y, fps, args.range)
    else:
        xz = np.zeros((n, 2))
    root = post.compose_root(xz, hips_y)
    if not args.no_foot_lock:
        local = post.foot_lock(local, root, fps)
    return fps, local, root, {}


def main(argv=None):
    args = parse_args(argv)
    global progress
    progress = Progress(json_mode=args.progress_json)
    try:
        return _main(args)
    except SystemExit as e:
        if args.progress_json and e.code not in (0, None) and not isinstance(e.code, int):
            progress.error(str(e.code))
            raise SystemExit(1) from None
        raise
    except Exception as e:  # unexpected: report, then fail
        if args.progress_json:
            progress.error(f"{type(e).__name__}: {e}")
            raise SystemExit(1) from None
        raise


def _main(args):
    from dancer_pipeline.video import download, is_url

    source = args.input
    if is_url(source):
        progress.stage("download", 0, "영상 내려받는 중")
        video = download(source, log=log, on_progress=lambda f: progress.stage("download", f))
    else:
        video = Path(source)
    if args.download_only:
        progress.done(video=str(video))
        return video
    if args.engine != "gvhmr" and not Path(video).exists():
        raise SystemExit(f"파일이 없습니다: {video}")

    if str(video).lower().endswith(".bvh"):
        fps, local, root, extra = run_bvh(args, video)
    elif args.engine == "gvhmr":
        fps, local, root, extra = run_gvhmr(args)
    else:
        fps, local, root, extra = run_video(args, video)

    if args.loop:
        local, root, n = post.make_loop(local, root, fps)
        log(f"loop: cut at {n / fps:.2f}s")

    name = args.name or (Path(video).stem if not is_url(source) else "dance")
    out = Path(args.out) if args.out else motions_dir()
    if out.suffix.lower() != ".vrma":
        out.mkdir(parents=True, exist_ok=True)
        out = out / f"{name}.vrma"
    else:
        out.parent.mkdir(parents=True, exist_ok=True)

    progress.stage("save", 0, "저장 중")
    local = {b: m for b, m in local.items() if b in BONES}
    write_vrma(out, fps, local, root, name=name)
    n = len(root)
    meta = {
        "name": name,
        "source": source,
        "start": args.start,
        "end": args.end,
        "engine": getattr(args, "engine_used", args.engine),
        "created": dt.datetime.now().isoformat(timespec="seconds"),
        "fps": round(fps, 3),
        "frames": n,
        "duration": round((n - 1) / fps, 3),
        "options": {k: getattr(args, k) for k in ("model", "person", "smooth", "root", "range", "loop", "mirror", "hands")},
    }
    meta.update({k: v for k, v in extra.items() if k != "keypoints"})
    out.with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    if "keypoints" in extra:
        np.savez_compressed(out.with_suffix(".keypoints.npz"), **extra["keypoints"])
    log(f"saved {out}  ({meta['duration']:.1f}s, {n} frames)")
    progress.done(out=str(out), duration=meta["duration"], frames=n, detected=meta.get("detected_ratio"))
    return out


if __name__ == "__main__":
    main()
