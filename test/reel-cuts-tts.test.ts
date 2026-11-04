import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {beforeEach, afterEach, expect, it, vi} from 'vitest';
vi.mock('../core/exec', () => ({execOk: async () => ({stdout: '1.2'}), exec: vi.fn()}));
import {generateTts, needsTtsIds, resetFishEnv} from '../core/tts';
import {createReelCut, defaultReelCutsConfig} from '../shared/reel-cuts';
import {writeReelCuts, readReelCuts} from '../core/reel-cuts';
import {readCuts, readNarration, writeCuts, writeNarration} from '../core/project';
import {resetSettings} from '../core/settings';
import {mixPreconditions} from '../core/mix';

let root: string;
let dir: string;
let bodies: Record<string, any>[];
const fakeWav = () => {const wav = new Uint8Array(64); wav.set([82, 73, 70, 70]); wav.set([87, 65, 86, 69], 8); return wav;};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-cuts-tts-')); dir = path.join(root, 'work', 'shop-reel');
  vi.stubEnv('REEL_STUDIO_DATA_ROOT', root); vi.stubEnv('FISH_API_KEY', 'test-key'); vi.stubEnv('FISH_MODEL_ID', 's2.1-pro-free');
  resetSettings(); resetFishEnv(); bodies = [];
  fs.mkdirSync(path.join(dir, 'public', 'uploads'), {recursive: true}); fs.writeFileSync(path.join(dir, 'public', 'uploads', 'dish.mp4'), 'video');
  writeReelCuts(dir, [
    createReelCut('uploads/dish.mp4', defaultReelCutsConfig(), {id: 'first', line: 'お肉の旨みがすごいです', intensity: 4, emotion_tag: '[happy]', speed: 1.3, emphasis: ['お肉']}),
    createReelCut('uploads/dish.mp4', defaultReelCutsConfig(), {id: 'second', start: 2, line: 'お店の雰囲気も素敵です', speed: 0.9}),
  ]);
  const narration = readNarration(dir)!; narration.voice = 'test-reel-voice'; writeNarration(dir, narration);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (!url.startsWith('https://api.fish.audio/')) throw new Error(`Storage access forbidden: ${url}`);
    if (init.method === 'POST') {bodies.push(JSON.parse(init.body as string)); return new Response(fakeWav());}
    return new Response('{}');
  }));
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetFishEnv(); resetSettings();
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('reel-cuts-tts-')) throw new Error('Unexpected test root');
  fs.rmSync(root, {recursive: true, force: true});
});

it('同じ入力は再生成せず、並べ替えでもローカルWAVを再利用する', async () => {
  expect((await generateTts(dir)).made).toEqual(['oc_first', 'oc_second']);
  expect(bodies[0].prosody.speed).toBe(1.3); expect(bodies[1].prosody.speed).toBe(0.9);
  expect(bodies[0].text).toBe('[excited][happy][emphasis]お肉の旨みがすごいです');
  expect(readNarration(dir)?.segments[0]).toMatchObject({durSec: 1.2, trimSec: 1.85, needsTts: false});
  expect(needsTtsIds(dir, readNarration(dir)!)).toEqual([]);
  expect((await generateTts(dir)).made).toEqual([]);
  const editor = readCuts(dir); editor.cuts.reverse(); writeCuts(dir, editor);
  expect((await generateTts(dir)).made).toEqual([]); expect(bodies).toHaveLength(2);
  expect(readNarration(dir)?.segments[1].at).toBe(2);
});

it('台詞・声・JSON設定の変更を検出し、必要な音声だけ作り直す', async () => {
  await generateTts(dir);
  const cuts = readReelCuts(dir)!; cuts[0].line = 'お肉がとてもジューシーです'; writeReelCuts(dir, cuts);
  expect((await generateTts(dir)).made).toEqual(['oc_first']);
  const narration = readNarration(dir)!; narration.voice = 'test-reel-other-voice'; writeNarration(dir, narration);
  expect(needsTtsIds(dir, readNarration(dir)!)).toEqual(['oc_first', 'oc_second']);
  expect((await generateTts(dir)).made).toEqual(['oc_first', 'oc_second']);
  const cfg = defaultReelCutsConfig(); cfg.fish.intensity_tags['4'] = '[confident]';
  const configFile = path.join(root, 'oc-eat.json'); fs.writeFileSync(configFile, JSON.stringify(cfg)); vi.stubEnv('REEL_STUDIO_OC_EAT_CONFIG', configFile);
  expect((await generateTts(dir)).made).toEqual(['oc_first']);
  expect(bodies.at(-1)?.text).toContain('[confident]');
});

it('生成待ち音声での書き出し合成を止め、生成後に通す', async () => {
  fs.mkdirSync(path.join(dir, 'out')); fs.writeFileSync(path.join(dir, 'out', 'final.mp4'), 'video');
  expect(mixPreconditions(dir)).toContain('音声を生成');
  await generateTts(dir); expect(mixPreconditions(dir)).toBeNull();
  const cuts = readReelCuts(dir)!; cuts[0].emotion_tag = '[surprised]'; writeReelCuts(dir, cuts);
  expect(mixPreconditions(dir)).toContain('変更されています');
});

it('生成中の文言変更に古い音声の実測値を付けない', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => {
    if (init.method === 'POST') {
      const cuts = readReelCuts(dir)!; cuts[0].line = 'お肉は新しい台詞です'; writeReelCuts(dir, cuts);
      return new Response(fakeWav());
    }
    return new Response('{}');
  }));
  await generateTts(dir, {ids: ['oc_first']});
  expect(readNarration(dir)?.segments[0]).toMatchObject({text: 'お肉は新しい台詞です', needsTts: true});
  expect(readNarration(dir)?.segments[0].durSec).toBeUndefined();
});
