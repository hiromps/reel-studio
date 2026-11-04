import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {expect, it, vi} from 'vitest';
import {makeCatalog, richClips} from './helpers';
import {buildCatalog, saveCatalog} from '../core/catalog';

vi.mock('../core/ffprobe', async original => ({...await original<typeof import('../core/ffprobe')>(), ffprobe: vi.fn(async () => ({codec: 'h264', width: 512, height: 512, rotation: 0, fps: 30, durationSec: 3, hasAudio: false, pixFmt: 'yuv420p'}))}));
vi.mock('../core/look', () => ({ensureLooks: vi.fn(async () => 0)}));

it('生成素材の追加・再追加・元フォルダの再スキャンで既存の素材とタグを保持する', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-modal-catalog-'));
  try {
    const project = path.join(root, 'project'), materials = path.join(root, 'materials'), generated = path.join(root, 'generated');
    fs.mkdirSync(materials, {recursive: true}); fs.mkdirSync(generated, {recursive: true});
    fs.mkdirSync(path.join(project, 'public/uploads'), {recursive: true});
    fs.writeFileSync(path.join(project, 'brief.json'), '{}');
    const original = {...richClips()[0], color: {exposure: 1, contrast: 1, saturation: 1, brightness: 1}};
    const c = makeCatalog('test', [original]); c.materialsDir = materials;
    saveCatalog(project, c);
    fs.writeFileSync(path.join(materials, original.original), 'original video');
    fs.writeFileSync(path.join(generated, 'ai-result.mp4'), 'generated video');
    const options = {projectDir: project, slug: 'test', proxy: false, thumbs: false};
    const marker = {provider: 'modal' as const, jobId: crypto.randomUUID()};
    const first = await buildCatalog({...options, materialsDir: generated, append: true, generated: marker});
    expect(first.catalog.clips).toHaveLength(2);
    expect(first.catalog.clips[0]).toMatchObject(JSON.parse(JSON.stringify(original)));
    expect(first.catalog.materialsDir).toBe(materials);
    const ai = first.catalog.clips.find(v => v.generated)!;
    expect(ai.generated).toEqual(marker);
    const again = await buildCatalog({...options, materialsDir: generated, append: true, generated: marker});
    expect(again.catalog.clips).toHaveLength(2);
    expect(again.catalog.clips.find(v => v.generated)?.id).toBe(ai.id);
    const scanned = await buildCatalog({...options, materialsDir: materials});
    expect(scanned.catalog.clips).toHaveLength(2);
    expect(scanned.catalog.clips.find(v => v.id === original.id)?.tags).toEqual(original.tags);
    expect(scanned.catalog.clips.find(v => v.generated)?.id).toBe(ai.id);
  } finally {
    expect(path.dirname(root)).toBe(os.tmpdir());
    fs.rmSync(root, {recursive: true, force: true});
  }
});
