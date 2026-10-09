import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {Narration} from '../shared/schema';

const state = vi.hoisted(() => ({narration: null as Narration | null}));
vi.mock('../core/project', () => ({readBrief: () => null, readNarration: () => state.narration, writeNarration: (_dir: string, n: Narration) => {state.narration = n;}}));
vi.mock('../core/settings', () => ({loadSettings: () => ({tts: {}})}));
vi.mock('../core/exec', () => ({execOk: async () => ({stdout: '1.2'})}));
import {generateTts, resetFishEnv} from '../core/tts';

let dir: string;
let postBodies: any[];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-studio-telop-tts-'));
  postBodies = []; resetFishEnv(); vi.stubEnv('FISH_API_KEY', 'test-key');
  state.narration = {voice: 'test-voice', speed: 1.2, segments: [{id: 'telop_test', at: 0, text: '牛タン、\n最高！', fromTelop: true, needsTts: true}]};
  vi.stubGlobal('fetch', vi.fn(async (_url: string, opt: RequestInit = {}) => {
    if (opt.method === 'POST') {postBodies.push(JSON.parse(opt.body as string)); const wav = new Uint8Array(64); wav.set([82, 73, 70, 70]); wav.set([87, 65, 86, 69], 8); return new Response(wav);}
    return new Response('{}', {status: 200});
  }));
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetFishEnv();
  if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('reel-studio-telop-tts-')) throw new Error('unexpected test directory');
  fs.rmSync(dir, {recursive: true, force: true});
});

it('Fish Audioへテロップの改行・句読点を含む文言をそのまま送り、再生成の印を消す', async () => {
  const result = await generateTts(dir);
  expect(postBodies).toHaveLength(1); expect(postBodies[0].text).toBe('牛タン、\n最高！');
  expect(result.made).toEqual(['telop_test']);
  expect(state.narration!.segments[0]).toMatchObject({text: '牛タン、\n最高！', durSec: 1.2});
  expect(state.narration!.segments[0].needsTts).toBeUndefined();
  expect(fs.existsSync(path.join(dir, 'narration', 'telop_test.wav'))).toBe(true);
});

it('通常のナレーションの改行チェックは維持する', async () => {
  delete state.narration!.segments[0].fromTelop;
  await expect(generateTts(dir)).rejects.toThrow('本文に改行'); expect(postBodies).toHaveLength(0);
});
