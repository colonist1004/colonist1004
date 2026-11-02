"""Progress reporting: readable lines for people, or JSON lines ("@@{...}") for the desktop app."""
from __future__ import annotations

import json
import sys

# Rough share of the total time each stage takes, used for one overall 0..1 progress value.
STAGES = {"download": (0.0, 0.15), "model": (0.15, 0.2), "pose": (0.2, 0.9), "post": (0.9, 0.97), "save": (0.97, 1.0)}


class Progress:
    def __init__(self, json_mode: bool = False, stages: dict | None = None):
        self.json = json_mode
        self.stages = stages or STAGES

    def _emit(self, obj):
        print("@@" + json.dumps(obj, ensure_ascii=False), flush=True)

    def log(self, msg="", end="\n"):
        if self.json:
            if msg.strip():
                self._emit({"type": "log", "msg": msg.strip()})
        else:
            print(msg, end=end, flush=True)

    def stage(self, name: str, frac: float = 0.0, msg: str | None = None):
        """Report progress inside a stage (frac 0..1)."""
        a, b = self.stages.get(name, (0, 1))
        if self.json:
            self._emit({"type": "progress", "stage": name, "frac": round(a + (b - a) * max(0, min(1, frac)), 4),
                        **({"msg": msg} if msg else {})})
        elif msg:
            print(msg, flush=True)

    def done(self, **info):
        if self.json:
            self._emit({"type": "done", **info})

    def error(self, msg: str):
        if self.json:
            self._emit({"type": "error", "msg": msg})
        else:
            print(msg, file=sys.stderr, flush=True)
