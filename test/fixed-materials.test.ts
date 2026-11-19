// 固定素材フォルダ（毎回の案件に入れるロゴ・外観など）を、カタログ実行のたびに案件の素材と一緒に読み込む
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {buildCatalog, collectMaterials, loadCatalog} from '../core/catalog';
import {fixedDirFor} from '../core/materials-folders';
import {FIXED_ORIGINAL_PREFIX, isFixedOriginal} from '../shared/project-from-folder';
import {studioConfig} from '../studio.config';

vi.mock('../core/ffprobe', async (original) => ({
  ...(await original<typeof import('../core/ffprobe')>()),
  ffprobe: vi.fn(async () => ({codec: 'h264', width: 1080, height: 1920, rotation: 0, fps: 60, durationSec: 3, hasAudio: false, pixFmt: 'yuv420p'})),
}));
vi.mock('../core/look', () => ({ensureLooks: vi.fn(async () => 0)}));

const PREFIX = path.join(os.tmpdir(), 'reel-fixed-materials-');
let dir = '';
let project = '';
let materials = '';
let fixed = '';

beforeEach(() => {
  dir = fs.mkdtempSync(PREFIX);
  project = path.join(dir, 'project');
  materials = path.join(dir, 'materials');
  fixed = path.join(dir, 'fixed');
  for (const d of [materials, fixed, path.join(project, 'public/uploads')]) fs.mkdirSync(d, {recursive: true});
  fs.writeFileSync(path.join(project, 'brief.json'), '{}');
  fs.writeFileSync(path.join(materials, 'a.mp4'), 'own-a');
  fs.writeFileSync(path.join(materials, 'logo.mp4'), 'own-logo');
  fs.writeFileSync(path.join(fixed, 'logo.mp4'), 'fixed-logo');
  fs.writeFileSync(path.join(fixed, 'memo.txt'), 'not a video');
});

afterEach(() => {
  // このテストが作った一時フォルダだけを片付ける
  expect(dir.startsWith(PREFIX)).toBe(true);
  fs.rmSync(dir, {recursive: true, force: true});
});

const build = (fixedDir: string | null) => buildCatalog({projectDir: project, materialsDir: materials, fixedDir, slug: 'test', proxy: false, thumbs: false});

it('案件の素材の後ろに固定素材を足し、同じファイル名でもぶつからない', () => {
  const list = collectMaterials(materials, fixed);
  expect(list.map((e) => e.key)).toEqual(['a.mp4', 'logo.mp4', `${FIXED_ORIGINAL_PREFIX}logo.mp4`]);
  expect(list[2].abs).toBe(path.join(fixed, 'logo.mp4'));
});

it('固定素材フォルダが無い・案件の素材フォルダと同じなら足さない', () => {
  expect(collectMaterials(materials, path.join(dir, 'missing'))).toHaveLength(2);
  expect(collectMaterials(materials, materials + path.sep)).toHaveLength(2);
  expect(collectMaterials(materials, null)).toHaveLength(2);
});

it('カタログ実行で固定素材もコピーされ、案件の前回の選択として記録される', async () => {
  const {catalog} = await build(fixed);
  const fixedClips = catalog.clips.filter((c) => isFixedOriginal(c.original));
  expect(catalog.clips).toHaveLength(3);
  expect(fixedClips).toHaveLength(1);
  expect(fs.readFileSync(path.join(project, 'public', fixedClips[0].src), 'utf8')).toBe('fixed-logo');
  // 同名の案件素材とは別のファイルにコピーされる
  expect(new Set(catalog.clips.map((c) => c.src)).size).toBe(3);
  expect(loadCatalog(project)!.includeFixed).toBe(true);
});

it('再実行しても固定素材のクリップの id とタグを保ち、外せばカタログから消える', async () => {
  const first = await build(fixed);
  const id = first.catalog.clips.find((c) => isFixedOriginal(c.original))!.id;
  const again = await build(fixed);
  expect(again.catalog.clips.find((c) => isFixedOriginal(c.original))!.id).toBe(id);
  const off = await build(null);
  expect(off.catalog.clips.some((c) => isFixedOriginal(c.original))).toBe(false);
  expect(off.catalog.includeFixed).toBe(false);
});

it('読み込むかどうかは 指定 → 案件の前回の選択 → 既定（読み込む）の順で決まる', () => {
  expect(fixedDirFor(undefined, undefined)).toBe(studioConfig.fixedMaterialsDir);
  expect(fixedDirFor(undefined, false)).toBeNull();
  expect(fixedDirFor(true, false)).toBe(studioConfig.fixedMaterialsDir);
  expect(fixedDirFor(false, true)).toBeNull();
});
