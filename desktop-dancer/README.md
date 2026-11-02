# Desktop Dancer

Windows 작업표시줄 위에서 3D 캐릭터(VRM)가 춤(VRMA)을 추는 데스크탑 앱입니다.
현재 단계는 **Part C MVP**입니다. 샘플 캐릭터와 샘플 춤이 작업표시줄 위에서 반복 재생됩니다.
영상에서 춤을 추출하는 Part B와 그림 한 장으로 캐릭터를 만드는 Part A(`pipeline/`)도 들어 있습니다. 자세한 내용은 [docs/spec.md](docs/spec.md)를 참고하세요.

## 받기 (Windows)

GitHub 저장소 **Actions → Build Desktop Dancer (Windows)** 에서 최근 실행을 엽니다.
**Artifacts** 의 `desktop-dancer-windows` 를 내려받으면 아래 두 파일이 들어 있습니다.

- `DesktopDancer-…-portable.exe` — 설치 없이 바로 실행
- `DesktopDancer-…-setup.exe` — 설치 프로그램 (시작 메뉴 등록, 제거 가능)

코드 서명이 없어 처음 실행할 때 SmartScreen 경고가 뜹니다. **추가 정보 → 실행**을 누르세요.

## 사용법

- 실행하면 화면 오른쪽 아래, 작업표시줄 바로 위에서 캐릭터가 춤을 춥니다.
- 캐릭터가 아닌 빈 영역은 클릭이 뒤의 창으로 그대로 전달됩니다.
- 캐릭터를 잡고 좌우로 끌면 작업표시줄을 따라 위치가 바뀝니다.
- **트레이 아이콘**
  - 클릭: 보이기/숨기기
  - 우클릭 메뉴: 캐릭터·춤 변경, VRM/VRMA 파일 추가, 크기, 모니터, 속도, FPS 제한, 자동 실행, 위치 초기화, 라이브러리 폴더 열기, 종료
- **캐릭터 → 샘플 캐릭터 내려받기 (Seed-san)** 를 누르면 VRM 컨소시엄의 샘플 캐릭터를 받습니다. 라이선스는 VRM Public License 1.0입니다.
- 내가 가진 `.vrm` / `.vrma` 파일은 **파일 추가…** 로 넣을 수 있습니다. **라이브러리 폴더 열기** 로 연 폴더에 직접 복사해도 됩니다. 폴더 위치는 `%APPDATA%\desktop-dancer\library` 입니다.

## 처음 한 번: 준비

춤 만들기나 캐릭터 만들기 창을 처음 열면 **설치 시작** 버튼이 나옵니다. 누르면 필요한 도구가 앱 전용 폴더(`%APPDATA%\desktop-dancer`)에 자동으로 설치됩니다.

- Python도 함께 내려받기 때문에 **따로 설치할 필요가 없습니다.**
- 처음 한 번 수백 MB를 내려받으며, 몇 분 걸립니다.

## 내 춤 영상으로 모션 만들기

트레이 메뉴에서 **춤 만들기 (영상에서)…** 를 누르세요.

1. **영상 넣기**
   - 영상을 끌어 놓거나 URL을 넣고, **지금 위치로** 버튼으로 시작과 끝을 정합니다.
   - 유튜브 URL을 쓰려면 위의 준비 단계로 설치된 도구가 필요합니다.
2. **인식 방식 고르기**
   - **정확하게 (RTMW3D)**: 기본값. 그래픽카드를 씁니다(DirectML이라 AMD·인텔·NVIDIA 모두 가능). 처음 한 번 모델 약 300MB를 내려받으며, 안 되면 자동으로 ‘보통’으로 바뀝니다.
   - **보통 / 빠르게 (MediaPipe)**: 가볍게 CPU로 인식합니다.
3. **더 정확하게 만들고 싶을 때**
   - Rokoko Vision(카메라 1대 무료), Plask, DeepMotion, QuickMagic 같은 웹 모캡 서비스에서 같은 영상을 처리해 **BVH**로 받습니다.
   - 받은 BVH를 같은 칸에 넣으면 그대로 변환됩니다. 창 안의 안내에 각 서비스 바로가기가 있습니다.
4. **결과 확인**: 반복 재생, 움직임, 거울 영상 등을 설정하고 **춤 만들기**를 누른 뒤, **지금 춤추게 하기**로 바로 적용합니다.

## 내 그림으로 캐릭터 만들기

트레이 메뉴에서 **캐릭터 만들기 (그림에서)…** 를 누르세요.

1. **그림 고르기**: 전신, 정면, T/A 포즈인지 자동으로 확인해 줍니다.
2. **3D 모델 만들기** — 방법 세 가지 중 하나를 고릅니다.
   - **A. 무료 웹 생성기 + 내 PC 자동 리깅 (추천, 그래픽카드 상관없음)**
     - Tripo나 Meshy 웹사이트에 그림을 올려 GLB를 받습니다.
     - 받은 GLB를 넣으면 뼈대는 **이 PC에서 자동으로** 넣습니다. CPU만 쓰고 약 15초 걸리며, AMD도 됩니다.
   - **B. 클라우드 GPU (TRELLIS + UniRig)**: 오픈소스이고, NVIDIA GPU를 빌려서 씁니다.
   - **C. VRoid Studio**
     - 얼굴, 머리카락, 옷까지 **슬라이더로 세밀하게** 직접 디자인하는 무료 프로그램입니다(코이카츠와 비슷).
     - VRM으로 내보내서 넣습니다.
3. **결과 가져오기**: `.glb` 나 `.vrm` 을 끌어 놓습니다. 뼈대가 없는 GLB는 자동으로 리깅됩니다.
4. **확인 · 다듬기 · 적용**
   - 3D 미리보기와 춤 미리보기로 확인합니다.
   - 슬라이더로 **키, 머리 크기, 어깨 너비, 팔·다리 길이, 밝기**를, 재질별(머리카락·피부·옷…) **색**을 조정합니다.
   - 조정값은 원본 파일과 따로 저장되어 언제든 처음대로 되돌릴 수 있습니다. 라이브러리의 모든 캐릭터(VRoid 캐릭터 포함)에 쓸 수 있습니다.

## 기본 포함 에셋

권리 문제가 없도록 두 파일 모두 코드로 생성했습니다. 생성 스크립트는 `npm run gen:samples` 입니다.

| 파일 | 내용 |
|---|---|
| `assets/characters/mannequin.vrm` | 박스로 만든 VRM 1.0 휴머노이드 마네킹 |
| `assets/motions/sample-dance.vrma` | 120 BPM, 4초 길이의 제자리 춤 루프 (팔 펌핑 → 팔 들어 흔들기) |

## 개발

Node 20 이상이 필요합니다.

```bash
npm ci
npm start        # 앱 실행
npm test         # 창 배치 단위 테스트 + 캐릭터/춤 로딩·발 미끄러짐·루프 검사
npm run dist     # Windows용 exe 빌드 (Windows에서 실행)
```

다른 VRM/VRMA 조합이 깨지지 않는지 검사하려면 아래처럼 실행합니다.

```bash
node scripts/check-assets.mjs path/to/character.vrm path/to/motion.vrma
```

개발용 환경 변수입니다.

- `DANCER_SELFTEST=out.png`: 몇 초 뒤 창을 캡처해 저장하고 앱을 종료합니다. 대기 시간은 `DANCER_SELFTEST_DELAY` 로 바꿉니다(ms).
- `DANCER_FREEZE_T=1.5`: 춤을 해당 시각에 멈춥니다.
- `DANCER_USER_DATA=dir`: 설정과 라이브러리 폴더 위치를 바꿉니다.
- `DANCER_RECORD=dir`: 모션을 30fps PNG 프레임으로 렌더링한 뒤 종료합니다. 프레임 수는 `DANCER_RECORD_FRAMES` 로 정합니다. 추출 정확도 테스트용 영상을 만들 때 씁니다.

## 구조

- `src/main.js`: 투명 창, 트레이 메뉴, 라이브러리, 드래그, 화면 변화 감지
- `src/placement.js`: 작업표시줄 감지와 창 위치 계산 (순수 함수)
- `src/settings.js`: 설정 저장
- `src/studio/`, `src/studio-preload.js`: "춤 만들기" 창
- `src/pipeline-runner.js`: uv로 Python과 패키지를 자동 설치하고, 파이프라인 실행과 진행률을 전달
- `src/charstudio/`, `src/charstudio-preload.js`: "캐릭터 만들기" 창 (그림 확인, 만드는 방법 안내, 변환, 3D 미리보기, 다듬기)
- `src/renderer/customize.js`: 비율·색 다듬기 (`<캐릭터>.custom.json`, 앱과 미리보기가 같이 사용)
- `scripts/preview/`: 모델을 앞·옆·뒤에서 렌더링하는 개발용 미리보기 (Playwright)
- `src/preload.js`: 렌더러에 노출하는 IPC API
- `src/renderer/`: three.js + three-vrm 렌더링, 픽셀 알파로 클릭 통과 판정, FPS 제한
- `scripts/vendor.mjs`: 렌더러가 쓰는 라이브러리를 `src/renderer/vendor/`로 복사 (`npm start`·`npm run dist` 때 자동 실행)
- `scripts/make-samples.mjs`, `skeleton.mjs`, `dance.mjs`, `gltf-writer.mjs`: 샘플 VRM/VRMA 생성
- `scripts/check-assets.mjs`, `scripts/test-placement.mjs`: 테스트

## 알려진 한계 (MVP)

- 클릭 통과와 마우스 오버 판정은 Windows/macOS에서만 동작합니다. Electron의 마우스 이벤트 전달 기능이 Linux를 지원하지 않기 때문입니다.
- 작업표시줄이 위나 옆에 있을 때는 캐릭터가 화면 아래쪽 작업 영역에 섭니다.
- 전체 화면 게임이나 영상을 재생할 때 자동으로 숨기는 기능은 아직 없습니다. 트레이 클릭으로 직접 숨기세요.
