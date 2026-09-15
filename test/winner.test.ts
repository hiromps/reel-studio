import {describe, expect, it} from 'vitest';
import {DEFAULT_WINNER_SPEED, applyTailNarration, applyTailTelop, checkWinner, lastNarrationId, spedUpSec, tailCutIndices, tailNarrationBudget, tailTelopOf} from '@shared/winner';
import type {Narration, ReelData} from '@shared/schema';

/** 6 カット。締め「ぜひ行ってみて」が末尾 2 カットにまたがる。最後のカットは main 無し */
const cutsOf = (): ReelData =>
  ({
    fps: 30,
    theme: 'pop',
    cuts: [
      {id: 'c01', src: 'uploads/01.mp4', inSec: 0, outSec: 1.5, main: {text: 'フック'}},
      {id: 'c02', src: 'uploads/02.mp4', inSec: 0, outSec: 1.5, main: {text: '本編'}},
      {id: 'c03', src: 'uploads/03.mp4', inSec: 0, outSec: 1.5, main: {text: '本編'}},
      {id: 'c04', src: 'uploads/04.mp4', inSec: 0, outSec: 1.5, main: {text: 'ぜひ行ってみて'}},
      {id: 'c05', src: 'uploads/05.mp4', inSec: 0, outSec: 1.5, main: {text: 'ぜひ行ってみて'}},
      {id: 'c06', src: 'uploads/06.mp4', inSec: 0, outSec: 1.0},
    ],
  }) as unknown as ReelData;

const narration = (): Narration =>
  ({voice: 'v', segments: [{id: '01_hook', at: 0, text: 'ふっく', durSec: 1.2}, {id: '05_cta', at: 4.6, text: 'ぜひ行ってみて', durSec: 1.5}]}) as Narration;

describe('tailCutIndices / applyTailTelop', () => {
  it('締めは末尾のテロップグループ（同じ文言が続く範囲）。main の無い末尾カットは飛ばす', () => {
    expect(tailCutIndices(cutsOf())).toEqual([3, 4]);
    expect(tailTelopOf(cutsOf())).toBe('ぜひ行ってみて');
  });

  it('締めのカットだけ文言が変わり、他は 1 文字も変わらない。元も書き換えない', () => {
    const before = cutsOf();
    const {cuts, cutIds, before: prev} = applyTailTelop(before, '一度は行っとこ');
    expect(cutIds).toEqual(['c04', 'c05']);
    expect(prev).toBe('ぜひ行ってみて');
    expect(cuts.cuts.slice(0, 3)).toEqual(before.cuts.slice(0, 3));
    expect(cuts.cuts[3].main?.text).toBe('一度は行っとこ');
    expect(cuts.cuts[4].main?.text).toBe('一度は行っとこ');
    expect(cuts.cuts[5]).toEqual(before.cuts[5]);
    expect(before.cuts[3].main?.text).toBe('ぜひ行ってみて');
  });

  it('空文字なら何もしない', () => {
    expect(applyTailTelop(cutsOf(), '  ').cutIds).toEqual([]);
  });
});

describe('applyTailNarration', () => {
  it('最後のブロックだけ差し替え、id を変えて wav がぶつからないようにする', () => {
    expect(lastNarrationId(narration())).toBe('05_cta');
    const {narration: n, wavId, before, at} = applyTailNarration(narration(), '一度は行っといて', 'A');
    expect(wavId).toBe('05_cta__WA');
    expect(before).toBe('ぜひ行ってみて');
    expect(at).toBe(4.6);
    expect(n.segments[1]).toMatchObject({id: '05_cta__WA', text: '一度は行っといて', needsTts: true});
    expect(n.segments[1].durSec).toBeUndefined();
    expect(n.segments[0]).toEqual(narration().segments[0]);
  });

  it('空なら何も変えない', () => {
    expect(applyTailNarration(narration(), '', 'A').wavId).toBeNull();
  });

  it('締めに使える文字数は残り秒数 × 話速 × 0.9', () => {
    expect(tailNarrationBudget(narration(), 8.5, 10)).toBe(35); // (8.5-4.6)*10*0.9 = 35.1
  });
});

describe('checkWinner', () => {
  const base = {tailTelop: '一度は行っとこ', prevTelop: 'ぜひ行ってみて', tailNarration: 'いちどは行っといて', prevNarration: 'ぜひ行ってみて', caption: '新しい本文', prevCaption: '元の本文', speed: DEFAULT_WINNER_SPEED, ctaPatterns: ['行ってみて', '行っとこ']};

  it('締めを変えて文面も変えていれば指摘なし', () => {
    expect(checkWinner(base)).toEqual([]);
  });

  it('締めが同じままは E（二次活用は締めを変えるのが決まり）', () => {
    expect(checkWinner({...base, tailTelop: 'ぜひ行ってみて'}).find((i) => i.code === 'TAIL_TELOP_SAME')?.severity).toBe('E');
    expect(checkWinner({...base, tailTelop: ''}).find((i) => i.code === 'TAIL_TELOP_EMPTY')?.severity).toBe('E');
  });

  it('キャプションが元と同じ文面は W（使い回し）', () => {
    expect(checkWinner({...base, caption: '元の本文'}).some((i) => i.code === 'CAPTION_SAME')).toBe(true);
  });

  it('来店を促す語族でない締めは W、長い・句点も W', () => {
    const r = checkWinner({...base, tailTelop: 'とにかく最高の一杯でした。'});
    expect(r.some((i) => i.code === 'TAIL_NOT_CTA')).toBe(true);
    expect(r.some((i) => i.code === 'TAIL_TELOP_PERIOD')).toBe(true);
  });

  it('倍速の範囲外は E', () => {
    expect(checkWinner({...base, speed: 2}).find((i) => i.code === 'SPEED_RANGE')?.severity).toBe('E');
    expect(checkWinner({...base, speed: 0.9}).some((i) => i.code === 'SPEED_RANGE')).toBe(true);
  });

  it('ナレーションに改行は E', () => {
    expect(checkWinner({...base, tailNarration: 'いち\nに'}).find((i) => i.code === 'TAIL_NARRATION_MULTILINE')?.severity).toBe('E');
  });
});

describe('spedUpSec', () => {
  it('1.1 倍速で尺は 1/1.1', () => {
    expect(spedUpSec(22, 1.1)).toBe(20);
  });
});
