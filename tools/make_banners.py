# -*- coding: utf-8 -*-
"""
生成两张首页轮播广告（1500×600，2.5:1，与 .banner-swiper 的 710×284rpx 一致）

配色沿用 v2 设计系统：校园蓝 #2E7CF6 + 活力橙 #FF8A3D。

排版不写死 y 坐标，改为「测量 -> 堆叠 -> 居中」：
每一块的高度由字体真实度量（ascent + descent）算出，块间距显式声明，
排完再用字形墨迹框两两做相交检测。这样字号一改也不会突然贴到一起。

中文字用系统字体精确绘制（不经过 AI，绝不会出现错字）。
"""
import functools
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
ACCENT_50 = (255, 240, 228)
T1 = (19, 26, 42)
T2 = (90, 100, 120)
WHITE = (255, 255, 255)

# 排版安全区：文字右边界与上下留白
SAFE_RIGHT = 1440
MIN_GAP = 8


@functools.lru_cache(maxsize=None)
def F(path, size):
    return ImageFont.truetype(path, size)


def lh(font):
    """单行占位高度 = ascent + descent（真实行高，不是字号）"""
    a, dsc = font.getmetrics()
    return a + dsc


def ink(font, text, x, y):
    """字形墨迹框（去掉字体行首行尾的空白），用于重叠检测"""
    b = font.getbbox(text)
    return (x + b[0], y + b[1], x + b[2], y + b[3])


# ---------------------------------------------------------------- 装饰图形
def hgrad(size, c0, c1):
    img = Image.new('RGB', size)
    d = ImageDraw.Draw(img)
    w, h = size
    for x in range(w):
        r = x / (w - 1)
        d.line([(x, 0), (x, h)], fill=tuple(int(c0[i] + (c1[i] - c0[i]) * r) for i in range(3)))
    return img


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
    bw = max(6, w // 9)
    d.rounded_rectangle((cx - bw // 2, cy - h * 0.22, cx + bw // 2, cy + h * 0.06),
                        radius=bw // 2, fill=mark)
    r = bw * 0.8
    d.ellipse((cx - r, cy + h * 0.16, cx + r, cy + h * 0.16 + r * 2), fill=mark)


def warn_tri(d, cx, cy, r, fill, mark):
    h = int(r * 1.74)
    d.polygon([(cx, cy - h * 0.55), (cx + r, cy + h * 0.45), (cx - r, cy + h * 0.45)], fill=fill)
    bw = max(5, r // 7)
    d.rounded_rectangle((cx - bw // 2, cy - h * 0.18, cx + bw // 2, cy + h * 0.16),
                        radius=bw // 2, fill=mark)
    d.ellipse((cx - bw * 0.7, cy + h * 0.24, cx + bw * 0.7, cy + h * 0.24 + bw * 1.4), fill=mark)


# ---------------------------------------------------------------- 排版引擎
def block(text, font, fill, gap=0, kind='text'):
    return {'text': text, 'font': font, 'fill': fill, 'gap': gap, 'kind': kind}


def pill_block(items, font, gap=0, padx=34, pady=15, spacing=16):
    """一行胶囊标签。items = [(文字, 前景色, 背景色), ...]"""
    return {'items': items, 'font': font, 'gap': gap, 'kind': 'pills',
            'padx': padx, 'pady': pady, 'spacing': spacing}


def measure(b):
    if b['kind'] == 'pills':
        return lh(b['font']) + b['pady'] * 2
    return lh(b['font'])


def stack(blocks, center_y):
    """垂直堆叠并在 center_y 处居中，返回 [(block, top, height), ...]"""
    total = sum(measure(b) + b['gap'] for b in blocks)
    y = center_y - total / 2.0
    out = []
    for b in blocks:
        y += b['gap']
        h = measure(b)
        out.append((b, y, h))
        y += h
    return out


def draw_pill(d, x, top, text, font, fg, bg, padx, pady):
    """圆角胶囊。文字按基线定位，垂直方向在胶囊里居中。"""
    b = font.getbbox(text)
    tw = b[2] - b[0]
    h = lh(font) + pady * 2
    box = (x, top, x + tw + padx * 2, top + h)
    d.rounded_rectangle(box, radius=h // 2, fill=bg)
    ascent = font.getmetrics()[0]
    d.text((x + padx, top + pady + ascent), text, font=font, fill=fg, anchor='ls')
    return box


def render(d, blocks, x, center_y, boxes, tag):
    """按堆叠结果绘制，并把每块的墨迹框收集进 boxes 供重叠检测"""
    for b, top, h in stack(blocks, center_y):
        if b['kind'] == 'pills':
            cx = x
            for text, fg, bg in b['items']:
                box = draw_pill(d, cx, top, text, b['font'], fg, bg, b['padx'], b['pady'])
                boxes.append(('%s/胶囊 %s' % (tag, text), box))
                cx = box[2] + b['spacing']
        else:
            d.text((x, top), b['text'], font=b['font'], fill=b['fill'])
            boxes.append(('%s/%s' % (tag, b['text'][:8]), ink(b['font'], b['text'], x, top)))


# ============================================================ 1. 文明发布提示
def banner_notice(boxes):
    img = hgrad((W, H), BRAND_50, WHITE)
    d = ImageDraw.Draw(img)

    # 装饰：右上淡橙圆、右下淡蓝圆（都在文字区右侧，不参与排版）
    d.ellipse((W - 470, -160, W - 190, 120), fill=ACCENT_50)
    d.ellipse((W - 280, H - 230, W + 140, H + 190), fill=(228, 238, 255))

    # 左侧徽章（警示三角做成徽章右上角的角标，避开四角圆角裁切区）
    bx, by, bs = 90, 150, 300
    d.rounded_rectangle((bx, by, bx + bs, by + bs), radius=76, fill=BRAND_100)
    shield(d, bx + bs // 2, by + bs // 2, 150, 180, BRAND, WHITE)
    warn_tri(d, bx + bs - 6, by + 8, 42, ACCENT, WHITE)

    # 字号按「手机实际显示」定：1500 宽 -> 710rpx（约 355pt），缩放 0.237
    # 42 号副标题落到手机上约 10pt，再小就糊了
    blocks = [
        block('文明发布 · 请勿上传违规内容', F(FONT_B, 62), T1),
        block('违禁、骚扰、虚假信息一律下架', F(FONT_R, 42), T2, gap=18),
        block('核实后下架订单，并扣减发布者信誉分', F(FONT_R, 42), T2, gap=8),
        pill_block([('共建文明校园', WHITE, BRAND), ('违规必究', ACCENT, ACCENT_50)],
                   F(FONT_B, 32), gap=24),
    ]
    render(d, blocks, 470, 300, boxes, '文明发布')
    return img


# ============================================================ 2. 广告位招租
def banner_ads(boxes):
    img = hgrad((W, H), BRAND, (99, 179, 255))
    d = ImageDraw.Draw(img)

    # 装饰
    d.ellipse((W - 300, H - 280, W + 140, H + 160), fill=(199, 226, 255))
    d.ellipse((W - 520, -140, W - 300, 80), fill=(140, 197, 255))

    # 右侧橙色「AD」块（先画深色做厚度）
    ax, ay, as_ = 1120, 170, 260
    d.rounded_rectangle((ax + 10, ay + 12, ax + as_ + 10, ay + as_ + 12), radius=56, fill=BRAND_600)
    d.rounded_rectangle((ax, ay, ax + as_, ay + as_), radius=56, fill=ACCENT)
    tf = F(FONT_B, 96)
    tb = tf.getbbox('AD')
    d.text((ax + (as_ - (tb[2] - tb[0])) // 2 - tb[0],
            ay + (as_ - (tb[3] - tb[1])) // 2 - tb[1]), 'AD', font=tf, fill=WHITE)

    blocks = [
        block('首页轮播 · 黄金位置', F(FONT_R, 36), (235, 244, 255)),
        block('广告位招租', F(FONT_B, 100), WHITE, gap=14),
        block('覆盖全校师生 · 每日高频曝光 · 价格可谈', F(FONT_R, 40), (226, 240, 255), gap=10),
        # 白底要配品牌蓝字 —— 白底白字会完全看不见
        pill_block([('详情请联系平台管理员', BRAND, WHITE)], F(FONT_B, 32), gap=26),
    ]
    render(d, blocks, 100, 300, boxes, '广告招租')
    return img


# ---------------------------------------------------------------- 自检
def check(boxes, decor=()):
    """① 文字互不相交且留够间距 ② 不超出安全区 ③ 不与装饰图形相撞"""
    bad = 0
    for i in range(len(boxes)):
        n1, b1 = boxes[i]
        if b1[2] > SAFE_RIGHT:
            print('  [X] %-28s 右边界 %d 超出安全区 %d' % (n1, b1[2], SAFE_RIGHT))
            bad += 1
        for j in range(i + 1, len(boxes)):
            n2, b2 = boxes[j]
            ox = min(b1[2], b2[2]) - max(b1[0], b2[0])
            oy = min(b1[3], b2[3]) - max(b1[1], b2[1])
            if ox > -MIN_GAP and oy > -MIN_GAP:
                print('  [X] 重叠: %s  <->  %s  (横向 %+d, 纵向 %+d)'
                      % (n1, n2, ox, oy))
                bad += 1
        for dn, db in decor:
            ox = min(b1[2], db[2]) - max(b1[0], db[0])
            oy = min(b1[3], db[3]) - max(b1[1], db[1])
            if ox > 0 and oy > 0:
                print('  [X] 文字压到装饰: %s  <->  %s' % (n1, dn))
                bad += 1
    return bad


def report(boxes):
    for name, b in boxes:
        print('  %-30s x %4d..%4d   y %3d..%3d' % (name, b[0], b[2], b[1], b[3]))


def main():
    os.makedirs(OUT, exist_ok=True)
    print('画布 %d×%d = %.2f:1（首页轮播容器 710×284rpx = 2.5:1，完全一致）'
          % (W, H, W / H))

    boxes1, boxes2 = [], []
    img1 = banner_notice(boxes1)
    img2 = banner_ads(boxes2)

    # 装饰图形不参与文字排版，但要在检测里排除「文字压装饰」
    # （椭圆用外接矩形判定，比实际形状更保守，宁严不松）
    decor1 = [('徽章方块', (90, 150, 390, 450)), ('角标三角', (342, 135, 426, 196)),
              ('右上橙圆', (1030, 0, 1310, 120)), ('右下蓝圆', (1220, 370, 1640, 790))]
    decor2 = [('AD 方块', (1120, 170, 1380, 430))]

    print('\n-- 图1 文明发布 --')
    report(boxes1)
    bad = check(boxes1, decor1)
    print('\n-- 图2 广告位招租 --')
    report(boxes2)
    bad += check(boxes2, decor2)

    if bad:
        raise RuntimeError('排版自检失败 %d 处，未生成图片' % bad)
    print('\n排版自检通过：文字零重叠、零越界、零压装饰')

    p1 = os.path.join(OUT, 'banner-no-illegal-content.png')
    p2 = os.path.join(OUT, 'banner-ad-rental.png')
    img1.save(p1)
    img2.save(p2)
    for p in (p1, p2):
        im = Image.open(p)
        print('%s  %d×%d  比例 %.2f:1  %.0f KB'
              % (os.path.basename(p), im.size[0], im.size[1],
                 im.size[0] / im.size[1], os.path.getsize(p) / 1024))


if __name__ == '__main__':
    main()
