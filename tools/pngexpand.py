"""纯 stdlib PNG 处理：解码 RGBA → 裁掉透明边 → 缩放 → 重新编码。
项目零依赖传统，不引 Pillow。
"""
import struct
import zlib
import sys
import os


def read_png(path):
    d = open(path, 'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n', 'not a png'
    pos = 8
    idat = b''
    w = h = bitd = ctype = None
    palette = None
    trns = None
    while pos < len(d):
        ln = struct.unpack('>I', d[pos:pos + 4])[0]
        typ = d[pos + 4:pos + 8]
        data = d[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            w, h, bitd, ctype, comp, filt, inter = struct.unpack('>IIBBBBB', data)
            assert bitd == 8 and inter == 0, f'unsupported bitdepth/interlace {bitd}/{inter}'
        elif typ == b'PLTE':
            palette = data
        elif typ == b'tRNS':
            trns = data
        elif typ == b'IDAT':
            idat += data
        elif typ == b'IEND':
            break
        pos += 12 + ln
    raw = zlib.decompress(idat)
    ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    stride = w * ch
    out = bytearray()
    prev = bytearray(stride)
    i = 0
    for y in range(h):
        f = raw[i]; i += 1
        line = bytearray(raw[i:i + stride]); i += stride
        if f == 0:
            pass
        elif f == 1:
            for x in range(ch, stride):
                line[x] = (line[x] + line[x - ch]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - ch] if x >= ch else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - ch] if x >= ch else 0
                b = prev[x]
                c = prev[x - ch] if x >= ch else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        out += line
        prev = line
    # 统一成 RGBA
    px = bytearray(w * h * 4)
    if ctype == 6:
        px = bytearray(out)
    elif ctype == 2:
        for i in range(w * h):
            px[i * 4:i * 4 + 3] = out[i * 3:i * 3 + 3]
            px[i * 4 + 3] = 255
    elif ctype == 3:
        for i in range(w * h):
            idx = out[i]
            px[i * 4] = palette[idx * 3]
            px[i * 4 + 1] = palette[idx * 3 + 1]
            px[i * 4 + 2] = palette[idx * 3 + 2]
            px[i * 4 + 3] = trns[idx] if trns and idx < len(trns) else 255
    elif ctype == 0:
        for i in range(w * h):
            v = out[i]
            px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v
            px[i * 4 + 3] = 255
    elif ctype == 4:
        for i in range(w * h):
            v = out[i * 2]
            px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v
            px[i * 4 + 3] = out[i * 2 + 1]
    return w, h, px


def write_png(path, w, h, px):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += px[y * w * 4:(y + 1) * w * 4]

    def chunk(typ, data):
        return struct.pack('>I', len(data)) + typ + data + struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    open(path, 'wb').write(png)


def alpha_bbox(w, h, px, thresh=8):
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        row = y * w * 4
        for x in range(w):
            if px[row + x * 4 + 3] > thresh:
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
    if maxx < 0:
        return 0, 0, w, h
    return minx, miny, maxx + 1, maxy + 1


def crop(w, h, px, box):
    x0, y0, x1, y1 = box
    cw, ch = x1 - x0, y1 - y0
    out = bytearray(cw * ch * 4)
    for y in range(ch):
        src = ((y + y0) * w + x0) * 4
        out[y * cw * 4:(y + 1) * cw * 4] = px[src:src + cw * 4]
    return cw, ch, out


def resize(w, h, px, nw, nh):
    """高质量盒式重采样（面积平均）—— 缩小时比最近邻干净得多。"""
    out = bytearray(nw * nh * 4)
    sx = w / nw
    sy = h / nh
    for y in range(nh):
        y0 = int(y * sy); y1 = min(h, int((y + 1) * sy) or y0 + 1)
        if y1 <= y0: y1 = y0 + 1
        for x in range(nw):
            x0 = int(x * sx); x1 = min(w, int((x + 1) * sx) or x0 + 1)
            if x1 <= x0: x1 = x0 + 1
            r = g = b = a = n = 0
            for yy in range(y0, y1):
                base = yy * w * 4
                for xx in range(x0, x1):
                    o = base + xx * 4
                    al = px[o + 3]
                    r += px[o] * al; g += px[o + 1] * al; b += px[o + 2] * al; a += al
                    n += 1
            o = (y * nw + x) * 4
            if a:
                out[o] = r // a; out[o + 1] = g // a; out[o + 2] = b // a; out[o + 3] = a // n
            else:
                out[o + 3] = 0
    return nw, nh, out


def pad_square(w, h, px, size, pad_ratio=0.0):
    """把图放进 size×size 的正方形画布（居中），用于 favicon / 头像。"""
    inner = int(size * (1 - pad_ratio * 2))
    scale = min(inner / w, inner / h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    _, _, rs = resize(w, h, px, nw, nh)
    out = bytearray(size * size * 4)
    ox, oy = (size - nw) // 2, (size - nh) // 2
    for y in range(nh):
        dst = ((y + oy) * size + ox) * 4
        out[dst:dst + nw * 4] = rs[y * nw * 4:(y + 1) * nw * 4]
    return size, size, out


if __name__ == '__main__':
    src = sys.argv[1]
    outdir = sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    w, h, px = read_png(src)
    print('source:', w, 'x', h)
    box = alpha_bbox(w, h, px)
    print('alpha bbox:', box)
    cw, ch, cpx = crop(w, h, px, box)
    print('cropped:', cw, 'x', ch)

    # 1) 完整 logo（裁透明边后原样），宽度上限 720
    lw = 720
    lh = max(1, round(ch * lw / cw))
    nw, nh, np_ = resize(cw, ch, cpx, lw, lh)
    write_png(os.path.join(outdir, 'logo.png'), nw, nh, np_)
    print('logo.png:', nw, 'x', nh)

    # 2) 2x 版本，用于高分屏
    nw2, nh2, np2 = resize(cw, ch, cpx, lw * 2, max(1, round(ch * lw * 2 / cw)))
    write_png(os.path.join(outdir, 'logo@2x.png'), nw2, nh2, np2)
    print('logo@2x.png:', nw2, 'x', nh2)

    # 3) 方形图标（favicon / 头像），留 8% 内边距
    for s in (512, 192, 180, 64, 32):
        sw, sh, sp = pad_square(cw, ch, cpx, s, 0.10)
        write_png(os.path.join(outdir, f'icon-{s}.png'), sw, sh, sp)
    print('square icons written: 512/192/180/64/32')
