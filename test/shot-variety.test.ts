import {describe, expect, it} from 'vitest';
import {isSimilarShot, lookDistance, nextStage, pickSupplement, seqGap, shotGroupNote, shotGroups, shotStage, type SupplementQuery} from '../shared/shot-variety';
import {checkOrder, chronologyBreak, collapseSameRuns} from '../shared/order';
import {checkScriptPlan, repairScriptPlan, type ScriptPlan} from '../shared/script';
import {FORMAT_SPECS} from '../shared/format-specs';
import type {Clip, ClipKind} from '../shared/schema/catalog';
import {makeBrief, makeCatalog, makeClip} from './helpers';

const sigOf = (v: number) => Buffer.from(new Uint8Array(336).fill(v)).toString('base64');
const clip = (id: string, o: {look?: number; sharp?: number; kind?: ClipKind; angle?: 'wide' | 'mid' | 'close'; subject?: string; desc?: string; sizzle?: number; tagged?: boolean} = {}): Clip => {
  const c = makeClip({id, slug: `s${id}`, dur: 4, kind: o.kind ?? 'sizzle', angle: o.angle ?? 'close', sizzle: o.sizzle ?? 4, subject: o.subject ?? `料理${id}`});
  const tags = o.tagged === false ? undefined : {...c.tags!, description: o.desc ?? c.tags!.description};
  return {...c, tags, ...(o.look !== undefined ? {look: {v: 1 as const, sig: sigOf(o.look), sharp: o.sharp ?? 1000}} : {})};
};

describe('似た構図の判定', () => {
  it('指紋があれば指紋の距離で決める（33 以下が同じ構図）', () => {
    expect(lookDistance(clip('01', {look: 100}), clip('02', {look: 130}))).toBe(30);
    expect(isSimilarShot(clip('01', {look: 100}), clip('02', {look: 133}))).toBe(true);
    expect(isSimilarShot(clip('01', {look: 100}), clip('02', {look: 134}))).toBe(false);
  });
  it('指紋が無ければ、被写体・画角・種別がすべて同じときだけ同じ構図', () => {
    expect(isSimilarShot(clip('01', {subject: 'カニ桶', angle: 'mid', kind: 'serving'}), clip('02', {subject: 'カニ桶', angle: 'mid', kind: 'serving'}))).toBe(true);
    expect(isSimilarShot(clip('01', {subject: 'カニ桶', angle: 'mid', kind: 'serving'}), clip('02', {subject: 'カニ桶', angle: 'close', kind: 'serving'}))).toBe(false);
  });
  it('まとまりは代表（最も鮮明）とだけ比べ、2 本以上のものを返す', () => {
    const cs = [clip('25', {look: 100, sharp: 2757}), clip('26', {look: 105, sharp: 3141}), clip('27', {look: 110, sharp: 2943}), clip('36', {look: 200})];
    const g = shotGroups(cs);
    expect(g).toEqual([{ids: ['25', '26', '27'], sharpest: '26'}]);
    expect(shotGroupNote(g, '25')).toContain('最も鮮明なのは 26');
    expect(shotGroupNote(g, '26')).toContain('この中で最も鮮明');
    expect(shotGroupNote(g, '36')).toBe('');
  });
});

describe('流れの段', () => {
  it('提供 → 寄り → シズル', () => {
    expect(shotStage(clip('14', {kind: 'serving', angle: 'mid', desc: '木桶のカニ脚を正面から'}))).toBe('serve');
    expect(shotStage(clip('15', {kind: 'serving', angle: 'mid', desc: '木桶を手で持ち上げて差し出す'}))).toBe('serve');
    expect(shotStage(clip('10', {kind: 'sizzle', angle: 'close', desc: '握りを舐めるように寄りで移動'}))).toBe('close');
    expect(shotStage(clip('36', {kind: 'sizzle', angle: 'close', desc: 'カニの身をタレに浸けてから引き上げる'}))).toBe('sizzle');
    expect(shotStage(clip('11', {kind: 'eating', angle: 'close'}))).toBe('sizzle');
    expect(nextStage('serve')).toBe('close');
    expect(nextStage('close')).toBe('sizzle');
  });
});

describe('足りないカットを補う素材', () => {
  const base = (over: Partial<SupplementQuery> = {}): SupplementQuery => ({candidates: [], usedIds: new Set(), nearby: [], used: [], context: '', anchors: [], minSec: 0.7, ...over});
  it('撮影順で前後に撮った素材を先に選ぶ', () => {
    const anchors = [clip('10', {look: 0})];
    const candidates = [clip('03', {look: 60}), clip('11', {look: 120}), clip('20', {look: 180})];
    expect(pickSupplement(base({candidates, anchors}))?.id).toBe('11');
    expect(seqGap(clip('11'), anchors)).toBe(1);
  });
  it('近くに似た構図があるもの・使用済み・人物や看板は使わない', () => {
    const near = clip('10', {look: 100});
    const candidates = [clip('11', {look: 110}), clip('12', {look: 200, kind: 'person'}), clip('13', {look: 250})];
    const used = new Set(['13']);
    expect(pickSupplement(base({candidates, nearby: [near], usedIds: used, anchors: [near]}))).toBeNull();
  });
  it('未タグの素材は撮影順ですぐ隣（2 本以内）のときだけ使う', () => {
    const anchors = [clip('10', {look: 0})];
    expect(pickSupplement(base({candidates: [clip('12', {look: 200, tagged: false})], anchors}))?.id).toBe('12');
    expect(pickSupplement(base({candidates: [clip('14', {look: 200, tagged: false})], anchors}))).toBeNull();
  });
});

describe('並び替えの規則', () => {
  const clips = (['01', '02', '03', '04', '05'] as const).map((id, i) => clip(id, {look: [0, 100, 104, 200, 250][i], sizzle: 3}));
  const catalog = makeCatalog('t', clips);
  const brief = makeBrief({persona: 'hiro', format: 'F0', hook: {clipId: '01'}});
  const ctx = {catalog, brief, spec: FORMAT_SPECS.F0};

  it('同じ素材が続いたら 1 つにまとめる', () => {
    expect(collapseSameRuns(['01', '02', '02', '02', '04', '04'])).toEqual({order: ['01', '02', '04'], removed: 3});
  });
  it('同じ素材の連続は E、近くの似た構図は W', () => {
    const r = checkOrder(['01', '02', '02', '04'], ctx);
    expect(r.findings.find((f) => f.code === 'ORDER_SAME_CLIP_RUN')?.severity).toBe('E');
    const s = checkOrder(['01', '02', '04', '03', '05'], ctx);
    expect(s.findings.some((f) => f.code === 'ORDER_SIMILAR_SHOT')).toBe(true);
  });
  it('撮影順を逆に戻る所が多ければ W（先頭のフックは数えない）', () => {
    const byId = new Map(clips.map((c) => [c.id, c]));
    expect(chronologyBreak(['05', '01', '02', '03', '04'], byId)).toBe(0);
    expect(chronologyBreak(['01', '05', '04', '03', '02'], byId)).toBe(1);
    expect(checkOrder(['01', '05', '04', '03', '02'], ctx).findings.some((f) => f.code === 'ORDER_NOT_CHRONOLOGICAL')).toBe(true);
  });
  it('使っていない素材は W（使っている素材と似た構図のものは数えない）', () => {
    const r = checkOrder(['01', '02', '04'], ctx);
    const w = r.findings.find((f) => f.code === 'ORDER_UNUSED_CLIPS');
    expect(w?.message).toContain('05');
    expect(w?.message).not.toContain('03');
  });
});

describe('台本の組み立ての規則', () => {
  const sections = [{heading: '【0〜3秒】フック', label: 'フック', fromSec: 0, toSec: 3}];
  const ctx = {sections, clipDurations: new Map([['36', 9.2], ['10', 4], ['11', 4]])};
  const plan = (cuts: ScriptPlan['cuts']): ScriptPlan => ({cuts, narration: [{id: '01', at: 0, text: 'あ'}], unmatched: [], notes: ''});
  const c = (clipId: string, inSec: number, outSec: number, telop = '') => ({clipId, inSec, outSec, telop, section: '【0〜3秒】フック'});

  it('同じ素材の連続は、尺を変えずに 1 カットにまとめる', () => {
    const r = repairScriptPlan(plan([c('10', 0.5, 1.5, 'A'), c('36', 1.5, 2.5, 'K'), c('36', 5.5, 6.7)]), ctx);
    expect(r.plan.cuts.map((x) => [x.clipId, x.inSec, x.outSec, x.telop])).toEqual([
      ['10', 0.5, 1.5, 'A'],
      ['36', 1.5, 3.7, 'K'],
    ]);
    expect(r.fixes.some((f) => f.includes('1 カット'))).toBe(true);
  });
  it('テロップが違えばまとめず W にする。近くの似た構図も W', () => {
    const p = plan([c('36', 1.5, 2.5, 'K'), c('36', 5.5, 6.5, 'L'), c('10', 0, 1), c('11', 0, 1)]);
    const r = repairScriptPlan(p, ctx);
    expect(r.plan.cuts).toHaveLength(4);
    const issues = checkScriptPlan(r.plan, {...ctx, similar: (a, b) => [a, b].sort().join() === '10,11'});
    expect(issues.some((i) => i.code === 'SCRIPT_SAME_CLIP_RUN')).toBe(true);
    expect(issues.some((i) => i.code === 'SCRIPT_SIMILAR_SHOT')).toBe(true);
  });
});
