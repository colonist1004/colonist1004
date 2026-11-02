"""Video input: local files or URLs (downloaded with yt-dlp), with optional time range."""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

from .library import cache_dir


def is_url(s: str) -> bool:
    return bool(re.match(r"^https?://", s))


def _find_deno():
    import shutil
    import sys

    exe = "deno.exe" if sys.platform == "win32" else "deno"
    for d in (Path(sys.executable).parent, Path(sys.prefix) / ("Scripts" if sys.platform == "win32" else "bin")):
        if (d / exe).exists():
            return d / exe
    found = shutil.which("deno")
    return Path(found) if found else None


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
    # Only finished videos count as cached; leftovers of a failed attempt (.part, .ytdl, f137.mp4…) do not.
    existing = sorted(p for p in out_dir.glob(f"{key}.*")
                      if p.suffix.lower() in (".mp4", ".webm", ".mkv", ".mov") and p.stem == key)
    for junk in out_dir.glob(f"{key}.*"):
        if junk not in existing:
            junk.unlink(missing_ok=True)
    if existing:
        log(f"cached download: {existing[0]}")
        return existing[0]
    opts = {
        # Pose detection needs no audio. Video-only streams always exist (YouTube rarely offers
        # combined 720p files any more) and need no ffmpeg merge. Prefer H.264: OpenCV and the
        # app's preview decode it everywhere.
        "format": ("bv*[height<=720][vcodec^=avc1]/bv*[height<=720][ext=mp4]/bv*[height<=720]"
                   "/b[height<=720]/bv*/b"),
        "outtmpl": str(out_dir / f"{key}.%(ext)s"),
        "quiet": True,
        "noprogress": True,
        "noplaylist": True,
    }
    # YouTube needs a JavaScript runtime to solve its player challenges (yt-dlp >= 2025.11).
    # requirements.txt installs `deno` into the same environment; point yt-dlp at it.
    deno = _find_deno()
    if deno:
        opts["js_runtimes"] = {"deno": {"path": str(deno)}}
    else:
        log("주의: deno(자바스크립트 런타임)를 찾지 못했습니다. 유튜브 내려받기가 실패할 수 있습니다.")
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
