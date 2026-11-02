"""Writes VRM Animation 1.0 (.vrma) files: a glTF binary whose nodes form the reference
humanoid skeleton (identity rest rotations) with one animation and the VRMC_vrm_animation extension."""
from __future__ import annotations

import json
import struct

import numpy as np

from .rot import matrix_to_quat, quat_continuous
from .skeleton import BONES, PARENT, local_offset


class _Glb:
    def __init__(self):
        self.json = {
            "asset": {"version": "2.0", "generator": "desktop-dancer pipeline"},
            "scene": 0,
            "scenes": [{"nodes": []}],
            "nodes": [],
            "bufferViews": [],
            "accessors": [],
        }
        self.bin = bytearray()

    def accessor(self, arr: np.ndarray, type_: str, minmax=False) -> int:
        arr = np.ascontiguousarray(arr, dtype="<f4")
        while len(self.bin) % 4:
            self.bin.append(0)
        self.json["bufferViews"].append({"buffer": 0, "byteOffset": len(self.bin), "byteLength": arr.nbytes})
        self.bin += arr.tobytes()
        comps = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[type_]
        acc = {
            "bufferView": len(self.json["bufferViews"]) - 1,
            "componentType": 5126,
            "count": arr.size // comps,
            "type": type_,
        }
        if minmax:
            flat = arr.reshape(-1, comps)
            acc["min"] = flat.min(axis=0).tolist()
            acc["max"] = flat.max(axis=0).tolist()
        self.json["accessors"].append(acc)
        return len(self.json["accessors"]) - 1

    def to_bytes(self) -> bytes:
        while len(self.bin) % 4:
            self.bin.append(0)
        self.json["buffers"] = [{"byteLength": len(self.bin)}]
        j = json.dumps(self.json, separators=(",", ":")).encode()
        j += b" " * ((4 - len(j) % 4) % 4)
        total = 12 + 8 + len(j) + 8 + len(self.bin)
        out = struct.pack("<III", 0x46546C67, 2, total)
        out += struct.pack("<II", len(j), 0x4E4F534A) + j
        out += struct.pack("<II", len(self.bin), 0x004E4942) + bytes(self.bin)
        return out


def write_vrma(path, fps: float, local_rot: dict, hips_pos: np.ndarray, name="dance"):
    """local_rot: bone -> (F,3,3) local rotations relative to the T-pose. hips_pos: (F,3) in meters,
    world space of the reference skeleton (rest hips height = skeleton.REST_HIPS_Y)."""
    g = _Glb()
    index = {}
    for bone in BONES:
        g.json["nodes"].append({"name": bone, "translation": local_offset(bone).tolist()})
        index[bone] = len(g.json["nodes"]) - 1
    for bone in BONES:
        p = PARENT[bone]
        if p:
            g.json["nodes"][index[p]].setdefault("children", []).append(index[bone])
    g.json["scenes"][0]["nodes"].append(index["hips"])

    n = len(hips_pos)
    times = np.arange(n, dtype=np.float64) / fps
    inp = g.accessor(times, "SCALAR", minmax=True)
    samplers, channels = [], []

    def add(node, path_, data, type_):
        samplers.append({"input": inp, "output": g.accessor(data, type_), "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": node, "path": path_}})

    add(index["hips"], "translation", np.asarray(hips_pos), "VEC3")
    for bone in BONES:
        if bone in local_rot:
            add(index[bone], "rotation", quat_continuous(matrix_to_quat(local_rot[bone])), "VEC4")

    g.json["animations"] = [{"name": name, "samplers": samplers, "channels": channels}]
    g.json["extensionsUsed"] = ["VRMC_vrm_animation"]
    g.json["extensions"] = {
        "VRMC_vrm_animation": {
            "specVersion": "1.0",
            "humanoid": {"humanBones": {b: {"node": index[b]} for b in BONES}},
        }
    }
    with open(path, "wb") as f:
        f.write(g.to_bytes())


def read_vrma(path):
    """Reads a .vrma written with an identity-rest skeleton (like ours) back into
    (fps, local_rot: bone -> (F,3,3), hips_pos: (F,3)). Used by tests and comparisons."""
    from .rot import quat_to_matrix

    data = open(path, "rb").read()
    jlen = struct.unpack_from("<I", data, 12)[0]
    j = json.loads(data[20 : 20 + jlen])
    bin_ = data[20 + jlen + 8 :]

    def acc(i):
        a = j["accessors"][i]
        v = j["bufferViews"][a["bufferView"]]
        comps = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[a["type"]]
        off = v.get("byteOffset", 0) + a.get("byteOffset", 0)
        return np.frombuffer(bin_, "<f4", a["count"] * comps, off).reshape(a["count"], comps).astype(np.float64)

    bones = {v["node"]: k for k, v in j["extensions"]["VRMC_vrm_animation"]["humanoid"]["humanBones"].items()}
    anim = j["animations"][0]
    local, hips, times = {}, None, None
    for ch in anim["channels"]:
        s = anim["samplers"][ch["sampler"]]
        times = acc(s["input"])[:, 0]
        bone = bones.get(ch["target"]["node"])
        if bone is None:
            continue
        if ch["target"]["path"] == "rotation":
            local[bone] = quat_to_matrix(acc(s["output"]))
        elif ch["target"]["path"] == "translation" and bone == "hips":
            hips = acc(s["output"])
    fps = (len(times) - 1) / times[-1] if len(times) > 1 else 30.0
    return fps, local, hips
