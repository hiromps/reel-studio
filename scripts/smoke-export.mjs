// 新規案件と同じ独立依存で、実素材のカット・テロップ・音声合成・MP4まで通す。
// API利用・既存案件の変更は行わない。結果は.runtime/smoke-*/に残す。
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {appRoot, runtimeEnv} from './runtime.mjs';
import {run, runNpm} from './setup-lib.mjs';

try {
  const runtime = path.join(appRoot, '.runtime');
  fs.mkdirSync(runtime, {recursive: true});
  const project = fs.mkdtempSync(path.join(runtime, 'smoke-'));
  const engine = path.join(appRoot, 'engine');
  fs.cpSync(engine, project, {recursive: true, filter: (src) => !['node_modules', 'out', '.studio'].includes(path.relative(engine, src).split(path.sep)[0])});
  runNpm(['ci', '--include=dev', '--no-audit', '--no-fund', '--prefer-offline'], project);
  fs.mkdirSync(path.join(project, 'public/uploads'), {recursive: true});
  fs.mkdirSync(path.join(project, 'narration'), {recursive: true});
  fs.mkdirSync(path.join(project, 'out'), {recursive: true});
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(project, 'public/uploads/sample.mp4')]);
  fs.writeFileSync(path.join(project, 'cuts.json'), JSON.stringify({fps: 30, theme: 'pop', cuts: [
    {src: 'uploads/sample.mp4', inSec: 0, outSec: 0.5, main: {text: '書き出しテスト', orientation: 'horizontal'}},
    {src: 'uploads/sample.mp4', inSec: 1, outSec: 2, playbackRate: 2, crop: {zoom: 1.2, x: 0.4, y: 0.5}, price: {text: '編集・音声OK'}},
  ]}));
  const cli = path.join(project, 'node_modules/@remotion/cli/remotion-cli.js');
  run(process.execPath, [cli, 'render', 'GourmetReel', 'out/final.mp4', '--codec=h264', '--concurrency=1', '--gl=swiftshader', '--overwrite'], {cwd: project});
  run(process.execPath, [cli, 'still', 'GourmetReel', 'out/preview.png', '--frame=8', '--gl=swiftshader', '--overwrite'], {cwd: project});
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6', path.join(project, 'narration/test.wav')]);
  fs.writeFileSync(path.join(project, 'narration.json'), JSON.stringify({segments: [{id: 'test', at: 0.1, durSec: 0.6, text: '動作確認'}], sfx: []}));
  const final = path.join(project, 'out/final_narration.mp4');
  run(process.execPath, [path.join(appRoot, 'scripts/mix-narration.cjs'), path.join(project, 'narration.json'), path.join(project, 'narration'), path.join(project, 'out/final.mp4'), final], {cwd: project});
  const result = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', final], {env: runtimeEnv(), encoding: 'utf8', windowsHide: true});
  if (result.status !== 0) throw new Error(result.stderr || 'ffprobeに失敗');
  const media = JSON.parse(result.stdout);
  const video = media.streams.find((s) => s.codec_type === 'video');
  const audio = media.streams.find((s) => s.codec_type === 'audio');
  if (video?.codec_name !== 'h264' || video.width !== 1080 || video.height !== 1920 || Number(video.nb_read_frames) !== 30 || audio?.codec_name !== 'aac' || Math.abs(Number(media.format.duration) - 1) > 0.15) {
    throw new Error('書き出しの映像・音声・フレーム数・尺が想定と異なります。');
  }
  fs.writeFileSync(path.join(runtime, 'last-export-test.json'), JSON.stringify({ok: true, checkedAt: new Date().toISOString(), output: final, preview: path.join(project, 'out/preview.png'), width: video.width, height: video.height, frames: Number(video.nb_read_frames), video: video.codec_name, audio: audio.codec_name}, null, 2));
  console.log(`\n書き出し動作確認OK: 1080×1920 / H.264 / AAC / 30フレーム\n${final}`);
} catch (error) {
  console.error(`書き出し動作確認に失敗: ${error.message}`);
  process.exitCode = 1;
}
