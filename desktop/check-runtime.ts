// Exercise the installed backend with no npm, global Node.js, or global FFmpeg.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createProject, npmInstall, readBrief, writeBrief, readCuts, writeCuts} from '../core/project';
import {applyPatch} from '../core/ai';
import {loadPersonasFromDisk} from '../core/personas-store';
import {defaultPersonaId} from '../shared/personas';
import {renderProject} from '../core/render';
import {mixNarration} from '../core/mix';
import {ffprobe} from '../core/ffprobe';
import {execOk} from '../core/exec';
import {codexVersion} from '../core/codex';
import {colorFilter} from '../shared/color';
import {loadSettings, mergeSettings, resetSettings, saveSettings} from '../core/settings';
import {resolveScriptSkill, scriptSkillCatalog, skillWithoutId} from '../shared/script-skill';
import {saveLocalUpload} from '../core/local-upload';
import {buildCatalog} from '../core/catalog';
import {syncAssets} from '../worker/sync';
import type {CloudClient} from '../worker/client';
import {createReelCut, defaultReelCutsConfig} from '../shared/reel-cuts';
import {readReelCuts, readReelScript, saveReelScript, writeReelCuts} from '../core/reel-cuts';
import {readNarration, writeNarration} from '../core/project';
import {generateTts, resetFishEnv} from '../core/tts';
import {modalConfig, modalSecrets, modalSettingsView, saveModalSettings} from '../core/modal-vault';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
// The standalone updater stages this helper outside the installed directory.
const updaterRuntime = require('./runtime.cjs');
updaterRuntime.checkFiles(updaterRuntime.locations(true, path.dirname(backend), backend));
for (const name of ['tsx', 'express', 'react', 'remotion', '@openai/codex/package.json']) {
  const resolved = require.resolve(name);
  if (!resolved.startsWith(path.join(backend, 'node_modules') + path.sep)) throw new Error(`同梱外の部品に依存しています: ${name}`);
}
const codex = await codexVersion();
if (!codex) throw new Error('同梱Codexの実行部品を起動できません。');
loadPersonasFromDisk();
saveModalSettings(modalConfig(), {proxyTokenId: 'wk-desktop-verification', proxyTokenSecret: 'ws-desktop-verification'});
if (modalSecrets().proxyTokenSecret !== 'ws-desktop-verification' || JSON.stringify(modalSettingsView()).includes('ws-desktop-verification')) throw new Error('Modal認証情報の暗号化・非表示を確認できません。');
const {dir} = createProject('desktop-offline-check', {persona: defaultPersonaId(), shopName: '動作確認'});
const selectedSkill = {id: 'desktop-selected', fileName: 'SKILL.md', content: '# 案件専用\n料理の全景を最初に見せる', enabled: true};
const defaultSkill = {...selectedSkill, id: 'desktop-default', content: '# 既定\n提供シーンから始める'};
saveSettings(mergeSettings(loadSettings(), {scriptSkills: [selectedSkill, defaultSkill], scriptSkill: skillWithoutId(defaultSkill)}));
resetSettings();
writeBrief(dir, {...readBrief(dir)!, scriptSkill: selectedSkill});
if (scriptSkillCatalog(loadSettings()).entries.length !== 2 || resolveScriptSkill(readBrief(dir)!, loadSettings())?.content !== selectedSkill.content) throw new Error('案件ごとの台本スキルの保存・読み込みに失敗しました。');
writeBrief(dir, {...readBrief(dir)!, scriptSkill: null});
if (resolveScriptSkill(readBrief(dir)!, loadSettings())) throw new Error('この案件では台本スキルを使わない設定に失敗しました。');
writeBrief(dir, {...readBrief(dir)!, scriptSkill: selectedSkill});
await npmInstall(dir, console.log);
const incoming = path.join(process.env.REEL_STUDIO_HOME!, 'incoming.mp4');
await execOk('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', incoming]);
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('ローカル素材の処理がネットワークへ接続しました'); };
let source: string;
try {
  const imported = await saveLocalUpload(fs.createReadStream(incoming), 'check', 'sample.mp4');
  const options = {materialsDir: path.dirname(imported.file), projectDir: dir, slug: 'desktop-offline-check', proxy: false, thumbs: false};
  source = (await buildCatalog(options)).catalog.clips[0].src;
  if ((await buildCatalog(options)).changed.length) throw new Error('同じ素材を再コピーしました');
  const client = {registerAssets: async (_slug: string, assets: {url: string}[]) => {
    if (assets.some((a) => !path.isAbsolute(a.url))) throw new Error('メディア参照がローカルパスではありません');
    return {ok: true, saved: assets.length, bad: []};
  }} as unknown as CloudClient;
  await syncAssets(client, dir);
  if ((await syncAssets(client, dir)).uploaded) throw new Error('変更のない素材参照を再登録しました');
} finally { globalThis.fetch = originalFetch; }
writeCuts(dir, {fps: 30, theme: 'pop', cuts: [
  {id: 'c1', src: source, inSec: 0, outSec: 0.5, zoom: {mode: 'push', scale_start: 1, scale_end: 1.18, ease: 'in_out', anchor_x: 0.5, anchor_y: 0.45}, main: {text: 'アプリの書き出し確認', orientation: 'horizontal'}},
  {id: 'c2', src: source, inSec: 1, outSec: 2, playbackRate: 2, crop: {zoom: 1.2, x: 0.4, y: 0.5}, zoom: {mode: 'pull', scale_start: 1.2, scale_end: 1, ease: 'out', anchor_x: 0.6, anchor_y: 0.45}, price: {text: '同梱のエンジンで編集'}},
]});
const color = {exposure: -0.5, brightness: 1.1, contrast: 1.2, saturation: 0.7};
const colorCuts = readCuts(dir);
writeCuts(dir, {...colorCuts, cuts: colorCuts.cuts.map((cut, index) => index === 0 ? {...cut, color} : cut)});
if (JSON.stringify(readCuts(dir).cuts[0].color) !== JSON.stringify(color) || !colorFilter(readCuts(dir).cuts[0].color)) throw new Error('色・明るさ補正の保存・描画設定を確認できません。');
const zoomPatch = applyPatch(readCuts(dir), null, {clips: []}, {summary: 'ズームを最適化', cuts: [
  {cutId: 'c1', zoom: {mode: 'push', scale_start: 1, scale_end: 1.1, anchor_x: 0.5, anchor_y: 0.42}},
  {cutId: 'c2', zoom: {mode: 'pull', scale_start: 1.1, scale_end: 1, anchor_x: 0.43, anchor_y: 0.61}},
]}, {maxCutSec: 3});
if (zoomPatch.applied.length !== 2 || zoomPatch.unapplied.length) throw new Error('AIズーム差分の適用に失敗しました。');
writeCuts(dir, zoomPatch.cuts);
const emptyTelopPatch = applyPatch(readCuts(dir), null, {clips: []}, {summary: '空のAI差分を保護', telops: [{cutId: 'c1', text: ''}]}, {maxCutSec: 3});
if (emptyTelopPatch.cutsTouched || emptyTelopPatch.applied.length || emptyTelopPatch.unapplied.length !== 1 || emptyTelopPatch.cuts.cuts[0].main?.text !== 'アプリの書き出し確認') throw new Error('AIの空テロップから既存文言を保護できません。');
const cfg = defaultReelCutsConfig();
writeReelCuts(dir, readCuts(dir).cuts.map(({id, src, inSec, outSec, ...editor}, index) => createReelCut(src, cfg, {
  id, start: inSec, duration: (outSec - inSec) / (editor.playbackRate ?? 1),
  line: index === 0 ? '動作確認です' : '', pause_after: index === 0 ? 0.1 : 0, editor,
})));
saveReelScript(dir, readReelScript(dir)!.replace('動作確認です', '動作確認しました'));
const commonEditor = readCuts(dir);
writeCuts(dir, {...commonEditor, cuts: commonEditor.cuts.map((cut, index) => index === 0 ? {...cut, main: {...cut.main!, text: '共通JSONから書き出し'}} : cut)});
if (readReelCuts(dir)?.[0].line !== '動作確認しました' || readReelCuts(dir)?.[0].editor?.main?.text !== '共通JSONから書き出し' || readNarration(dir)?.segments[0].text !== '動作確認しました') throw new Error('共通カットJSONと編集・台本・音声が一致しません。');
const render = await renderProject({projectDir: dir, allowErrors: true, force: true, retries: 1, thumbnail: false, concurrency: 1, onLine: console.log});
if (!render.ok || render.frames !== 30) throw new Error('映像の書き出し検証に失敗しました。');
fs.mkdirSync(path.join(dir, 'narration'), {recursive: true});
const synthetic = path.join(dir, '.studio', 'synthetic.wav');
await execOk('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.35', synthetic]);
writeNarration(dir, {...readNarration(dir)!, voice: 'packaged-test-voice'});
process.env.FISH_API_KEY = 'synthetic-test-key'; process.env.FISH_MODEL_ID = 's2.1-pro-free'; resetFishEnv();
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith('https://api.fish.audio/')) throw new Error('テストがStorageに接続しました');
  return init.method === 'POST' ? new Response(fs.readFileSync(synthetic)) : new Response('{}');
};
try {
  if ((await generateTts(dir)).made.length !== 1 || (await generateTts(dir)).made.length !== 0) throw new Error('同梱版の共通カット音声生成・再利用を確認できません。');
  const plain = path.join(dir, '.studio', 'ordinary-narration-check');
  fs.mkdirSync(plain, {recursive: true});
  writeNarration(plain, {voice: 'packaged-test-voice', segments: [{id: 'test-emotion', at: 0, text: '動作確認です', emotion_tag: 'excited', needsTts: true}]});
  let sentText = '';
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).startsWith('https://api.fish.audio/')) throw new Error('テストがStorageに接続しました');
    if (init.method === 'POST') sentText = JSON.parse(String(init.body)).text;
    return init.method === 'POST' ? new Response(fs.readFileSync(synthetic)) : new Response('{}');
  };
  if ((await generateTts(plain, {ids: ['test-emotion'], force: true})).made.length !== 1 || sentText !== '[excited] 動作確認です' || (await generateTts(plain)).made.length !== 0) throw new Error('ナレーション音声への感情タグとローカル再利用を確認できません。');
} finally {globalThis.fetch = originalFetch; delete process.env.FISH_API_KEY; resetFishEnv();}
const mixed = await mixNarration(dir, {onLine: console.log});
const final = path.join(dir, mixed.outRel);
const probe = await ffprobe(final);
if (probe.width !== 1080 || probe.height !== 1920 || !probe.hasAudio || Math.abs(probe.durationSec - 1) > 0.15) throw new Error('完成動画の映像・音声・尺が一致しません。');
fs.writeFileSync(path.join(process.env.REEL_STUDIO_HOME!, 'runtime-smoke.json'), JSON.stringify({ok: true, modalCloudGpu: true, modalCredentialsEncrypted: true, mediaStorage: 'local', localImport: true, catalogReuse: true, commonReelCuts: true, narrationReuse: true, narrationEmotion: true, fishApi: 'mock', node: process.version, codex, frames: render.frames, width: probe.width, height: probe.height, hasAudio: probe.hasAudio, output: final}, null, 2));
console.log(`インストール版の書き出し確認OK: ${final}`);
