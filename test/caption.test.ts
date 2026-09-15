import {describe, expect, it} from 'vitest';
import {checkCaption, hashtagsOf} from '../shared/caption';
import {TEST_PERSONAS} from './helpers';

// standard = ハッシュタグ 3 個・600 文字・誘導なし ／ casual = 5 個・上限なし・@example_account への誘導あり
const hiro = TEST_PERSONAS.standard;
const sayuri = TEST_PERSONAS.casual;

/** standard の型（ハッシュタグ 3 個・自分アカウントへの誘導なし）を満たす最小のキャプション */
const ok = ['梅田で見つけた炭火焼き🔥', '', '・備長炭でじっくり焼く', '', '#梅田グルメ #焼き鳥 #炭火焼き'].join('\n');

describe('hashtagsOf', () => {
  it('# から空白までを 1 個として数える', () => {
    expect(hashtagsOf('本文 #梅田グルメ #焼き鳥\n#炭火')).toEqual(['#梅田グルメ', '#焼き鳥', '#炭火']);
  });
});

describe('checkCaption', () => {
  it('型どおりなら指摘なし', () => {
    expect(checkCaption(ok, hiro)).toEqual([]);
  });

  it('空なら E', () => {
    expect(checkCaption('   ', hiro)).toEqual([{severity: 'E', code: 'EMPTY', message: 'キャプションが空です'}]);
  });

  it('ハッシュタグの本数は人格ごとに違う（standard 3 / casual 5）', () => {
    expect(checkCaption(ok, hiro).some((i) => i.code === 'HASHTAG_COUNT')).toBe(false);
    expect(checkCaption(ok, sayuri).some((i) => i.code === 'HASHTAG_COUNT')).toBe(true);
  });

  it('保存・いいね誘導は E', () => {
    const bad = ok.replace('・備長炭でじっくり焼く', '保存しておくと便利');
    expect(checkCaption(bad, hiro).find((i) => i.code === 'ENGAGEMENT_BAIT')?.severity).toBe('E');
  });

  it('来店を促す一文は通す', () => {
    expect(checkCaption(ok.replace('・備長炭でじっくり焼く', 'ぜひ行ってみて'), hiro)).toEqual([]);
  });

  it('文末の句点を指摘する', () => {
    expect(checkCaption(ok.replace('・備長炭でじっくり焼く', '・備長炭でじっくり焼く。'), hiro).some((i) => i.code === 'TRAILING_PERIOD')).toBe(true);
  });

  it('未確定のプレースホルダを指摘する', () => {
    expect(checkCaption(ok.replace('・備長炭でじっくり焼く', '・＿＿＿　880円'), hiro).some((i) => i.code === 'PLACEHOLDER')).toBe(true);
  });

  it('#PR は使わない（pr 表記は店名の直後）', () => {
    expect(checkCaption(ok.replace('#炭火焼き', '#PR'), hiro).some((i) => i.code === 'HASHTAG_PR')).toBe(true);
  });

  it('PR 案件で pr 表記が無ければ指摘する', () => {
    expect(checkCaption(ok, hiro, {pr: true}).some((i) => i.code === 'PR_MISSING')).toBe(true);
    expect(checkCaption(`${ok}\n「炭火焼き 煙」pr`, hiro, {pr: true}).some((i) => i.code === 'PR_MISSING')).toBe(false);
  });

  it('PR でないのに店名の後の pr があれば指摘する', () => {
    expect(checkCaption(`${ok}\n『炭火焼き 煙』pr`, hiro, {pr: false}).some((i) => i.code === 'PR_UNEXPECTED')).toBe(true);
  });

  it('repostAccount のある人格は自分のアカウントへの誘導行が要る', () => {
    const five = ok.replace('#梅田グルメ #焼き鳥 #炭火焼き', '#a #b #c #d #e');
    expect(checkCaption(five, sayuri).some((i) => i.code === 'REPOST_ACCOUNT')).toBe(true);
    expect(checkCaption(`${five}\n@example_account`, sayuri).some((i) => i.code === 'REPOST_ACCOUNT')).toBe(false);
  });

  it('長さの目安（600 文字）を超えたら指摘する。maxChars 0 の人格は上限なし', () => {
    expect(checkCaption(`${'あ'.repeat(700)}\n#a #b #c`, hiro).some((i) => i.code === 'TOO_LONG')).toBe(true);
    // casual は上限なし（メニューが多い店では長文化してよい）
    expect(checkCaption(`${'あ'.repeat(700)}\n@example_account\n#a #b #c #d #e`, sayuri).some((i) => i.code === 'TOO_LONG')).toBe(false);
  });
});
