import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {runModalImport} from '../worker/cloud-jobs';
import type {CloudClient} from '../worker/client';
import {loadCatalog, saveCatalog} from '../core/catalog';
import {resetSettings} from '../core/settings';
import {makeCatalog, richClips} from './helpers';

vi.mock('../core/ffprobe', async original => ({...await original<typeof import('../core/ffprobe')>(), ffprobe: vi.fn(async () => ({codec: 'h264', width: 512, height: 512, rotation: 0, fps: 30, durationSec: 3, hasAudio: false, pixFmt: 'yuv420p'}))}));
vi.mock('../core/look', () => ({ensureLooks: vi.fn(async () => 0)}));
vi.mock('../core/thumbnails', () => ({makeThumbnails: vi.fn(async () => ({sheet: '', strip: []}))}));
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-modal-worker-'));
  vi.stubEnv('REEL_STUDIO_HOME', path.join(root, 'settings'));
  vi.stubEnv('REEL_STUDIO_WORK_DIR', path.join(root, 'work'));
  vi.stubEnv('REEL_STUDIO_UPLOADS_ROOT', path.join(root, 'uploads'));
  resetSettings();
});
afterEach(() => {vi.unstubAllEnvs(); resetSettings(); expect(path.dirname(root)).toBe(os.tmpdir()); fs.rmSync(root, {recursive: true, force: true});});

it('Modalの鍵がないPCでも既存ワーカー認証で生成MP4を取得し、既存素材を保持して取り込める', async () => {
  const project = path.join(root, 'work', 'shop-reel');
  fs.mkdirSync(project, {recursive: true}); fs.writeFileSync(path.join(project, 'brief.json'), '{}');
  const original = richClips()[0]; saveCatalog(project, makeCatalog('shop-reel', [original]));
  const id = crypto.randomUUID(), bytes = Buffer.from('streamed MP4 from authenticated cloud');
  const client = {modalJob: vi.fn(async () => ({id, status: 'completed', kind: 'text-to-video', resultType: 'video/mp4'})), modalResult: vi.fn(async () => new Response(bytes, {headers: {'Content-Type': 'video/mp4'}}))};
  const ctx = {signal: new AbortController().signal, onLine: vi.fn(), onProgress: vi.fn()};
  await runModalImport(client as unknown as CloudClient, 'shop-reel', {id}, ctx);
  const catalog = loadCatalog(project)!;
  expect(catalog.clips).toHaveLength(2);
  expect(catalog.clips.find(c => c.id === original.id)?.tags).toEqual(original.tags);
  expect(catalog.clips.find(c => c.generated)?.generated?.jobId).toBe(id);
  expect(fs.readFileSync(path.join(root, 'settings/modal-results', `${id}.mp4`))).toEqual(bytes);
  expect(client.modalResult).toHaveBeenCalledWith(id, ctx.signal);
  expect(fs.existsSync(path.join(root, 'settings/modal-cloud.json'))).toBe(false);
});
