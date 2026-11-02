# Desktop Dancer

Windows 작업표시줄 위에서 3D 캐릭터(VRM)가 춤(VRMA)을 추는 데스크탑 앱입니다.
현재 단계는 **Part C MVP**입니다. 샘플 캐릭터와 샘플 춤이 작업표시줄 위에서 반복 재생됩니다.
영상에서 춤을 추출하는 Part B(`pipeline/`)도 들어 있습니다. 이미지로 캐릭터를 만드는 Part A는 다음 마일스톤입니다. 자세한 내용은 [docs/spec.md](docs/spec.md)를 참고하세요.

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

## 내 춤 영상으로 모션 만들기

[`pipeline/README.md`](pipeline/README.md) 를 참고하세요. 간단히 정리하면 아래와 같습니다.

```bash
cd pipeline
```

```bash
pip install -r requirements.txt
```

```bash
python extract_dance.py 춤영상.mp4 --start 10 --end 30 --loop
```

만든 모션은 앱의 트레이 메뉴 **춤**에 자동으로 나타납니다.

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
- `src/preload.js`: 렌더러에 노출하는 IPC API
- `src/renderer/`: three.js + three-vrm 렌더링, 픽셀 알파로 클릭 통과 판정, FPS 제한
- `scripts/vendor.mjs`: 렌더러가 쓰는 라이브러리를 `src/renderer/vendor/`로 복사 (`npm start`·`npm run dist` 때 자동 실행)
- `scripts/make-samples.mjs`, `skeleton.mjs`, `dance.mjs`, `gltf-writer.mjs`: 샘플 VRM/VRMA 생성
- `scripts/check-assets.mjs`, `scripts/test-placement.mjs`: 테스트

## 알려진 한계 (MVP)

- 클릭 통과와 마우스 오버 판정은 Windows/macOS에서만 동작합니다. Electron의 마우스 이벤트 전달 기능이 Linux를 지원하지 않기 때문입니다.
- 작업표시줄이 위나 옆에 있을 때는 캐릭터가 화면 아래쪽 작업 영역에 섭니다.
- 전체 화면 게임이나 영상을 재생할 때 자동으로 숨기는 기능은 아직 없습니다. 트레이 클릭으로 직접 숨기세요.
