# 사진 편집기 (Android APK)

> 이 저장소에는 별도 프로젝트 [`desktop-dancer/`](desktop-dancer/README.md)도 있습니다. 작업표시줄 위에서 VRM 캐릭터가 춤추는 Windows 앱입니다.

라이트룸 스타일의 사진 편집기를 [Capacitor](https://capacitorjs.com)로 감싼 안드로이드 앱입니다.
모든 처리는 기기 안에서만 이루어지며 사진이 외부로 전송되지 않습니다.

## 기능

| 탭 | 내용 |
|---|---|
| 프리셋 | 기본 프리셋 11종(맑은 피부, 따뜻한 필름, 시네마틱, 흑백 등) + 내 프리셋 저장/삭제 |
| 기본 | 자동 보정, 노출·대비·하이라이트·섀도우·흰색/검정 계열, 색온도·색조·활기·채도 |
| 톤 커브 | RGB / R / G / B 포인트 커브, 히스토그램 표시 |
| 색상 | HSL 8색(색조·채도·휘도), 컬러 그레이딩(섀도우/하이라이트 색·양, 균형) |
| 효과 | 선명하게, 텍스처, 부분 대비, 디헤이즈, 비네팅, 그레인 |
| 인물 | 얼굴 인식(MediaPipe) 기반 피부 스무딩·밝기·톤, 눈 크게, 얼굴 갸름하게, 피부 영역 보기 |
| 바디 | 리퀴파이 브러시(밀기·축소·확대·복원)로 허리·팔·다리 라인 보정 |
| 자르기 | 비율(자유/원본/1:1/4:5/3:4/2:3/9:16/16:9), 90° 회전, 좌우 반전, 수평 맞추기 |

그 밖에: 실행 취소/다시 실행, 누르는 동안 원본 보기, 핀치 줌·이동, 히스토그램,
갤러리에 바로 저장(사진/사진 편집기 앨범, Android 10+), 공유, 뒤로 가기 버튼 처리.

## APK 받기

GitHub 저장소의 **Actions → Build Android APK** 에서 최근 실행을 열고
아래쪽 **Artifacts** 의 `photo-editor-apk` 를 내려받으면 `app-debug.apk` 가 들어 있습니다.
휴대폰에서 "출처를 알 수 없는 앱 설치"를 허용한 뒤 설치하세요.

## 직접 빌드 / 개발

Node 20+, JDK 17+, Android SDK 필요.

```bash
npm ci
npm run serve   # 브라우저에서 http://localhost:8080 으로 미리보기
npm run apk     # → android/app/build/outputs/apk/debug/app-debug.apk
```

## 구조

- `www/index.html`, `www/css/app.css` — 화면
- `www/js/app.js` — UI, 상태, 실행 취소, 제스처, 저장
- `www/js/engine.js` — 이미지 처리 (Web Worker에서 실행)
- `www/js/geom.js` — 회전·반전·수평·자르기 좌표 변환
- `www/js/curve.js` — 톤 커브 보간과 에디터
- `www/js/face.js` — MediaPipe 얼굴 랜드마크 (모델: `www/models/face_landmarker.task`)
- `www/js/presets.js` — 기본 프리셋
- `scripts/prepare-web.mjs` — node_modules의 라이브러리를 `www/vendor`로 복사
- `scripts/make-icons.py` — 앱 아이콘·스플래시 생성
- `android/.../GallerySaverPlugin.java` — 갤러리 저장 네이티브 플러그인
