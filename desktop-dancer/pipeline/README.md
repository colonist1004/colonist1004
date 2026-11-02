# 춤 추출 파이프라인 (Part B)

춤 영상에서 동작을 뽑아 VRMA 파일로 저장합니다.
결과는 앱의 모션 라이브러리(`%APPDATA%\desktop-dancer\library\motions`)에 바로 저장되어 트레이 메뉴 **춤**에 자동으로 나타납니다.

엔진은 두 가지 중에서 고릅니다.

| 엔진 | 실행 위치 | 품질 | 라이선스 |
|---|---|---|---|
| **MediaPipe** (기본) | 내 PC CPU. AMD GPU라도 상관없음 | 보통. 후처리로 보완 | Apache 2.0 (상업 이용 가능) |
| **GVHMR** | 클라우드 NVIDIA GPU (RunPod, Colab 등) | 높음. 전역 이동과 점프까지 복원 | **비상업 전용** (GVHMR, SMPL-X 둘 다) |

## 설치 (Windows, MediaPipe)

Python 3.10~3.12가 필요합니다.

```bash
cd desktop-dancer\pipeline
```

```bash
python -m venv .venv
```

```bash
.venv\Scripts\activate
```

```bash
pip install -r requirements.txt
```

첫 실행 때 MediaPipe 모델(약 30MB)을 자동으로 내려받습니다.

## 사용법

```bash
python extract_dance.py 춤영상.mp4 --start 12 --end 40 --name 내춤 --loop
```

URL도 넣을 수 있습니다. yt-dlp로 내려받으며, 내려받기는 본인이 권리를 가진 영상에만 하세요(유튜브 약관 주의).

```bash
python extract_dance.py "https://www.youtube.com/watch?v=..." --start 5 --end 25
```

자주 쓰는 옵션입니다.

| 옵션 | 설명 |
|---|---|
| `--start`, `--end` | 사용할 구간(초) |
| `--name` | 모션 이름. 기본은 영상 파일 이름 |
| `--loop` | 처음 자세와 가장 비슷한 지점에서 잘라 끝과 시작을 이어 붙임. 반복 재생용 |
| `--root planted` (기본) | 디딘 발을 기준으로 몸이 조금씩 이동 (`--range` 범위 안, 기본 ±25cm) |
| `--root inplace` | 완전히 제자리에서만 춤 |
| `--root original` | 원본 이동 그대로 (GVHMR 전용) |
| `--mirror` | 좌우 반전. 거울 모드 안무 영상에 사용 |
| `--person 1` | 여러 명이 나올 때 대상 지정 (첫 장면 기준 왼쪽부터 0, 1, 2…). 기본은 가장 크게 보이는 사람 |
| `--smooth 2` | 떨림 제거를 더 강하게 (0이면 끔) |
| `--model full` | MediaPipe 모델을 가벼운 것으로 바꿔 속도를 높임 (`lite`/`full`/`heavy`) |
| `--out 폴더/파일.vrma` | 저장 위치 지정 |

출력은 `<이름>.vrma` 와 `<이름>.json`(원본 출처, 구간, 옵션 메타데이터) 두 파일입니다.

**영상 권장 조건:** 전신이 보이고, 카메라가 고정되어 있고, 몸이 가려지지 않으며, 정면 위주인 영상이 좋습니다.

## GVHMR (클라우드 GPU, 고품질)

1. SMPL-X(https://smpl-x.is.tue.mpg.de)와 SMPL(https://smpl.is.tue.mpg.de)에 가입합니다. `SMPLX_NEUTRAL.npz`, `SMPL_NEUTRAL.pkl` 을 내려받습니다.
2. NVIDIA GPU 클라우드 인스턴스를 띄웁니다. RunPod의 PyTorch 템플릿을 권장합니다.
3. `cloud/` 폴더, 1번의 두 파일, 춤 영상을 올립니다. 그다음 아래 명령을 실행합니다.

   ```bash
   bash cloud/run_gvhmr.sh 춤영상.mp4
   ```

   카메라가 움직이는 영상이면 `--moving-camera` 를 붙입니다.
4. 생성된 `춤영상.gvhmr.npz` 를 PC로 내려받은 뒤 아래 명령을 실행합니다.

   ```bash
   python extract_dance.py 춤영상.mp4 --engine gvhmr --gvhmr-result 춤영상.gvhmr.npz --loop
   ```

GVHMR 공식 Colab 데모로 만든 `hmr4d_results.pt` 도 `--gvhmr-result` 에 바로 넣을 수 있습니다. 이 경우 `torch` 가 설치되어 있어야 합니다.

## 처리 과정

1. **포즈 추정**
   - MediaPipe의 2D 랜드마크(정확함)와 3D 랜드마크(깊이가 부정확함)를 함께 씁니다.
   - x/y는 2D 랜드마크에서 가져옵니다.
   - 깊이는 뼈 길이로 다시 계산하고, MediaPipe 3D는 관절이 앞인지 뒤인지 판단할 때만 씁니다.
2. **보정**
   - 사람이 감지되지 않은 프레임은 앞뒤 프레임으로 보간합니다.
   - 카메라 기울기를 보정합니다. 평균 몸통 방향을 수직으로 맞춥니다.
   - 떨림을 제거합니다. 앞뒤 프레임을 함께 보고 부드럽게 만들어 지연이 생기지 않습니다.
3. **리타게팅**: 관절 위치를 VRM 휴머노이드 뼈 회전으로 바꿉니다. 팔꿈치와 무릎은 굽힘 평면으로 비틀림을 정합니다.
4. **바닥 처리**: 발목과 발끝이 바닥 아래로 내려가지 않게 엉덩이 높이를 맞춥니다.
5. **발 고정**
   - 디딘 발을 감지해 그 자리에 고정하고, 다리를 IK로 다시 계산합니다.
   - planted 모드에서는 디딘 발 기준으로 몸을 이동시킵니다.
6. **루프** (`--loop`): 처음 자세와 가장 비슷한 지점에서 자르고, 남은 차이를 0.5초에 걸쳐 서서히 맞춥니다.

## 테스트와 검증

```bash
python tests/test_roundtrip.py
```

위 테스트는 numpy만 있으면 돌아가며, 아래 항목을 검사합니다.

- 리타게팅 정확도
- 카메라 기울기 보정
- 노이즈 제거 효과
- SMPL 변환 (Z-up 좌표계도 포함)
- GVHMR CLI 경로
- 루프 이음매

추출 결과는 아래 두 도구로 검증합니다.

- 정답 모션이 있을 때 정확도 비교:

  ```bash
  python tools/compare_motion.py 추출.vrma 정답.vrma
  ```

- 아무 캐릭터에 적용했을 때 발 미끄러짐, 바닥 뚫림, 루프 확인:

  ```bash
  node ../scripts/check-assets.mjs 캐릭터.vrm 추출.vrma --no-loop
  ```

## 알려진 한계

- **MediaPipe 정확도:** 손이 몸 앞에서 카메라 쪽을 향할 때(깊이 방향) 오차가 큽니다. 빠른 회전이나 뒤돌기에서는 좌우가 뒤바뀔 수 있습니다. 이런 영상은 GVHMR을 쓰세요.
- **점프:** MediaPipe 엔진은 점프를 복원하지 못합니다. 항상 한 발이 바닥에 붙습니다. GVHMR 엔진은 점프를 유지합니다.
- **캐릭터 체형 차이:** 발 고정은 기준 체형으로 계산합니다. 체형이 많이 다른 캐릭터에서는 발이 조금 미끄러질 수 있고, 손이 몸을 뚫는 문제도 아직 보정하지 않습니다.
- **추출 범위:** 손가락과 표정은 추출하지 않고, 음악도 저장하지 않습니다.
