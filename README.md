# 사진 편집기 (Android APK)

브라우저용 사진 편집기 프로토타입을 [Capacitor](https://capacitorjs.com)로 감싼 안드로이드 앱입니다.

- 노출 / 대비 / 하이라이트 / 섀도우, 색온도 / 틴트 / 활기 / 채도
- 인물 보정: 피부 스무딩, 피부 밝기 (색상 기반 피부 검출)
- 저장 버튼 → 공유 시트에서 갤러리·드라이브 등으로 저장 (앱에서는 긴 변 최대 4096px)

## APK 받기

GitHub 저장소의 **Actions → Build Android APK** 에서 최근 실행을 열고
아래쪽 **Artifacts** 의 `photo-editor-apk` 를 내려받으면 `app-debug.apk` 가 들어 있습니다.
휴대폰에서 "출처를 알 수 없는 앱 설치"를 허용한 뒤 설치하세요.

## 직접 빌드

Node 20+, JDK 17+, Android SDK 필요.

```bash
npm ci
npm run apk   # → android/app/build/outputs/apk/debug/app-debug.apk
```

웹 코드는 `www/index.html` 하나입니다. 수정 후 `npx cap sync android` 로 반영합니다.
