// テロップごとの大きさ（main.size）と改行の扱い
import {describe, expect, it} from 'vitest';
import {MainTelopSchema, TELOP_SIZE_MAX, TELOP_SIZE_MIN} from '../shared/schema/cuts';
import {telopGroupsOf} from '../shared/timeline';
import {wrapTelop} from '../engine/src/telops';

describe('main.size', () => {
  it('範囲内だけ通す', () => {
    expect(MainTelopSchema.safeParse({text: 'a', size: 120}).success).toBe(true);
    expect(MainTelopSchema.safeParse({text: 'a', size: TELOP_SIZE_MIN - 1}).success).toBe(false);
    expect(MainTelopSchema.safeParse({text: 'a', size: TELOP_SIZE_MAX + 1}).success).toBe(false);
  });
  it('大きさが違えば同じ文言でも別のテロップグループになる', () => {
    const cut = (size?: number) => ({src: 'a.mp4', inSec: 0, outSec: 1, main: {text: '同じ', ...(size ? {size} : {})}});
    expect(telopGroupsOf({fps: 30, cuts: [cut(), cut()]})).toHaveLength(1);
    expect(telopGroupsOf({fps: 30, cuts: [cut(), cut(150)]})).toHaveLength(2);
    expect(telopGroupsOf({fps: 30, cuts: [cut(150), cut(150)]})).toHaveLength(1);
  });
});

describe('改行', () => {
  it('横書きは改行どおりに行を分ける（3 行以上も）', () => {
    expect(wrapTelop('一行目\n二行目\n三行目', 0, false)).toEqual(['一行目', '二行目', '三行目']);
  });
  it('空行は詰める', () => {
    expect(wrapTelop('上\n\n下', 0, false)).toEqual(['上', '下']);
  });
});
