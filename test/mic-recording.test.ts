import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {Server} from 'node:http';
import {createRequire} from 'node:module';
import {encodeWav, readWavInfo} from '../shared/wav';
import {needsTtsIds} from '../core/tts';
import {narrationRecordingRouter} from '../server/routes/narration-recording';
import type {Narration} from '../shared/schema';

const {permissionAllowed} = createRequire(import.meta.url)('../desktop/runtime.cjs');

const tone = (sec: number, rate = 48000) => Float32Array.from({length: Math.round(sec * rate)}, (_, i) => Math.sin(i / 10) * 0.5);

describe('WAV の書き出しと検査', () => {
  it('ステレオを平均してモノラル 16bit にし、尺をヘッダから読める', () => {
    const wav = new Uint8Array(encodeWav([tone(1.5), tone(1.5)], 48000));
    expect(readWavInfo(wav)).toEqual({sampleRate: 48000, channels: 1, bitsPerSample: 16, durSec: 1.5});
  });

  it('WAV でないものは null', () => {
    expect(readWavInfo(new TextEncoder().encode('OggS'.padEnd(64, 'x')))).toBeNull();
    expect(readWavInfo(new Uint8Array(10))).toBeNull();
  });
});

describe('マイク録音のブロックは TTS で作り直さない', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-mic-'));
    fs.mkdirSync(path.join(dir, 'narration'));
    fs.writeFileSync(path.join(dir, 'narration', 'mic_a.wav'), Buffer.from(encodeWav([tone(0.5)], 48000)));
  });
  afterEach(() => fs.rmSync(dir, {recursive: true, force: true}));

  it('needsTts が立っていても録音は対象外で、TTS ブロックだけが残る', () => {
    const narration: Narration = {voice: 'v', segments: [
      {id: 'mic_a', at: 0, text: 'メモ', durSec: 0.5, recorded: true, needsTts: true} as Narration['segments'][number],
      {id: 'n001', at: 1, text: '生成する文'},
    ]};
    expect(needsTtsIds(dir, narration)).toEqual(['n001']);
  });
});

describe('録音の保存 API', () => {
  let root: string;
  let server: Server;
  let base: string;
  const oldWorkDir = process.env.REEL_STUDIO_WORK_DIR;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-mic-api-'));
    process.env.REEL_STUDIO_WORK_DIR = root;
    fs.mkdirSync(path.join(root, 'demo-reel'), {recursive: true});
    const app = express();
    app.use(express.json());
    app.use('/api/projects/:slug', narrationRecordingRouter);
    server = await new Promise<Server>((resolve) => resolve(app.listen(0)));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('テストサーバーのポートがありません');
    base = `http://127.0.0.1:${address.port}/api/projects/demo-reel/narration-recording`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (oldWorkDir === undefined) delete process.env.REEL_STUDIO_WORK_DIR;
    else process.env.REEL_STUDIO_WORK_DIR = oldWorkDir;
    fs.rmSync(root, {recursive: true, force: true});
  });
  const post = (id: string, body: BodyInit) => fetch(`${base}/${id}`, {method: 'POST', headers: {'Content-Type': 'audio/wav'}, body});

  it('WAV を narration/<id>.wav に置き、実測の尺を返す。同じ ID は上書きしない', async () => {
    const wav = encodeWav([tone(1.2)], 48000);
    const ok = await post('mic_abc', wav);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({durSec: 1.2});
    expect(fs.existsSync(path.join(root, 'demo-reel', 'narration', 'mic_abc.wav'))).toBe(true);
    expect((await post('mic_abc', wav)).status).toBe(409);
  });

  it('WAV 以外・mic_ 以外の ID・短すぎる録音は断る', async () => {
    expect((await post('mic_x', 'not a wav')).status).toBe(400);
    expect((await post('n001', encodeWav([tone(1)], 48000))).status).toBe(400);
    expect((await post('mic_short', encodeWav([tone(0.05)], 48000))).status).toBe(400);
  });
});

describe('デスクトップ版のマイク権限', () => {
  const origin = 'http://127.0.0.1:4321';
  it('同じ画面からのマイクだけ許し、カメラや外部サイトは断る', () => {
    expect(permissionAllowed('media', `${origin}/`, origin, ['audio'])).toBe(true);
    expect(permissionAllowed('media', `${origin}/`, origin, ['audio', 'video'])).toBe(false);
    expect(permissionAllowed('media', `${origin}/`, origin, [])).toBe(false);
    expect(permissionAllowed('media', 'https://example.com/', origin, ['audio'])).toBe(false);
    expect(permissionAllowed('media', origin, origin, 'audio')).toBe(true);
    expect(permissionAllowed('media', origin, origin, 'video')).toBe(false);
  });
});
