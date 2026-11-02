"""앱 아이콘·스플래시 생성 (PIL). 사용: python3 scripts/make-icons.py"""
from PIL import Image, ImageDraw
import os

RES = os.path.join(os.path.dirname(__file__), '..', 'android', 'app', 'src', 'main', 'res')
C1, C2 = (58, 109, 240), (123, 77, 255)
SS = 4

def gradient(size):
    im = Image.new('RGB', (size, size))
    px = im.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(int(C1[i] + (C2[i] - C1[i]) * t) for i in range(3))
    return im

def glyph(size, scale):
    """투명 배경 위 흰색 슬라이더 3개 (size 정사각형 중앙, scale = 글리프가 차지하는 비율)"""
    S = size * SS
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    g = S * scale
    x0, x1 = (S - g) / 2, (S + g) / 2
    th, kr = g * 0.075, g * 0.12
    for row, pos in zip((-1, 0, 1), (0.30, 0.68, 0.45)):
        y = S / 2 + row * g * 0.33
        d.rounded_rectangle([x0, y - th / 2, x1, y + th / 2], radius=th / 2, fill=(255, 255, 255, 255))
        kx = x0 + g * pos
        d.ellipse([kx - kr, y - kr, kx + kr, y + kr], fill=(255, 255, 255, 255))
        d.ellipse([kx - kr * 0.45, y - kr * 0.45, kx + kr * 0.45, y + kr * 0.45], fill=(80, 90, 245, 255))
    return im.resize((size, size), Image.LANCZOS)

def legacy(size, round_):
    S = size * SS
    bg = gradient(64).resize((S, S), Image.BICUBIC).convert('RGBA')
    mask = Image.new('L', (S, S), 0)
    md = ImageDraw.Draw(mask)
    if round_: md.ellipse([0, 0, S - 1, S - 1], fill=255)
    else: md.rounded_rectangle([S * 0.04, S * 0.04, S * 0.96, S * 0.96], radius=S * 0.22, fill=255)
    out = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    out.paste(bg, (0, 0), mask)
    out = out.resize((size, size), Image.LANCZOS)
    out.alpha_composite(glyph(size, 0.56))
    return out

DENS = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
for d, k in DENS.items():
    base = os.path.join(RES, f'mipmap-{d}')
    legacy(int(48 * k), False).save(os.path.join(base, 'ic_launcher.png'))
    legacy(int(48 * k), True).save(os.path.join(base, 'ic_launcher_round.png'))
    glyph(int(108 * k), 0.42).save(os.path.join(base, 'ic_launcher_foreground.png'))

# 스플래시: 어두운 배경 + 가운데 아이콘
for name in os.listdir(RES):
    p = os.path.join(RES, name, 'splash.png')
    if not name.startswith('drawable') or not os.path.exists(p): continue
    w, h = Image.open(p).size
    im = Image.new('RGBA', (w, h), (18, 19, 22, 255))
    s = int(min(w, h) * 0.26)
    ic = legacy(s, False)
    im.alpha_composite(ic, ((w - s) // 2, (h - s) // 2))
    im.convert('RGB').save(p)
print('icons done')
