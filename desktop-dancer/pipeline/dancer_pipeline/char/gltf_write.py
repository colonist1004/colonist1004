"""Writes a Model as GLB, optionally as a VRM 1.0 avatar (VRMC_vrm + MToon materials)."""
from __future__ import annotations

import json
import struct

import numpy as np

from .gltf_read import Model


class _Bin:
    def __init__(self):
        self.json = {"bufferViews": [], "accessors": []}
        self.bin = bytearray()

    def view(self, raw: bytes, target=None) -> int:
        while len(self.bin) % 4:
            self.bin.append(0)
        v = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(raw)}
        if target:
            v["target"] = target
        self.bin += raw
        self.json["bufferViews"].append(v)
        return len(self.json["bufferViews"]) - 1

    def accessor(self, arr, comp, type_, target=None, minmax=False, normalized=False) -> int:
        dt = {5126: "<f4", 5123: "<u2", 5125: "<u4", 5121: "u1"}[comp]
        arr = np.ascontiguousarray(arr, dtype=dt)
        nc = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[type_]
        a = {"bufferView": self.view(arr.tobytes(), target), "componentType": comp, "count": arr.size // nc, "type": type_}
        if normalized:
            a["normalized"] = True
        if minmax:
            f = arr.reshape(-1, nc)
            a["min"] = f.min(0).tolist()
            a["max"] = f.max(0).tolist()
        self.json["accessors"].append(a)
        return len(self.json["accessors"]) - 1


def _mat_to_trs(M):
    t = M[:3, 3]
    R = M[:3, :3]
    s = np.linalg.norm(R, axis=0)
    R = R / np.maximum(s, 1e-12)
    from ..rot import matrix_to_quat

    q = matrix_to_quat(R)
    node = {}
    if np.linalg.norm(t) > 1e-9:
        node["translation"] = [float(x) for x in t]
    if abs(q[3]) < 1 - 1e-9:
        node["rotation"] = [float(x) for x in q]
    if np.abs(s - 1).max() > 1e-6:
        node["scale"] = [float(x) for x in s]
    return node


def write_glb(model: Model, path, *, name="model", vrm: dict | None = None, mtoon: dict | None = None):
    """vrm: {"humanBones": {vrmBone: jointIndex}, "meta": {...}} to write a VRM 1.0 file.
    mtoon: MToon parameters applied to every material (only with vrm)."""
    b = _Bin()
    j = b.json
    j.update({"asset": {"version": "2.0", "generator": "desktop-dancer character pipeline"}, "scene": 0})
    J = len(model.joint_names)

    # Joints -> nodes, with local transforms from world bind matrices.
    nodes = []
    for k in range(J):
        p = model.joint_parent[k]
        local = model.joint_world[k] if p < 0 else np.linalg.inv(model.joint_world[p]) @ model.joint_world[k]
        nodes.append({"name": model.joint_names[k], **_mat_to_trs(local)})
    for k, p in enumerate(model.joint_parent):
        if p >= 0:
            nodes[p].setdefault("children", []).append(k)
    roots = [k for k, p in enumerate(model.joint_parent) if p < 0]

    # Images / textures / materials
    j["images"], j["textures"], j["samplers"] = [], [], [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]
    for data, mime in model.images:
        j["images"].append({"bufferView": b.view(data), "mimeType": mime})
        j["textures"].append({"source": len(j["images"]) - 1, "sampler": 0})
    j["materials"] = []
    for m in model.materials or [{"name": "default", "baseColorFactor": [1, 1, 1, 1], "baseColorTexture": None,
                                  "alphaMode": "OPAQUE", "alphaCutoff": 0.5, "doubleSided": False}]:
        tex = m["baseColorTexture"] if m["baseColorTexture"] is not None and model.images[m["baseColorTexture"]][0] else None
        mat = {
            "name": m["name"],
            "pbrMetallicRoughness": {"baseColorFactor": m["baseColorFactor"], "metallicFactor": 0.0, "roughnessFactor": 0.9},
            "alphaMode": m["alphaMode"],
            "doubleSided": m["doubleSided"],
        }
        if m["alphaMode"] == "MASK":
            mat["alphaCutoff"] = m["alphaCutoff"]
        if tex is not None:
            mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": tex}
        if vrm is not None and mtoon is not None:
            ext = {"specVersion": "1.0", **mtoon}
            ext["shadeColorFactor"] = [c * mtoon.get("shadeScale", 0.75) for c in m["baseColorFactor"][:3]]
            ext.pop("shadeScale", None)
            if tex is not None:
                ext["shadeMultiplyTexture"] = {"index": tex}
            mat["extensions"] = {"VRMC_materials_mtoon": ext}
        j["materials"].append(mat)

    # One skinned mesh, one primitive per source primitive.
    prims = []
    for p in model.prims:
        V = len(p.positions)
        w = p.weights / np.maximum(p.weights.sum(1, keepdims=True), 1e-9)
        w[~np.isfinite(w)] = 0
        attrs = {
            "POSITION": b.accessor(p.positions, 5126, "VEC3", 34962, minmax=True),
            "JOINTS_0": b.accessor(p.joints, 5123, "VEC4", 34962),
            "WEIGHTS_0": b.accessor(w, 5126, "VEC4", 34962),
        }
        if p.normals is not None:
            attrs["NORMAL"] = b.accessor(p.normals, 5126, "VEC3", 34962)
        if p.uvs is not None:
            attrs["TEXCOORD_0"] = b.accessor(p.uvs, 5126, "VEC2", 34962)
        comp = 5123 if V < 65535 else 5125
        prim = {"attributes": attrs, "indices": b.accessor(p.indices, comp, "SCALAR", 34963)}
        if p.material is not None and p.material < len(j["materials"]):
            prim["material"] = p.material
        elif model.materials == []:
            prim["material"] = 0
        prims.append(prim)
    j["meshes"] = [{"name": name, "primitives": prims}]
    ibm = np.linalg.inv(model.joint_world).transpose(0, 2, 1).reshape(-1)  # column-major
    j["skins"] = [{"joints": list(range(J)), "inverseBindMatrices": b.accessor(ibm, 5126, "MAT4"),
                   "skeleton": roots[0]}]
    nodes.append({"name": name, "mesh": 0, "skin": 0})
    j["nodes"] = nodes
    j["scenes"] = [{"nodes": roots + [len(nodes) - 1]}]
    if not j["textures"]:
        for k in ("images", "textures", "samplers"):
            del j[k]

    if vrm is not None:
        used = ["VRMC_vrm"] + (["VRMC_materials_mtoon"] if mtoon is not None else [])
        j["extensionsUsed"] = used
        j["extensions"] = {
            "VRMC_vrm": {
                "specVersion": "1.0",
                "meta": vrm["meta"],
                "humanoid": {"humanBones": {bone: {"node": int(k)} for bone, k in vrm["humanBones"].items()}},
            }
        }

    while len(b.bin) % 4:
        b.bin.append(0)
    j["buffers"] = [{"byteLength": len(b.bin)}]
    js = json.dumps(j, separators=(",", ":"), ensure_ascii=False).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(b.bin)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        f.write(struct.pack("<II", len(b.bin), 0x004E4942) + bytes(b.bin))
