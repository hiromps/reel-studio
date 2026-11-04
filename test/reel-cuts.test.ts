import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ReelCutsSchema, ReelSlotSchema} from '../shared/schema/reel-cuts';
import {createReelCut, defaultReelCutsConfig, reelCutsToScript, reelFishText} from '../shared/reel-cuts';
import {loadReelCutsConfig, readReelCuts, readReelScript, reelCutsPath, saveReelScript, writeReelCuts} from '../core/reel-cuts';
import {readCuts, readNarration, writeCuts, writeNarration} from '../core/project';
import {reelTtsBody} from '../core/tts';
import {reelCutsRouter} from '../server/routes/reel-cuts';
import {filesRouter} from '../server/routes/files';
import {resetSettings} from '../core/settings';
import {calcTotalFrames, cutRanges} from '../shared/timeline';

let root: string;
let dir: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-cuts-test-'));
  vi.stubEnv('REEL_STUDIO_DATA_ROOT', root);
  resetSettings();
  dir = path.join(root, 'work', 'test-reel');
  fs.mkdirSync(path.join(dir, 'public', 'uploads'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'public', 'uploads', 'dish.mp4'), 'local-media');
});
afterEach(() => {
  vi.unstubAllEnvs(); resetSettings();
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('reel-cuts-test-')) throw new Error('Unexpected test root');
  fs.rmSync(root, {recursive: true, force: true});
});
const cut = (values = {}) => createReelCut('uploads/dish.mp4', defaultReelCutsConfig(), {id: 'dish-1', line: 'このお肉は最高です', emphasis: ['お肉'], ...values});

describe('共通カット配列の検証', () => {
  it('指定の10スロットと全フィールドを扱う', () => {
    expect(ReelSlotSchema.options).toEqual(['self_eat', 'shop_highlight', 'dish', 'crowd', 'entrance', 'serve', 'sizzle', 'eating', 'interior', 'exterior']);
    for (const slot of ReelSlotSchema.options) expect(ReelCutsSchema.parse([cut({slot})])[0].slot).toBe(slot);
  });
  it.each([
    {slot: 'hook'}, {intensity: 0}, {intensity: 6}, {intensity: 1.5}, {start: -1}, {duration: 0},
    {duration: Infinity}, {speed: 0.4}, {speed: 2.1}, {pause_after: -1}, {pause_after: 2},
    {clip_path: 'https://example.supabase.co/storage/v1/object/public/video.mp4'}, {clip_path: 'data:video/mp4;base64,AAAA'},
    {clip_path: '../secret.mp4'}, {clip_path: 'uploads/../../secret.mp4'}, {clip_path: '\\\\server\\clip.mp4'},
    {emotion_tag: '(excited)'}, {emphasis: ['存在しない語']}, {id: '../evil'},
  ])('不正な入力を拒否する: %j', (invalid) => {
    expect(ReelCutsSchema.safeParse([{...cut(), ...invalid}]).success).toBe(false);
  });
  it('不足フィールド・重複IDを拒否する', () => {
    for (const field of ['slot', 'clip_path', 'start', 'duration', 'line', 'intensity', 'emotion_tag', 'speed', 'pause_after', 'emphasis']) {
      const value: Record<string, unknown> = {...cut()}; delete value[field];
      expect(ReelCutsSchema.safeParse([value]).success, field).toBe(false);
    }
    expect(ReelCutsSchema.safeParse([cut(), cut()]).success).toBe(false);
  });
});

it('編集・台本・音声が同じ配列へ保存され、並べ替えてもIDを保持する', () => {
  const saved = writeReelCuts(dir, [cut(), cut({id: 'shop-2', slot: 'shop_highlight', start: 3, duration: 3, line: '店内も素敵です', emphasis: []})]);
  expect(readReelCuts(dir)).toEqual(saved);
  const editor = readCuts(dir);
  editor.cuts.reverse(); editor.cuts[1].inSec = 1; editor.cuts[1].outSec = 3.5;
  editor.cuts[1].crop = {zoom: 1.2, x: 0.4, y: 0.5};
  writeCuts(dir, editor);
  expect(readReelCuts(dir)?.[1]).toMatchObject({id: 'dish-1', start: 1, duration: 2.5, editor: {crop: {zoom: 1.2}}});
  const script = readReelScript(dir)!;
  saveReelScript(dir, script.replace('このお肉は最高です', 'このお肉はとろけます'));
  expect(readNarration(dir)?.segments[1]).toMatchObject({id: 'oc_dish-1', at: 3, text: 'このお肉はとろけます', trimSec: 2.35, needsTts: true});
  const narration = readNarration(dir)!;
  narration.segments[1].text = 'お肉が最高です'; narration.segments[1].speed = 1.4;
  writeNarration(dir, narration);
  expect(readReelCuts(dir)?.[1]).toMatchObject({line: 'お肉が最高です', speed: 1.4});
  expect(readReelScript(dir)).toContain('お肉が最高です');
  expect(fs.readdirSync(path.join(dir, '.studio', 'backups')).some((f) => f.startsWith('reel-cuts.'))).toBe(true);
});

it('音声実測と再利用を保持し、文言・話速・感情の変更で無効化する', () => {
  writeReelCuts(dir, [cut()]);
  const narration = readNarration(dir)!;
  narration.segments[0].durSec = 1.2; delete narration.segments[0].needsTts;
  writeNarration(dir, narration);
  expect(readNarration(dir)?.segments[0]).toMatchObject({durSec: 1.2, needsTts: false});
  for (const update of [{line: 'このお肉が一番です'}, {speed: 1.3}, {emotion_tag: '[happy]'}, {intensity: 4}, {emphasis: ['最高']}]) {
    writeReelCuts(dir, [cut(update)]);
    expect(readNarration(dir)?.segments[0].needsTts).toBe(true);
    expect(readNarration(dir)?.segments[0].durSec).toBeUndefined();
  }
});

it('ローカル絶対パスを一度だけリンク/コピーし、繰り返し参照する', () => {
  const media = path.join(root, 'media', '素材.mp4'); fs.mkdirSync(path.dirname(media)); fs.writeFileSync(media, 'video');
  const first = writeReelCuts(dir, [cut({clip_path: media})]);
  const src = readCuts(dir).cuts[0].src;
  const stat = fs.statSync(path.join(dir, 'public', src));
  writeReelCuts(dir, first);
  expect(readCuts(dir).cuts[0].src).toBe(src);
  expect(fs.statSync(path.join(dir, 'public', src)).mtimeMs).toBe(stat.mtimeMs);
  expect(fs.readdirSync(path.join(dir, 'public', 'uploads', 'reel-cuts'))).toHaveLength(1);
  const editor = readCuts(dir); editor.cuts[0].outSec = 3; writeCuts(dir, editor);
  expect(readReelCuts(dir)?.[0].clip_path).toBe(media);
});

it('不正JSON・ファイル欠落時に既存の共通JSONを上書きしない', () => {
  writeReelCuts(dir, [cut()]);
  const before = fs.readFileSync(reelCutsPath(dir), 'utf8');
  expect(() => writeReelCuts(dir, [cut({clip_path: 'uploads/missing.mp4'})])).toThrow();
  expect(fs.readFileSync(reelCutsPath(dir), 'utf8')).toBe(before);
  expect(() => saveReelScript(dir, '自由文に置き換える')).toThrow('カットID');
});

it('端数フレームを含む連続カットでも編集映像と音声の開始位置が一致する', () => {
  writeReelCuts(dir, Array.from({length: 40}, (_, i) => cut({id: `cut-${i}`, duration: 0.07, pause_after: 0.01})));
  const narration = readNarration(dir)!;
  expect(narration.segments[39].at).toBe(78 / 30);
  expect(narration.videoSec).toBe(80 / 30);
  expect(readReelCuts(dir)?.[0].duration).toBe(0.07);
  const n = structuredClone(narration); n.segments[0].text = 'お肉は最高です'; writeNarration(dir, n);
  expect(readReelCuts(dir)?.[0].line).toBe('お肉は最高です');
  writeReelCuts(dir, [cut({start: 0.1, duration: 0.05, pause_after: 0.01}), cut({id: 'next', duration: 0.1, pause_after: 0.01})]);
  const video = readCuts(dir);
  expect(readNarration(dir)?.segments[1].at).toBe(cutRanges(video)[1].startSec);
  expect(readNarration(dir)?.videoSec).toBe(calcTotalFrames(video) / video.fps);
});

it('初回の保存でIDを割り当て、JSON設定を再起動なしで読み直す', () => {
  const input = cut(); delete input.id;
  expect(writeReelCuts(dir, [input])[0].id).toMatch(/^[a-f0-9-]+$/);
  const configFile = path.join(root, 'oc-eat.json'); vi.stubEnv('REEL_STUDIO_OC_EAT_CONFIG', configFile);
  const cfg = defaultReelCutsConfig(); cfg.defaults.speed = 1.25;
  fs.writeFileSync(configFile, JSON.stringify(cfg)); expect(loadReelCutsConfig().defaults.speed).toBe(1.25);
  cfg.defaults.speed = 1.4; fs.writeFileSync(configFile, JSON.stringify(cfg)); expect(loadReelCutsConfig().defaults.speed).toBe(1.4);
});

it('Fish S2用に感情・強調・カットごとの話速を公式の形式で渡す', () => {
  const cfg = defaultReelCutsConfig();
  const c = cut({intensity: 4, emotion_tag: '[happy]', speed: 1.3});
  expect(reelFishText(c, cfg)).toBe('[excited][happy]この[emphasis]お肉は最高です');
  const body = reelTtsBody({id: 'x', at: 0, text: c.line, ...c}, 'voice', 'normal', cfg);
  expect(body.prosody.speed).toBe(1.3); expect(body.text).toContain('[emphasis]お肉');
  expect(body).not.toHaveProperty('pause_after'); expect(body).not.toHaveProperty('intensity');
});

it('保存APIの検証・競合検出と既存編集APIからの共通JSON更新が動く', async () => {
  const app = express(); app.use(express.json()); app.use('/api/projects/:slug', reelCutsRouter); app.use('/api/projects/:slug/files', filesRouter);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/projects/test-reel`;
  try {
    const put = await fetch(`${base}/reel-cuts`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify([cut()])});
    expect(put.status).toBe(200); const first = await put.json();
    const get = await fetch(`${base}/files/cuts`); const edit = await get.json();
    const beforeNarration = await (await fetch(`${base}/files/narration`)).json();
    edit.data.cuts[0].inSec = 0.5;
    const saved = await fetch(`${base}/files/cuts`, {method: 'PUT', headers: {'Content-Type': 'application/json', 'If-Match': edit.etag}, body: JSON.stringify(edit.data)});
    expect(saved.status).toBe(200); expect(readReelCuts(dir)?.[0].start).toBe(0.5);
    const savedMeta = await saved.json();
    expect(savedMeta.relatedEtags.narration.before).toBe(beforeNarration.etag);
    const projectedNarration = await (await fetch(`${base}/files/narration`)).json();
    expect(savedMeta.relatedEtags.narration.after).toBe(projectedNarration.etag);
    projectedNarration.data.segments[0].emotion_tag = 'excited';
    const savedNarration = await fetch(`${base}/files/narration`, {method: 'PUT', headers: {'Content-Type': 'application/json', 'If-Match': savedMeta.relatedEtags.narration.after}, body: JSON.stringify(projectedNarration.data)});
    expect(savedNarration.status).toBe(200); expect(readReelCuts(dir)?.[0].emotion_tag).toBe('excited');
    const conflict = await fetch(`${base}/reel-cuts`, {method: 'PUT', headers: {'Content-Type': 'application/json', 'If-Match': first.etag}, body: JSON.stringify([cut()])});
    expect(conflict.status).toBe(409);
    const invalid = await fetch(`${base}/reel-cuts`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify([{...cut(), intensity: 7}])});
    expect(invalid.status).toBe(400);
  } finally {await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));}
});
