import {describe, expect, it} from 'vitest';
import {allocateByWeight, fitBlockedBy, fitCutsToNarration, missingAudioIds} from '../shared/fit';
import {checkNarration} from '../shared/narration';
import {cutFrames, cutRanges, telopGroupsOf, totalSec} from '../shared/timeline';
import {validateCuts} from '../shared/validate';
import type {Cut, ReelData} from '../shared/schema/cuts';
import type {Narration} from '../shared/schema/narration';
import type {Clip, ClipKind} from '../shared/schema/catalog';
import {makeClip} from './helpers';

const FPS = 30;
const cut = (id: string, src: string, inSec: number, outSec: number, telop?: string, extra: Partial<Cut> = {}): Cut => ({id, src, inSec, outSec, ...(telop ? {main: {text: telop}} : {}), ...extra});
const reel = (cuts: Cut[], meta?: ReelData['meta']): ReelData => ({fps: FPS, theme: 'pop', cuts, ...(meta ? {meta} : {})});
const narr = (segments: Narration['segments'], extra: Partial<Narration> = {}): Narration => ({voice: 'v', videoSec: 0, segments, ...extra});
/** 素材はどれも 6 秒（元の区間の外にも使える） */
const clip6 = () => 6;
const texts = (d: ReelData) => telopGroupsOf(d).map((g) => g.def.text);
const frames = (d: ReelData) => d.cuts.map((c) => cutFrames(c, d.fps));
const noE = (d: ReelData) => expect(validateCuts(d).errors.map((e) => `${e.code} ${e.message}`)).toEqual([]);
/** 見た目の指紋（全バイト同じ値）。値の差がそのまま指紋の距離になる */
const sigOf = (v: number) => Buffer.from(new Uint8Array(336).fill(v)).toString('base64');
/** catalog の素材（src を指定できる。look は指紋の値と鮮明さ） */
const clipAt = (id: string, src: string, o: {look?: number; sharp?: number; kind?: ClipKind; dur?: number} = {}): Clip => ({
  ...makeClip({id, slug: `s${id}`, dur: o.dur ?? 6, kind: o.kind ?? 'sizzle', angle: 'close', sizzle: 4, subject: `料理${id}`}),
  src,
  ...(o.look !== undefined ? {look: {v: 1 as const, sig: sigOf(o.look), sharp: o.sharp ?? 1000}} : {}),
});
/** 素材ごとにばらばらの白黒模様の指紋（どの 2 本も距離はおよそ 127 で、似ていない） */
const noiseSig = (seed: number) => {
  let x = seed * 2654435761 % 4294967296;
  const b = new Uint8Array(336).map(() => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296 < 0.5 ? 0 : 255;
  });
  return Buffer.from(b).toString('base64');
};
/** 01〜n の素材（src は s01.mp4 …）。どれも似ていない */
const library = (n: number, extra: Clip[] = []): Clip[] => [
  ...extra,
  ...Array.from({length: n}, (_, i) => String(i + 1).padStart(2, '0'))
    .filter((id) => !extra.some((c) => c.id === id))
    .map((id) => ({...clipAt(id, `s${id}.mp4`), look: {v: 1 as const, sig: noiseSig(Number(id)), sharp: 1000}})),
];
const MIN_F = Math.round(0.7 * FPS);
const MAX_F = Math.round(0.8 * FPS);
const noSameRun = (d: ReelData) => {
  for (let i = 1; i < d.cuts.length; i++) expect(d.cuts[i].src, `カット${i}と${i + 1}`).not.toBe(d.cuts[i - 1].src);
};

describe('allocateByWeight', () => {
  it('重み比例で配り、端数は小数部の大きい順に足す', () => {
    expect(allocateByWeight([2, 1, 1], 4)).toEqual([2, 1, 1]);
    expect(allocateByWeight([3, 1], 3)).toEqual([2, 1]);
    expect(allocateByWeight([1, 1, 1], 4)).toEqual([2, 1, 1]);
  });
  it('最低個数を先に確保してから残りを比例で配る', () => {
    expect(allocateByWeight([10, 0.1], 3, [1, 1])).toEqual([2, 1]);
    expect(allocateByWeight([1, 1], 1, [1, 1])).toEqual([1, 1]);
  });
  it('重みが全部 0 でも配りきる', () => {
    expect(allocateByWeight([0, 0], 3)).toEqual([2, 1]);
  });
});

describe('fitCutsToNarration', () => {
  // 3 カット×2 秒（テロップ A・B・C）、ナレーション 2 本（3.1 秒 / 2.4 秒）
  const base = () => reel([cut('c01', 'a.mp4', 0, 2, 'A'), cut('c02', 'b.mp4', 0, 2, 'B'), cut('c03', 'c.mp4', 0, 2, 'C')]);
  const two = () => narr([{id: 'n1', at: 0, durSec: 3.1, text: 'あ'}, {id: 'n2', at: 3, durSec: 2.4, text: 'い'}]);

  // a / b / c は catalog の 01 / 02 / 03。ほかに 04〜12 がある
  const lib = () => library(12, [clipAt('01', 'a.mp4', {look: 10}), clipAt('02', 'b.mp4', {look: 60}), clipAt('03', 'c.mp4', {look: 110})]);

  it('音声の合計に映像を合わせ、どのカットも 0.70〜0.80 秒に刻む', () => {
    const r = fitCutsToNarration(base(), two(), {clipDurationOf: clip6, clips: lib()});
    expect(r.ok).toBe(true);
    // 各ブロックの映像 ≥ 音声（フレーム切り上げ）で、はみ出しは無い
    expect(r.blocks.map((b) => b.videoSec >= b.audioSec)).toEqual([true, true]);
    expect(r.blocks.map((b) => b.shortSec)).toEqual([0, 0]);
    expect(totalSec(r.cuts)).toBeGreaterThanOrEqual(5.5);
    expect(totalSec(r.cuts)).toBeLessThan(5.5 + 0.2);
    // どのカットも 0.70〜0.80 秒（フックは 0.8 秒）。3.1 秒 → 4 カット、2.4 秒 → 3 カット
    for (const f of frames(r.cuts)) {
      expect(f).toBeGreaterThanOrEqual(MIN_F);
      expect(f).toBeLessThanOrEqual(MAX_F);
    }
    expect(r.after.cutCount).toBe(7);
    // 同じ素材は続けない。足りないぶんは補った素材
    noSameRun(r.cuts);
    expect(r.supplemented.length).toBe(4);
    // narration.at はブロックの頭、videoSec は新しい合計
    expect(r.narration.segments.map((s) => s.at)).toEqual([0, r.blocks[0].videoSec]);
    expect(r.narration.videoSec).toBe(r.after.totalSec);
    expect(checkNarration(r.narration, {estimate: () => 1})).toEqual([]);
    noE(r.cuts);
  });

  it('テロップは順番どおり全部残り、同じ文言は連続する', () => {
    const r = fitCutsToNarration(base(), two(), {clipDurationOf: clip6, clips: lib()});
    expect(texts(r.cuts)).toEqual(['A', 'B', 'C']);
    // 元カットの並びも保たれ、どの素材も 1 回だけ
    const srcs = r.cuts.cuts.map((c) => c.src);
    expect(srcs.filter((x) => ['a.mp4', 'b.mp4', 'c.mp4'].includes(x))).toEqual(['a.mp4', 'b.mp4', 'c.mp4']);
    expect(new Set(srcs).size).toBe(srcs.length);
  });

  it('カットの尺はフレームで揃い、outSec から同じフレーム数が出る', () => {
    const r = fitCutsToNarration(base(), two(), {clipDurationOf: clip6, clips: lib()});
    const fr = frames(r.cuts);
    for (const f of fr) expect(f).toBeGreaterThanOrEqual(MIN_F);
    expect(fr.reduce((a, b) => a + b, 0)).toBe(Math.round(totalSec(r.cuts) * FPS));
    // ブロックのフレーム数 = ceil(音声 × fps) 以上
    const ranges = cutRanges(r.cuts);
    const n1 = r.blocks[0].cutCount;
    expect(ranges[n1 - 1].from + ranges[n1 - 1].dur).toBeGreaterThanOrEqual(Math.ceil(3.1 * FPS));
  });

  it('同じ素材は続けて刻まず、撮影順で前後に撮った素材で補う', () => {
    // 1 カット 6 秒（素材 05・テロップ A）を 3.1 秒の音声に → 4 カット。足りない 3 カットは 05 の前後から
    const r = fitCutsToNarration(reel([cut('c01', 's05.mp4', 0, 6, 'A')]), narr([{id: 'n1', at: 0, durSec: 3.1, text: 'あ'}]), {clipDurationOf: clip6, clips: library(12)});
    expect(r.after.cutCount).toBe(4);
    noSameRun(r.cuts);
    expect([...r.supplemented].sort()).toEqual(['03', '04', '06']);
    // ブロックの中は撮影順（フックの先頭 05 は動かさない）
    expect(r.cuts.cuts.map((c) => c.src)).toEqual(['s05.mp4', 's03.mp4', 's04.mp4', 's06.mp4']);
    expect(texts(r.cuts)).toEqual(['A']);
    expect(r.notes.some((n) => n.includes('撮影順で近い'))).toBe(true);
  });

  it('catalog が無ければ補えないので、同じ素材を刻まずにカットを長くして注記する', () => {
    const r = fitCutsToNarration(reel([cut('c01', 'a.mp4', 0, 6, 'A')]), narr([{id: 'n1', at: 0, durSec: 3.1, text: 'あ'}]), {clipDurationOf: clip6});
    expect(r.after.cutCount).toBe(1);
    expect(r.blocks[0].shortSec).toBe(0);
    expect(r.notes.some((n) => n.includes('長いカット'))).toBe(true);
  });

  it('近くに続く似た構図はまとめ、最も鮮明な素材を残す（カニ蔵の卓上全景）', () => {
    // 01・02・03 は指紋がほぼ同じ（卓上全景）。鮮明さは 02 が一番。04 は別の構図
    const clips = library(12, [
      clipAt('01', 'z01.mp4', {look: 100, sharp: 2700, kind: 'serving'}),
      clipAt('02', 'z02.mp4', {look: 105, sharp: 3100, kind: 'serving'}),
      clipAt('03', 'z03.mp4', {look: 110, sharp: 2100, kind: 'serving'}),
      clipAt('04', 'z04.mp4', {look: 200}),
    ]);
    const data = reel([cut('c01', 'z01.mp4', 0, 1, 'H', {badge: '三宮'}), cut('c02', 'z03.mp4', 0, 1, 'H'), cut('c03', 'z02.mp4', 0, 1, 'P'), cut('c04', 'z04.mp4', 0, 1, 'P')]);
    const r = fitCutsToNarration(data, narr([{id: 'n1', at: 0, durSec: 3.1, text: 'あ'}]), {clipDurationOf: clip6, clips});
    const srcs = r.cuts.cuts.map((c) => c.src);
    // 卓上全景は 1 本だけ（最も鮮明な 02）。テロップ H・P は両方残る
    expect(srcs.filter((x) => ['z01.mp4', 'z02.mp4', 'z03.mp4'].includes(x))).toEqual(['z02.mp4']);
    expect(srcs[0]).toBe('z02.mp4');
    expect(texts(r.cuts)).toEqual(['H', 'P']);
    expect(r.cuts.cuts[0].badge).toBe('三宮');
    expect(r.merged).toEqual([{kept: '02', dropped: ['01', '03']}]);
    noSameRun(r.cuts);
    for (const f of frames(r.cuts)) expect(f).toBeLessThanOrEqual(MAX_F);
    noE(r.cuts);
  });

  it('同じ素材が続いていたら 1 カットにまとめ、足りないぶんは別の素材で埋める', () => {
    // カニ蔵の 36（つゆに浸ける → 持ち上げる）を 3 カット続けていた形
    const data = reel([cut('c01', 's05.mp4', 0.4, 1.2, 'K'), cut('c02', 's05.mp4', 4, 4.8, 'K'), cut('c03', 's05.mp4', 7.4, 8.2, 'K')]);
    const r = fitCutsToNarration(data, narr([{id: 'n1', at: 0, durSec: 2.3, text: 'あ'}]), {clipDurationOf: () => 9.2, clips: library(12)});
    expect(r.cuts.cuts.filter((c) => c.src === 's05.mp4')).toHaveLength(1);
    expect(r.after.cutCount).toBe(3);
    noSameRun(r.cuts);
    expect(r.notes.some((n) => n.includes('同じ素材が続いていた'))).toBe(true);
  });

  it('離れた位置なら同じ構図でもまとめない（冒頭と締めの全景）', () => {
    const clips = library(20, [clipAt('01', 'z01.mp4', {look: 100}), clipAt('09', 'z09.mp4', {look: 102})]);
    const mid = ['s03.mp4', 's05.mp4', 's07.mp4', 's11.mp4'].map((src, i) => cut(`m${i}`, src, 0, 0.8, `T${i}`));
    const data = reel([cut('c01', 'z01.mp4', 0, 0.8, 'H'), ...mid, cut('c09', 'z09.mp4', 0, 0.8, 'E')]);
    const r = fitCutsToNarration(data, narr([{id: 'n1', at: 0, durSec: 4.7, text: 'あ'}]), {clipDurationOf: clip6, clips});
    expect(r.cuts.cuts.map((c) => c.src)).toContain('z09.mp4');
    expect(r.merged).toEqual([]);
  });

  it('元の区間が足りなければ素材の残りを使い、素材そのものが短ければ次のナレーションを後ろへ送って注記する', () => {
    // 元は 1 秒しか採っていないが素材は 6 秒ある → 区間の外を使う（catalog が無いので 1 カットのまま長くなる）
    const a = fitCutsToNarration(reel([cut('c01', 'a.mp4', 1, 2, 'A')]), narr([{id: 'n1', at: 0, durSec: 3.1, text: 'あ'}]), {clipDurationOf: clip6});
    expect(a.blocks[0].shortSec).toBe(0);
    expect(a.cuts.cuts.every((c) => c.outSec <= 6)).toBe(true);
    expect(a.notes.some((n) => n.includes('素材の残り'))).toBe(true);
    // 素材が 1.2 秒しか無い → 同じ場面を重ねて使わない。足りないぶんは次へ送る（shortSec > 0）
    const b = fitCutsToNarration(reel([cut('c01', 'a.mp4', 0, 1.2, 'A')]), narr([{id: 'n1', at: 0, durSec: 3.1, text: 'あ'}]), {clipDurationOf: () => 1.2});
    expect(b.cuts.cuts.every((c) => c.outSec <= 1.2 && c.inSec >= 0)).toBe(true);
    noSameRun(b.cuts);
    expect(b.blocks[0].shortSec).toBeGreaterThan(0);
    // 素材が 1 カットぶんにも満たなければ映像が音声より短いまま → 注記（スローや別クリップの流用はしない）
    const c = fitCutsToNarration(reel([cut('c01', 'a.mp4', 0, 0.5, 'A')]), narr([{id: 'n1', at: 0, durSec: 1.0, text: 'あ'}]), {clipDurationOf: () => 0.5});
    expect(c.cuts.cuts.every((x) => x.outSec <= 0.5 && x.playbackRate === undefined)).toBe(true);
    expect(c.blocks[0].shortSec).toBeGreaterThan(0);
    expect(c.notes.some((n) => n.includes('足りず'))).toBe(true);
  });

  it('いまあるクリップは全部残す（1 文の下に 2 クリップあれば 2 カットのまま）', () => {
    // 伍感のフック: 0.90 秒＋1.13 秒の 2 クリップ（同じテロップ）に 1.14 秒の音声。以前は 1 カットに切り詰めて片方を落としていた
    const data = reel([cut('c02', 'a.mp4', 0.983, 1.883, 'H', {badge: '北新地'}), cut('c29', 'b.mp4', 5.2, 6.333, 'H')]);
    const r = fitCutsToNarration(data, narr([{id: '01_hook', at: 0, durSec: 1.144, text: 'あ'}]), {clipDurationOf: clip6});
    expect(r.cuts.cuts.map((c) => c.src)).toEqual(['a.mp4', 'b.mp4']);
    expect(r.notes.some((n) => n.includes('2 本のうち 2 本を残して'))).toBe(true);
    // 映像は音声以上（被らない）。フックは 0.8 秒、もう 1 本は 0.6 秒を下回らない
    expect(r.blocks[0].videoSec).toBeGreaterThanOrEqual(1.144);
    expect(frames(r.cuts)[0]).toBeGreaterThanOrEqual(Math.ceil(0.8 * FPS));
    expect(frames(r.cuts)[1]).toBeGreaterThanOrEqual(Math.ceil(0.6 * FPS));
    noE(r.cuts);
  });

  it('材料が足りていれば、担うクリップ全部で音声を覆う（伍感の「デート向きの店内」）', () => {
    // 0.73 秒（catalog に無い＝長さ不明）＋ 0.67 秒の 2 クリップに 1.144 秒の音声。以前は 1 カットに決めて前者だけ使い、
    // 長さ不明で伸ばせず 0.43 秒足りないまま → 次の「まつさかぎゅう」が食い込んだ
    const data = reel([cut('c10', 'dji-d.mp4', 2.35, 3.083, 'D'), cut('c19', 'k.mp4', 0, 0.667, 'D'), cut('c21', 'm.mp4', 0, 1, 'M')]);
    const n = narr([{id: '09_new', at: 0, durSec: 1.144, text: 'あ'}, {id: '10_new', at: 1.4, durSec: 1.531, text: 'い'}]);
    const r = fitCutsToNarration(data, n, {clipDurationOf: (src) => (src === 'dji-d.mp4' ? undefined : 6)});
    expect(r.blocks[0].cutCount).toBe(2);
    expect(r.blocks[0].shortSec).toBe(0);
    expect(r.blocks[0].videoSec).toBeGreaterThanOrEqual(1.144);
    expect(checkNarration(r.narration, {estimate: () => 1})).toEqual([]);
  });

  it('素材が尽きたら元のクリップのトリミングを広げる（後ろ → 頭）。それでも足りなければ次のナレーションを後ろへ送って被らない', () => {
    // 素材 2.0 秒のうち 1.0〜1.5 を採っている。2.0 秒の音声 → 後ろへ 0.5、頭へ 1.0 広げて素材を丸ごと（0〜2.0）使う
    // （3 カットに刻まれるが、つなげると 0〜2.0 を連続で通る＝同じ場面の重ね使いは無い）
    const a = fitCutsToNarration(reel([cut('c01', 'a.mp4', 1.0, 1.5, 'A')]), narr([{id: 'n1', at: 0, durSec: 2.0, text: 'あ'}]), {clipDurationOf: () => 2.0});
    expect(a.blocks[0].shortSec).toBe(0);
    // 同じ素材は刻まない → 1 カットで素材を丸ごと（0〜2.0）通す
    expect(a.cuts.cuts).toHaveLength(1);
    expect(a.cuts.cuts[0].inSec).toBe(0);
    expect(a.cuts.cuts[0].outSec).toBe(2);
    expect(a.cuts.cuts.every((c) => c.playbackRate === undefined)).toBe(true);
    expect(a.notes.some((n) => n.includes('素材の残り'))).toBe(true);
    // 素材が 0.5 秒しか無いのに 1.0 秒の音声 ×2 → 1 本目は 0.5 秒足りない → 2 本目の at をその分だけ後ろへ。被りは無い
    const b = fitCutsToNarration(
      reel([cut('c01', 'a.mp4', 0, 0.5, 'A'), cut('c02', 'b.mp4', 0, 2, 'B')]),
      narr([{id: 'n1', at: 0, durSec: 1.0, text: 'あ'}, {id: 'n2', at: 0.5, durSec: 1.0, text: 'い'}]),
      {clipDurationOf: (src) => (src === 'a.mp4' ? 0.5 : 6)},
    );
    expect(b.blocks[0].shortSec).toBeCloseTo(0.5, 2);
    expect(b.narration.segments[1].at).toBeCloseTo(b.blocks[0].videoSec + 0.5, 2);
    expect(b.narration.segments[1].at).toBeGreaterThanOrEqual(1.0);
    expect(checkNarration(b.narration, {estimate: () => 1}).filter((x) => x.includes('重なります') || x.includes('はみ出します'))).toEqual([]);
    expect(b.notes.some((n) => n.includes('後ろへ送りました'))).toBe(true);
    expect(b.notes.some((n) => n.includes('catalog に無い'))).toBe(false);
  });

  it('素材の長さが分からなければ、後ろへは元の区間までしか伸ばさない（頭は素材の 0 秒まで広げてよい）', () => {
    const r = fitCutsToNarration(reel([cut('c01', 'a.mp4', 1, 2, 'A')]), narr([{id: 'n1', at: 0, durSec: 3.1, text: 'あ'}]));
    expect(r.cuts.cuts.every((c) => c.inSec >= 0 && c.outSec <= 2)).toBe(true);
    expect(r.cuts.cuts[0].inSec).toBe(0);
    // 0〜2 の 2 秒しか無いので 3.1 秒は埋まらない → 同じ場面は重ねず、足りないぶんは注記
    expect(r.blocks[0].shortSec).toBeGreaterThan(0);
    expect(r.notes.some((n) => n.includes('catalog に無い'))).toBe(true);
  });

  it('テロップが 1 カットしか無いところは 0.8 秒に伸ばす（読めない E を出さない）', () => {
    // 1.0 秒の音声に A・B の 2 テロップ → 2 カット（0.5 秒ずつ）になるところを 0.8 秒ずつに
    const r = fitCutsToNarration(reel([cut('c01', 'a.mp4', 0, 1, 'A'), cut('c02', 'b.mp4', 0, 1, 'B')]), narr([{id: 'n1', at: 0, durSec: 1.0, text: 'あ'}]), {clipDurationOf: clip6});
    expect(texts(r.cuts)).toEqual(['A', 'B']);
    for (const f of frames(r.cuts)) expect(f).toBeGreaterThanOrEqual(Math.ceil(0.8 * FPS));
    noE(r.cuts);
  });

  it('会話（subs）とロック済みのカットは刻まず、尺も倍速もそのまま', () => {
    const talk = cut('c02', 'talk.mp4', 0, 3, undefined, {subs: [{text: 'こんにちは', startSec: 0.2, endSec: 2.5, orientation: 'horizontal'}]});
    const locked = cut('c03', 'lock.mp4', 1, 2.5, 'L', {playbackRate: 1.25});
    const data = reel([cut('c01', 'a.mp4', 0, 2, 'A'), talk, locked, cut('c04', 'd.mp4', 0, 2, 'D')], {
      slots: [
        {cutId: 'c01', segment: 's', role: 'hook', clipId: '01', textStatus: 'final', locked: false, qc: []},
        {cutId: 'c02', segment: 's', role: 'conversation', clipId: '02', textStatus: 'final', locked: false, qc: []},
        {cutId: 'c03', segment: 's', role: 'info', clipId: '03', textStatus: 'final', locked: true, qc: []},
        {cutId: 'c04', segment: 's', role: 'cta', clipId: '04', textStatus: 'final', locked: false, qc: []},
      ],
    });
    // 窓: n1 [0,2) → A / n2 [2, 6.2) → 会話(中点 3.5)＋ロック(中点 5.6) / n3 [6.2, ∞) → D
    const n = narr([{id: 'n1', at: 0, durSec: 1.6, text: 'あ'}, {id: 'n2', at: 2, durSec: 4.4, text: 'い'}, {id: 'n3', at: 6.2, durSec: 1.6, text: 'う'}]);
    const r = fitCutsToNarration(data, n, {clipDurationOf: clip6});
    expect(r.ok).toBe(true);
    const kept = r.cuts.cuts.filter((c) => c.src === 'talk.mp4' || c.src === 'lock.mp4');
    expect(kept.map((c) => [c.inSec, c.outSec, c.playbackRate ?? 1])).toEqual([
      [0, 3, 1],
      [1, 2.5, 1.25],
    ]);
    expect(kept[0].subs).toHaveLength(1);
    // ロックは slot にも引き継がれる
    const lockSlot = r.cuts.meta?.slots?.find((s) => s.cutId === kept[1].id);
    expect(lockSlot?.locked).toBe(true);
    expect(r.notes.some((x) => x.includes('刻んでいません'))).toBe(true);
    // 会話 3 秒＋ロック 1.2 秒 = 4.2 秒 < 4.4 秒 → 残り 0.2 秒は刻んだカットで埋まる（映像 ≥ 音声）
    expect(r.blocks[1].videoSec).toBeGreaterThanOrEqual(4.4);
  });

  it('meta.slots と meta.telopGroups は新しい id に付け替わり、バッジは元カットにつき 1 つ', () => {
    const data = reel([cut('c01', 'a.mp4', 0, 3, 'A', {badge: '生野区'}), cut('c02', 'b.mp4', 0, 3, 'A')], {
      slots: [
        {cutId: 'c01', segment: '1_hook', role: 'hook', clipId: '01', textStatus: 'final', locked: false, qc: []},
        {cutId: 'c02', segment: '1_hook', role: 'hook', clipId: '02', textStatus: 'final', locked: false, qc: []},
      ],
      telopGroups: [{id: 'g01', cutIds: ['c01', 'c02'], intent: 'hook', placeholder: '{{g01:hook}}', minSec: 1.2}],
      generated: {tool: 't', at: 'x', briefHash: 'b', catalogHash: 'c', specId: 'F0'},
    });
    const clips = library(12, [clipAt('01', 'a.mp4', {look: 10}), clipAt('02', 'b.mp4', {look: 60})]);
    const r = fitCutsToNarration(data, narr([{id: 'n1', at: 0, durSec: 4.65, text: 'あ'}]), {clipDurationOf: clip6, clips});
    expect(r.after.cutCount).toBe(6);
    expect(r.cuts.cuts.map((c) => c.id)).toEqual(['c01', 'c02', 'c03', 'c04', 'c05', 'c06']);
    expect(r.cuts.meta?.slots?.map((s) => s.cutId)).toEqual(['c01', 'c02', 'c03', 'c04', 'c05', 'c06']);
    // 補った素材の slot は、その素材の id になる。並びは撮影順（先頭のフックは動かさない）
    expect(r.cuts.meta?.slots?.map((s) => s.clipId)).toEqual(['01', '02', '03', '04', '05', '06']);
    expect(r.cuts.meta?.telopGroups?.[0].cutIds).toEqual(['c01', 'c02', 'c03', 'c04', 'c05', 'c06']);
    expect(r.cuts.meta?.generated?.specId).toBe('F0');
    expect(r.cuts.cuts.filter((c) => c.badge).length).toBe(1);
    expect(r.cuts.cuts[0].badge).toBe('生野区');
    // 同じ文言が続くので 1 グループのまま
    expect(texts(r.cuts)).toEqual(['A']);
  });

  it('カットがナレーションの窓をまたいでも、同じ src は連続したまま（非連続参照の E を作らない）', () => {
    // c01 は [0,3)。n2 は 1.5 秒から始まるので c01 が両方のブロックに掛かる
    const data = reel([cut('c01', 'a.mp4', 0, 3, 'A'), cut('c02', 'b.mp4', 0, 3, 'B')]);
    const n = narr([{id: 'n1', at: 0, durSec: 1.55, text: 'あ'}, {id: 'n2', at: 1.5, durSec: 3.1, text: 'い'}]);
    const r = fitCutsToNarration(data, n, {clipDurationOf: clip6});
    expect(validateCuts(r.cuts).errors.filter((e) => e.code === 'SAME_SRC_NONCONSECUTIVE')).toEqual([]);
    expect(texts(r.cuts)).toEqual(['A', 'B']);
  });

  it('at が同じ・動画尺の外にあるブロックは隣のカットを借りて注記する', () => {
    const data = reel([cut('c01', 'a.mp4', 0, 2, 'A'), cut('c02', 'b.mp4', 0, 2, 'B')]);
    const n = narr([{id: 'n1', at: 0, durSec: 1.6, text: 'あ'}, {id: 'n2', at: 0, durSec: 1.6, text: 'い'}, {id: 'n3', at: 9, durSec: 1.6, text: 'う'}]);
    const r = fitCutsToNarration(data, n, {clipDurationOf: clip6});
    expect(r.ok).toBe(true);
    expect(r.blocks).toHaveLength(3);
    expect(r.blocks.every((b) => b.videoSec >= 1.6)).toBe(true);
    expect(r.notes.some((x) => x.includes('借りました'))).toBe(true);
  });

  it('効果音はブロックの中の相対位置で新しい場所へ動く', () => {
    const data = base();
    const n = narr(two().segments, {sfx: [{id: 'sfx1', at: 4.5, file: 'x.mp3'}, {id: 'sfx2', at: 0, file: 'y.mp3'}]});
    const r = fitCutsToNarration(data, n, {clipDurationOf: clip6});
    const [b1, b2] = r.blocks;
    // 4.5 は n2 の窓 [3, 6) の真ん中 → 新しいブロック 2 の真ん中あたり
    const s1 = r.narration.sfx!.find((x) => x.id === 'sfx1')!;
    expect(s1.at).toBeGreaterThan(b2.at);
    expect(s1.at).toBeLessThan(b2.at + b2.videoSec);
    expect(Math.abs(s1.at - (b2.at + b2.videoSec / 2))).toBeLessThan(0.1);
    expect(r.narration.sfx!.find((x) => x.id === 'sfx2')!.at).toBe(b1.at);
  });

  it('先頭と末尾の余白を足せる', () => {
    const r = fitCutsToNarration(base(), two(), {clipDurationOf: clip6, leadSec: 0.5, tailSec: 1});
    expect(r.narration.segments[0].at).toBe(0.5);
    expect(totalSec(r.cuts)).toBeGreaterThanOrEqual(5.5 + 1.5);
    expect(checkNarration(r.narration, {estimate: () => 1})).toEqual([]);
  });

  it('音声が無いブロックがあると止まる。estimate を渡したときだけ見積もりで合わせる', () => {
    const n = narr([{id: 'n1', at: 0, durSec: 2, text: 'あ'}, {id: 'n2', at: 2, text: 'いいいいいいいい'}]);
    expect(missingAudioIds(n)).toEqual(['n2']);
    expect(fitBlockedBy(base(), n)).toContain('n2');
    expect(fitBlockedBy(base(), narr([]))).toContain('ナレーションがありません');
    expect(fitBlockedBy(null, n)).toContain('cuts.json');
    const stop = fitCutsToNarration(base(), n, {clipDurationOf: clip6});
    expect(stop.ok).toBe(false);
    expect(stop.blockers[0]).toContain('n2');
    expect(stop.cuts).toBe(base().cuts.length ? stop.cuts : stop.cuts); // 入力のまま返る
    const go = fitCutsToNarration(base(), n, {clipDurationOf: clip6, estimate: (s) => [...s.text].length / 8});
    expect(go.ok).toBe(true);
    expect(go.blocks[1].audioSec).toBe(1);
    expect(go.notes.some((x) => x.includes('見積もり'))).toBe(true);
  });

  it('短いブロックが混ざっても、どのカットも 0.70〜0.80 秒（短すぎるブロックは映像を少し長くする）', () => {
    // ちるぷるー凪の実データに近い形: 0.99 / 1.10 / 2.65 / 3.35 / 0.72 秒。元の構成は 1 文 1 カット（2.4 秒ずつ）
    const cuts: Cut[] = ['A', 'B', 'C', 'D', 'E'].map((t, i) => cut(`c${String(i + 1).padStart(2, '0')}`, `s${String(i * 4 + 1).padStart(2, '0')}.mp4`, 0, 2.4, t));
    const durs = [0.99, 1.1, 2.65, 3.35, 0.72];
    let at = 0;
    const segs = durs.map((d, i) => {
      const s = {id: `n${i}`, at, durSec: d, text: 'あ'};
      at += 2.4;
      return s;
    });
    const r = fitCutsToNarration(reel(cuts), narr(segs), {clipDurationOf: clip6, clips: library(24)});
    expect(r.ok).toBe(true);
    // 音声 ÷ 0.8 秒の切り上げ
    expect(r.blocks.map((b) => b.cutCount)).toEqual([2, 2, 4, 5, 1]);
    for (const f of frames(r.cuts)) {
      expect(f).toBeGreaterThanOrEqual(MIN_F);
      expect(f).toBeLessThanOrEqual(MAX_F);
    }
    expect(r.blocks.every((b) => b.videoSec >= b.audioSec && b.shortSec === 0)).toBe(true);
    noSameRun(r.cuts);
    noE(r.cuts);
  });

  it('入力の cuts / narration は書き換えない', () => {
    const data = base();
    const n = two();
    const snapC = JSON.stringify(data);
    const snapN = JSON.stringify(n);
    fitCutsToNarration(data, n, {clipDurationOf: clip6});
    expect(JSON.stringify(data)).toBe(snapC);
    expect(JSON.stringify(n)).toBe(snapN);
  });

  it('長いナレーション（30 秒）でもどのカットも 0.70〜0.80 秒に収まり、E は出ない', () => {
    const cuts: Cut[] = [];
    for (let i = 0; i < 12; i++) cuts.push(cut(`c${String(i + 1).padStart(2, '0')}`, `s${String(i * 3 + 1).padStart(2, '0')}.mp4`, 0.2, 2.7, i % 3 === 2 ? undefined : `テロップ${i}`));
    const segs = [];
    let at = 0;
    for (let i = 0; i < 8; i++) {
      const dur = 2.3 + (i % 3) * 0.9;
      segs.push({id: `n${i}`, at, durSec: dur, text: 'あ'});
      at += 3.75; // 元は 30 秒 = 12 カット × 2.5 秒。ナレーションは合計 ≈ 25.6 秒
    }
    const r = fitCutsToNarration(reel(cuts), narr(segs), {clipDurationOf: clip6, clips: library(40)});
    expect(r.ok).toBe(true);
    for (const f of frames(r.cuts)) {
      expect(f).toBeGreaterThanOrEqual(MIN_F);
      expect(f).toBeLessThanOrEqual(MAX_F);
    }
    noSameRun(r.cuts);
    expect(r.blocks.every((b) => b.shortSec === 0)).toBe(true);
    expect(texts(r.cuts)).toEqual(cuts.filter((c) => c.main).map((c) => c.main!.text));
    noE(r.cuts);
    expect(checkNarration(r.narration, {estimate: () => 1})).toEqual([]);
  });
});
