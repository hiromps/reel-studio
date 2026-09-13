import {describe, expect, it} from 'vitest';
import {DEFAULT_HOOK_CUTS, applyHookNarration, applyHookVariant, checkHooks, firstNarrationId, hookCutIndices, variantTouches, type HookVariant, type Hooks} from '@shared/hooks';
import type {Narration, ReelData} from '@shared/schema';

/** 5 カット。slots ではフックは c01 だけ（＝既定の 3 カットの方が長い） */
const cutsOf = (n = 5): ReelData =>
  ({
    fps: 30,
    theme: 'pop',
    cuts: Array.from({length: n}, (_, i) => ({
      id: `c0${i + 1}`,
      src: `uploads/0${i + 1}_x.mp4`,
      inSec: 0,
      outSec: 1.5,
      main: {text: `もとの文言${i + 1}`},
      ...(i === 0 ? {badge: '西九条'} : {}),
    })),
    meta: {slots: [{segment: '1_hook'}, {segment: '2_proof'}, {segment: '2_reveal'}, {segment: '3_reason'}, {segment: '5_cta'}]},
  }) as unknown as ReelData;

const v = (o: Partial<HookVariant> = {}): HookVariant => ({id: 'A', label: '', telops: [], clipIds: [], badge: undefined, narration: '', ...o});
const clipOf = (id: string) => ({src: `uploads/${id}_new.mp4`, durationSec: 10});

describe('hookCutIndices', () => {
  it('既定は冒頭 3 カット（1 カットだと違いが伝わらないため）', () => {
    expect(DEFAULT_HOOK_CUTS).toBe(3);
    expect(hookCutIndices(cutsOf())).toEqual([0, 1, 2]);
  });

  it('カット数を指定できる', () => {
    expect(hookCutIndices(cutsOf(), 1)).toEqual([0]);
    expect(hookCutIndices(cutsOf(), 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it('slots の 1_hook が既定より長ければそちらに合わせる', () => {
    const c = cutsOf();
    (c.meta as {slots: {segment: string}[]}).slots = [{segment: '1_hook'}, {segment: '1_hook'}, {segment: '1_hook'}, {segment: '1_hook'}, {segment: '5_cta'}];
    expect(hookCutIndices(c)).toEqual([0, 1, 2, 3]);
  });

  it('カット数より多くは返さない', () => {
    expect(hookCutIndices(cutsOf(2))).toEqual([0, 1]);
    expect(hookCutIndices({fps: 30, cuts: []} as unknown as ReelData)).toEqual([]);
  });
});

describe('applyHookVariant', () => {
  it('カットごとに文言を入れる', () => {
    const {cuts} = applyHookVariant(cutsOf(), v({telops: ['あ', 'い', 'う']}));
    expect(cuts.cuts.slice(0, 3).map((c) => c.main?.text)).toEqual(['あ', 'い', 'う']);
  });

  it('空文字と足りない分は今の文言のまま（1 枚目だけ変えることもできる）', () => {
    const {cuts} = applyHookVariant(cutsOf(), v({telops: ['あ', '']}));
    expect(cuts.cuts.map((c) => c.main?.text)).toEqual(['あ', 'もとの文言2', 'もとの文言3', 'もとの文言4', 'もとの文言5']);
  });

  it('フック区間の外は一切変えない', () => {
    const before = cutsOf();
    const {cuts} = applyHookVariant(before, v({telops: ['あ', 'い', 'う'], clipIds: ['91', '92', '93']}), {clipOf});
    expect(cuts.cuts.slice(3)).toEqual(before.cuts.slice(3));
  });

  it('元の cuts を書き換えない', () => {
    const before = cutsOf();
    applyHookVariant(before, v({telops: ['あ']}));
    expect(before.cuts[0].main?.text).toBe('もとの文言1');
  });

  it('素材を差し替えてもカットの尺は保つ（合計尺を変えない）', () => {
    const {cuts} = applyHookVariant(cutsOf(), v({clipIds: ['', '92']}), {clipOf});
    expect(cuts.cuts[1].src).toBe('uploads/92_new.mp4');
    expect(cuts.cuts[1].outSec - cuts.cuts[1].inSec).toBeCloseTo(1.5);
    expect(cuts.cuts[0].src).toBe('uploads/01_x.mp4'); // 空文字は差し替えない
  });

  it('素材が短ければその長さまで（存在しない区間を指さない）', () => {
    const {cuts} = applyHookVariant(cutsOf(), v({clipIds: ['91']}), {clipOf: () => ({src: 'uploads/91_new.mp4', durationSec: 0.8})});
    expect(cuts.cuts[0].outSec).toBeCloseTo(0.8);
  });

  it('バッジはフック 1 枚目だけ。null で消える', () => {
    expect(applyHookVariant(cutsOf(), v({badge: '梅田'})).cuts.cuts[0].badge).toBe('梅田');
    expect(applyHookVariant(cutsOf(), v({badge: '梅田'})).cuts.cuts[1].badge).toBeUndefined();
    expect(applyHookVariant(cutsOf(), v({badge: null})).cuts.cuts[0].badge).toBeUndefined();
    expect(applyHookVariant(cutsOf(), v({telops: ['あ']})).cuts.cuts[0].badge).toBe('西九条'); // 省略なら今のまま
  });

  it('変えた内容が changes に出る', () => {
    const {changes} = applyHookVariant(cutsOf(), v({telops: ['あ'], badge: '梅田'}));
    expect(changes.join()).toContain('1枚目「あ」');
    expect(changes.join()).toContain('バッジ「梅田」');
  });
});

describe('applyHookNarration', () => {
  const narration = (): Narration =>
    ({voice: 'v', segments: [{id: '01_hook', at: 0, text: '元の読み', durSec: 1.6}, {id: '02', at: 1.8, text: '2本目', durSec: 1.2}]}) as Narration;

  it('at が最小のブロックが 1 本目', () => {
    expect(firstNarrationId(narration())).toBe('01_hook');
  });

  it('1 本目だけ差し替え、id を変えて wav がぶつからないようにする', () => {
    const {narration: n, wavId} = applyHookNarration(narration(), v({id: 'B', narration: '新しい読み'}));
    expect(wavId).toBe('01_hook__B');
    expect(n.segments[0]).toMatchObject({id: '01_hook__B', text: '新しい読み', needsTts: true});
    expect(n.segments[0].durSec).toBeUndefined();
    expect(n.segments[1]).toEqual(narration().segments[1]);
  });

  it('空なら何も変えない', () => {
    expect(applyHookNarration(narration(), v()).wavId).toBeNull();
  });
});

describe('checkHooks', () => {
  const hooks = (variants: HookVariant[], cutCount = 3): Hooks => ({version: 1, cutCount, variants});

  it('1 パターンだけでは比較にならない', () => {
    expect(checkHooks(hooks([v({telops: ['あ', 'い', 'う']})])).some((i) => i.code === 'HOOK_TOO_FEW')).toBe(true);
  });

  it('id の重複は E', () => {
    expect(checkHooks(hooks([v({id: 'A', telops: ['あ']}), v({id: 'A', telops: ['い']})])).find((i) => i.code === 'HOOK_DUP_ID')?.severity).toBe('E');
  });

  it('何も変えていないパターンは E', () => {
    expect(variantTouches(v())).toBe(false);
    expect(checkHooks(hooks([v({id: 'A'}), v({id: 'B', telops: ['い']})])).find((i) => i.code === 'HOOK_EMPTY')?.severity).toBe('E');
  });

  it('1 カットしか変えていないと W（違いが伝わらない）', () => {
    const r = checkHooks(hooks([v({id: 'A', telops: ['あ']}), v({id: 'B', telops: ['い', 'う', 'え']})]));
    expect(r.filter((i) => i.code === 'HOOK_ONLY_ONE_CUT').map((i) => i.message.slice(0, 1))).toEqual(['A']);
  });

  it('ナレーションも変えていれば 1 カットでも催促しない', () => {
    const r = checkHooks(hooks([v({id: 'A', telops: ['あ'], narration: 'よみ'}), v({id: 'B', telops: ['い', 'う', 'え']})]));
    expect(r.some((i) => i.code === 'HOOK_ONLY_ONE_CUT')).toBe(false);
  });

  it('差し替え範囲より多い文言は W', () => {
    expect(checkHooks(hooks([v({id: 'A', telops: ['あ', 'い', 'う', 'え']}), v({id: 'B', telops: ['か', 'き', 'く']})])).some((i) => i.code === 'HOOK_OVER_SPAN')).toBe(true);
  });

  it('中身が同じパターンは W', () => {
    expect(checkHooks(hooks([v({id: 'A', telops: ['あ', 'い']}), v({id: 'B', telops: ['あ', 'い']})])).some((i) => i.code === 'HOOK_SAME')).toBe(true);
  });

  it('長すぎる文言・句点は枚数つきで W', () => {
    const r = checkHooks(hooks([v({id: 'A', telops: ['', 'あ'.repeat(20)]}), v({id: 'B', telops: ['い。', 'う', 'え']})]));
    expect(r.find((i) => i.code === 'HOOK_TELOP_LONG')?.message).toContain('2 枚目');
    expect(r.some((i) => i.code === 'HOOK_TELOP_PERIOD')).toBe(true);
  });

  it('ちゃんと 3 カットぶん違えば指摘なし', () => {
    const r = checkHooks(hooks([v({id: 'A', telops: ['あ', 'い', 'う']}), v({id: 'B', telops: ['か', 'き', 'く']})]));
    expect(r).toEqual([]);
  });
});
