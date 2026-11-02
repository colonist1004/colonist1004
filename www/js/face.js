// MediaPipe Face Landmarker — 앱 안에 포함된 모델로 오프라인 동작
let landmarker = null, loading = null;

async function load() {
  const base = new URL('.', document.baseURI);
  const { FilesetResolver, FaceLandmarker } = await import(new URL('vendor/mediapipe/vision_bundle.mjs', base).href);
  const fileset = await FilesetResolver.forVisionTasks(new URL('vendor/mediapipe/wasm', base).href);
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: new URL('models/face_landmarker.task', base).href, delegate: 'CPU' },
    runningMode: 'IMAGE',
    numFaces: 6,
    minFaceDetectionConfidence: 0.4,
    minFacePresenceConfidence: 0.4,
  });
}

// canvas: 원본 방향 그대로 그린 작업용 이미지. 반환: 얼굴마다 [[x,y],...] (0~1 정규화)
export async function detectFaces(canvas) {
  if (!landmarker) {
    loading = loading || load();
    landmarker = await loading;
  }
  const res = landmarker.detect(canvas);
  return (res.faceLandmarks || []).map(f => f.map(p => [p.x, p.y]));
}
