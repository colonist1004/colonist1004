// node_modules에서 앱에 필요한 라이브러리를 www/vendor로 복사 (빌드 전에 실행)
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = p => join(root, 'node_modules', p);
const out = p => join(root, 'www', 'vendor', p);
const copy = (from, to) => {
  if (!existsSync(nm(from))) throw new Error(`missing ${from} — run npm ci first`);
  mkdirSync(dirname(out(to)), { recursive: true });
  cpSync(nm(from), out(to), { recursive: true });
  console.log('vendor:', to);
};

copy('@capacitor/core/dist/capacitor.js', 'capacitor.js');
copy('@mediapipe/tasks-vision/vision_bundle.mjs', 'mediapipe/vision_bundle.mjs');
// 안드로이드 WebView(Chrome 91+)는 WASM SIMD를 지원하므로 SIMD 빌드만 포함해 APK 크기를 줄인다
copy('@mediapipe/tasks-vision/wasm/vision_wasm_internal.js', 'mediapipe/wasm/vision_wasm_internal.js');
copy('@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm', 'mediapipe/wasm/vision_wasm_internal.wasm');
