#!/usr/bin/env python3
"""
素材動画の顔にモザイクをかける（Reel Studio の core/mosaic.ts から呼ばれる）。

顔の検出には deface（https://github.com/ORB-HD/deface 、MIT）の CenterFace を使う。
deface の CLI をそのまま使わないのは、Reel Studio の素材に対して次の問題があるため:
  - 出力を 16 の倍数にリサイズする（1080x1920 が 1088x1920 になる）
  - RGB を経由して書き出すので色（BT.709）がずれ、色の情報も落ちる
  - 固定 fps で書き出すので、可変フレームレートの素材は尺と音声がずれる
  - フレームごとに独立に検出するので、1 フレーム取りこぼすと顔が一瞬映る
  - 開けないファイルでも終了コード 0 で終わる
ここでは ffmpeg で YUV のまま読み書きし（モザイク以外の画素は色変換しない）、素材の公称 fps にそろえ、
前後のフレームで裏付けの取れた検出だけを前後 --hold フレームに広げてから塗る。

    python face-mosaic.py --check
    python face-mosaic.py --input in.mp4 --output out.mp4 --report r.json --width 1080 --height 1920 --fps 60000/1001

stdout には 1 行ずつ `progress <済> <全体>` / `info <文>` を出す。最後にレポート（JSON）を --report に書く。
終了コード: 0 = 成功 / 1 = 処理の失敗 / 3 = deface（または onnxruntime）が入っていない
"""
import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from collections import deque


def emit(kind, text):
    print(f'{kind} {text}', flush=True)


# 自動選択に任せると CPU 版では AzureExecutionProvider（リモート推論用）が先頭に来て、ログにもそれが出る。
# 実際に何で動いているかが分からなくなるので、GPU 系 → CPU の順に明示する
GPU_PROVIDERS = ('CUDAExecutionProvider', 'DmlExecutionProvider', 'CoreMLExecutionProvider', 'OpenVINOExecutionProvider')


def pick_provider(requested):
    if requested:
        return requested
    try:
        import onnx  # noqa: F401
        import onnxruntime
    except Exception:
        return None  # onnxruntime が無い → deface が OpenCV 版に落ちる
    available = onnxruntime.get_available_providers()
    for p in GPU_PROVIDERS:
        if p in available:
            return p
    return 'CPUExecutionProvider' if 'CPUExecutionProvider' in available else None


def load_centerface():
    try:
        import numpy  # noqa: F401
        import cv2  # noqa: F401
        from deface.centerface import CenterFace
        import deface
    except Exception as e:  # ImportError 以外（DLL の読み込み失敗など）も同じ扱い
        print(f'deface を読み込めません: {e}', file=sys.stderr)
        sys.exit(3)
    return CenterFace, getattr(deface, '__version__', '?')


def check():
    CenterFace, version = load_centerface()
    info = {'python': sys.version.split()[0], 'executable': sys.executable, 'deface': version, 'onnxruntime': None, 'providers': []}
    try:
        import onnx  # noqa: F401  （deface は onnx と onnxruntime の両方が無いと遅い OpenCV 版に落ちる）
        import onnxruntime
        info['onnxruntime'] = onnxruntime.__version__
        info['providers'] = onnxruntime.get_available_providers()
    except Exception:
        pass
    print(json.dumps(info), flush=True)


def fps_value(text):
    """'60000/1001' も '59.94' も受ける"""
    num, _, den = str(text).partition('/')
    return round(float(num) / float(den), 3) if den else float(num)


def read_exact(stream, n):
    buf = bytearray(n)
    view = memoryview(buf)
    got = 0
    while got < n:
        r = stream.readinto(view[got:])
        if not r:
            break
        got += r
    return buf if got == n else None


def tail(path, lines=8):
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            return '\n'.join([l for l in f.read().splitlines() if l.strip()][-lines:])
    except OSError:
        return ''


def scale_box(det, mask_scale, width, height):
    x1, y1, x2, y2 = (float(v) for v in det[:4])
    s = mask_scale - 1.0
    w, h = x2 - x1, y2 - y1
    x1, x2 = x1 - w * s, x2 + w * s
    y1, y2 = y1 - h * s, y2 + h * s
    return [max(0, int(math.floor(x1))), max(0, int(math.floor(y1))), min(width, int(math.ceil(x2))), min(height, int(math.ceil(y2)))]


def overlaps_any(box, others):
    return any(box[0] < o[2] and o[0] < box[2] and box[1] < o[3] and o[1] < box[3] for o in others)


def merge_boxes(boxes):
    """重なる矩形を 1 つにまとめる（同じ場所を 2 回塗って升目がずれないように）"""
    boxes = [b[:] for b in boxes if b[2] > b[0] and b[3] > b[1]]
    merged = True
    while merged:
        merged = False
        out = []
        while boxes:
            a = boxes.pop()
            i = 0
            while i < len(boxes):
                b = boxes[i]
                if a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]:
                    a = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]
                    boxes.pop(i)
                    merged = True
                else:
                    i += 1
            out.append(a)
        boxes = out
    return boxes


def pixelate_plane(plane, x1, y1, x2, y2, cell):
    import numpy as np

    region = plane[y1:y2, x1:x2]
    h, w = region.shape
    if h == 0 or w == 0:
        return
    nh, nw = -(-h // cell), -(-w // cell)
    padded = np.pad(region, ((0, nh * cell - h), (0, nw * cell - w)), mode='edge')
    small = padded.reshape(nh, cell, nw, cell).mean(axis=(1, 3))
    plane[y1:y2, x1:x2] = np.repeat(np.repeat(small, cell, axis=0), cell, axis=1)[:h, :w].round().astype(np.uint8)


def mosaic_yuv420(frame, width, height, boxes, cells):
    """I420 のフレームに矩形モザイク。升目は画面全体の格子にそろえる（顔が少し動いても模様がちらつかない）"""
    y_size = width * height
    c_w, c_h = width // 2, height // 2
    y_plane = frame[:y_size].reshape(height, width)
    u_plane = frame[y_size:y_size + c_w * c_h].reshape(c_h, c_w)
    v_plane = frame[y_size + c_w * c_h:].reshape(c_h, c_w)
    for x1, y1, x2, y2 in boxes:
        size = max(x2 - x1, y2 - y1)
        # 升目は偶数 px（色差は縦横 1/2 なので、輝度と同じ格子に乗せるため）。4 px 刻みに丸めて揺れを抑える
        cell = max(4, int(round(size / max(1, cells) / 4.0)) * 4)
        gx1, gy1 = (x1 // cell) * cell, (y1 // cell) * cell
        gx2, gy2 = min(width - width % 2, -(-x2 // cell) * cell), min(height - height % 2, -(-y2 // cell) * cell)
        pixelate_plane(y_plane, gx1, gy1, gx2, gy2, cell)
        half = cell // 2
        pixelate_plane(u_plane, gx1 // 2, gy1 // 2, gx2 // 2, gy2 // 2, half)
        pixelate_plane(v_plane, gx1 // 2, gy1 // 2, gx2 // 2, gy2 // 2, half)


def run(args):
    import numpy as np
    import cv2

    CenterFace, version = load_centerface()
    width, height = args.width, args.height
    if width % 2 or height % 2:
        print(f'幅と高さは偶数である必要があります: {width}x{height}', file=sys.stderr)
        return 1

    # 検出は短辺 --detect-short に縮めて行う（CenterFace が 32 の倍数に丸める）
    short = min(width, height)
    k = min(1.0, args.detect_short / short) if args.detect_short > 0 else 1.0
    in_shape = (max(32, int(round(width * k))), max(32, int(round(height * k))))
    centerface = CenterFace(in_shape=in_shape, backend=args.backend, override_execution_provider=pick_provider(args.ep) if args.backend != 'opencv' else None)
    provider = 'opencv'
    if getattr(centerface, 'backend', '') == 'onnxrt':
        provider = centerface.sess.get_providers()[0]
    emit('info', f'deface {version} / {provider} / 検出 {in_shape[0]}x{in_shape[1]}')

    tmpdir = tempfile.mkdtemp(prefix='reel-mosaic-')
    dec_err_path = os.path.join(tmpdir, 'decode.log')
    enc_err_path = os.path.join(tmpdir, 'encode.log')
    frame_bytes = width * height * 3 // 2

    # fps フィルタで固定フレームレートにそろえる（可変フレームレート素材でも尺と音声がずれない）
    dec_cmd = [args.ffmpeg, '-v', 'error', '-nostdin', '-i', args.input, '-map', '0:v:0',
               '-vf', f'scale={width}:{height},fps={args.fps}:round=near,format=yuv420p',
               '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1']
    enc_cmd = [args.ffmpeg, '-v', 'error', '-nostdin', '-y',
               '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', f'{width}x{height}', '-framerate', args.fps, '-i', 'pipe:0']
    if args.audio == 'copy':
        enc_cmd += ['-i', args.input, '-map', '0:v:0', '-map', '1:a:0?', '-c:a', 'copy']
    else:
        enc_cmd += ['-an']
    enc_cmd += ['-c:v', 'libx264', '-preset', args.preset, '-crf', str(args.crf), '-g', '30', '-keyint_min', '30', '-pix_fmt', 'yuv420p']
    # 元の色の情報（BT.709 等）を付け直す。rawvideo 経由だと失われ、ffmpeg 7 以降は -color_trc 等の出力オプションが
    # フィルタグラフの値で上書きされるので、setparams でフレーム側に持たせる
    color = [f'{k}={v}' for k, v in (('colorspace', args.color_space), ('color_primaries', args.color_primaries), ('color_trc', args.color_trc), ('range', args.color_range)) if v]
    if color:
        enc_cmd += ['-vf', 'setparams=' + ':'.join(color)]
    if os.path.splitext(args.output)[1].lower() in ('.mp4', '.mov', '.m4v'):
        enc_cmd += ['-movflags', '+faststart']
    enc_cmd += [args.output]

    started = time.time()
    every = max(1, args.detect_every)
    hold = max(0, args.hold)
    counts = []  # フレームごとの「確定した顔」の数（前後に広げる前）
    with open(dec_err_path, 'w', encoding='utf-8') as dec_err, open(enc_err_path, 'w', encoding='utf-8') as enc_err:
        dec = subprocess.Popen(dec_cmd, stdout=subprocess.PIPE, stderr=dec_err, bufsize=frame_bytes * 2)
        enc = subprocess.Popen(enc_cmd, stdin=subprocess.PIPE, stderr=enc_err)
        # 各要素: {'frame', 'raw': 検出した矩形（検出しなかったフレームは None）, 'prev': 1 つ前に検出したフレームの矩形, 'confirmed'}
        pending = deque()
        past = deque(maxlen=hold)  # 書き出し済みフレームの confirmed（前方向に広げる分）
        last_detected = None
        written = 0
        failed = None

        def confirm(entry, next_raw):
            # 前後どちらかの検出フレームに重なる顔があるものだけを残す。
            # 料理の模様を顔と取り違えるのはほぼ 1 フレームだけなので、これで消える（本物の顔は続けて映る）
            if not args.confirm:
                entry['confirmed'] = entry['raw']
                return
            entry['confirmed'] = [b for b in entry['raw'] if overlaps_any(b, entry['prev']) or overlaps_any(b, next_raw)]

        def flush_one():
            nonlocal written
            entry = pending.popleft()
            ahead = [e['confirmed'] or [] for e in list(pending)[:hold]]
            window = [b for bs in past for b in bs] + (entry['confirmed'] or []) + [b for bs in ahead for b in bs]
            if window:
                mosaic_yuv420(entry['frame'], width, height, merge_boxes(window), args.cells)
            enc.stdin.write(entry['frame'])
            past.append(entry['confirmed'] or [])
            counts.append(len(entry['confirmed'] or []))
            written += 1

        try:
            index = 0
            while True:
                raw = read_exact(dec.stdout, frame_bytes)
                if raw is None:
                    break
                entry = {'frame': np.frombuffer(raw, dtype=np.uint8), 'raw': None, 'prev': [], 'confirmed': []}
                if index % every == 0:
                    rgb = cv2.cvtColor(entry['frame'].reshape(height * 3 // 2, width), cv2.COLOR_YUV2RGB_I420)
                    dets, _ = centerface(rgb, threshold=args.threshold)
                    entry['raw'] = [scale_box(d, args.mask_scale, width, height) for d in dets]
                    entry['prev'] = last_detected['raw'] if last_detected else []
                    entry['confirmed'] = None  # 次に検出するフレームを見てから決める
                    if last_detected:
                        confirm(last_detected, entry['raw'])
                    last_detected = entry
                pending.append(entry)
                # 先頭を書き出すには、後ろ hold フレームぶんの確定が要る（確定には次の検出フレームが要る）
                if len(pending) > hold + every:
                    flush_one()
                index += 1
                if index % 10 == 0:
                    emit('progress', f'{index} {max(index, args.frames)}')
            if last_detected and last_detected['confirmed'] is None:
                confirm(last_detected, [])
            while pending:
                flush_one()
        except BrokenPipeError:
            failed = 'エンコーダ（ffmpeg）が途中で終了しました'
        finally:
            try:
                enc.stdin.close()
            except OSError:
                pass
            dec.stdout.close()
            dec_code = dec.wait()
            enc_code = enc.wait()

    dec_tail, enc_tail = tail(dec_err_path), tail(enc_err_path)
    shutil.rmtree(tmpdir, ignore_errors=True)
    if dec_code != 0:
        print(f'読み込み（ffmpeg）が終了コード {dec_code} で失敗\n{dec_tail}', file=sys.stderr)
        return 1
    if failed or enc_code != 0:
        print(f'{failed or "書き出し（ffmpeg）が失敗"}（終了コード {enc_code}）\n{enc_tail}', file=sys.stderr)
        return 1
    if written == 0:
        print('フレームを 1 枚も読めませんでした', file=sys.stderr)
        return 1

    emit('progress', f'{written} {written}')
    report = {
        'frames': written,
        'fps': fps_value(args.fps),
        'width': width,
        'height': height,
        'faces': counts,
        'engine': f'deface {version} / {provider}',
        'elapsedSec': round(time.time() - started, 2),
    }
    with open(args.report, 'w', encoding='utf-8') as f:
        json.dump(report, f)
    return 0


def main():
    # Windows でパイプに出すと cp932 になり、Node 側（UTF-8）で文字化けする
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8')
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description='顔にモザイクをかける（deface の CenterFace で検出）')
    ap.add_argument('--check', action='store_true', help='deface と onnxruntime が使えるかを JSON で出すだけ')
    ap.add_argument('--input')
    ap.add_argument('--output')
    ap.add_argument('--report')
    ap.add_argument('--width', type=int, help='回転を反映した実効サイズ（ffmpeg は自動で回転してから渡す）')
    ap.add_argument('--height', type=int)
    ap.add_argument('--fps', help='書き出しのフレームレート（例 59.94）')
    ap.add_argument('--frames', type=int, default=0, help='進捗の分母の目安')
    ap.add_argument('--threshold', type=float, default=0.6, help='顔とみなすスコア。料理の寄りの誤検出は実測で 0.59 まで、実際の顔は 0.7〜0.93')
    ap.add_argument('--no-confirm', dest='confirm', action='store_false', help='前後のフレームに裏付けの無い検出も使う')
    ap.add_argument('--mask-scale', type=float, default=1.3)
    ap.add_argument('--cells', type=int, default=8, help='顔 1 つを何マスに割るか（少ないほど粗い）')
    ap.add_argument('--detect-short', type=int, default=720, help='検出に使う短辺の px（0 = 原寸）')
    ap.add_argument('--detect-every', type=int, default=1, help='何フレームに 1 回検出するか')
    ap.add_argument('--hold', type=int, default=4, help='検出した位置を前後何フレームまで隠すか')
    ap.add_argument('--crf', type=int, default=16)
    ap.add_argument('--preset', default='medium')
    ap.add_argument('--audio', choices=['copy', 'none'], default='copy')
    ap.add_argument('--color-space', default='')
    ap.add_argument('--color-primaries', default='')
    ap.add_argument('--color-trc', default='')
    ap.add_argument('--color-range', default='')
    ap.add_argument('--ffmpeg', default='ffmpeg')
    ap.add_argument('--backend', default='auto', choices=['auto', 'onnxrt', 'opencv'])
    ap.add_argument('--ep', default=None, help='onnxruntime の execution provider を固定する')
    args = ap.parse_args()
    if args.check:
        check()
        return 0
    missing = [n for n in ('input', 'output', 'report', 'width', 'height', 'fps') if getattr(args, n) in (None, '')]
    if missing:
        print(f'引数が足りません: {", ".join("--" + m for m in missing)}', file=sys.stderr)
        return 2
    return run(args)


if __name__ == '__main__':
    sys.exit(main())
