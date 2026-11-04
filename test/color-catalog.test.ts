import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {expect, it, vi} from 'vitest';
import {makeCatalog, richClips} from './helpers';
import {buildCatalog, loadCatalog, saveCatalog} from '../core/catalog';

vi.mock('../core/ffprobe', async (original) => ({
  ...await original<typeof import('../core/ffprobe')>(),
  ffprobe: vi.fn(async () => ({codec: 'h264', width: 1080, height: 1920, rotation: 0, fps: 60, durationSec: 3, hasAudio: false, pixFmt: 'yuv420p'})),
}));
vi.mock('../core/look', () => ({ensureLooks: vi.fn(async () => 0)}));

it('カタログの再実行でも保存済みの素材の補正を維持する', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-color-catalog-'));
  try {
    const project = path.join(dir, 'project');
    const materials = path.join(dir, 'materials');
    fs.mkdirSync(materials, {recursive: true});
    fs.mkdirSync(path.join(project, 'public/uploads'), {recursive: true});
    fs.writeFileSync(path.join(project, 'brief.json'), '{}');
    const clip = {...richClips()[0], color: {exposure: -1, brightness: 1.2, contrast: 0.9, saturation: 0.5}};
    fs.writeFileSync(path.join(materials, clip.original), 'video');
    saveCatalog(project, makeCatalog('test', [clip]));
    const result = await buildCatalog({projectDir: project, materialsDir: materials, slug: 'test', proxy: false, thumbs: false});
    expect(result.catalog.clips[0].color).toEqual(clip.color);
    expect(loadCatalog(project)!.clips[0].color).toEqual(clip.color);
  } finally {
    // このテストが作った絶対パスだけを片付ける。
    expect(dir.startsWith(path.join(os.tmpdir(), 'reel-color-catalog-'))).toBe(true);
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
