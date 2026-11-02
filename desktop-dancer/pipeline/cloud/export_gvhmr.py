#!/usr/bin/env python3
"""GVHMR result (hmr4d_results.pt) -> small .npz for extract_dance.py --engine gvhmr.

  python export_gvhmr.py outputs/demo/<video>/hmr4d_results.pt my_dance.npz [--fps 30]

Needs only torch (already installed wherever GVHMR ran). The npz holds the world-space
SMPL(-X) body parameters: global_orient (F,3), body_pose (F,63), transl (F,3), betas, fps.
"""
import argparse

import numpy as np
import torch

ap = argparse.ArgumentParser()
ap.add_argument("pt")
ap.add_argument("out")
ap.add_argument("--fps", type=float, default=30.0, help="GVHMR demo works at 30 fps")
a = ap.parse_args()

pred = torch.load(a.pt, map_location="cpu")
g = pred["smpl_params_global"]
arr = {k: v.detach().cpu().numpy().astype(np.float32) for k, v in g.items() if hasattr(v, "detach")}
np.savez_compressed(a.out, global_orient=arr["global_orient"], body_pose=arr["body_pose"][:, :63],
                    transl=arr["transl"], betas=arr.get("betas", np.zeros((1, 10), np.float32)), fps=a.fps)
print(f"saved {a.out}: {len(arr['global_orient'])} frames")
