import {describe, expect, it} from 'vitest';
import {applyReadingHints, checkNarration, fixNarrationOverlaps, OVERLAP_TOLERANCE_SEC, ttsReadingHints} from '../shared/narration';
import {ttsBody} from '../core/tts';
import type {Narration, NarrationSegment} from '../shared/schema/narration';

const narr = (segments: NarrationSegment[], videoSec?: number): Narration => ({voice: 'v', videoSec, segments});
const est = (s: NarrationSegment) => [...s.text].length / 11;

describe('checkNarration', () => {
  it('前後の無音ぶんの重なりは警告しない', () => {
    // Fish Audio の wav は前後に 0.09 秒ほど無音が付くので、durSec 基準で 0.12 秒重なっても実際は鳴らない
    const n = narr([
      {id: 'a', at: 0, durSec: 1.6, text: 'あああ'},
      {id: 'b', at: 1.48, durSec: 1.19, text: 'いいい'},
    ]);
    expect(checkNarration(n, {estimate: est})).toEqual([]);
  });

  it('無音ぶんを超えて重なったら警告する', () => {
    const n = narr([
      {id: 'a', at: 0, durSec: 1.6, text: 'あああ'},
      {id: 'b', at: 1.6 - OVERLAP_TOLERANCE_SEC - 0.05, durSec: 1, text: 'いいい'},
    ]);
    expect(checkNarration(n, {estimate: est})).toHaveLength(1);
    expect(checkNarration(n, {estimate: est})[0]).toContain('重なります');
  });

  it('2 秒以上の空きを無音として指摘する', () => {
    const n = narr([
      {id: 'a', at: 0, durSec: 1, text: 'あ'},
      {id: 'b', at: 3.2, durSec: 1, text: 'い'},
    ]);
    expect(checkNarration(n, {estimate: est})[0]).toContain('無音');
  });

  it('動画尺をはみ出したら指摘する', () => {
    const n = narr([{id: 'a', at: 9, durSec: 2, text: 'あ'}], 10);
    expect(checkNarration(n, {estimate: est})[0]).toContain('はみ出します');
  });

  it('durSec が無いブロックは文字数から見積もる', () => {
    // 22 文字 ÷ 11 = 2 秒 → 0 秒開始で終端 2.0。次が 1.5 開始なら 0.5 秒重なる
    const n = narr([
      {id: 'a', at: 0, text: 'あ'.repeat(22)},
      {id: 'b', at: 1.5, text: 'い'},
    ]);
    expect(checkNarration(n, {estimate: est})[0]).toContain('0.50 秒重なります');
  });

  it('emptyText を付けたときだけ空の本文を指摘する', () => {
    const n = narr([{id: 'a', at: 0, durSec: 1, text: '  '}]);
    expect(checkNarration(n, {estimate: est})).toEqual([]);
    expect(checkNarration(n, {estimate: est, emptyText: true})[0]).toContain('本文が空');
  });
});

describe('ttsBody', () => {
  it('narration-tts.md §2 の固定パラメータで組み立てる', () => {
    const b = ttsBody('てすと', 'voice-id', 1.6, 'normal');
    expect(b.format).toBe('wav');
    expect(b.latency).toBe('normal');
    expect(b.reference_id).toBe('voice-id');
    // 話速は prosody に入れる（MCP パッケージと同じ経路）
    expect(b.prosody).toEqual({speed: 1.6, volume: 0});
    // wav に sample_rate を渡すと 400 になるので、キー自体を作らない
    expect('sample_rate' in b).toBe(false);
  });
});

describe('ttsReadingHints — TTS が誤読しやすい表記', () => {
  it('「牛すじ」は「ぎゅうすじ」に開くよう指摘する（焼肉伍龍で「うしすじ」と読まれた実例）', () => {
    expect(ttsReadingHints('お通しの牛すじが食べ放題')).toEqual([{from: '牛すじ', to: 'ぎゅうすじ'}]);
  });

  it('長い語を先に拾い、含まれる短い語で二重に指摘しない。順番は本文に出てくる順', () => {
    const h = ttsReadingHints('大盛りの黒毛和牛');
    expect(h.map((x) => x.from)).toEqual(['大盛り', '黒毛和牛']);
  });

  it('数字＋単位記号はカタカナの単位にする', () => {
    expect(ttsReadingHints('肉は350g、ビールは500ml')).toEqual([
      {from: '350g', to: '350グラム'},
      {from: '500ml', to: '500ミリリットル'},
    ]);
  });

  it('かな書き・辞書に無い語は指摘しない', () => {
    expect(ttsReadingHints('お通しのぎゅうすじが食べ放題')).toEqual([]);
    expect(ttsReadingHints('とろける脂で箸が止まらない')).toEqual([]);
  });

  it('applyReadingHints は指摘どおりに開く', () => {
    expect(applyReadingHints('お通しの牛すじが食べ放題')).toBe('お通しのぎゅうすじが食べ放題');
    expect(applyReadingHints('生ビール 500ml')).toBe('なまビール 500ミリリットル');
  });

  it('checkNarration の警告に載る', () => {
    const n = narr([{id: 'a', at: 0, text: '牛タンが旨い', durSec: 1}]);
    const out = checkNarration(n, {estimate: est});
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('a: TTS が誤読しやすい表記');
    expect(out[0]).toContain('「牛タン」→「ぎゅうタン」');
  });
});

describe('fixNarrationOverlaps — 重なりの自動調整', () => {
  const seg = (id: string, at: number, durSec: number): NarrationSegment => ({id, at, durSec, text: 'よみ'});

  it('重なっているブロックを後ろにずらす（音声はそのまま使える）', () => {
    // 01 は 0.00〜3.17。02 が 2.42 開始で 0.75 秒重なる
    const n = narr([seg('01_intro', 0, 3.17), seg('02_shokushitsu', 2.42, 1.5)]);
    const r = fixNarrationOverlaps(n, {estimate: est});
    expect(r.moved).toEqual([{id: '02_shokushitsu', from: 2.42, to: 3.02}]); // 3.17 - 0.15（無音ぶん）
    expect(checkNarration({...n, segments: r.segments}, {estimate: est}).filter((m) => m.includes('重なります'))).toEqual([]);
  });

  it('前には動かさない（映像と合わなくなるため）', () => {
    const n = narr([seg('01', 0, 1.0), seg('02', 5.0, 1.0)]);
    const r = fixNarrationOverlaps(n, {estimate: est});
    expect(r.moved).toEqual([]);
    expect(r.segments[1].at).toBe(5.0);
  });

  it('連鎖する重なりも順に押し出す', () => {
    const n = narr([seg('01', 0, 2), seg('02', 1, 2), seg('03', 1.5, 2)]);
    const r = fixNarrationOverlaps(n, {estimate: est});
    expect(r.segments.map((x) => x.at)).toEqual([0, 1.85, 3.7]);
    expect(r.moved).toHaveLength(2);
  });

  it('動画尺に収まらないぶんは報告するだけ（勝手に削らない）', () => {
    const n = narr([seg('01', 0, 5), seg('02', 1, 5)], 8);
    const r = fixNarrationOverlaps(n, {estimate: est});
    expect(r.overrunSec).toBeCloseTo(1.85); // 4.85 + 5 = 9.85 > 8
    expect(r.notes.join()).toContain('文を短くする');
    expect(r.segments).toHaveLength(2); // 消していない
  });

  it('1 秒以上ずれたブロックは確認を促す', () => {
    const n = narr([seg('01', 0, 4), seg('02', 0.5, 1)]);
    expect(fixNarrationOverlaps(n, {estimate: est}).notes.join()).toContain('映像が合っているか確認');
  });

  it('直すものが無ければ何も動かさない', () => {
    const n = narr([seg('01', 0, 1), seg('02', 1.2, 1)]);
    const r = fixNarrationOverlaps(n, {estimate: est});
    expect(r.moved).toEqual([]);
    expect(r.notes[0]).toContain('動かす必要のあるブロックはありません');
  });

  it('durSec が無いブロックは文字数からの見積もりで詰める', () => {
    const n = narr([{id: '01', at: 0, text: 'あ'.repeat(22)}, {id: '02', at: 0.5, text: 'い'}]);
    const r = fixNarrationOverlaps(n, {estimate: est}); // 22字 / 11 = 2 秒
    expect(r.segments[1].at).toBeCloseTo(1.85);
  });
});
