#!/usr/bin/env bash
# Image -> 3D mesh (TRELLIS) -> skeleton + skin weights (UniRig) -> VRM, on a cloud NVIDIA GPU.
#
#   bash run_character.sh my_character.png [name]
#
# Needs an NVIDIA GPU with >= 16 GB VRAM (TRELLIS) and ~40 GB disk. Tested layout: RunPod
# "PyTorch" template (Ubuntu, CUDA 12.x). First run installs everything (~20-30 min); later runs
# reuse it (~3-5 min per character). Both TRELLIS and UniRig are MIT licensed.
#
# Output (next to this script):  <name>.vrm  (ready for Desktop Dancer)  and  <name>.rigged.glb
set -euo pipefail

IMG=$(realpath "${1:?usage: run_character.sh IMAGE [name]}")
NAME=${2:-$(basename "${IMG%.*}")}
HERE=$(cd "$(dirname "$0")" && pwd)
PIPE=$(cd "$HERE/.." && pwd)            # desktop-dancer/pipeline (for make_character.py)
WORK=${WORK:-$HOME/char-work}
OUT=$WORK/out/$NAME
mkdir -p "$WORK" "$OUT"

nvidia-smi >/dev/null || { echo "NVIDIA GPU가 필요합니다 (nvidia-smi 실패)"; exit 1; }

# ---------------------------------------------------------------- conda
if ! command -v conda >/dev/null; then
  if [[ ! -x $WORK/miniconda/bin/conda ]]; then
    wget -q https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -O "$WORK/mc.sh"
    bash "$WORK/mc.sh" -b -p "$WORK/miniconda"
  fi
  export PATH="$WORK/miniconda/bin:$PATH"
fi
eval "$(conda shell.bash hook)"
conda config --set always_yes yes >/dev/null
conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/main >/dev/null 2>&1 || true
conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/r >/dev/null 2>&1 || true

# ---------------------------------------------------------------- TRELLIS (image -> textured mesh)
cd "$WORK"
[[ -d TRELLIS ]] || git clone --recurse-submodules https://github.com/microsoft/TRELLIS.git
if [[ ! -f TRELLIS/.installed ]]; then
  (cd TRELLIS && . ./setup.sh --new-env --basic --xformers --flash-attn --diffoctreerast --spconv --mipgaussian --kaolin --nvdiffrast)
  touch TRELLIS/.installed
fi
conda activate trellis
echo "[1/3] TRELLIS: 이미지 → 3D"
(cd TRELLIS && SPCONV_ALGO=native python - "$IMG" "$OUT/mesh.glb" <<'PY'
import sys
from PIL import Image
from trellis.pipelines import TrellisImageTo3DPipeline
from trellis.utils import postprocessing_utils
pipe = TrellisImageTo3DPipeline.from_pretrained("microsoft/TRELLIS-image-large")
pipe.cuda()
out = pipe.run(Image.open(sys.argv[1]), seed=1)   # background removal is part of the pipeline
glb = postprocessing_utils.to_glb(out["gaussian"][0], out["mesh"][0], simplify=0.95, texture_size=2048)
glb.export(sys.argv[2])
print("mesh:", sys.argv[2])
PY
)
conda deactivate

# ---------------------------------------------------------------- UniRig (skeleton + skinning)
[[ -d UniRig ]] || git clone https://github.com/VAST-AI-Research/UniRig.git
if [[ ! -f UniRig/.installed ]]; then
  conda create -n unirig python=3.11
  conda activate unirig
  pip install torch torchvision
  TORCH=$(python -c "import torch;print(torch.__version__.split('+')[0])")
  CU=$(python -c "import torch;print('cu'+torch.version.cuda.replace('.',''))")
  (cd UniRig && pip install -r requirements.txt)
  # spconv wheels exist per CUDA line (cu118, cu120, cu121, cu124, cu126); pick the closest one.
  for c in "$CU" cu126 cu124 cu121 cu120 cu118; do pip install "spconv-$c" && break; done
  pip install torch_scatter torch_cluster -f "https://data.pyg.org/whl/torch-${TORCH}+${CU}.html" --no-cache-dir
  pip install numpy==1.26.4
  pip install flash_attn --no-build-isolation || echo "flash_attn 설치 실패 — UniRig README의 안내를 확인하세요"
  conda deactivate
  touch UniRig/.installed
fi
conda activate unirig
cd UniRig
echo "[2/3] UniRig: 뼈대 + 스키닝"
ok=""
for seed in 12345 42 7 2024; do
  bash launch/inference/generate_skeleton.sh --input "$OUT/mesh.glb" --output "$OUT/skeleton.fbx" --seed $seed
  bash launch/inference/generate_skin.sh --input "$OUT/skeleton.fbx" --output "$OUT/skin.fbx"
  bash launch/inference/merge.sh --source "$OUT/skin.fbx" --target "$OUT/mesh.glb" --output "$OUT/rigged.glb"
  echo "[3/3] VRM 변환 (seed $seed)"
  if python "$PIPE/make_character.py" "$OUT/rigged.glb" --name "$NAME" --out "$OUT/$NAME.vrm"; then
    ok=1; break
  fi
  echo "사람 뼈대로 인식되지 않음 → 다른 seed로 뼈대를 다시 만듭니다"
done
conda deactivate

cp "$OUT/rigged.glb" "$HERE/$NAME.rigged.glb"
if [[ -n $ok ]]; then
  cp "$OUT/$NAME.vrm" "$HERE/$NAME.vrm"
  echo; echo "완료: $HERE/$NAME.vrm  (PC로 내려받아 앱의 ‘캐릭터 만들기’ 창에 넣으세요)"
else
  echo; echo "VRM 변환은 실패했지만 리깅 결과는 있습니다: $HERE/$NAME.rigged.glb"
  echo "포즈가 T/A 포즈가 아니거나 전신이 아닌 이미지일 수 있습니다. 다른 이미지로 시도해 보세요."
  exit 2
fi
