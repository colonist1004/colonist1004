"""Operations on a world-space bind-pose Model: global transforms, posing + baking a new rest pose."""
from __future__ import annotations

import copy

import numpy as np

from .gltf_read import Model


def children_of(model: Model):
    ch = [[] for _ in model.joint_names]
    for i, p in enumerate(model.joint_parent):
        if p >= 0:
            ch[p].append(i)
    return ch


def descendants(model: Model, j: int) -> list[int]:
    ch = children_of(model)
    out, stack = [], [j]
    while stack:
        k = stack.pop()
        out.append(k)
        stack.extend(ch[k])
    return out


def topo_order(model: Model) -> list[int]:
    ch = children_of(model)
    roots = [i for i, p in enumerate(model.joint_parent) if p < 0]
    out, stack = [], list(reversed(roots))
    while stack:
        k = stack.pop()
        out.append(k)
        stack.extend(reversed(ch[k]))
    return out


def transform(model: Model, M: np.ndarray) -> Model:
    """Apply a global 4x4 (rotation * uniform scale + translation) to the whole model."""
    m = copy.deepcopy(model)
    R = M[:3, :3]
    for p in m.prims:
        p.positions = p.positions @ R.T + M[:3, 3]
        if p.normals is not None:
            n = p.normals @ R.T
            p.normals = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
    m.joint_world = np.einsum("ij,njk->nik", M, m.joint_world)
    return m


def joint_pos(model: Model, j: int) -> np.ndarray:
    return model.joint_world[j][:3, 3].copy()


def pose_and_bake(model: Model, world_rotations: dict[int, np.ndarray]) -> Model:
    """Rotate joints about their own position (world-space rotations, applied parent-first and carried
    to all descendants), deform the mesh with linear blend skinning, and make the result the new rest pose."""
    m = copy.deepcopy(model)
    G = model.joint_world
    P = G.copy()
    ch = children_of(model)
    for j in topo_order(model):
        if j not in world_rotations:
            continue
        pivot = P[j][:3, 3].copy()
        T = np.eye(4)
        T[:3, :3] = world_rotations[j]
        T[:3, 3] = pivot - world_rotations[j] @ pivot
        stack = [j]
        while stack:
            k = stack.pop()
            P[k] = T @ P[k]
            stack.extend(ch[k])
    skin = np.einsum("nij,njk->nik", P, np.linalg.inv(G))  # bind -> posed, per joint
    for p in m.prims:
        w = p.weights / np.maximum(p.weights.sum(1, keepdims=True), 1e-9)
        Mv = np.einsum("vk,vkij->vij", w, skin[p.joints])
        p.positions = np.einsum("vij,vj->vi", Mv, np.c_[p.positions, np.ones(len(p.positions))])[:, :3]
        if p.normals is not None:
            n = np.einsum("vij,vj->vi", Mv[:, :3, :3], p.normals)
            p.normals = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
    m.joint_world = P
    return m


def clear_joint_rotations(model: Model) -> Model:
    """Make every joint's rest orientation world-aligned (translation only), as VRM 1.0 expects.
    The mesh does not move: only the bind frames change."""
    m = copy.deepcopy(model)
    for k in range(len(m.joint_world)):
        t = m.joint_world[k][:3, 3].copy()
        m.joint_world[k] = np.eye(4)
        m.joint_world[k][:3, 3] = t
    return m
