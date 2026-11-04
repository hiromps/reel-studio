import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {migrateMedia} from '../scripts/migrate-media';
import {resetSettings} from '../core/settings';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-media-migrate-'));
  vi.stubEnv('REEL_STUDIO_DATA_ROOT', root);
  resetSettings();
});
afterEach(() => { vi.unstubAllEnvs(); resetSettings(); fs.rmSync(root, {recursive: true, force: true}); });

const storage = () => vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith('/bucket')) return Response.json([{id: 'media'}]);
  if (url.pathname.includes('/object/list/')) {
    const {prefix} = JSON.parse(String(init?.body));
    return Response.json(prefix === '' ? [{name: 'nested', id: null, metadata: null}] : [{name: '日本語.wav', id: 'id', updated_at: 'v1', metadata: {size: 4}}]);
  }
  return new Response('wave');
});
const options = () => ({source: 'supabase' as const, apply: false, updateDb: false, root: path.join(root, 'media'), supabaseUrl: 'https://test.supabase.co', key: 'test-service-key', log: vi.fn()});

it('dry-run は階層を走査するだけでファイルをダウンロード・作成しない', async () => {
  const request = storage();
  const result = await migrateMedia({...options(), fetch: request as typeof fetch});
  expect(result).toMatchObject({planned: 1, downloaded: 0});
  expect(fs.readdirSync(root)).toEqual([]);
  expect(request.mock.calls.every(([url]) => !String(url).includes('/object/authenticated/'))).toBe(true);
});

it('非公開オブジェクトを逐次保存し、再実行時はSHA-256検証してダウンロードを省く。削除しない', async () => {
  const request = storage();
  const opt = {...options(), apply: true, fetch: request as typeof fetch};
  expect(await migrateMedia(opt)).toMatchObject({downloaded: 1, reused: 0});
  expect(await migrateMedia(opt)).toMatchObject({downloaded: 0, reused: 1});
  const downloads = request.mock.calls.filter(([url]) => String(url).includes('/object/authenticated/'));
  expect(downloads).toHaveLength(1);
  expect((downloads[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer test-service-key');
  expect(request.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  const manifest = JSON.parse(fs.readFileSync(path.join(opt.root, 'migration-manifest.json'), 'utf8'));
  const record = Object.values(manifest.entries)[0] as {file: string; sha256: string};
  expect(fs.readFileSync(record.file, 'utf8')).toBe('wave');
  expect(record.sha256).toHaveLength(64);
  fs.writeFileSync(record.file, 'bad!');
  await expect(migrateMedia(opt)).rejects.toThrow('検証');
  expect(request.mock.calls.filter(([url]) => String(url).includes('/object/authenticated/'))).toHaveLength(1);
});

it('途中失敗時にはpartファイルを消し、DB更新を行わない', async () => {
  const request = storage();
  const broken = async (url: string | URL | Request, init?: RequestInit) => String(url).includes('/object/authenticated/') ? new Response('x') : request(url, init);
  const opt = {...options(), apply: true, fetch: broken as typeof fetch};
  await expect(migrateMedia(opt)).rejects.toThrow('バイト数');
  expect(fs.existsSync(path.join(opt.root, '.migration.lock'))).toBe(false);
  expect(fs.existsSync(path.join(opt.root, 'migration-manifest.json'))).toBe(false);
  const walk = (dir: string): string[] => fs.readdirSync(dir, {withFileTypes: true}).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [e.name]);
  expect(walk(opt.root)).toEqual([]);
});

it('100件を超える一覧もページングする', async () => {
  const offsets: number[] = [];
  const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const {offset} = JSON.parse(String(init?.body)); offsets.push(offset);
    return Response.json(Array.from({length: offset === 0 ? 100 : 1}, (_, i) => ({name: `${offset + i}.mp4`, id: `${offset + i}`, metadata: {size: 4}})));
  });
  expect((await migrateMedia({...options(), bucket: 'media', fetch: request as typeof fetch})).planned).toBe(101);
  expect(offsets).toEqual([0, 100]);
});

it('既存案件の足りない音声を復元し、PCで生成した版を上書きしない', async () => {
  const project = path.join(root, 'work', 'shop-reel');
  fs.mkdirSync(project, {recursive: true});
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes('/object/list/')) {
      const {prefix} = JSON.parse(String(init?.body));
      const parts = ['p', 'shop-reel', 'full', 'narration'];
      const depth = prefix ? prefix.split('/').length : 0;
      return Response.json(depth < parts.length ? [{name: parts[depth], id: null, metadata: null}] : [{name: 'a.wav', id: 'id', updated_at: 'v1', metadata: {size: 4}}]);
    }
    return new Response('wave');
  });
  const opt = {...options(), bucket: 'media', apply: true, fetch: request as typeof fetch};
  await migrateMedia(opt);
  const restored = path.join(project, 'narration', 'a.wav');
  expect(fs.readFileSync(restored, 'utf8')).toBe('wave');
  // 生成処理のように同じパスへ書き直しても、移行元の検証ファイルは壊れない。
  fs.writeFileSync(restored, 'new local generation');
  expect((await migrateMedia(opt)).reused).toBe(1);
  expect(fs.readFileSync(restored, 'utf8')).toBe('new local generation');
});
