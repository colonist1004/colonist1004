"""Local 3D generation: pinned upstream sources and where they live (stdlib only, used before setup)."""
from __future__ import annotations

import os
from pathlib import Path

# MIT-licensed upstream code, pinned; gen_setup.py downloads it into <data>/gen-src/<name>
SOURCES = {
    "triposg": ("VAST-AI-Research/TripoSG", "fc5c40990181e2a756c4e0b1c2f4d6b5202faf8c"),
    "triposr": ("VAST-AI-Research/TripoSR", "107cefdc244c39106fa830359024f6a2f1c78871"),
}
WEIGHTS = {"triposg": "VAST-AI/TripoSG", "triposr": "stabilityai/TripoSR"}


def data_dir() -> Path:
    d = os.environ.get("DANCER_DATA_DIR")
    if d:
        return Path(d)
    from .library import app_data_dir

    return app_data_dir()


def src_dir(name: str) -> Path:
    return data_dir() / "gen-src" / name
