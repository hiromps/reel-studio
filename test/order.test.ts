import {describe, expect, it} from 'vitest';
import {OrderProposalSchema, checkOrder, formatOrderCheck, longestUsableSec, orderFromCuts, orderPrinciples, recommendedCutCount} from '@shared/order';
import {planCuts} from '@shared/plan';
import {FORMAT_SPECS} from '@shared/format-specs';
import {TEST_PERSONAS} from './helpers';
import {makeBrief, makeCatalog, makeClip, richClips} from './helpers';

const catalog = makeCatalog('reunion', richClips());
const f7 = FORMAT_SPECS.F7;
const f0 = FORMAT_SPECS.F0;
const briefF7 = makeBrief({persona: 'standard', format: 'F7', hook: {clipId: '11', text: '東大阪、9割が知らない'}, shop: {name: 'Cafe REUNION', area: '東大阪', genre: 'ティールーム', pr: false}});
const ctxF7 = {catalog, brief: briefF7, spec: f7, persona: TEST_PERSONAS.standard};

const codes = (r: {findings: {code: string}[]}) => r.findings.map((f) => f.code);
const errCodes = (r: {findings: {code: string; severity: string}[]}) => r.findings.filter((f) => f.severity === 'E').map((f) => f.code);

/** planCuts が出した並び（＝型どおりの並び）を clipId 配列で得る */
const planOrder = (brief = briefF7): string[] => {
  const r = planCuts({catalog, brief, options: {now: '2026-09-09T00:00:00.000Z'}});
  return orderFromCuts(r.cuts, catalog);
};

describe('checkOrder — 並び順そのものの構成チェック', () => {
  it('planCuts が組んだ並びは E ゼロで通る（型どおりの構成が基準）', () => {
    const r = checkOrder(planOrder(), ctxF7);
    expect(errCodes(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.summary.count).toBeGreaterThan(0);
  });

  it('空の並びは E', () => {
    const r = checkOrder([], ctxF7);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('ORDER_EMPTY');
  });

  it('catalog に無い id・NG クリップ・使える区間が無いクリップは E', () => {
    const short = makeClip({id: '99', slug: 'tiny', dur: 0.4, kind: 'detail'});
    const ng = makeClip({id: '98', slug: 'blurred', dur: 3.0, kind: 'detail'});
    ng.user.ng = true;
    const cat = makeCatalog('x', [...richClips(), short, ng]);
    const r = checkOrder(['11', 'zz', '98', '99'], {...ctxF7, catalog: cat});
    expect(errCodes(r)).toEqual(expect.arrayContaining(['ORDER_UNKNOWN_CLIP', 'ORDER_NG_CLIP', 'ORDER_CLIP_UNUSABLE']));
  });

  it('先頭が brief.hook でなければ E（フック素材はユーザーが選ぶ）', () => {
    const r = checkOrder(['16', '11', '12', '19'], ctxF7);
    expect(errCodes(r)).toContain('ORDER_HOOK_FIRST');
  });

  it('先頭に看板クリップを置いたら E', () => {
    const brief = makeBrief({persona: 'standard', format: 'F7', hook: {clipId: '19'}});
    const r = checkOrder(['19', '11', '12'], {...ctxF7, brief});
    expect(errCodes(r)).toContain('ORDER_HOOK_SIGNAGE');
  });

  it('先頭が料理でない（外観・店内）なら W', () => {
    const brief = makeBrief({persona: 'standard', format: 'F7', hook: {clipId: '01'}});
    const r = checkOrder(['01', '11', '16', '19'], {...ctxF7, brief});
    expect(codes(r)).toContain('ORDER_OPENING_NOT_FOOD');
    expect(errCodes(r)).not.toContain('ORDER_OPENING_NOT_FOOD');
  });

  describe('店名リビールの位置', () => {
    it('F7：看板が最後の 2 カットより前にあると E', () => {
      const r = checkOrder(['11', '19', '16', '12', '18'], ctxF7);
      expect(errCodes(r)).toContain('ORDER_SIGNAGE_EARLY');
    });

    it('F7：看板が末尾 2 カット以内なら E にならない', () => {
      const r = checkOrder(['11', '16', '12', '19', '01'], ctxF7);
      expect(errCodes(r)).not.toContain('ORDER_SIGNAGE_EARLY');
    });

    it('F7：看板が catalog にあるのに使われていなければ W', () => {
      const r = checkOrder(['11', '16', '12', '18'], ctxF7);
      expect(codes(r)).toContain('ORDER_REVEAL_MISSING');
    });

    it('F0：看板が 2〜5 番目に無ければ W（②証明の直後にリビール）', () => {
      const brief = makeBrief({persona: 'standard', format: 'F0', hook: {clipId: '11'}});
      const late = checkOrder(['11', '16', '12', '18', '13', '15', '19'], {...ctxF7, brief, spec: f0});
      expect(codes(late)).toContain('ORDER_REVEAL_POSITION');
      const ok = checkOrder(['11', '16', '19', '12', '18', '13', '15'], {...ctxF7, brief, spec: f0});
      expect(codes(ok)).not.toContain('ORDER_REVEAL_POSITION');
    });
  });

  it('同一被写体・同一画角の 3 連続は W', () => {
    // 16(黄身/close) → 18(黄身/close) → 11(紅茶/close)：被写体 2 連続・画角 3 連続
    const r = checkOrder(['11', '16', '18', '09', '19'], ctxF7);
    expect(codes(r)).toContain('ORDER_SAME_ANGLE_RUN');
  });

  it('同じクリップを離れた位置で再使用したら W（隣接の 2 回使いは W にしない）', () => {
    const apart = checkOrder(['11', '16', '11', '19'], ctxF7);
    expect(codes(apart)).toContain('ORDER_SAME_CLIP_NONCONSECUTIVE');
    const adjacent = checkOrder(['11', '11', '16', '19'], ctxF7);
    expect(codes(adjacent)).not.toContain('ORDER_SAME_CLIP_NONCONSECUTIVE');
  });

  it('カット数が型の推奨から外れたら W', () => {
    const r = checkOrder(['11', '16', '19'], ctxF7);
    expect(codes(r)).toContain('ORDER_CUT_COUNT');
    expect(r.summary.recommendedCount).toEqual(recommendedCutCount(f7, 30));
  });

  it('見せ場のある素材の使い残しは W（未使用の id を summary に出す）', () => {
    const r = checkOrder(['11', '16', '19'], ctxF7);
    expect(codes(r)).toContain('ORDER_UNUSED_GOOD');
    expect(r.summary.unusedGood).toContain('18'); // sizzleScore 5 の黄身マクロ
    expect(r.summary.unusedGood).not.toContain('11');
  });

  it('未タグのクリップが混ざったら W', () => {
    const clips = richClips();
    delete clips.find((c) => c.id === '16')!.tags;
    const r = checkOrder(['11', '16', '19'], {...ctxF7, catalog: makeCatalog('x', clips)});
    expect(codes(r)).toContain('ORDER_UNTAGGED');
    expect(r.summary.untagged).toBe(1);
  });

  it('看板の位置を summary に出す', () => {
    const r = checkOrder(['11', '16', '12', '19', '01'], ctxF7);
    expect(r.summary.signageAt).toEqual([3]);
  });
});

describe('orderFromCuts — cuts.json から並びを読み戻す', () => {
  it('plan → orderFromCuts で clipId の並びが復元でき、alias 名も辿れる', () => {
    const r = planCuts({catalog, brief: briefF7, options: {now: '2026-09-09T00:00:00.000Z'}});
    const order = orderFromCuts(r.cuts, catalog);
    expect(order).toHaveLength(r.cuts.cuts.length);
    expect(order.every((id) => catalog.clips.some((c) => c.id === id))).toBe(true);
    // alias（同一 src の非連続再参照）が出ていても catalog の id に戻る
    for (const a of r.cuts.meta!.aliases!) expect(r.cuts.cuts.some((c) => c.src === a.to)).toBe(true);
  });

  it('固定順で plan すると、指定した並びがそのまま cuts の並びになる', () => {
    const want = ['11', '16', '12', '18', '13', '15', '17', '21', '09', '10', '20', '02', '19', '01'];
    const brief = makeBrief({persona: 'standard', format: 'F7', hook: {clipId: '11'}, order: {mode: 'fixed', fixed: want}});
    const r = planCuts({catalog, brief, options: {now: '2026-09-09T00:00:00.000Z'}});
    expect(orderFromCuts(r.cuts, catalog)).toEqual(want);
  });
});

describe('OrderProposalSchema — Claude が返す形', () => {
  it('order だけで通り、余分なキーは弾かれない', () => {
    const r = OrderProposalSchema.safeParse({order: ['11', '16'], notes: 'テスト', reasons: [{clipId: '11', why: 'フック'}]});
    expect(r.success).toBe(true);
  });

  it('order が無い・空・文字列でないものは弾く', () => {
    expect(OrderProposalSchema.safeParse({}).success).toBe(false);
    expect(OrderProposalSchema.safeParse({order: []}).success).toBe(false);
    expect(OrderProposalSchema.safeParse({order: [1, 2]}).success).toBe(false);
  });
});

describe('orderPrinciples / longestUsableSec / formatOrderCheck', () => {
  it('F7 は看板の温存、F0 は 2〜5 番目のリビールを指示する', () => {
    const a = orderPrinciples(f7, briefF7, TEST_PERSONAS.standard).join('\n');
    expect(a).toMatch(/最後の 2 カット/);
    expect(a).toMatch(/先頭は必ず 11/);
    const b = orderPrinciples(f0, makeBrief({persona: 'standard', format: 'F0'}), TEST_PERSONAS.standard).join('\n');
    expect(b).toMatch(/2〜5 番目/);
  });

  it('usableRanges があればその最長区間、無ければ頭尾マージンを引いた尺', () => {
    const withRange = catalog.clips.find((c) => c.id === '11')!; // best 2.0-4.5 / ok 5.0-9.5
    expect(longestUsableSec(withRange)).toBeCloseTo(4.5, 3);
    const plain = catalog.clips.find((c) => c.id === '01')!; // 2.9 秒・マージン 0.2
    expect(longestUsableSec(plain)).toBeCloseTo(2.5, 3);
    const shortClip = makeClip({id: '97', slug: 's', dur: 1.2, kind: 'detail'});
    expect(longestUsableSec(shortClip)).toBeCloseTo(1.2, 3);
  });

  it('formatOrderCheck は 1 行目に要約、以降に指摘を出す', () => {
    const text = formatOrderCheck(checkOrder(['11', '19', '16', '12', '18'], ctxF7));
    expect(text.split('\n')[0]).toMatch(/^NG {2}5 カット（推奨 18〜22 \/ 30s）/);
    expect(text).toMatch(/E ORDER_SIGNAGE_EARLY \[2番目\]/);
  });
});
