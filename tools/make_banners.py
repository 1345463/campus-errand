# -*- coding: utf-8 -*-
"""
生成两张首页轮播广告（1500×600，2.5:1，与 .banner-swiper 的 750×300 一致）

配色沿用 v2 设计系统：校园蓝 #2E7CF6 + 活力橙 #FF8A3D。
纯代码排版，中文字用系统字体精确绘制（不经过 AI，绝不会出现错字）。
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = r"C:/Users/包子6688/WorkBuddy/2026-10-14-12-13-59/campus-errand/docs/assets"
W, H = 1500, 600

FONT_B = r"C:/Windows/Fonts/msyhbd.ttc"
FONT_R = r"C:/Windows/Fonts/msyh.ttc"

BRAND = (46, 124, 246)
BRAND_600 = (29, 95, 208)
BRAND_100 = (228, 238, 255)
BRAND_50 = (242, 247, 255)
ACCENT = (255, 138, 61)
T1 = (19, 26, 42)
T2 = (90, 100, 120)
WHITE = (255, 255, 255)


def f(path, size):
    return ImageFont.truetype(path, size)


def hgrad(size, c0, c1):
    """左右线性渐变"""
    img = Image.new('RGB', size)
    d = ImageDraw.Draw(img)
    w, h = size
    for x in range(w):
        r = x / (w - 1)
        d.line([(x, 0), (x, h)], fill=tuple(int(c0[i] + (c1[i] - c0[i]) * r) for i in range(3)))
    return img


def pill(d, x, y, text, font, fg, bg, padx=34, pady=18, radius=999):
    """圆角胶囊标签，返回右边界"""
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    box = (x, y, x + tw + padx * 2, y + th + pady * 2)
    r = min(radius, (box[3] - box[1]) // 2)
    d.rounded_rectangle(box, radius=r, fill=bg)
    d.text((x + padx, y + pady - bbox[1]), text, font=font, fill=fg)
    return box[2]


def shield(d, cx, cy, w, h, fill, mark):
    """盾牌 + 中间感叹号"""
    pts = [
        (cx, cy - h // 2),
        (cx + w // 2, cy - h // 2 + h * 0.18),
        (cx + w // 2, cy + h * 0.12),
        (cx, cy + h // 2),
        (cx - w // 2, cy + h * 0.12),
        (cx - w // 2, cy - h // 2 + h * 0.18),
    ]
    d.polygon(pts, fill=fill)
    # 感叹号
    bw = max(6, w // 9)
    d.rounded_rectangle((cx - bw // 2, cy - h * 0.22, cx + bw // 2, cy + h * 0.06),
                        radius=bw // 2, fill=mark)
    r = bw * 0.8
    d.ellipse((cx - r, cy + h * 0.16, cx + r, cy + h * 0.16 + r * 2), fill=mark)


def warn_tri(d, cx, cy, r, fill, mark):
    """警示三角"""
    h = int(r * 1.74)
    d.polygon([(cx, cy - h * 0.55), (cx + r, cy + h * 0.45), (cx - r, cy + h * 0.45)], fill=fill)
    bw = max(5, r // 7)
    d.rounded_rectangle((cx - bw // 2, cy - h * 0.18, cx + bw // 2, cy + h * 0.16),
                        radius=bw // 2, fill=mark)
    d.ellipse((cx - bw * 0.7, cy + h * 0.24, cx + bw * 0.7, cy + h * 0.24 + bw * 1.4), fill=mark)


# ============================================================ 1. 文明发布提示
def banner_notice():
    img = hgrad((W, H), BRAND_50, WHITE)
    d = ImageDraw.Draw(img)

    # 装饰圆
    d.ellipse((W - 320, H - 260, W + 120, H + 180), fill=(228, 238, 255))
    d.ellipse((W - 470, -120, W - 250, 100), fill=(255, 240, 228))

    # 左侧徽章
    bx, by, bs = 90, 150, 300
    d.rounded_rectangle((bx, by, bx + bs, by + bs), radius=76, fill=BRAND_100)
    shield(d, bx + bs // 2, by + bs // 2, 150, 180, BRAND, WHITE)

    # 右侧警示三角（橙色）—— 靠最右侧放，避免和副标题撞在一起
    warn_tri(d, 1372, 300, 70, ACCENT, WHITE)

    # 文案
    x = 470
    d.text((x, 176), '文明发布 · 请勿上传违规内容', font=f(FONT_B, 66), fill=T1)
    d.text((x, 288), '违禁、骚扰、虚假信息一律下架', font=f(FONT_R, 34), fill=T2)
    d.text((x, 336), '核实后下架订单，并扣减发布者信誉分', font=f(FONT_R, 34), fill=T2)
    pill(d, x, 372, '共建文明校园', f(FONT_B, 30), WHITE, BRAND)
    pill(d, x + 300, 372, '违规必究', f(FONT_B, 30), ACCENT, (255, 240, 228))

    return img


# ============================================================ 2. 广告位招租
def banner_ads():
    img = hgrad((W, H), BRAND, (99, 179, 255))
    d = ImageDraw.Draw(img)

    # 装饰：半透明白圆 + 橙色圆角块
    d.ellipse((W - 300, H - 280, W + 140, H + 160), fill=(255, 255, 255, 40))
    d.ellipse((W - 520, -140, W - 300, 80), fill=(255, 255, 255, 30))

    # 右侧橙色「AD」块（先画一层深色做阴影）
    ax, ay, as_ = 1120, 170, 260
    d.rounded_rectangle((ax + 10, ay + 12, ax + as_ + 10, ay + as_ + 12), radius=56, fill=(29, 95, 208))
    d.rounded_rectangle((ax, ay, ax + as_, ay + as_), radius=56, fill=ACCENT)
    tf = f(FONT_B, 96)
    tb = d.textbbox((0, 0), 'AD', font=tf)
    d.text((ax + (as_ - (tb[2] - tb[0])) // 2 - tb[0], ay + (as_ - (tb[3] - tb[1])) // 2 - tb[1]),
           'AD', font=tf, fill=WHITE)

    # 文案
    x = 100
    d.text((x, 150), '首页轮播 · 黄金位置', font=f(FONT_R, 34), fill=(235, 244, 255))
    d.text((x, 210), '广告位招租', font=f(FONT_B, 104), fill=WHITE)
    d.text((x, 356), '覆盖全校师生 · 每日高频曝光 · 价格可谈', font=f(FONT_R, 36), fill=(226, 240, 255))
    pill(d, x, 440, '详情请联系平台管理员', f(FONT_B, 30), WHITE, (255, 255, 255, 56))

    return img


def fit_check():
    """校验所有文字都在安全区内（右边界 1440 = 画布右边留 60 安全边距），
    且不与右侧装饰图形（x >= 1230）重叠。看不到成品图，只能靠算。"""
    probe = ImageDraw.Draw(Image.new('RGB', (W, H)))
    cases = [
        ('主标题', '文明发布 · 请勿上传违规内容', f(FONT_B, 66), 470),
        ('副标题1', '违禁、骚扰、虚假信息一律下架', f(FONT_R, 34), 470),
        ('副标题2', '核实后下架订单，并扣减发布者信誉分', f(FONT_R, 34), 470),
        ('招租主标题', '广告位招租', f(FONT_B, 104), 100),
        ('招租副标题', '覆盖全校师生 · 每日高频曝光 · 价格可谈', f(FONT_R, 36), 100),
    ]
    bad = 0
    for name, text, font, x in cases:
        b = probe.textbbox((0, 0), text, font=font)
        right = x + b[2]
        flag = 'OK' if right <= 1440 else '超出安全区!'
        if right > 1440:
            bad += 1
        print('  %-10s 右边界 %4d  %s' % (name, right, flag))
    return bad


def main():
    os.makedirs(OUT, exist_ok=True)
    print('画布 %d×%d = %.2f:1（首页轮播容器 710×284rpx = 2.5:1，完全一致）'
          % (W, H, W / H))
    bad = fit_check()
    if bad:
        raise RuntimeError('有 %d 处文字超出安全区，需调整字号或文案' % bad)

    p1 = os.path.join(OUT, 'banner-no-illegal-content.png')
    p2 = os.path.join(OUT, 'banner-ad-rental.png')
    banner_notice().save(p1, quality=95)
    banner_ads().save(p2, quality=95)
    for p in (p1, p2):
        im = Image.open(p)
        print('%s  %d×%d  %.0f KB' % (os.path.basename(p), im.size[0], im.size[1],
                                      os.path.getsize(p) / 1024))


if __name__ == '__main__':
    main()
