// 実レンダー受け入れテスト。REEL_ZOOM_RENDER_TEST=1 npm test -- test/zoom-render.test.ts
// 結果（動画、先頭/中央/末尾PNG、比較タイル）は .runtime/zoom-check-*/ に残す。
import fs from 'node:fs';
import path from 'node:path';
import {expect, it} from 'vitest';
import {execOk} from '../core/exec';
import {ffprobe, countFrames} from '../core/ffprobe';
import {renderProject} from '../core/render';
import {studioConfig} from '../studio.config';

it.skipIf(process.env.REEL_ZOOM_RENDER_TEST !== '1')('23フレーム、解像度、none互換、映像ズームと固定テロップ、音声を実レンダーで検証', async () => {
  const runtime = path.join(studioConfig.appRoot, '.runtime');
  fs.mkdirSync(runtime, {recursive: true});
  const projectDir = fs.mkdtempSync(path.join(runtime, 'zoom-check-'));
  for (const name of ['src', 'public', 'package.json', 'remotion.config.ts', 'tsconfig.json']) {
    fs.cpSync(path.join(studioConfig.templateDir, name), path.join(projectDir, name), {recursive: true});
  }
  fs.symlinkSync(path.join(studioConfig.templateDir, 'node_modules'), path.join(projectDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const source = path.join(projectDir, 'public', 'grid.mp4');
  await execOk('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x486050:s=1080x1920:r=30,drawgrid=w=120:h=120:t=3:c=white,drawbox=x=480:y=800:w=120:h=120:color=red:t=fill,drawbox=x=700:y=400:w=100:h=100:color=yellow:t=fill', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-frames:v', '23', '-t', String(23 / 30), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
  expect((await countFrames(source)).frames).toBe(23);
  const cuts = {fps: 30, cuts: [{id: 'c01', src: 'grid.mp4', inSec: 0, outSec: 23 / 30, main: {text: 'ズーム確認', orientation: 'horizontal'}}]};
  const cutsPath = path.join(projectDir, 'cuts.json');
  const originalCuts = JSON.stringify(cuts);
  fs.writeFileSync(cutsPath, originalCuts);
  const configPath = path.join(projectDir, 'zoom.json');
  const results: Record<string, string> = {};
  const opts = {projectDir, concurrency: 1, retries: 1, thumbnail: false, allowErrors: true, force: true};
  for (const mode of ['baseline', 'none', 'push', 'pull'] as const) {
    if (mode !== 'baseline') fs.writeFileSync(configPath, JSON.stringify({cuts: {c01: {mode, scale_start: mode === 'pull' ? 1.45 : 1, scale_end: mode === 'push' ? 1.45 : 1, anchor_x: 0.5, anchor_y: 0.45}}}));
    const result = await renderProject({...opts, out: `out/${mode}.mp4`, zoomPreset: mode === 'push' ? 'viral_zoom' : undefined, zoomConfig: mode === 'baseline' ? undefined : configPath});
    expect(result.frames).toBe(23); expect(result.expectedFrames).toBe(23);
    const probe = await ffprobe(result.outPath);
    expect([probe.width, probe.height, probe.fps, probe.hasAudio]).toEqual([1080, 1920, 30, true]);
    expect(fs.readFileSync(cutsPath, 'utf8')).toBe(originalCuts);
    results[mode] = result.outPath;
    for (const [name, frame] of [['first', 0], ['middle', 11], ['last', 22]] as const) {
      await execOk('ffmpeg', ['-y', '-v', 'error', '-i', result.outPath, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', path.join(projectDir, 'out', `${mode}-${name}.png`)]);
    }
  }
  const frameHashes = async (file: string, filter?: string) => {
    const args = ['-v', 'error', '-i', file, '-map', '0:v:0'];
    if (filter) args.push('-vf', filter);
    const r = await execOk('ffmpeg', [...args, '-f', 'framemd5', '-']);
    return r.stdout.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').at(-1)?.trim());
  };
  expect(await frameHashes(results.none)).toEqual(await frameHashes(results.baseline));
  // 音声は同じ素材・同じ時間軸で供給され、ズームによって変化しない。
  const audioHash = async (file: string) => (await execOk('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'md5', '-'])).stdout.trim();
  expect(await audioHash(results.push)).toBe(await audioHash(results.baseline));
  expect(await audioHash(results.pull)).toBe(await audioHash(results.baseline));
  const center = 'crop=600:700:240:600';
  const push = await frameHashes(results.push, center);
  const pull = await frameHashes(results.pull, center);
  expect(push[0]).not.toBe(push[22]); expect(pull[0]).not.toBe(pull[22]);
  await execOk('ffmpeg', ['-y', '-v', 'error', '-i', results.push, '-vf', 'select=eq(n\\,0)+eq(n\\,11)+eq(n\\,22),scale=270:480,tile=3x1', '-frames:v', '1', path.join(projectDir, 'out', 'push-comparison.png')]);
  fs.writeFileSync(path.join(runtime, 'last-zoom-test.json'), JSON.stringify({ok: true, projectDir, results, frames: 23, width: 1080, height: 1920}, null, 2));
  console.log(`ズーム受け入れ検証OK: ${projectDir}`);
}, 600000);
