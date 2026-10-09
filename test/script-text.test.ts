import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {makeBrief, makeCatalog, makeClip} from './helpers';
import {readCuts, readNarration, writeCuts, writeNarration} from '../core/project';
import {assembleScriptOrConfirm, lockedScriptTextConfirmation} from '../core/script';
import {aiScriptText} from '../core/script-text';
import {aiScriptDraft} from '../core/script-draft';
import {aiMimic, writeReference} from '../core/reference';
import {ReferenceSchema} from '../shared/reference';
vi.mock('../core/look', () => ({ensureLooks: vi.fn(async () => 0)}));
vi.mock('../core/agent', () => ({runAgent: vi.fn()}));
import {runAgent} from '../core/agent';
let dir: string;
const catalog = makeCatalog('text', [makeClip({id: '01', slug: 'food', dur: 8, kind: 'sizzle'}), makeClip({id: '02', slug: 'shop', dur: 8, kind: 'interior'})]);
const plan = () => ({telops: [{cutId: 'k0001', text: '炭火で焼く', orientation: 'horizontal'}, {cutId: 'k0002', text: '香ばしい'}], narration: [{at: 0, text: 'すみびでやく'}, {at: 3, text: 'いいかおり'}], notes: '今の映像に合わせた'});
const opt = () => ({confirmed: true, fingerprint: lockedScriptTextConfirmation(dir)!.fingerprint});
const raw = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-script-text-'));
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(dir, 'brief.json'), JSON.stringify(makeBrief({persona: 'standard', format: 'F0'})));
  fs.writeFileSync(path.join(dir, 'script.md'), '保存済みのフックと台本');
  writeCuts(dir, {fps: 30, font: 'Gothic.otf', meta: {orderLocked: true}, cuts: [
    {id: 'c02', src: catalog.clips[1].src, inSec: 1, outSec: 7, playbackRate: 2, crop: {zoom: 1.5, x: 0.2, y: 0.6}, badge: '地名', main: {text: '旧文言', highlightColor: 'red'}},
    {id: 'c01', src: catalog.clips[0].src, inSec: 0, outSec: 4},
    {id: 'c03', src: catalog.clips[1].src, inSec: 0, outSec: 1, subs: [{startSec: 0, endSec: 1, text: '会話字幕'}]},
  ]});
  writeNarration(dir, {voice: 'custom-voice', speed: 1.2, narrationGainDb: 7, ambientGain: 0.1, sfx: [{id: 's1', at: 2, file: 'ding.mp3'}], segments: [{id: 'old', at: 0, text: '旧原稿', durSec: 3}]});
  vi.mocked(runAgent).mockResolvedValue({data: plan(), costUsd: 0.1} as any);
});
afterEach(() => fs.rmSync(dir, {recursive: true, force: true}));
it('ロック中の組み立ては確認待ちになり、AIを呼ばず台本と構成を保つ', async () => {
  const before = raw('cuts.json');
  const result = await assembleScriptOrConfirm(dir, {write: true});
  expect(result.textConfirmation).toMatchObject({cuts: 3, totalSec: 8, narration: 1});
  expect(result.assembled).toBeUndefined();
  expect(runAgent).not.toHaveBeenCalled();
  expect(raw('cuts.json')).toBe(before);
  expect(raw('script.md')).toBe('保存済みのフックと台本');
});
it('明示の確認と最新内容が揃うまで、生成も書き込みもしない', async () => {
  const before = raw('cuts.json');
  await expect(aiScriptText(dir, {...opt(), confirmed: false})).rejects.toThrow('確認');
  await expect(aiScriptText(dir, {...opt(), fingerprint: 'stale'})).rejects.toThrow('確認後');
  expect(runAgent).not.toHaveBeenCalled();
  expect(raw('cuts.json')).toBe(before);
});
it('承認後は文言だけを生成し、素材・順番・尺・倍速・画角・フォント・音設定・会話字幕を保つ', async () => {
  const before = readCuts(dir);
  const oldNarr = readNarration(dir)!;
  const result = await aiScriptText(dir, {...opt(), model: 'gpt-6-sol'});
  const after = readCuts(dir);
  const structural = (cuts: typeof before) => cuts.cuts.map(({main, ...rest}) => rest);
  expect(structural(after)).toEqual(structural(before));
  expect(after.meta?.orderLocked).toBe(true);
  expect(after.font).toBe(before.font);
  expect(after.cuts[0].main).toMatchObject({text: '炭火で焼く', orientation: 'horizontal', highlightColor: 'red'});
  expect(after.cuts[1].main?.text).toBe('香ばしい');
  const narr = readNarration(dir)!;
  expect(narr).toMatchObject({voice: oldNarr.voice, speed: oldNarr.speed, narrationGainDb: 7, ambientGain: 0.1, sfx: oldNarr.sfx, videoSec: 8});
  expect(narr.segments.map(s => [s.at, s.text, s.needsTts, s.durSec])).toEqual([[0, 'すみびでやく', true, undefined], [3, 'いいかおり', true, undefined]]);
  expect(result).toMatchObject({written: true, cuts: 3, telops: 2, narration: 2});
  expect(runAgent).toHaveBeenCalledOnce();
  const request = vi.mocked(runAgent).mock.calls[0][0];
  expect(request.model).toBe('gpt-6-sol');
  expect(request.prompt).toContain('保存済みのフックと台本');
  expect(request.prompt).toContain('"fromSec":0,"toSec":3');
  expect(request.prompt).toContain('映像と時間軸を優先');
  expect(request.prompt).toContain(String.fromCharCode(10));
});
it.each(['missing', 'duplicate', 'unknown', 'outside'])('不正な応答 %s は元の構成と原稿を上書きしない', async kind => {
  const data = plan();
  if (kind === 'missing') data.telops.pop();
  if (kind === 'duplicate') data.telops.push(data.telops[0]);
  if (kind === 'unknown') data.telops[1].cutId = 'other';
  if (kind === 'outside') data.narration[0].at = 8;
  vi.mocked(runAgent).mockResolvedValue({data} as any);
  const before = [raw('cuts.json'), raw('narration.json')];
  await expect(aiScriptText(dir, opt())).rejects.toThrow();
  expect([raw('cuts.json'), raw('narration.json')]).toEqual(before);
});
it('生成中に手動変更された場合は古い確認を無効にし、新しい並びを守る', async () => {
  const approved = opt();
  vi.mocked(runAgent).mockImplementation(async () => {
    const cuts = readCuts(dir); cuts.cuts.reverse(); writeCuts(dir, cuts);
    return {data: plan()} as any;
  });
  const narration = raw('narration.json');
  await expect(aiScriptText(dir, approved)).rejects.toThrow('確認後');
  expect(readCuts(dir).cuts.map(c => c.id)).toEqual(['c03', 'c01', 'c02']);
  expect(raw('narration.json')).toBe(narration);
});

it.each(['draft', 'mimic'])('%s は保存済み台本を残し、ロック中は追加AIを呼ばず確認待ちへ進む', async kind => {
  const section = {fromSec: 0, toSec: 8, label: 'フック', video: '店内と料理', cutCount: 2, cutSec: '4', telop: '炭火の香り', badge: '', narration: 'すみびのかおり', why: '映像を先に見せる'};
  vi.mocked(runAgent).mockResolvedValue({data: {sections: [section], notes: '映像に沿う', unmatched: []}, costUsd: 0} as any);
  writeReference(dir, ReferenceSchema.parse({source: {file: 'reference/source.mp4', originalName: 'source.mp4', durationSec: 8, fps: 30, importedAt: '2026-10-09'}, analyzedAt: '2026-10-09', segments: [{id: 'hook', fromSec: 0, toSec: 8, cutCount: 2, cutIndices: [1, 2]}], cuts: [{index: 1, startSec: 0, endSec: 4}, {index: 2, startSec: 4, endSec: 8}]}));
  const before = [raw('cuts.json'), raw('narration.json')];
  const result = kind === 'draft' ? await aiScriptDraft(dir, {request: '料理と店内を紹介', assemble: true}) : await aiMimic(dir, {assemble: true});
  expect(result.textConfirmation).toMatchObject({cuts: 3, totalSec: 8});
  expect(result.assembled).toBeUndefined();
  expect(raw('script.md')).toContain('炭火の香り');
  expect(runAgent).toHaveBeenCalledOnce();
  expect([raw('cuts.json'), raw('narration.json')]).toEqual(before);
});

it('ナレーションの映像位置はフレーム丸めを含め、Timeline と同じ秒数で生成する', async () => {
  const cuts = readCuts(dir);
  cuts.cuts[0].outSec = 1.051;cuts.cuts[0].playbackRate = 1;
  writeCuts(dir, cuts);
  await aiScriptText(dir, opt());
  expect(vi.mocked(runAgent).mock.calls[0][0].prompt).toContain('"fromSec":0,"toSec":0.06666666666666667');
  expect(vi.mocked(runAgent).mock.calls[0][0].prompt).toContain('"fromSec":0.06666666666666667,"toSec":4.066666666666666');
});
