// 新規案件と同じ独立依存で、実素材のカット・テロップ・音声合成・MP4まで通す。
// API利用・既存案件の変更は行わない。結果は.runtime/smoke-*/に残す。
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {appRoot, runtimeEnv} from './runtime.mjs';
import {run, runNpm} from './setup-lib.mjs';
import {tsImport} from 'tsx/esm/api';

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
  const incoming = path.join(project, 'incoming.mp4');
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', incoming]);
  process.env.REEL_STUDIO_DATA_ROOT = path.join(project, 'local-data');
  process.env.REEL_STUDIO_HOME = path.join(project, 'settings');
  const {saveLocalUpload} = await tsImport('../core/local-upload.ts', import.meta.url);
  const {buildCatalog} = await tsImport('../core/catalog.ts', import.meta.url);
  const networkFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('ローカルの素材取り込み中にネットワークが呼ばれました'); };
  let src;
  try {
    const imported = await saveLocalUpload(fs.createReadStream(incoming), 'smoke', 'sample.mp4');
    const options = {materialsDir: path.dirname(imported.file), projectDir: project, slug: 'smoke', proxy: false, thumbs: true};
    const first = await buildCatalog(options);
    src = first.catalog.clips[0].src;
    const second = await buildCatalog(options);
    if (second.changed.length) throw new Error('変更のない素材が再コピーされました');
  } finally { globalThis.fetch = networkFetch; }
  fs.writeFileSync(path.join(project, 'cuts.json'), JSON.stringify({fps: 30, theme: 'pop', cuts: [
    {src, inSec: 0, outSec: 0.5, main: {text: '書き出しテスト', orientation: 'horizontal'}},
    {src, inSec: 1, outSec: 2, playbackRate: 2, crop: {zoom: 1.2, x: 0.4, y: 0.5}, price: {text: '編集・音声OK'}},
  ]}));
  const {createReelCut, defaultReelCutsConfig} = await tsImport('../shared/reel-cuts.ts', import.meta.url);
  const {writeReelCuts, readReelScript, saveReelScript, readReelCuts} = await tsImport('../core/reel-cuts.ts', import.meta.url);
  const {readCuts, writeCuts, readNarration, writeNarration} = await tsImport('../core/project.ts', import.meta.url);
  const cfg = defaultReelCutsConfig();
  writeReelCuts(project, [
    createReelCut(src, cfg, {id: 'first', duration: 0.5, pause_after: 0.1, line: '動作確認です', editor: {main: {text: '書き出しテスト', orientation: 'horizontal'}}}),
    createReelCut(src, cfg, {id: 'second', start: 1, duration: 0.5, pause_after: 0, editor: {playbackRate: 2, crop: {zoom: 1.2, x: 0.4, y: 0.5}, price: {text: '編集・音声OK'}}}),
  ]);
  const editing = readCuts(project); editing.cuts[0].color = {exposure: 0.1}; writeCuts(project, editing);
  saveReelScript(project, readReelScript(project).replace('動作確認です', '動作確認しました'));
  if (readReelCuts(project)[0].line !== '動作確認しました') throw new Error('共通台本の編集が保存されていません');
  const cli = path.join(project, 'node_modules/@remotion/cli/remotion-cli.js');
  run(process.execPath, [cli, 'render', 'GourmetReel', 'out/final.mp4', '--codec=h264', '--concurrency=1', '--gl=swiftshader', '--overwrite'], {cwd: project});
  run(process.execPath, [cli, 'still', 'GourmetReel', 'out/preview.png', '--frame=8', '--gl=swiftshader', '--overwrite'], {cwd: project});
  const synthetic = path.join(project, '.studio', 'synthetic.wav');
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.35', synthetic]);
  const n = readNarration(project); n.voice = 'smoke-voice'; writeNarration(project, n);
  process.env.FISH_API_KEY = 'synthetic-test-key'; process.env.FISH_MODEL_ID = 's2.1-pro-free';
  const {generateTts, resetFishEnv} = await tsImport('../core/tts.ts', import.meta.url); resetFishEnv();
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).startsWith('https://api.fish.audio/')) throw new Error(`Storage access forbidden: ${url}`);
    return init.method === 'POST' ? new Response(fs.readFileSync(synthetic)) : new Response('{}');
  };
  try {
    await generateTts(project);
    if ((await generateTts(project)).made.length) throw new Error('同じ音声が再生成されました');
  } finally {globalThis.fetch = networkFetch;}
  const final = path.join(project, 'out/final_narration.mp4');
  const {mixNarration} = await tsImport('../core/mix.ts', import.meta.url); await mixNarration(project, {onLine: console.log});
  const result = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', final], {env: runtimeEnv(), encoding: 'utf8', windowsHide: true});
  if (result.status !== 0) throw new Error(result.stderr || 'ffprobeに失敗');
  const media = JSON.parse(result.stdout);
  const video = media.streams.find((s) => s.codec_type === 'video');
  const audio = media.streams.find((s) => s.codec_type === 'audio');
  if (video?.codec_name !== 'h264' || video.width !== 1080 || video.height !== 1920 || Number(video.nb_read_frames) !== 30 || audio?.codec_name !== 'aac' || Math.abs(Number(media.format.duration) - 1) > 0.15) {
    throw new Error('書き出しの映像・音声・フレーム数・尺が想定と異なります。');
  }
  fs.writeFileSync(path.join(runtime, 'last-export-test.json'), JSON.stringify({ok: true, localImport: true, catalogReuse: true, commonReelCuts: true, narrationReuse: true, fishApi: 'mock', mediaStorage: 'local', checkedAt: new Date().toISOString(), output: final, preview: path.join(project, 'out/preview.png'), width: video.width, height: video.height, frames: Number(video.nb_read_frames), video: video.codec_name, audio: audio.codec_name}, null, 2));
  console.log(`\n書き出し動作確認OK: 1080×1920 / H.264 / AAC / 30フレーム\n${final}`);
} catch (error) {
  console.error(`書き出し動作確認に失敗: ${error.message}`);
  process.exitCode = 1;
}
