"""GPU-budgeted fixed-template rendering and lightweight mobile previews."""
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile

from modal_backend.models import gpu_info
from modal_backend.render_contracts import safe_asset


def main(request_file, progress_file, result_file, job_id):
    p = json.loads(Path(request_file).read_text())
    p['_jobId'] = job_id
    info = gpu_info()
    session = p['_session']
    from uuid import UUID
    base = Path('/data/cloud/sessions') / str(UUID(p['sessionId']))
    for f in session['files']:
        if not safe_asset(f['path']) or not f['complete']:
            raise ValueError('Invalid manifest')
        target = base / 'assets' / str(UUID(f['id']))
        if target.is_symlink() or not target.is_file() or target.stat().st_size != f['size']:
            raise ValueError('Stored asset unavailable')

    def progress(percent, phase):
        temp = Path(progress_file + '.tmp')
        temp.write_text(json.dumps({'status': 'running', 'percent': percent, 'phase': phase}))
        temp.replace(progress_file)

    if p['kind'] == 'remotion-render':
        with tempfile.TemporaryDirectory(prefix='reel-render-') as work:
            request = Path(work) / 'request.json'
            request.write_text(json.dumps(p))
            subprocess.run(['node', '/opt/reel/modal_backend/render.mjs', str(request), progress_file, result_file, work], check=True)
        result = json.loads(Path(result_file).read_text())
        result['gpuInfo'] = info
        Path(result_file).write_text(json.dumps(result))
        return

    videos = [f for f in session['files'] if f['path'].startswith('uploads/')]
    if not videos:
        raise ValueError('No videos')
    probes, derived, total_sec = {}, {}, 0
    (base / 'previews').mkdir(exist_ok=True)
    (base / 'thumbs').mkdir(exist_ok=True)
    nvenc = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=64x64:d=0.1', '-c:v', 'h264_nvenc', '-f', 'null', '-'], capture_output=True, timeout=10).returncode == 0
    for i, f in enumerate(videos):
        progress(5 + round(i / len(videos) * 85), f'軽量プレビューを作成中 {i+1}/{len(videos)}')
        source = base / 'assets' / f['id']
        probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', str(source)], timeout=30))
        video = next(s for s in probe['streams'] if s['codec_type'] == 'video')
        sec = float(probe['format']['duration'])
        total_sec += sec
        if not math.isfinite(sec) or not 0 < sec <= 180 or total_sec > 600 or video['width'] * video['height'] > 7680 * 4320:
            raise ValueError('Media bounds exceeded')
        a, b = map(float, video.get('avg_frame_rate', '30/1').split('/'))
        rotation = next((int(s.get('rotation', 0)) for s in video.get('side_data_list', []) if 'rotation' in s), 0)
        probes[f['id']] = {'codec': video['codec_name'], 'width': video['width'], 'height': video['height'], 'rotation': rotation, 'fps': a / b if b else 30, 'durationSec': sec, 'hasAudio': any(s['codec_type'] == 'audio' for s in probe['streams']), 'pixFmt': video.get('pix_fmt', '')}
        output = base / 'previews' / (f['id'] + '.mp4')
        codec = ['-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '2M'] if nvenc else ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24']
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', str(source), '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=540:960:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=30', *codec, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', str(output)], check=True)
        thumb = base / 'thumbs' / (f['id'] + '.jpg')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(output), '-frames:v', '1', '-vf', 'scale=320:-2', str(thumb)], check=True)
        derived['light/' + f['path']] = 'previews/' + output.name
        derived['studio/thumbs/' + thumb.name] = 'thumbs/' + thumb.name
    progress(96, 'プレビュー情報を保存中')
    output = Path('/data/results') / job_id / 'media.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    public = {'sessionId': p['sessionId'], 'files': [{'id': f['id'], 'path': f['path'], 'probe': probes[f['id']]} for f in videos]}
    output.write_text(json.dumps(public))
    Path(result_file).write_text(json.dumps({'path': str(output), 'resultType': 'application/json', 'gpuInfo': info, 'model': 'FFmpeg mobile preview', 'sessionUpdate': {'id': p['sessionId'], 'probes': probes, 'derived': derived}}))


if __name__ == '__main__':
    try:
        main(*sys.argv[1:])
    except Exception as error:
        # Only private worker logs receive diagnostics.
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)
