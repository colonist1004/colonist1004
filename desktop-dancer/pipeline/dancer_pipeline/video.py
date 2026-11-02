"""Video input: local files or URLs (downloaded with yt-dlp), with optional time range."""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

from .library import cache_dir


def is_url(s: str) -> bool:
    return bool(re.match(r"^https?://", s))


def download(url: str, log=print, on_progress=None) -> Path:
    """Download a video URL with yt-dlp into the cache (reused on later runs).
    Only for videos you are allowed to download; YouTube's terms restrict downloading."""
    try:
        import yt_dlp
    except ImportError as e:
        raise SystemExit("URL 입력에는 yt-dlp가 필요합니다: pip install yt-dlp") from e
    out_dir = cache_dir() / "videos"
    out_dir.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(url.encode()).hexdigest()[:12]
    existing = sorted(out_dir.glob(f"{key}.*"))
    if existing:
        log(f"cached download: {existing[0]}")
        return existing[0]
    opts = {
        # A single progressive file avoids needing ffmpeg for merging; 720p is plenty for pose.
        "format": "b[height<=720][ext=mp4]/b[height<=720]/b",
        "outtmpl": str(out_dir / f"{key}.%(ext)s"),
        "quiet": True,
        "noprogress": True,
        "noplaylist": True,
    }
    if on_progress:
        def hook(d):
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            if d.get("status") == "downloading" and total:
                on_progress(d.get("downloaded_bytes", 0) / total)
        opts["progress_hooks"] = [hook]
    log(f"downloading {url} ...")
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            path = Path(ydl.prepare_filename(info))
    except yt_dlp.utils.DownloadError as e:
        raise SystemExit(
            f"내려받기 실패: {e}\n"
            "  · yt-dlp를 최신으로: pip install -U yt-dlp\n"
            "  · 안 되면 영상을 직접 저장한 뒤 파일 경로로 실행하세요."
        ) from e
    log(f"downloaded: {path.name} ({info.get('title', '')})")
    return path


def read_frames(path, start=None, end=None, target_fps=30.0):
    """Yields (time_seconds, rgb_frame) between start and end, resampled to at most target_fps.
    The first value is ('info', {'fps': effective fps, 'total': expected number of frames})."""
    import cv2

    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise SystemExit(f"영상을 열 수 없습니다: {path}")
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, round(src_fps / target_fps)) if target_fps else 1
    count = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    first = (start or 0) * src_fps
    last = min(count, end * src_fps) if end is not None and count else (end * src_fps if end is not None else count)
    yield "info", {"fps": src_fps / step, "total": max(1, int((last - first) / step))}
    if start:
        cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000
        if end is not None and t > end:
            break
        if i % step == 0:
            yield t, cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        i += 1
    cap.release()
