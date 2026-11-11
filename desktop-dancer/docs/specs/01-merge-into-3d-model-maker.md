# 01. Desktop Dancer를 3D 모델 제작기에 병합

> 작성 기준: Desktop Dancer `claude/new-session-1rr4dt` 브랜치, 커밋 `3d57eab` (2026-11).
> 이 문서에서 **호스트** = 3D 모델 제작기, **댄서** = Desktop Dancer에서 옮겨 오는 부분.
> 호스트의 코드를 보지 못한 상태에서 썼다. 호스트 쪽 사실이 필요한 곳은 10장에 질문으로 모았다.

## 1. 목적

Desktop Dancer의 재생·상호작용·모션 제작 기능을 3D 모델 제작기 안으로 옮겨, 한 프로그램에서 "모델 제작(호스트 기존 기능) → 바탕화면에서 춤추기(댄서)"가 이어지게 한다.
3D 모델을 만드는 기능은 호스트 것을 쓰고, 댄서의 것은 가져오지 않는다.

## 2. 범위

- 포함: 댄서 창(작업표시줄 위 캐릭터), 살아 있는 느낌(반응·산책·앉기·음악), 툰 셰이더와 조명 설정, 위치·크기 창, 춤 만들기·포즈 만들기 창과 그 Python 파이프라인, 포즈 저장, 창 감시(게임 모드·창 위에 앉기), 라이브러리·설정 저장, 트레이 메뉴, 테스트.
- 호스트와의 연결: 호스트가 만든 VRM을 댄서 캐릭터로 바로 쓰는 경로 (F9).

## 3. 범위 밖 (하지 않을 것)

- **3D 모델 만드는 기능 전부** (사용자 지정). 댄서에서 아래를 가져오지 않는다.
  - 캐릭터 만들기 창: `src/charstudio/`, `src/charstudio-preload.js`, IPC `char:*` 전부
  - Python: `pipeline/make_character.py`, `gen_local.py`, `gen_setup.py`, `check_image.py`, `requirements-gen.txt`, `dancer_pipeline/char/` 전체(자동 리깅·베이크·스프링본·VRM 작성), `dancer_pipeline/gen_sources.py`, `pipeline/cloud/run_character.sh`
  - `src/pipeline-runner.js`의 `genStatus`, `setupGen`, `runGen`, `buildCharArgs`와 `userData/gen-env`
  - 트레이 항목 "캐릭터 만들기 (그림에서)…", "샘플 캐릭터 내려받기"는 10장 Q5에서 결정
  - 테스트 `pipeline/tests/test_character.py`, `test_gen.py`, `make_char_fixture.py`
- Android 앱(`desktop-dancer/mobile`, `.github/workflows/desktop-dancer-android.yml`).
- 포터블 exe 빌드 (설치 프로그램만).
- 댄서에 없는 새 기능 추가. 병합은 동작을 바꾸지 않고 옮기는 작업이다.
- 호스트 기존 기능의 동작 변경.

## 4. 입력 / 출력

- 입력
  - 캐릭터: VRM 1.0 또는 0.x 파일 (호스트가 만든 것 포함)
  - 춤: VRMA 1.0. 포즈: `<이름>.pose.vrma` (같은 키 2개, 1초 간격)
  - 춤 만들기 입력: 영상 파일, URL, `.bvh`, `.vmd`. 포즈 만들기 입력: 사진(jpg, png, webp)
- 출력
  - 춤·포즈 파일: 사용자 라이브러리 `library/motions/`
  - 저장한 포즈: `library/motions/내 포즈 N.pose.vrma`
  - 설정: `settings.json` (7장)

## 5. 기능 목록

"필수"는 병합 후에도 지금과 똑같이 동작해야 하는 것. 원본 파일은 모두 `desktop-dancer/` 기준.

| ID | 기능 | 우선순위 | 원본 | 비고 |
|----|------|----------|------|------|
| F1 | 댄서 창: 투명·테두리 없음·항상 위·포커스 안 받음, 캐릭터 픽셀만 클릭됨(알파 판정), 작업표시줄 위 배치, 모니터 선택, 크기 25~1600%, 끌어서 이동, Ctrl+휠 크기, 작업표시줄 뒤로, FPS 24/30/60, 속도 | 필수 | `src/main.js`, `src/placement.js`, `src/renderer/renderer.js` | |
| F2 | 위치·크기 창 (크기·가로·높이·앉았을 때 높이 보정 ±200px) | 필수 | `src/placewin/`, `src/placewin-preload.js` | |
| F3 | 라이브러리: 기본 에셋 + 사용자 폴더, VRM/VRMA 파일 추가, 폴더 감시로 메뉴 자동 갱신, 캐릭터별 `<이름>.custom.json` 읽어 적용 | 필수 | `src/main.js`, `src/renderer/customize.js` | custom.json을 **편집**하는 UI는 캐릭터 만들기 창에 있었음 → Q4 |
| F4 | 살아 있는 느낌: 깜빡임, 마우스 쳐다보기, 클릭·쓰다듬기·들어 올리기 반응, 포즈일 때 숨쉬기 | 필수 | `src/renderer/life.js` | VRM 0.x는 x/z 회전 반전(`vrmAxisSign`) |
| F5 | Alt+끌기(손·발·가슴), Shift로 고정, 고정 풀기, 지금 포즈 저장 | 필수 | `life.js`, `renderer.js`, `src/vrma-writer.js` | |
| F6 | 산책, 산책 뒤 쉬기, 앉아서 춤추기, 앉는 자세 8종(랜덤 포함), 다리 흔들기, 앉을 때 창 아래로 늘리기 | 필수 | `src/wander.js`, `life.js`, `src/renderer/poses-data.js`, `placement.js` | |
| F7 | 창 감시(Windows): 게임·전체 화면일 때 숨기기, 앞 창 위에 앉기, 끌어서 창 위에 놓기 | 필수 | `src/perch.js`, `main.js` | PowerShell + C# 도우미 프로세스. 실제 Windows 검증 아직 안 됨 |
| F8 | 음악에 맞춰 춤추기 (PC 소리 loopback, 박자 추적) | 필수 | `src/renderer/beat.js`, `music.js`, `main.js`의 `allowSystemAudio` | Windows 전용 |
| F9 | 전용 툰 셰이더(강도, 머리카락 그림자), 조명 설정 창, MToon 아닌 재질 대체, 알파-데이터 재질 자동 불투명 | 필수 | `src/renderer/toon/`, `src/lightwin/`, `customize.js`의 `markAlphaData` | three-vrm 셰이더 문자열에 의존 (8장) |
| F10 | 춤 만들기·포즈 만들기 창과 파이프라인 (영상/URL/BVH/VMD → VRMA, 사진 → 포즈), 준비 설치(uv + Python 3.12) | 필수 | `src/studio/`, `src/studio-preload.js`, `src/pipeline-runner.js`(춤 부분), `pipeline/extract_dance.py`, `dancer_pipeline/`(char·gen 제외), `pipeline/cloud/`(GVHMR 부분) | |
| F11 | 기본 에셋: 마네킹 VRM, 샘플 춤, 기본 포즈 12종과 생성 스크립트 | 필수 | `assets/`, `scripts/make-samples.mjs`, `poses.mjs`, `dance.mjs`, `skeleton.mjs`, `gltf-writer.mjs`, `shared/skeleton.json` | |
| F12 | 트레이 메뉴 (댄서 항목 전체), Windows 시작 시 자동 실행 | 필수 | `main.js`의 `rebuildTrayMenu` | 호스트에 트레이가 이미 있으면 합침 → Q2 |
| F13 | **호스트 연결**: 호스트에서 만든 VRM을 "댄서로 보내기" 한 번으로 댄서 라이브러리에 넣고 현재 캐릭터로 선택 | 필수 | 신규 (기존 `char:apply`와 같은 동작) | 호스트 쪽 버튼 위치 → Q6 |
| F14 | 기존 Desktop Dancer 사용자 데이터 이어받기 (설정·라이브러리) | 필수 | 신규 | 방식 → Q3 |
| F15 | 테스트 이전: `npm test`의 댄서 항목과 파이프라인 테스트 | 필수 | `scripts/test-*.mjs`, `check-*.mjs`, `pipeline/tests/`(char·gen 제외) | |

## 6. UI / 동작

- 댄서 창과 그 보조 창(위치·크기, 조명 설정, 춤/포즈 만들기)의 화면·문구·단축키는 지금 그대로 둔다.
- 트레이 메뉴 구성(현재): 보이기/숨기기, 춤 만들기, 포즈 만들기, 캐릭터, 춤, 포즈(지금 포즈 저장·고정 풀기 포함), 크기, 위치·크기 자세히 조정, 모니터, 속도, FPS 제한, 보기(툰 셰이더·조명 설정), 앉는 자세, 반응(8개 체크), Windows 시작 시 자동 실행, 위치 초기화, 라이브러리 폴더 열기, 종료.
  - "캐릭터 만들기 (그림에서)…" 항목은 뺀다. 그 자리에 호스트의 모델 제작 화면을 여는 항목을 둘지는 Q5.
- 호스트 창을 닫아도 댄서는 트레이에서 계속 돈다 (현재 `window-all-closed`에서 종료하지 않음). 호스트의 종료 동작과 맞추는 방법은 Q2.
- 단일 실행(`requestSingleInstanceLock`)은 유지한다.

## 7. 데이터 구조 / 파일 포맷

### 7-1. 폴더
- 지금: `%APPDATA%\desktop-dancer\` 아래 `settings.json`, `library\characters`, `library\motions`, `tools`(uv), `python`, `pipeline-env`.
- Python 파이프라인은 이 폴더를 환경 변수 `DANCER_DATA_DIR`로 받는다. 병합 후 폴더가 바뀌면 이 값만 바꾸면 된다.
- 기본 에셋은 설치본의 `resources/assets`, 파이프라인은 `resources/pipeline` (electron-builder `extraResources`).

### 7-2. 설정 키 (`src/settings.js` DEFAULTS, 그대로 유지)
`visible, scale, xFraction(구버전), xCenter, yOffset, behindTaskbar, displayId, character, motion, speed, fps, lookAt, reactions, music, wander, restSit, light{face,hair,body,shade,sun,ambient,dirX,dirY}, sitStyle, sitOffset, gameMode, perch, sitDance, toonShader, toonStrength, toonHairShadow`
- 저장은 250ms 디바운스, 종료 시 `flush()`.
- 호스트 설정과 한 파일에 합칠 경우 댄서 키는 `dancer` 아래에 넣는다 (Q3).

### 7-3. IPC (이름 충돌 방지를 위해 병합 시 접두어를 붙일 대상)
- 댄서 창 ↔ main: `get-initial, read-asset, set-hover, drag, resize-by, sitting, busy, pose:captured, renderer-error, custom:get` / main → 창: `frame, load, settings, cursor, walk, rest-sit, perch, paused, capture-pose, release-pins, custom-updated`
- 보조 창: `place:get/set/reset`, `place:changed`, `light:get/set`, `view:get-settings`, `studio:*` 11개, `studio:mode`
- 가져오지 않음: `char:*` 13개, `custom:set`(편집 UI를 안 가져올 때. Q4)
- 보안 규칙 유지: 렌더러는 라이브러리 폴더 안의 파일만 읽는다(`read-asset`의 경로 검사). 모든 창은 `contextIsolation: true, nodeIntegration: false, sandbox: true`.

### 7-4. 파트 간 약속
- 좌표: VRM 1.0 기준 (+Y 위, 몸은 +Z를 봄, 캐릭터의 왼쪽 = +X). main의 좌표는 Electron DIP.
- 기준 뼈대: `shared/skeleton.json` (JS 샘플 생성기와 Python 파이프라인이 같이 씀).
- 재질 종류 힌트: glTF 재질 `extras.dancerToon = { kind, lightmap, shadeWarm }`. 호스트가 VRM을 쓸 때 이 값을 넣으면 툰 셰이더가 재질 이름 추측 대신 이 값을 쓴다 (선택 사항).

## 8. 환경 / 의존성

- Windows 11, AMD RX 9070 XT. 댄서 재생은 GPU 종류와 무관. 춤 추출은 로컬 실행(RTMW3D는 DirectML로 AMD GPU 사용, MediaPipe는 CPU). GVHMR만 클라우드 NVIDIA.
- JS: Electron ^33.4.11, three ^0.170.0, @pixiv/three-vrm ^3.5.5, @pixiv/three-vrm-animation ^3.5.5. 렌더러용 라이브러리는 `scripts/vendor.mjs`가 `src/renderer/vendor/`로 복사한다 (electron-builder가 `node_modules/*/examples`를 빼기 때문).
  - **버전 제약**: 툰 셰이더는 three-vrm 3.5의 MToon 프래그먼트 셰이더 문자열을 고쳐 쓴다. 호스트가 다른 three / three-vrm 버전을 쓰면 `scripts/check-toon.mjs`가 실패한다. 이 경우 호스트 버전에 맞춰 앵커를 고치거나, 댄서 창만 별도 사본을 쓴다 (Q1).
- Python(춤 파이프라인만): `numpy, opencv-python, mediapipe, yt-dlp[default], deno, onnxruntime-directml(Windows), tqdm, rtmlib==0.0.16(--no-deps)`. uv가 Python 3.12와 venv를 사용자 폴더에 설치한다.
- 창 감시: `powershell.exe` + `Add-Type`(C# 5). 추가 설치 없음.
- 빌드: electron-builder NSIS 설치 프로그램. 코드 서명 없음.

## 9. 완료 기준 (검증 방법)

- [ ] F1: 병합본을 실행하면 마네킹이 작업표시줄 위에서 샘플 춤을 춘다. 캐릭터 밖을 클릭하면 뒤의 창이 클릭된다. `scripts/test-placement.mjs` 통과.
- [ ] F2: 위치·크기 창에서 크기 200%, 높이 +100을 넣으면 창 bounds가 그 값대로 바뀐다. 앉았을 때 높이 보정 +50이면 앉은 엉덩이 뼈가 약 50px 내려간다.
- [ ] F3: 사용자 `library/characters`에 VRM을 복사하면 재시작 없이 트레이 캐릭터 목록에 나온다. `.custom.json`이 있는 캐릭터는 그 값이 적용된 모습으로 나온다.
- [ ] F4: 머리 클릭 → `happy`, 몸 클릭 → `surprised`, 5번 연속 클릭 → `angry` (`window.__dancer().react`).
- [ ] F5: Alt+끌기로 손을 옮기면 손 뼈가 커서에서 3px 이내. Shift로 놓으면 `pins`에 남는다. 지금 포즈 저장 후 다시 불러온 손·발 위치가 저장 전과 3px 이내 (VRM 1.0, 0.x 각각).
- [ ] F6: 앉는 자세 7종 각각에서 `sit.sitting === true`이고 허벅지 뼈 y가 바닥선 ±15px. 앉으면 창 높이가 늘어난다. `scripts/test-wander.mjs` 통과.
- [ ] F7: `scripts/test-perch.mjs` 통과. `DANCER_FULLSCREEN_FAKE`로 "보임 → 숨김·멈춤 → 다시 보임". `DANCER_WINDOWS_FAKE` 창 위에 놓으면 바닥이 창 위쪽 끝 +4px. **실제 Windows에서** 유튜브 전체 화면 시 숨는지, 창에 끌어 놓으면 앉는지 사용자가 확인.
- [ ] F8: `scripts/test-beat.mjs` 통과. `DANCER_FAKE_MUSIC=120`에서 `music.bpm`이 120±3.
- [ ] F9: `scripts/check-toon.mjs` 통과. 조명 설정에서 몸 밝기 160%로 올리면 캐릭터 몸 영역 평균 밝기가 올라가고, 기본값으로 버튼이 저장값을 되돌린다.
- [ ] F10: 춤 만들기 창에서 샘플 영상 → VRMA가 `library/motions`에 생기고 트레이 춤 목록에 나온다. `pipeline/tests/test_roundtrip.py`, `test_vmd.py` 통과.
- [ ] F11: `npm run gen:samples` 후 `scripts/check-assets.mjs`, `check-poses.mjs` 통과.
- [ ] F12: 트레이 메뉴에 6장의 항목이 모두 있고 "캐릭터 만들기 (그림에서)…"는 없다.
- [ ] F13: 호스트에서 VRM을 만든 뒤 "댄서로 보내기"를 누르면 5초 안에 그 캐릭터가 작업표시줄 위에 나온다.
- [ ] F14: 기존 `%APPDATA%\desktop-dancer`가 있는 PC에서 병합본을 처음 실행하면 이전 캐릭터·춤·위치·조명 설정이 그대로다.
- [ ] 범위 밖 확인: 병합본 소스에 `charstudio`, `gen_local`, `make_character`, `char:` IPC가 없다 (`grep`으로 0건).
- [ ] 호스트 회귀: 호스트 기존 테스트가 병합 전과 같은 결과.

## 10. 미정 사항 / 질문

호스트 코드를 보고 답하거나, 사용자가 정해야 하는 것.

- **Q1. 호스트의 기술 스택과 저장소 위치.** Electron인지(버전), three / three-vrm을 쓰는지(버전), 빌드 도구(번들러 유무). 이 답에 따라 병합 형태가 갈린다.
  - Electron이면: 한 main 프로세스에 댄서 모듈을 넣는다 (권장 형태).
  - Electron이 아니면(Unity, 웹, Python 등): 코드를 합칠 수 없으므로 "한 설치 프로그램 + 호스트가 댄서를 실행하고 VRM을 넘김" 형태가 된다. 그 경우 F12·F13·F14의 내용이 바뀐다.
- **Q2. 실행 형태.** 호스트 창을 닫으면 댄서도 끝낼지, 트레이에 남길지. 트레이 아이콘을 하나로 합칠지.
- **Q3. 데이터 폴더.** `%APPDATA%\desktop-dancer`를 그대로 쓸지, 호스트 폴더로 옮길지(옮기면 첫 실행 때 복사). 설정 파일을 합칠지 따로 둘지.
- **Q4. 슬라이더로 다듬기**(키·머리 크기·팔다리 길이·밝기·재질별 색·불투명)는 캐릭터 만들기 창 안에 있다. "3D 모델 만드는 기능"에 넣어 같이 뺄지, 이 부분만 남길지. 빼면 "옷이 비쳐 보일 때 불투명 체크"를 손으로 바꿀 방법이 없어진다(자동 판정은 남음).
- **Q5. 트레이의 "캐릭터 만들기" 자리**에 호스트 화면을 여는 항목을 둘지. "샘플 캐릭터 내려받기 (Seed-san)"를 남길지.
- **Q6. 호스트가 VRM을 내보내는 방식.** 내보내기 버전(1.0 / 0.x), 저장 위치, "댄서로 보내기" 버튼을 둘 화면.
- **Q7. 저장소.** 병합본을 호스트 저장소에 둘지, 이 저장소(`colonist1004/colonist1004`)에 둘지. 기존 `desktop-dancer/` 폴더와 Windows 빌드 워크플로를 남길지.
- 제안: 호스트가 VRM을 쓸 때 `extras.dancerToon`(7-4)을 넣으면 얼굴·머리카락·피부 판정이 정확해진다.
- 제안: 병합 순서는 F1·F3·F11(재생) → F4~F9(상호작용·보기) → F10(파이프라인) → F12~F14(연결) 순으로, 단계마다 9장의 해당 항목을 확인한다.
