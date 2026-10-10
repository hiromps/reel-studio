import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {aiEdit} from '../core/ai';
import {runAgent} from '../core/agent';
import {codexOutputSchema} from '../core/codex';
import {readCuts, writeCuts} from '../core/project';
import {ZoomSchema} from '../shared/schema/zoom';
import {makeBrief, makeCatalog, makeClip} from './helpers';

vi.mock('../core/agent', () => ({runAgent: vi.fn()}));
vi.mock('../core/cut-frames', () => ({ensureCutFrame: vi.fn(async () => null)}));
vi.mock('../core/render', () => ({validateProject: vi.fn(() => ({ok: true, issues: []}))}));

let dir: string;
beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-ai-zoom-'));
  const catalog = makeCatalog('ai-zoom', [makeClip({id: '01', slug: 'food', dur: 5, kind: 'sizzle'})]);
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(dir, 'brief.json'), JSON.stringify(makeBrief({persona: 'standard', format: 'F0'})));
  writeCuts(dir, {fps: 30, meta: {orderLocked: true}, cuts: [
    {id: 'c01', src: catalog.clips[0].src, inSec: 0, outSec: 0.8, main: {text: 'そのまま'}},
    {id: 'c02', src: catalog.clips[0].src, inSec: 1, outSec: 1.8, zoom: ZoomSchema.parse({mode: 'push'}), main: {text: '寄りの画'}},
  ]});
});
afterEach(() => fs.rmSync(dir, {recursive: true, force: true}));

it('AI修正の出力契約にzoomを渡し、保存したcuts.jsonにも設定・解除を反映する', async () => {
  const before = readCuts(dir);
  vi.mocked(runAgent).mockResolvedValue({data: {summary: '必要なカットだけズーム', cuts: [
    {cutId: 'c01', inSec: 0, outSec: 0.8, playbackRate: 1, badge: '', remove: false, zoom: {mode: 'push', scale_start: 1, scale_end: 1.1, ease: 'in_out', anchor_x: 0.5, anchor_y: 0.42}},
    {cutId: 'c02', zoom: {mode: 'none'}},
  ]}, costUsd: 0, durationMs: 1, turns: 1});
  const log: string[] = [];
  const result = await aiEdit(dir, '必要な場所だけズーム。不要な箇所はなくていい', {onLine: s => log.push(s)});
  const call = vi.mocked(runAgent).mock.calls[0][0];
  const zoomSchema = (call.schema as any).properties.cuts.items.properties.zoom;
  expect(zoomSchema.anyOf[0].properties.mode.enum).toEqual(['none', 'push', 'pull']);
  expect(zoomSchema.anyOf[0].properties.scale_end).toMatchObject({minimum: 1, maximum: 1.5});
  expect(zoomSchema.anyOf[1]).toEqual({type: 'null'});
  const strict = codexOutputSchema(call.schema) as any;
  expect(strict.properties.cuts.items.required).toContain('zoom');
  expect(strict.properties.cuts.items.properties.zoom.anyOf[1]).toEqual({type: 'null'});
  expect(call.prompt).toContain('/ zoom {"mode":"push"');
  expect(call.prompt).toContain('必要なカットだけ設定');
  expect(call.prompt).toContain('区間・順番・倍速・テロップ・ナレーションを変えない');
  const after = readCuts(dir);
  expect(after.cuts[0].zoom).toEqual(ZoomSchema.parse({mode: 'push', scale_start: 1, scale_end: 1.1, ease: 'in_out', anchor_x: 0.5, anchor_y: 0.42}));
  expect(after.cuts[1].zoom?.mode).toBe('none');
  expect(after.cuts.map(({zoom, ...c}) => c)).toEqual(before.cuts.map(({zoom, ...c}) => c));
  expect(after.meta?.orderLocked).toBe(true);
  expect(result.applied).toHaveLength(2); expect(result.unapplied).toEqual([]);
  expect(log.some(s => s.includes('ズームイン 1.00→1.10倍'))).toBe(true);
  expect(log.some(s => s.includes('0.00〜0.80 → 0.00〜0.80'))).toBe(false);
});

it('無変更のAI差分ではcuts.jsonを書き直さず、成功件数も0件にする', async () => {
  const before = fs.readFileSync(path.join(dir, 'cuts.json'), 'utf8');
  vi.mocked(runAgent).mockResolvedValue({data: {summary: '変更不要', cuts: [{cutId: 'c01', inSec: 0, outSec: 0.8, playbackRate: 1, badge: '', remove: false, zoom: null}]}, costUsd: 0, durationMs: 1, turns: 1});
  const result = await aiEdit(dir, 'ズームを最適化');
  expect(result.applied).toEqual([]); expect(fs.readFileSync(path.join(dir, 'cuts.json'), 'utf8')).toBe(before);
});
