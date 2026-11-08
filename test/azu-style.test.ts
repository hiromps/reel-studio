import {describe, expect, it} from 'vitest';
import {planCuts} from '@shared/plan';
import {FORMAT_SPECS} from '@shared/format-specs';
import {ReelDataSchema} from '@shared/schema';
import {parseTelopPieces, resolveTelopStyle, wrapTelop} from '../engine/src/telops';
import {makeBrief, makeCatalog, richClips} from './helpers';

describe('azu 型のテロップ', () => {
  it('azu テーマの既定は横書き 2 行・高さ 44%・ゴシック・黒フチ・赤タグ', () => {
    const look = resolveTelopStyle('azu');
    expect(look).toMatchObject({layout: 'horizontal', y: 0.44, lineChars: 12, family: 'gothic', outline: 'hard', tags: true, bigNumbers: true});
  });

  it('従来テーマは今までどおり（縦書き・明朝・ぼかしフチ）で、telopStyle の項目だけ上書きされる', () => {
    expect(resolveTelopStyle('pop')).toMatchObject({layout: 'auto', y: null, family: 'custom', outline: 'soft', tags: false});
    expect(resolveTelopStyle('pop', {layout: 'horizontal', y: 0.5})).toMatchObject({layout: 'horizontal', y: 0.5, family: 'custom'});
    expect(resolveTelopStyle('azu', {y: 5}).y).toBe(0.9);
  });

  it('1 行に入らない文は真ん中に近い読点の後ろで 2 行に割る', () => {
    expect(wrapTelop('〇〇駅の路地裏なのに、平日でも満席の', 12, true)).toEqual(['〇〇駅の路地裏なのに、', '平日でも満席の']);
    expect(wrapTelop('マジでリピ確定です', 12, true)).toEqual(['マジでリピ確定です']);
    expect(wrapTelop('一行目\n二行目', 12, true)).toEqual(['一行目', '二行目']);
  });

  it('タグと数字のかたまりの途中では割らない', () => {
    const lines = wrapTelop('これで一人2000円は反則すぎる', 8, true);
    expect(lines.join('')).toBe('これで一人2000円は反則すぎる');
    expect(lines.some((l) => l.includes('2000円'))).toBe(true);
    expect(wrapTelop('お腹パンパンになるまで食べた、最高すぎる', 12, true).every((l) => !/^[、。ー]/.test(l))).toBe(true);
    const tagged = wrapTelop('【名物】の黒酢豚はサクサクで中はジューシー', 10, true);
    expect(tagged.every((l) => (l.match(/【/g)?.length ?? 0) === (l.match(/】/g)?.length ?? 0))).toBe(true);
  });

  it('【】は赤タグ、数字は大きい数字に分かれる', () => {
    expect(parseTelopPieces('【名物】の100倍うまい', {tags: true, bigNumbers: true})).toEqual([
      {kind: 'tag', text: '名物'},
      {kind: 'text', text: 'の'},
      {kind: 'num', text: '100倍'},
      {kind: 'text', text: 'うまい'},
    ]);
    expect(parseTelopPieces('【名物】', {tags: false, bigNumbers: false})).toEqual([{kind: 'text', text: '【名物】'}]);
  });

  it('cuts.json に telopStyle と最終カードを書ける', () => {
    const data = ReelDataSchema.parse({
      fps: 30,
      theme: 'azu',
      telopStyle: {size: 60, shadow: 0.4},
      cuts: [{src: 'a.mp4', inSec: 0, outSec: 1, endCard: {title: '中華酒場〇〇', sub: '詳細はキャプションまで'}}],
    });
    expect(data.telopStyle?.size).toBe(60);
    expect(data.cuts[0].endCard?.title).toBe('中華酒場〇〇');
  });
});

describe('azu のフォーマット（F8 単店型 / F9 3店まとめ型）', () => {
  it('F8 は約19秒・20カット・azu テーマ', () => {
    const f8 = FORMAT_SPECS.F8;
    expect(f8.theme).toBe('azu');
    expect(f8.segments.reduce((n, s) => n + s.cuts[0], 0)).toBe(20);
    expect(f8.segments.at(-1)!.timeSec[1]).toBe(19);
  });

  it('F8 で planCuts が組める', () => {
    const catalog = makeCatalog('azu', richClips());
    const r = planCuts({catalog, brief: makeBrief({persona: 'standard', format: 'F8', hook: {clipId: '11', text: 'マジで大阪で一番リピしてる'}}), options: {now: '2026-11-08T00:00:00.000Z', allowReuse: true}});
    expect(r.cuts.cuts.length).toBeGreaterThan(5);
    expect(r.cuts.theme).toBe('azu');
  });

  it('F9 は 3 店の繰り返しで planCuts が組める', () => {
    const catalog = makeCatalog('azu3', richClips());
    const r = planCuts({
      catalog,
      brief: makeBrief({persona: 'standard', format: 'F9', hook: {clipId: '11', text: 'ガチで外さない、大阪の中華まとめ3選'}}),
      options: {now: '2026-11-08T00:00:00.000Z', allowReuse: true},
    });
    expect(r.cuts.cuts.length).toBeGreaterThan(5);
    expect(FORMAT_SPECS.F9.repeat?.count).toEqual([3, 3]);
  });
});

describe('azu 型の最終カード', () => {
  it('F8 の planCuts は最後のカットを店名の最終カードにする', () => {
    const catalog = makeCatalog('azu-end', richClips());
    const r = planCuts({catalog, brief: makeBrief({persona: 'standard', format: 'F8', hook: {clipId: '11'}, shop: {name: '中華酒場テスト', area: '梅田', genre: '中華', pr: false}}), options: {now: '2026-11-08T00:00:00.000Z', allowReuse: true}});
    expect(r.cuts.cuts.at(-1)!.endCard).toEqual({title: '中華酒場テスト', sub: '詳細はキャプションまで'});
    expect(r.cuts.cuts.filter((c) => c.endCard)).toHaveLength(1);
  });

  it('azu 以外のフォーマットには付けない', () => {
    const catalog = makeCatalog('f1-end', richClips());
    const r = planCuts({catalog, brief: makeBrief({persona: 'standard', format: 'F1', hook: {clipId: '11'}, shop: {name: '中華酒場テスト', area: '梅田', genre: '中華', pr: false}}), options: {now: '2026-11-08T00:00:00.000Z', allowReuse: true}});
    expect(r.cuts.cuts.some((c) => c.endCard)).toBe(false);
  });
});
