import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ReelDataSchema, type ReelData} from '../shared/schema/cuts';
import {assertOrderUnlocked, readCuts, writeCuts} from '../core/project';
import {importOrder, loadOrderEnv} from '../core/order';
import {applyScriptProposal} from '../core/script';
import {aiOrder, applyPatch} from '../core/ai';
import {makeBrief, makeCatalog, makeClip} from './helpers';

vi.mock('../core/agent', () => ({runAgent: vi.fn()}));
import {runAgent} from '../core/agent';

let dir: string;
const catalog = makeCatalog('locked', [makeClip({id: '01', slug: 'food', dur: 5, kind: 'sizzle'}), makeClip({id: '02', slug: 'shop', dur: 5, kind: 'interior'})]);
const reel = (): ReelData => ({fps: 30, meta: {orderLocked: true}, cuts: catalog.clips.map((c, i) => ({id: 'c0' + (i + 1), src: c.src, inSec: 0, outSec: 1, main: {text: '旧テロップ'}}))});
const raw = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-order-lock-'));
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(dir, 'brief.json'), JSON.stringify(makeBrief({persona: 'standard', format: 'F0'})));
  writeCuts(dir, reel());
});
afterEach(() => fs.rmSync(dir, {recursive: true, force: true}));

describe('AI 専用の並び順ロック', () => {
  it('旧案件はロック無しで読め、ロック設定は保存して読み直せる', () => {
    expect(ReelDataSchema.parse({...reel(), meta: undefined}).meta?.orderLocked).toBeUndefined();
    expect(readCuts(dir).meta?.orderLocked).toBe(true);
    expect(() => ReelDataSchema.parse({...reel(), meta: {orderLocked: 'true'}})).toThrow();
  });

  it('並べ替え・追加・削除を含むAI差分でも、文言・尺・ナレーションの修正は適用する', () => {
    const before = reel();
    const r = applyPatch(before, {voice: 'v', segments: [{id: 'n1', at: 0, text: '旧原稿'}]}, catalog, {
      summary: '修正', order: ['c02', 'c01'], add: [{ref: 'n1', clipId: '01'}],
      cuts: [{cutId: 'c02', remove: true}, {cutId: 'c01', outSec: 1.5, playbackRate: 1.2}],
      telops: [{cutId: 'c01', text: '新しい文言'}], narration: [{id: 'n1', text: '新しい原稿'}],
    }, {maxCutSec: 3});
    expect(r.cuts.cuts.map(c => c.id)).toEqual(['c01', 'c02']);
    expect(r.cuts.cuts[0]).toMatchObject({outSec: 1.5, playbackRate: 1.2, main: {text: '新しい文言'}});
    expect(r.narration?.segments[0].text).toBe('新しい原稿');
    expect(r.unapplied).toHaveLength(3);
    expect(r.unapplied.every(s => s.includes('ロック'))).toBe(true);
    expect(before.cuts[0].outSec).toBe(1);
    writeCuts(dir, r.cuts, {preserveOrder: true});
    expect(readCuts(dir).meta?.orderLocked).toBe(true);
  });

  it('AIの書き込み直前にも最新のロックを検査し、IDの再採番による素材入れ替えも防ぐ', () => {
    const before = raw('cuts.json');
    const swapped = reel();
    swapped.cuts.reverse();
    expect(() => writeCuts(dir, swapped, {preserveOrder: true})).toThrow('ロック');
    const relabeled = reel();
    [relabeled.cuts[0].src, relabeled.cuts[1].src] = [relabeled.cuts[1].src, relabeled.cuts[0].src];
    expect(() => writeCuts(dir, relabeled, {preserveOrder: true})).toThrow('ロック');
    expect(() => writeCuts(dir, {...reel(), cuts: [reel().cuts[0]]}, {preserveOrder: true})).toThrow('ロック');
    expect(raw('cuts.json')).toBe(before);
  });

  it('ロック中も手動で並べ替え・追加・削除して保存でき、その新しい順番をAIから守る', () => {
    const stale = reel();
    const manual = reel();
    manual.cuts.reverse();
    writeCuts(dir, manual);
    expect(readCuts(dir).cuts.map(c => c.id)).toEqual(['c02', 'c01']);
    expect(() => writeCuts(dir, stale, {preserveOrder: true})).toThrow('ロック');
    writeCuts(dir, {...manual, cuts: [manual.cuts[0]]});
    expect(readCuts(dir).cuts).toHaveLength(1);
    expect(readCuts(dir).meta?.orderLocked).toBe(true);
  });

  it('AIはロックを消せず、手動で解除を保存するとAI並べ替えを再開できる', () => {
    const next = {...reel(), meta: undefined};
    writeCuts(dir, next, {preserveOrder: true});
    expect(readCuts(dir).meta?.orderLocked).toBe(true);
    writeCuts(dir, {...reel(), meta: {orderLocked: false}});
    expect(() => assertOrderUnlocked(dir)).not.toThrow();
    const swapped = reel();
    swapped.cuts.reverse();
    writeCuts(dir, swapped, {preserveOrder: true});
    expect(readCuts(dir).cuts.map(c => c.id)).toEqual(['c02', 'c01']);
    expect(readCuts(dir).meta?.orderLocked).toBe(false);
    const r = applyPatch(readCuts(dir), null, catalog, {summary: '', order: ['c01', 'c02']}, {maxCutSec: 3});
    expect(r.cuts.cuts.map(c => c.id)).toEqual(['c01', 'c02']);
  });

  it('再構成はforceでもロックを守り、Briefも既存カットも書き換えない', async () => {
    const cuts = raw('cuts.json');
    const brief = raw('brief.json');
    expect(() => importOrder(loadOrderEnv(dir), {order: ['02', '01']}, {force: true, write: true})).toThrow('ロック');
    expect(() => applyScriptProposal(dir)).toThrow('ロック');
    await expect(aiOrder(dir, {force: true, write: true})).rejects.toThrow('ロック');
    expect(runAgent).not.toHaveBeenCalled();
    expect(raw('cuts.json')).toBe(cuts);
    expect(raw('brief.json')).toBe(brief);
  });
});
