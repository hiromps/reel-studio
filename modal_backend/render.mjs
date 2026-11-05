// Only this shipped composition is executable. Requests contain editing data, never code.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';
const [requestFile, progressFile, resultFile, work] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
const root = process.env.REEL_REMOTION_ROOT || '/opt/reel';
const update = (status, percent, phase) => {
  fs.writeFileSync(progressFile + '.tmp', JSON.stringify({status, percent, phase}));
  fs.renameSync(progressFile + '.tmp', progressFile);
};
const run = (bin, args, extra = {}) => {
  const r = spawnSync(bin, args, {encoding: 'utf8', maxBuffer: 4 * 1024 ** 2, timeout: 120000, ...extra});
  if (r.status !== 0) throw new Error('Render subprocess failed: ' + bin);
  return r.stdout;
};
const info = file => JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
try {
  update('loading', 5, '描画エンジンを準備中');
  const publicDir = path.join(work, 'public');
  fs.mkdirSync(publicDir, {recursive: true});
  fs.cpSync(path.join(root, 'engine/public/fonts'), path.join(publicDir, 'fonts'), {recursive: true});
  const sessionRoot = path.join('/data/cloud/sessions', p.sessionId);
  for (const f of p._session.files) {
    const target = path.resolve(publicDir, f.path);
    if (!target.startsWith(publicDir + path.sep)) throw new Error('Invalid media path');
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(path.join(sessionRoot, 'assets', f.id), target);
  }
  const serveUrl = await bundle({entryPoint: path.join(root, 'modal_backend/remotion_entry.tsx'), publicDir, outDir: path.join(work, 'bundle')});
  const browserExecutable = JSON.parse(fs.readFileSync(path.join(root, 'chrome.json'), 'utf8')).path;
  const inputProps = p.cuts;
  const common = {serveUrl, inputProps, browserExecutable, chromiumOptions: {gl: 'swiftshader'}, timeoutInMilliseconds: 30000};
  const composition = await selectComposition({...common, id: 'GourmetReel'});
  if (composition.durationInFrames / composition.fps > 180) throw new Error('Duration limit');
  const nvenc = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=64x64:d=0.1', '-c:v', 'h264_nvenc', '-f', 'null', '-'], {timeout: 10000, stdio: 'ignore'}).status === 0;
  const output = path.join('/data/results', p._jobId, 'final.mp4');
  fs.mkdirSync(path.dirname(output), {recursive: true});
  const raw = path.join(work, 'render.mp4');
  let previous = -1;
  await renderMedia({...common, composition, codec: 'h264', outputLocation: raw,
    hardwareAcceleration: nvenc ? 'required' : 'disable', videoBitrate: p.draft ? '2M' : '8M',
    audioCodec: 'aac', audioBitrate: '192k', enforceAudioTrack: true,
    scale: p.draft ? 0.5 : 1, concurrency: 2, offthreadVideoThreads: 2,
    onProgress: ({progress}) => {const percent = Math.floor(10 + progress * 75); if (percent > previous) {previous = percent; update('running', percent, '映像・字幕をレンダリング中');}},
  });
  const narration = p.narration;
  if (narration && (narration.segments.length || narration.sfx.length)) {
    update('running', 88, 'ナレーション・効果音を合成中');
    // Strip every passthrough field before invoking the existing audio mixer.
    // Its shell receives only generated paths, IDs and validated numeric values.
    const audio = path.join(work, 'audio'); const sfxDir = path.join(work, 'sfx');
    fs.mkdirSync(audio, {recursive: true}); fs.mkdirSync(sfxDir, {recursive: true});
    const finite = (v, lo, hi, fallback) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
    const spec = {narrationGainDb: finite(narration.narrationGainDb, -12, 12, 8), ambientGain: finite(narration.ambientGain, 0, 1, 0.22), sfxGainDb: finite(narration.sfxGainDb, -30, 12, 0), sfxDir,
      segments: narration.segments.map((s, i) => {
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(s.id)) throw new Error('Invalid audio ID');
        fs.copyFileSync(path.join(publicDir, 'narration', s.id + '.wav'), path.join(audio, `n${i}.wav`));
        return {id: `n${i}`, text: '', at: finite(s.at, 0, 3600, 0), durSec: finite(s.durSec, 0.001, 3600, 1), ...(s.trimSec ? {trimSec: finite(s.trimSec, 0.001, 3600, 1)} : {})};
      }),
      sfx: narration.sfx.map((s, i) => {
        const source = path.resolve(publicDir, 'sfx', s.file);
        if (!source.startsWith(path.join(publicDir, 'sfx') + path.sep)) throw new Error('Invalid sound path');
        const file = `s${i}${path.extname(s.file).toLowerCase()}`;
        fs.copyFileSync(source, path.join(sfxDir, file));
        return {id: `s${i}`, file, at: finite(s.at, 0, 3600, 0), gainDb: finite(s.gainDb, -30, 12, 0), ...(s.trimSec ? {trimSec: finite(s.trimSec, 0.001, 180, 1)} : {}), fadeOutSec: finite(s.fadeOutSec, 0, 10, 0)};
      })};
    const specPath = path.join(work, 'narration.json'); fs.writeFileSync(specPath, JSON.stringify(spec));
    run(process.execPath, [path.join(root, 'scripts/mix-narration.cjs'), specPath, audio, raw, output], {env: {...process.env, REEL_SFX_DIR: sfxDir}, timeout: 180000});
  } else fs.copyFileSync(raw, output);
  const probe = info(output); const video = probe.streams.find(s => s.codec_type === 'video');
  const audio = probe.streams.some(s => s.codec_type === 'audio');
  if (video?.codec_name !== 'h264' || Number(video.nb_frames) !== composition.durationInFrames || !audio) throw new Error('Final MP4 validation failed');
  fs.writeFileSync(resultFile, JSON.stringify({path: output, resultType: 'video/mp4', model: 'Remotion 4.0.540', renderInfo: {remotion: '4.0.540', encoder: nvenc ? 'h264_nvenc' : 'libx264', width: video.width, height: video.height, fps: composition.fps, frames: composition.durationInFrames, durationSec: Number(probe.format.duration), audio, warnings: nvenc ? [] : ['この実行環境ではNVENCを利用できないため、クラウドCPUでエンコードしました。端末側ではレンダリングしません。']}}));
  update('running', 99, 'MP4を保存中');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
