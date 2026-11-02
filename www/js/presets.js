// 기본 제공 프리셋. adj는 바꿀 값만 적고, 나머지 "룩" 값은 기본값으로 초기화된다.
const hsl = (o = {}) => ({ h: o.h || [0, 0, 0, 0, 0, 0, 0, 0], s: o.s || [0, 0, 0, 0, 0, 0, 0, 0], l: o.l || [0, 0, 0, 0, 0, 0, 0, 0] });
const curve = (rgb) => ({ rgb, r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] });

export const BUILTIN_PRESETS = [
  { name: '원본', adj: {} },
  { name: '자연스럽게', adj: { vibrance: 18, contrast: 8, clarity: 6, shadows: 10 } },
  { name: '맑은 피부', adj: { exposure: 0.2, smooth: 45, skinBright: 12, highlights: -15, shadows: 15, temp: 5, vibrance: 10 } },
  { name: '비비드', adj: { vibrance: 40, sat: 10, contrast: 20, clarity: 12, dehaze: 10 } },
  { name: '따뜻한 필름', adj: { temp: 25, tint: 5, contrast: -10, sat: -10, grain: 28, vignette: -15 }, curve: curve([[0, 0.07], [0.25, 0.27], [0.75, 0.76], [1, 0.95]]) },
  { name: '시네마틱', adj: { temp: -8, contrast: 15, sat: -15, vignette: -25, gShadowHue: 200, gShadowSat: 35, gHighHue: 35, gHighSat: 28 } },
  { name: '청량', adj: { temp: -18, tint: -4, exposure: 0.15, vibrance: 25, highlights: -10 }, hsl: hsl({ s: [0, 0, 0, 0, 20, 20, 0, 0], l: [0, 0, 0, 0, 5, -10, 0, 0] }) },
  { name: '노을', adj: { temp: 35, tint: 12, vibrance: 15, gHighHue: 30, gHighSat: 40, gShadowHue: 280, gShadowSat: 20 } },
  { name: '페이드', adj: { contrast: -20, sat: -20, grain: 12 }, curve: curve([[0, 0.12], [0.5, 0.52], [1, 0.93]]) },
  { name: '흑백', adj: { sat: -100, contrast: 25, clarity: 15, grain: 15 } },
  { name: '흑백 고대비', adj: { sat: -100, contrast: 45, clarity: 30, blacks: -20, whites: 15, vignette: -20 } },
];
