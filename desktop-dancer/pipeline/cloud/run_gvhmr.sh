#!/usr/bin/env bash
# Run GVHMR on a cloud NVIDIA GPU (RunPod, Vast, Lambda, a Colab terminal...) and export the result
# for Desktop Dancer.  Usage:  bash run_gvhmr.sh my_dance.mp4 [--moving-camera]
#
# One-time requirements (see README.md in this folder):
#   - SMPL-X / SMPL body models: register at https://smpl-x.is.tue.mpg.de and https://smpl.is.tue.mpg.de,
#     then upload SMPLX_NEUTRAL.npz and SMPL_NEUTRAL.pkl next to this script (or into $BODY_MODELS).
#   - GVHMR is licensed for non-commercial use only.
set -euo pipefail

VIDEO=${1:?usage: run_gvhmr.sh VIDEO [--moving-camera]}
STATIC="-s"
[[ "${2:-}" == "--moving-camera" ]] && STATIC=""
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${WORK:-$HOME/gvhmr-work}
BODY_MODELS=${BODY_MODELS:-$HERE}
VIDEO=$(realpath "$VIDEO")
NAME=$(basename "${VIDEO%.*}")

nvidia-smi >/dev/null || { echo "NVIDIA GPU가 필요합니다 (nvidia-smi 실패)"; exit 1; }
mkdir -p "$WORK" && cd "$WORK"

if [[ ! -d GVHMR ]]; then
  git clone --depth 1 https://github.com/zju3dv/GVHMR
fi
cd GVHMR

if [[ ! -f .installed ]]; then
  # The upstream instructions use a conda env with python 3.10; a venv works the same way.
  PY=${PYTHON:-python3.10}
  command -v "$PY" >/dev/null || PY=python3
  "$PY" -m venv .venv
  source .venv/bin/activate
  pip install -U pip
  pip install -r requirements.txt
  pip install -e .
  pip install gdown
  touch .installed
else
  source .venv/bin/activate
fi

mkdir -p inputs/checkpoints/body_models/smplx inputs/checkpoints/body_models/smpl outputs
for f in SMPLX_NEUTRAL.npz; do
  [[ -f inputs/checkpoints/body_models/smplx/$f ]] || cp "$BODY_MODELS/$f" inputs/checkpoints/body_models/smplx/ \
    || { echo "$BODY_MODELS/$f 가 없습니다 (SMPL-X 등록 후 내려받아 올려주세요)"; exit 1; }
done
for f in SMPL_NEUTRAL.pkl; do
  [[ -f inputs/checkpoints/body_models/smpl/$f ]] || cp "$BODY_MODELS/$f" inputs/checkpoints/body_models/smpl/ \
    || { echo "$BODY_MODELS/$f 가 없습니다 (SMPL 등록 후 내려받아 올려주세요)"; exit 1; }
done

# Pretrained GVHMR / ViTPose / YOLO / HMR2 weights (Google Drive folder from the GVHMR install guide)
if [[ ! -f inputs/checkpoints/gvhmr/gvhmr_siga24_release.ckpt ]]; then
  gdown --folder "https://drive.google.com/drive/folders/1eebJ13FUEXrKBawHpJroW0sNSxLjh9xD" -O inputs/checkpoints_dl
  cp -rn inputs/checkpoints_dl/*/* inputs/checkpoints/ 2>/dev/null || cp -rn inputs/checkpoints_dl/* inputs/checkpoints/
fi

python tools/demo/demo.py --video="$VIDEO" $STATIC
RESULT="outputs/demo/$NAME/hmr4d_results.pt"
python "$HERE/export_gvhmr.py" "$RESULT" "$HERE/$NAME.gvhmr.npz"
echo
echo "완료: $HERE/$NAME.gvhmr.npz"
echo "PC로 내려받은 뒤:  python extract_dance.py \"$NAME.mp4\" --engine gvhmr --gvhmr-result $NAME.gvhmr.npz"
