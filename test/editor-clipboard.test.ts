import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {Server} from 'node:http';
import {clipboardRouter} from '../server/routes/clipboard';

let root: string;
let server: Server;
let url: string;
const oldWorkDir = process.env.REEL_STUDIO_WORK_DIR;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-clipboard-'));
  process.env.REEL_STUDIO_WORK_DIR = root;
  fs.mkdirSync(path.join(root, 'source-reel', 'narration'), {recursive: true});
  fs.mkdirSync(path.join(root, 'target-reel'), {recursive: true});
  const app = express();
  app.use(express.json());
  app.use('/api/projects/:slug', clipboardRouter);
  server = await new Promise<Server>((resolve) => resolve(app.listen(0)));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('テストサーバーのポートがありません');
  url = `http://127.0.0.1:${address.port}/api/projects/target-reel/clipboard/copy-narration-audio`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (oldWorkDir === undefined) delete process.env.REEL_STUDIO_WORK_DIR;
  else process.env.REEL_STUDIO_WORK_DIR = oldWorkDir;
  fs.rmSync(root, {recursive: true, force: true});
});

describe('ナレーション音声の案件間コピー', () => {
  it('存在する WAV を新しい ID に複製し、無い WAV は要再生成として返す', async () => {
    fs.writeFileSync(path.join(root, 'source-reel', 'narration', 'voice01.wav'), 'wave');
    const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({from: 'source-reel', pairs: [{from: 'voice01', to: 'copy_01'}, {from: 'missing', to: 'copy_02'}]})});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({copied: [true, false]});
    expect(fs.readFileSync(path.join(root, 'target-reel', 'narration', 'copy_01.wav'), 'utf8')).toBe('wave');
    expect(fs.existsSync(path.join(root, 'target-reel', 'narration', 'copy_02.wav'))).toBe(false);
  });

  it('音声 ID のパストラバーサルを拒否する', async () => {
    const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({from: 'source-reel', pairs: [{from: '../outside', to: 'copy_01'}]})});
    expect(response.status).toBe(400);
  });
});
