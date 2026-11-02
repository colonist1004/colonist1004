"""Reference VRM humanoid skeleton (shared/skeleton.json) and forward kinematics."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

SKELETON_JSON = Path(__file__).resolve().parents[2] / "shared" / "skeleton.json"

_data = json.loads(SKELETON_JSON.read_text(encoding="utf-8"))
BONES: list[str] = [b["name"] for b in _data["bones"]]
PARENT: dict[str, str | None] = {b["name"]: b["parent"] for b in _data["bones"]}
REST_POS: dict[str, np.ndarray] = {b["name"]: np.array(b["pos"], dtype=np.float64) for b in _data["bones"]}
REST_HIPS_Y = float(REST_POS["hips"][1])


def local_offset(name: str) -> np.ndarray:
    p = PARENT[name]
    return REST_POS[name] - (REST_POS[p] if p else 0)


def forward_kinematics(local_rot: dict[str, np.ndarray], hips_pos: np.ndarray):
    """local_rot: bone -> (F,3,3) local rotations (missing = identity). hips_pos: (F,3).
    Returns (world_pos, world_rot): bone -> (F,3) and bone -> (F,3,3)."""
    n = len(hips_pos)
    eye = np.broadcast_to(np.eye(3), (n, 3, 3))
    world_pos, world_rot = {}, {}
    for name in BONES:  # parents come before children in skeleton.json
        r = local_rot.get(name, eye)
        p = PARENT[name]
        if p is None:
            world_rot[name] = r
            world_pos[name] = np.asarray(hips_pos, dtype=np.float64)
        else:
            world_rot[name] = world_rot[p] @ r
            world_pos[name] = world_pos[p] + np.einsum("fij,j->fi", world_rot[p], local_offset(name))
    return world_pos, world_rot
