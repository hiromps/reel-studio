// Exercise the installed backend with no npm, global Node.js, or global FFmpeg.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createProject, npmInstall, writeCuts} from '../core/project';
import {loadPersonasFromDisk} from '../core/personas-store';
import {defaultPersonaId} from '../shared/personas';
import {renderProject} from '../core/render';
import {mixNarration} from '../core/mix';
import {ffprobe} from '../core/ffprobe';
import {execOk} from '../core/exec';
import {codexVersion} from '../core/codex';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
for (const name of ['tsx', 'express', 'react', 'remotion', '@openai/codex/package.json']) {
  const resolved = require.resolve(name);
  if (!resolved.startsWith(path.join(backend, 'node_modules') + path.sep)) throw new Error(`同梱外の部品に依存しています: ${name}`);
}
const codex = await codexVersion();
if (!codex) throw new Error('同梱Codexの実行部品を起動できません。');
loadPersonasFromDisk();
const {dir} = createProject('desktop-offline-check', {persona: defaultPersonaId(), shopName: '動作確認'});
await npmInstall(dir, console.log);
await execOk('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'public/uploads/sample.mp4')]);
writeCuts(dir, {fps: 30, theme: 'pop', cuts: [
  {id: 'c1', src: 'uploads/sample.mp4', inSec: 0, outSec: 0.5, zoom: {mode: 'push', scale_start: 1, scale_end: 1.18, ease: 'in_out', anchor_x: 0.5, anchor_y: 0.45}, main: {text: 'アプリの書き出し確認', orientation: 'horizontal'}},
  {id: 'c2', src: 'uploads/sample.mp4', inSec: 1, outSec: 2, playbackRate: 2, crop: {zoom: 1.2, x: 0.4, y: 0.5}, zoom: {mode: 'pull', scale_start: 1.2, scale_end: 1, ease: 'out', anchor_x: 0.6, anchor_y: 0.45}, price: {text: '同梱のエンジンで編集'}},
]});
const render = await renderProject({projectDir: dir, allowErrors: true, force: true, retries: 1, thumbnail: false, concurrency: 1, onLine: console.log});
if (!render.ok || render.frames !== 30) throw new Error('映像の書き出し検証に失敗しました。');
fs.mkdirSync(path.join(dir, 'narration'), {recursive: true});
await execOk('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6', path.join(dir, 'narration/test.wav')]);
fs.writeFileSync(path.join(dir, 'narration.json'), JSON.stringify({voice: 'test', segments: [{id: 'test', at: 0.1, durSec: 0.6, text: '動作確認'}], sfx: []}));
const mixed = await mixNarration(dir, {onLine: console.log});
const final = path.join(dir, mixed.outRel);
const probe = await ffprobe(final);
if (probe.width !== 1080 || probe.height !== 1920 || !probe.hasAudio || Math.abs(probe.durationSec - 1) > 0.15) throw new Error('完成動画の映像・音声・尺が一致しません。');
fs.writeFileSync(path.join(process.env.REEL_STUDIO_HOME!, 'runtime-smoke.json'), JSON.stringify({ok: true, node: process.version, codex, frames: render.frames, width: probe.width, height: probe.height, hasAudio: probe.hasAudio, output: final}, null, 2));
console.log(`インストール版の書き出し確認OK: ${final}`);
