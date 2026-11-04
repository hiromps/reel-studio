import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {resetSettings} from '../core/settings';
import {saveLocalUpload} from '../core/local-upload';
import {requireLocalMedia, migratedMedia} from '../core/local-media';
import {assertMetadataOnly} from '../shared/media';
import {pullNarrationAudio, syncAssets} from '../worker/sync';
import type {CloudClient} from '../worker/client';
import express from 'express';
import type {AddressInfo} from 'node:net';
import {uploadsRouter} from '../server/routes/uploads';
import {filesRouter} from '../server/routes/files';
import {mediaRouter} from '../server/routes/media';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-local-media-'));
  vi.stubEnv('REEL_STUDIO_DATA_ROOT', root);
  vi.stubEnv('REEL_STUDIO_HOME', path.join(root, 'settings'));
  vi.stubEnv('REEL_STUDIO_MEDIA_ROOT', path.join(root, 'media'));
  resetSettings();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetSettings(); fs.rmSync(root, {recursive: true, force: true}); });

describe('ローカルメディア', () => {
  it('HTTP で素材取り込み→編集保存→ローカル動画のRange再生・ダウンロードができる', async () => {
    const dir = path.join(root, 'work', 'shop-reel');
    fs.mkdirSync(path.join(dir, 'out'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'out', 'final.mp4'), '0123456789');
    const app = express();
    app.use(express.json());
    app.use('/api/uploads', uploadsRouter);
    app.use('/api/projects/:slug/files', filesRouter);
    app.use(mediaRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.on('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const uploaded = await fetch(`${base}/api/uploads/local?slug=shop-reel&filename=clip.mp4`, {method: 'POST', headers: {'Content-Type': 'video/mp4'}, body: 'video'});
      expect(uploaded.status).toBe(200);
      const saved = await uploaded.json();
      expect(fs.readFileSync(saved.file, 'utf8')).toBe('video');
      const edited = await fetch(`${base}/api/projects/shop-reel/files/cuts`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({fps: 30, cuts: [{src: 'uploads/clip.mp4', inSec: 0, outSec: 1}]})});
      expect(edited.status).toBe(200);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'cuts.json'), 'utf8')).cuts).toHaveLength(1);
      const partial = await fetch(`${base}/p/shop-reel/full/out/final.mp4`, {headers: {Range: 'bytes=2-5'}});
      expect(partial.status).toBe(206);
      expect(await partial.text()).toBe('2345');
      expect(partial.headers.get('ETag')).toBeTruthy();
      const download = await fetch(`${base}/p/shop-reel/full/out/final.mp4?download=1`);
      expect(download.headers.get('Content-Disposition')).toContain('attachment');
      expect(download.headers.get('Location')).toBeNull();
      await download.arrayBuffer();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    }
  });

  it('同一素材を再利用し、内容の違う同名素材や未完了ファイルを公開しない', async () => {
    const first = await saveLocalUpload(Readable.from(['video']), 'shop', 'clip.mp4');
    expect(first.reused).toBe(false);
    expect((await saveLocalUpload(Readable.from(['video']), 'shop', 'clip.mp4')).reused).toBe(true);
    await expect(saveLocalUpload(Readable.from(['other']), 'shop', 'clip.mp4')).rejects.toThrow('同名');
    await expect(saveLocalUpload(Readable.from(['too large']), 'shop', 'big.mp4', 2)).rejects.toThrow('上限');
    expect(fs.readFileSync(first.file, 'utf8')).toBe('video');
    expect(fs.readdirSync(path.dirname(first.file))).toEqual(['clip.mp4']);
  });

  it('パストラバーサル・外部URL・保存先外への読み書きを拒否する', async () => {
    await expect(saveLocalUpload(Readable.from(['x']), '..', 'clip.mp4')).rejects.toThrow();
    await expect(saveLocalUpload(Readable.from(['x']), 'shop', '../clip.mp4')).rejects.toThrow();
    expect(() => requireLocalMedia('https://example.supabase.co/storage/v1/object/public/a/b')).toThrow('移行');
    expect(() => requireLocalMedia(path.join(os.tmpdir(), 'unrelated.mp4'))).toThrow();
  });

  it('DBへ送るのは参照だけ。再同期時は索引もバイナリも再取得しない', async () => {
    const dir = path.join(root, 'work', 'shop-reel');
    for (const [file, text] of [['public/uploads/a.mp4', 'video'], ['narration/a.wav', 'audio'], ['out/final.mp4', 'export']]) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true});
      fs.writeFileSync(path.join(dir, file), text);
    }
    const network = vi.fn(() => { throw new Error('Storageへ接続しました'); });
    vi.stubGlobal('fetch', network);
    const registerAssets = vi.fn(async (_slug, items) => ({ok: true, saved: items.length, bad: []}));
    const listAssets = vi.fn(() => { throw new Error('不要な索引再取得'); });
    const client = {registerAssets, listAssets} as unknown as CloudClient;
    expect((await syncAssets(client, dir)).uploaded).toBe(3);
    const registered = registerAssets.mock.calls[0][1];
    expect(registered.every((a: {url: string}) => path.isAbsolute(a.url))).toBe(true);
    expect(JSON.stringify(registered)).not.toContain('base64');
    expect((await syncAssets(client, dir)).uploaded).toBe(0);
    expect(registerAssets).toHaveBeenCalledTimes(1);
    fs.writeFileSync(path.join(dir, 'narration', 'a.wav'), 'changed audio');
    expect((await syncAssets(client, dir)).uploaded).toBe(1);
    expect(listAssets).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it('生成音声はローカル参照から復元し、存在するものは再取得しない', async () => {
    const dir = path.join(root, 'work', 'shop-reel');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'narration.json'), JSON.stringify({segments: [{id: 'a', durSec: 1}]}));
    const file = path.join(root, 'saved.wav');
    fs.writeFileSync(file, 'wave');
    const listAssets = vi.fn(async () => ({assets: [{kind: 'narration', mode: 'full', relPath: 'a.wav', url: file}]}));
    const client = {listAssets} as unknown as CloudClient;
    const network = vi.fn(); vi.stubGlobal('fetch', network);
    expect(await pullNarrationAudio(client, dir)).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'narration', 'a.wav'), 'utf8')).toBe('wave');
    expect(await pullNarrationAudio(client, dir)).toBe(0);
    expect(listAssets).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
  });

  it('バイナリ保存を拒否し、台本・ローカルパス・小さい指紋を許可する', () => {
    expect(() => assertMetadataOnly({audio: 'data:audio/wav;base64,AA=='})).toThrow();
    expect(() => assertMetadataOnly({audio: Buffer.from('audio')})).toThrow();
    expect(() => assertMetadataOnly({binary: 'A'.repeat(70_000)})).toThrow();
    expect(() => assertMetadataOnly({text: '台本', file: path.join(root, 'clip.mp4'), look: 'A'.repeat(448)})).not.toThrow();
  });

  it('移行済みメディアをローカル索引から参照する', () => {
    fs.mkdirSync(path.join(root, 'media'));
    const file = path.join(root, 'media', 'clip.mp4'); fs.writeFileSync(file, 'video');
    fs.writeFileSync(path.join(root, 'media', 'asset-index.json'), JSON.stringify({'shop-reel/light/uploads/clip.mp4': file}));
    expect(migratedMedia('shop-reel', 'full', 'uploads', 'clip.mp4')).toBe(file);
  });
});
