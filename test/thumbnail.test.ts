import {describe, expect, it} from 'vitest';
import {bgAtTimelineSec, bgFromCut, bgTimelineSec, defaultBgOf, regionOf, resolveThumbnail, sideTextOf, THUMBNAIL_BUILTIN_FONT, titleTextOf} from '../shared/thumbnail';
import {ReelDataSchema} from '../shared/schema';
import type {ReelData} from '../shared/schema';

const brief = (shop: Partial<{name: string; area: string; station: string; genre: string}>) => ({shop: {name: '伍感', area: '北新地', genre: '焼肉屋', pr: false, ...shop}});

const reel = (extra: Partial<ReelData> = {}): ReelData => ({
  fps: 30,
  cuts: [
    {id: 'c01', src: 'uploads/a.mp4', inSec: 0, outSec: 2, main: {text: '北新地で神コスパ'}},
    {id: 'c02', src: 'uploads/b.mp4', inSec: 1, outSec: 3, crop: {zoom: 1.5, x: 0.4, y: 0.5}},
  ],
  ...extra,
});

describe('サムネイルの地名', () => {
  it('大阪のエリアは OSAKA、神戸・京都のエリアはそれぞれの地域', () => {
    expect(regionOf('天満')).toEqual({ja: '大阪', en: 'OSAKA'});
    expect(regionOf('三ノ宮')).toEqual({ja: '神戸', en: 'KOBE'});
    expect(regionOf('祇園')).toEqual({ja: '京都', en: 'KYOTO'});
    expect(regionOf('渋谷')).toEqual({ja: '東京', en: 'TOKYO'});
  });

  it('分からないエリアは大阪にしておく（手で直せる）', () => {
    expect(regionOf('うめきた')).toEqual({ja: '大阪', en: 'OSAKA'});
    expect(regionOf(undefined)).toEqual({ja: '大阪', en: 'OSAKA'});
  });

  it('縦書きは「地域×エリア」。エリアが無い・地域名そのものなら地域名だけ', () => {
    expect(sideTextOf('大阪', '天満')).toBe('大阪×天満');
    expect(sideTextOf('大阪', '')).toBe('大阪');
    expect(sideTextOf('京都', '京都')).toBe('京都');
  });
});

describe('サムネイルのキャッチ', () => {
  it('短いジャンル → 最初のテロップ → 店名 の順', () => {
    expect(titleTextOf(brief({genre: '焼肉屋'}), reel())).toBe('焼肉屋');
    expect(titleTextOf(brief({genre: 'インバウンドの外国人に人気なカフェ'}), reel())).toBe('北新地で神コスパ');
    expect(titleTextOf(brief({genre: ''}), reel({cuts: [{src: 'uploads/a.mp4', inSec: 0, outSec: 1, main: {text: '{{g01:hook}}'}}]}))).toBe('伍感');
  });
});

describe('サムネイルの背景', () => {
  it('料理のカット（reveal）の真ん中。切り出しも引き継ぐ', () => {
    const r = reel({meta: {slots: [{cutId: 'c02', segment: '3_reveal', role: 'reveal', clipId: 'b', textStatus: 'final', locked: false, qc: []}]}});
    expect(defaultBgOf(r)).toEqual({src: 'uploads/b.mp4', atSec: 2, crop: {zoom: 1.5, x: 0.4, y: 0.5}});
  });

  it('役割が無ければ 1 カット目の真ん中', () => {
    expect(defaultBgOf(reel())).toEqual({src: 'uploads/a.mp4', atSec: 1});
  });

  it('再生ヘッドの位置はカットの中に収める', () => {
    const c = {src: 'uploads/a.mp4', inSec: 1, outSec: 3};
    expect(bgFromCut(c, 0.5).atSec).toBe(1.5);
    expect(bgFromCut(c, -1).atSec).toBe(1);
    expect(bgFromCut(c, 10).atSec).toBe(2.95);
  });
});

describe('タイムラインのピン（背景のコマ ⇄ 動画の秒）', () => {
  it('背景のコマが動画の何秒目か', () => {
    expect(bgTimelineSec(reel(), {src: 'uploads/a.mp4', atSec: 1})).toBe(1);
    // 2 カット目（b.mp4 の 1〜3 秒）の 2.5 秒 → 動画の 2 + 1.5 = 3.5 秒目
    expect(bgTimelineSec(reel(), {src: 'uploads/b.mp4', atSec: 2.5})).toBe(3.5);
    // どのカットにも入っていない
    expect(bgTimelineSec(reel(), {src: 'uploads/b.mp4', atSec: 5})).toBeNull();
  });

  it('動画の秒からそのコマを背景にする（切り出しはカットから）', () => {
    expect(bgAtTimelineSec(reel(), 0.5)).toEqual({src: 'uploads/a.mp4', atSec: 0.5});
    expect(bgAtTimelineSec(reel(), 3.5)).toEqual({src: 'uploads/b.mp4', atSec: 2.5, crop: {zoom: 1.5, x: 0.4, y: 0.5}});
  });

  it('倍速のカットは素材の秒に直す', () => {
    const r = reel({cuts: [{src: 'uploads/a.mp4', inSec: 0, outSec: 4, playbackRate: 2}]});
    expect(bgAtTimelineSec(r, 1)).toEqual({src: 'uploads/a.mp4', atSec: 2});
    expect(bgTimelineSec(r, {src: 'uploads/a.mp4', atSec: 2})).toBe(1);
  });
});

describe('resolveThumbnail', () => {
  it('空欄は案件から埋め、英字は大文字にする', () => {
    const r = resolveThumbnail(reel({thumbnail: {en: 'osaka', title: ' '}}), brief({}));
    expect(r).toMatchObject({en: 'OSAKA', side: '大阪×北新地', title: '焼肉屋', bg: {src: 'uploads/a.mp4', atSec: 1}});
  });

  it('フォントは サムネ指定 → テロップ → 設定の既定。builtin なら同梱の明朝', () => {
    expect(resolveThumbnail(reel(), brief({}), 'set.ttf').font).toBe('set.ttf');
    expect(resolveThumbnail(reel({font: 'telop.otf'}), brief({}), 'set.ttf').font).toBe('telop.otf');
    expect(resolveThumbnail(reel({font: 'telop.otf', thumbnail: {font: 'thumb.ttf'}}), brief({}), 'set.ttf').font).toBe('thumb.ttf');
    expect(resolveThumbnail(reel({font: 'telop.otf', thumbnail: {font: THUMBNAIL_BUILTIN_FONT}}), brief({}), 'set.ttf').font).toBeUndefined();
  });

  it('手で決めた背景を使う', () => {
    const bg = {src: 'uploads/b.mp4', atSec: 2.5};
    expect(resolveThumbnail(reel({thumbnail: {bg}}), brief({})).bg).toEqual(bg);
  });

  it('cuts.json のスキーマが thumbnail を通す', () => {
    const parsed = ReelDataSchema.safeParse(reel({thumbnail: {en: 'OSAKA', side: '大阪×天満', title: '神コスパ寿司酒場', bg: {src: 'uploads/a.mp4', atSec: 1}}}));
    expect(parsed.success).toBe(true);
    expect(ReelDataSchema.safeParse({...reel(), thumbnail: {bg: {src: 'uploads/a.mp4', atSec: -1}}}).success).toBe(false);
  });
});
