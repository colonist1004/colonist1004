// 기하 변환 (회전 90°, 좌우 반전, 수평 맞추기, 자르기) — 메인 스레드와 워커가 함께 사용
//
// 좌표계
//  - source: 원본 사진 기준 정규화 좌표 (0~1)
//  - frame : 90° 회전/반전을 적용한 사진의 경계 상자 기준 정규화 좌표 (0~1).
//            수평 맞추기(angle)는 이 프레임 안에서 사진을 중심 기준으로 돌린다.
//  - crop  : frame 좌표의 사각형 {x,y,w,h}

export const DEFAULT_GEO = () => ({ rot: 0, flip: false, angle: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: 0 });

export function orientedSize(sw, sh, rot) {
  return rot & 1 ? [sh, sw] : [sw, sh];
}

export function frameToSource(fx, fy, geo, ow, oh) {
  const px = (fx - 0.5) * ow, py = (fy - 0.5) * oh;
  const a = (geo.angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  let ox = (px * c + py * s) / ow + 0.5;
  const oy = (-px * s + py * c) / oh + 0.5;
  if (geo.flip) ox = 1 - ox;
  switch (geo.rot & 3) {
    case 1: return [oy, 1 - ox];
    case 2: return [1 - ox, 1 - oy];
    case 3: return [1 - oy, ox];
    default: return [ox, oy];
  }
}

// 출력 픽셀 (i+0.5, j+0.5) → source 정규화 좌표의 아핀 계수
export function outputAffine(geo, ow, oh, outW, outH, crop) {
  const f = (i, j) => frameToSource(crop.x + (i / outW) * crop.w, crop.y + (j / outH) * crop.h, geo, ow, oh);
  const p0 = f(0, 0), p1 = f(1, 0), p2 = f(0, 1);
  return { u0: p0[0], ux: p1[0] - p0[0], uy: p2[0] - p0[0], v0: p0[1], vx: p1[1] - p0[1], vy: p2[1] - p0[1] };
}

// 자르기 사각형의 네 꼭짓점이 (기울인) 사진 안에 있는지
export function cropFits(crop, angle, ow, oh) {
  const a = (angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), e = 1e-6;
  if (crop.x < -e || crop.y < -e || crop.x + crop.w > 1 + e || crop.y + crop.h > 1 + e) return false;
  for (const [fx, fy] of [[crop.x, crop.y], [crop.x + crop.w, crop.y], [crop.x, crop.y + crop.h], [crop.x + crop.w, crop.y + crop.h]]) {
    const px = (fx - 0.5) * ow, py = (fy - 0.5) * oh;
    const u = px * c + py * s, v = -px * s + py * c;
    if (Math.abs(u) > ow / 2 + 0.01 * ow || Math.abs(v) > oh / 2 + 0.01 * oh) return false;
  }
  return true;
}

// 주어진 픽셀 비율(가로/세로)로, 기울인 사진 안에 들어가는 가장 큰 중앙 사각형
export function maxCrop(aspect, angle, ow, oh) {
  const a = Math.abs((angle * Math.PI) / 180), c = Math.cos(a), s = Math.sin(a);
  const ar = aspect > 0 ? aspect : ow / oh;
  const t = Math.min(oh, ow / ar, ow / (ar * c + s), oh / (ar * s + c));
  const w = (ar * t) / ow, h = t / oh;
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

// 현재 자르기 영역의 실제 픽셀 크기
export function cropPixelSize(geo, sw, sh) {
  const [ow, oh] = orientedSize(sw, sh, geo.rot);
  return [geo.crop.w * ow, geo.crop.h * oh];
}
