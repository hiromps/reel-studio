// テロップ文の禁則・正規化（shared/telop-text.ts）
import {describe, expect, it} from 'vitest';
import {ELLIPSIS, countChars, ellipsisCount, hasNonStandardEllipsis, normalizeEllipsis} from '@shared/telop-text';

// 三点リーダーは全角の中黒 3 文字「・・・」に固定する（2026-09-23 のユーザー指示。縦書きで「…」は細く見えて消える）
describe('normalizeEllipsis', () => {
  it('「…」「……」「‥」「...」「．．．」「。。。」「･･･」「・・」を「・・・」にする', () => {
    expect(normalizeEllipsis('その名も…')).toBe('その名も・・・');
    expect(normalizeEllipsis('その名も……')).toBe('その名も・・・');
    expect(normalizeEllipsis('その名も‥')).toBe('その名も・・・');
    expect(normalizeEllipsis('その名も...')).toBe('その名も・・・');
    expect(normalizeEllipsis('その名も. . .')).toBe('その名も・・・');
    expect(normalizeEllipsis('その名も．．．')).toBe('その名も・・・');
    expect(normalizeEllipsis('その名も。。。')).toBe('その名も・・・');
    expect(normalizeEllipsis('その名も･･･')).toBe('その名も・・・');
    expect(normalizeEllipsis('その名も・・')).toBe('その名も・・・');
    expect(normalizeEllipsis('その名も・・・・・')).toBe('その名も・・・');
  });

  it('正しい「・・・」はそのまま。単独の「・」（区切り）や小数点・文末の句点は触らない', () => {
    expect(normalizeEllipsis('その名も・・・')).toBe('その名も・・・');
    expect(normalizeEllipsis('焼肉・ホルモン')).toBe('焼肉・ホルモン');
    expect(normalizeEllipsis('2.5倍')).toBe('2.5倍');
    expect(normalizeEllipsis('うまい。')).toBe('うまい。');
    expect(normalizeEllipsis('')).toBe('');
  });

  it('文中に 2 か所あっても両方直す', () => {
    expect(normalizeEllipsis('まさか…の…結末')).toBe('まさか・・・の・・・結末');
  });

  it('ELLIPSIS は 3 文字として数える', () => {
    expect(countChars(ELLIPSIS)).toBe(3);
    expect(countChars(normalizeEllipsis('その名も…'))).toBe(7);
  });
});

describe('hasNonStandardEllipsis / ellipsisCount', () => {
  it('「…」が混ざっていれば true、「・・・」だけなら false', () => {
    expect(hasNonStandardEllipsis('その名も…')).toBe(true);
    expect(hasNonStandardEllipsis('その名も...')).toBe(true);
    expect(hasNonStandardEllipsis('その名も・・・')).toBe(false);
    expect(hasNonStandardEllipsis('焼肉・ホルモン')).toBe(false);
  });

  it('回数は書き方を揃えてから数える', () => {
    expect(ellipsisCount('その名も…')).toBe(1);
    expect(ellipsisCount('まさか・・・の…結末')).toBe(2);
    expect(ellipsisCount('焼肉・ホルモン')).toBe(0);
  });
});
