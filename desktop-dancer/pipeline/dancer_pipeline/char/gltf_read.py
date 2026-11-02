"""Reads a rigged GLB (e.g. UniRig output) into a flat, world-space "bind pose" model.

Everything is resolved into one skeleton (the union of all skins' joints, plus their ancestors)
and a list of primitives whose vertices are in world space at bind time. Meshes without a skin
are attached rigidly to their node (or nearest joint ancestor).
"""
from __future__ import annotations

import json
import struct
from dataclasses import dataclass, field

import numpy as np

COMP = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


@dataclass
class Prim:
    positions: np.ndarray  # (V,3) world bind pose
    normals: np.ndarray | None
    uvs: np.ndarray | None
    joints: np.ndarray  # (V,4) indices into Model.joints
    weights: np.ndarray  # (V,4)
    indices: np.ndarray  # (T*3,)
    material: int | None


@dataclass
class Model:
    joint_names: list[str]
    joint_parent: list[int]  # -1 for roots
    joint_world: np.ndarray  # (J,4,4) bind-pose world matrices
    prims: list[Prim]
    materials: list[dict]  # simplified: baseColorFactor, baseColorTexture(image idx), alphaMode, alphaCutoff, doubleSided, name
    images: list[tuple[bytes, str]]  # (data, mimeType)
    extras: dict = field(default_factory=dict)


def _node_local(n):
    if "matrix" in n:
        return np.array(n["matrix"], dtype=np.float64).reshape(4, 4).T
    t = np.array(n.get("translation", [0, 0, 0]), dtype=np.float64)
    q = np.array(n.get("rotation", [0, 0, 0, 1]), dtype=np.float64)
    s = np.array(n.get("scale", [1, 1, 1]), dtype=np.float64)
    x, y, z, w = q / max(np.linalg.norm(q), 1e-12)
    R = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])
    M = np.eye(4)
    M[:3, :3] = R * s
    M[:3, 3] = t
    return M


def read_glb(path) -> Model:
    data = open(path, "rb").read()
    if data[:4] != b"glTF":
        raise ValueError("GLB(바이너리 glTF) 파일이 아닙니다")
    jlen = struct.unpack_from("<I", data, 12)[0]
    j = json.loads(data[20 : 20 + jlen])
    off = 20 + jlen
    bin_ = data[off + 8 :] if len(data) > off + 8 else b""

    def view_bytes(vi):
        v = j["bufferViews"][vi]
        o = v.get("byteOffset", 0)
        return bin_[o : o + v["byteLength"]], v.get("byteStride")

    def acc(i):
        a = j["accessors"][i]
        dt = np.dtype(COMP[a["componentType"]]).newbyteorder("<")
        nc = NCOMP[a["type"]]
        if "bufferView" not in a:
            out = np.zeros((a["count"], nc), dtype=np.float64)
        else:
            raw, stride = view_bytes(a["bufferView"])
            base = a.get("byteOffset", 0)
            item = dt.itemsize * nc
            if stride and stride != item:
                out = np.stack([np.frombuffer(raw, dt, nc, base + k * stride) for k in range(a["count"])])
            else:
                out = np.frombuffer(raw, dt, a["count"] * nc, base).reshape(a["count"], nc)
            out = out.astype(np.float64)
            if a.get("normalized"):
                out = out / float(np.iinfo(dt).max)
        if "sparse" in a:
            sp = a["sparse"]
            ia = sp["indices"]
            idt = np.dtype(COMP[ia["componentType"]]).newbyteorder("<")
            raw, _ = view_bytes(ia["bufferView"])
            idx = np.frombuffer(raw, idt, sp["count"], ia.get("byteOffset", 0))
            raw, _ = view_bytes(sp["values"]["bufferView"])
            vals = np.frombuffer(raw, dt, sp["count"] * nc, sp["values"].get("byteOffset", 0)).reshape(-1, nc)
            out = out.copy()
            out[idx] = vals
        return out

    nodes = j.get("nodes", [])
    parent = [-1] * len(nodes)
    for i, n in enumerate(nodes):
        for c in n.get("children", []):
            parent[c] = i
    world = [None] * len(nodes)

    def W(i):
        if world[i] is None:
            world[i] = _node_local(nodes[i]) if parent[i] < 0 else W(parent[i]) @ _node_local(nodes[i])
        return world[i]

    for i in range(len(nodes)):
        W(i)

    # Joint set: every skin joint plus their ancestors (keeps the hierarchy connected).
    joint_nodes = set()
    for s in j.get("skins", []):
        for jn in s["joints"]:
            k = jn
            while k >= 0 and k not in joint_nodes:
                joint_nodes.add(k)
                k = parent[k]
    unrigged = not joint_nodes
    # Ancestors of joints are kept as joints; the humanoid mapper ignores bones it does not use.
    order = [i for i in range(len(nodes)) if i in joint_nodes]
    jindex = {n: k for k, n in enumerate(order)}
    joint_parent = []
    for n in order:
        p = parent[n]
        while p >= 0 and p not in jindex:
            p = parent[p]
        joint_parent.append(jindex.get(p, -1))

    # Bind matrices: inverse(IBM) where available (authoritative), else node world matrix.
    joint_world = np.stack([W(n) for n in order]) if order else np.eye(4)[None]
    for s in j.get("skins", []):
        if "inverseBindMatrices" in s:
            ibm = acc(s["inverseBindMatrices"]).reshape(-1, 4, 4).transpose(0, 2, 1)
            for k, jn in enumerate(s["joints"]):
                joint_world[jindex[jn]] = np.linalg.inv(ibm[k])

    prims: list[Prim] = []
    for ni, n in enumerate(nodes):
        if "mesh" not in n:
            continue
        mesh = j["meshes"][n["mesh"]]
        skin = j["skins"][n["skin"]] if "skin" in n else None
        for p in mesh["primitives"]:
            if p.get("mode", 4) != 4:
                continue  # triangles only
            a = p["attributes"]
            pos = acc(a["POSITION"])
            nrm = acc(a["NORMAL"]) if "NORMAL" in a else None
            uv = acc(a["TEXCOORD_0"]) if "TEXCOORD_0" in a else None
            idx = acc(p["indices"]).astype(np.int64).ravel() if "indices" in p else np.arange(len(pos))
            if skin is not None and "JOINTS_0" in a:
                jl = acc(a["JOINTS_0"]).astype(np.int64)
                wt = acc(a["WEIGHTS_0"])
                gj = np.array([jindex[x] for x in skin["joints"]])[jl]
                ibm = (acc(skin["inverseBindMatrices"]).reshape(-1, 4, 4).transpose(0, 2, 1)
                       if "inverseBindMatrices" in skin else np.broadcast_to(np.eye(4), (len(skin["joints"]), 4, 4)))
                # Vertices are given in the skin's bind space; bring them to world bind pose:
                # world = sum_w jointWorld_bind * IBM * v = v when IBM = inv(jointWorld_bind) (the usual case).
                M = np.einsum("vk,vkij->vij", wt / np.maximum(wt.sum(1, keepdims=True), 1e-9),
                              joint_world[gj] @ ibm[jl])
                ph = np.c_[pos, np.ones(len(pos))]
                wpos = np.einsum("vij,vj->vi", M, ph)[:, :3]
                wn = np.einsum("vij,vj->vi", M[:, :3, :3], nrm) if nrm is not None else None
                gjoints, gweights = gj, wt
            else:
                # Rigid mesh: follow its own node (or nearest joint ancestor, or the first root joint).
                k = ni
                while k >= 0 and k not in jindex:
                    k = parent[k]
                target = jindex.get(k, 0)
                M = W(ni)
                wpos = (np.c_[pos, np.ones(len(pos))] @ M.T)[:, :3]
                wn = nrm @ M[:3, :3].T if nrm is not None else None
                gjoints = np.zeros((len(pos), 4), np.int64)
                gjoints[:, 0] = target
                gweights = np.zeros((len(pos), 4))
                gweights[:, 0] = 1
            if wn is not None:
                wn = wn / np.maximum(np.linalg.norm(wn, axis=1, keepdims=True), 1e-9)
            prims.append(Prim(wpos, wn, uv, gjoints, gweights, idx, p.get("material")))

    materials = []
    for m in j.get("materials", []):
        pbr = m.get("pbrMetallicRoughness", {})
        tex = pbr.get("baseColorTexture")
        img = None
        if tex is not None:
            t = j["textures"][tex["index"]]
            img = t.get("source")
            if img is None:  # e.g. EXT_texture_webp / KHR_texture_basisu
                for ext in t.get("extensions", {}).values():
                    img = ext.get("source", img)
        materials.append({
            "name": m.get("name", ""),
            "baseColorFactor": pbr.get("baseColorFactor", [1, 1, 1, 1]),
            "baseColorTexture": img,
            "alphaMode": m.get("alphaMode", "OPAQUE"),
            "alphaCutoff": m.get("alphaCutoff", 0.5),
            "doubleSided": m.get("doubleSided", False),
        })
    images = []
    for im in j.get("images", []):
        if "bufferView" in im:
            raw, _ = view_bytes(im["bufferView"])
            images.append((bytes(raw), im.get("mimeType", "image/png")))
        else:
            images.append((b"", im.get("mimeType", "image/png")))  # external URIs are not supported

    if unrigged:  # a plain mesh: one placeholder root joint; autorig.py builds the real skeleton
        return Model(["root"], [-1], joint_world, prims, materials, images, {"unrigged": True})
    return Model([nodes[n].get("name", f"node{n}") for n in order], joint_parent, joint_world, prims, materials, images)
