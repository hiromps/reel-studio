// テロップの背景色の範囲（〖…〗）と、バッジの改行
import {describe, expect, it} from 'vitest';
import {badgeLines, markTextColor, parseTelopPieces, resolveTelopStyle, stripTelopMarks as engineStrip, wrapTelop} from '../engine/src/telops';
import {countChars, stripTelopMarks, wrapTelopMark} from '../shared/telop-text';

describe('テロップの背景色の範囲', () => {
  it('〖…〗は既定の色、〖…|#色〗はその色の範囲になり、ほかの部分はこれまでどおり', () => {
    const pieces = parseTelopPieces('この〖肉汁〗が〖反則|#E53935〗', {tags: false, bigNumbers: false});
    expect(pieces).toEqual([
      {kind: 'text', text: 'この'},
      {kind: 'mark', text: '肉汁', bg: '#FFE14D'},
      {kind: 'text', text: 'が'},
      {kind: 'mark', text: '反則', bg: '#E53935'},
    ]);
  });

  it('赤タグや大きい数字と一緒に使える', () => {
    const pieces = parseTelopPieces('【限定】〖30個〗だけ', {tags: true, bigNumbers: true});
    expect(pieces.map((p) => p.kind)).toEqual(['tag', 'mark', 'text']);
  });

  it('文字数と折り返しでは指定の記号を数えず、範囲の途中で改行しない', () => {
    expect(countChars('〖肉汁|#E53935〗あふれる')).toBe(6);
    expect(stripTelopMarks('〖肉汁|#E53935〗あふれる')).toBe('肉汁あふれる');
    expect(engineStrip('〖肉汁〗あふれる')).toBe('肉汁あふれる');
    // 7 字で折り返す設定でも「〖肉汁あふれる〗」は割らない
    const lines = wrapTelop('とろける〖肉汁あふれる〗ハンバーグ', 7, false);
    expect(lines.some((l) => l.includes('〖肉汁あふれる〗'))).toBe(true);
  });

  it('選んだ範囲を包む。既定の色は色指定を省き、すでにある指定は付け直す', () => {
    expect(wrapTelopMark('肉汁あふれる', 0, 2)).toBe('〖肉汁〗あふれる');
    expect(wrapTelopMark('肉汁あふれる', 2, 6, '#e53935')).toBe('肉汁〖あふれる|#E53935〗');
    expect(wrapTelopMark('肉汁', 1, 1)).toBe('肉汁');
  });

  it('背景色の濃さはバッジと同じ 0.6 が既定で、0〜1 に収める', () => {
    expect(resolveTelopStyle('pop').markOpacity).toBe(0.6);
    expect(resolveTelopStyle('azu', {markOpacity: 1}).markOpacity).toBe(1);
    expect(resolveTelopStyle('pop', {markOpacity: 3}).markOpacity).toBe(1);
  });

  it('背景の明るさで文字色を決める', () => {
    expect(markTextColor('#FFE14D')).toBe('#111');
    expect(markTextColor('#1A237E')).toBe('#fff');
  });
});

describe('バッジの改行', () => {
  it('改行で行に分け、空行は詰める', () => {
    expect(badgeLines('大阪・天満\n第3位')).toEqual(['大阪・天満', '第3位']);
    expect(badgeLines('天満\r\n\n  第1位 ')).toEqual(['天満', '第1位']);
    expect(badgeLines('天満')).toEqual(['天満']);
  });
});
