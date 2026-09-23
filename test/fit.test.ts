import {describe, expect, it} from 'vitest';
import {allocateByWeight, fitBlockedBy, fitCutsToNarration, missingAudioIds} from '../shared/fit';
import {checkNarration} from '../shared/narration';
import {cutFrames, cutRanges, telopGroupsOf, totalSec} from '../shared/timeline';
import {validateCuts} from '../shared/validate';
import type {Cut, ReelData} from '../shared/schema/cuts';
import type {Narration} from '../shared/schema/narration';

const FPS = 30;
const cut = (id: string, src: string, inSec: number, outSec: number, telop?: string, extra: Partial<Cut> = {}): Cut => ({id, src, inSec, outSec, ...(telop ? {main: {text: telop}} : {}), ...extra});
const reel = (cuts: Cut[], meta?: ReelData['meta']): ReelData => ({fps: FPS, theme: 'pop', cuts, ...(meta ? {meta} : {})});
const narr = (segments: Narration['segments'], extra: Partial<Narration> = {}): Narration => ({voice: 'v', videoSec: 0, segments, ...extra});
/** 素材はどれも 6 秒（元の区間の外にも使える） */
const clip6 = () => 6;
const texts = (d: ReelData) => telopGroupsOf(d).map((g) => g.def.text);
const frames = (d: ReelData) => d.cuts.map((c) => cutFrames(c, d.fps));
const noE = (d: ReelData) => expect(validateCuts(d).errors.map((e) => `${e.code} ${e.message}`)).toEqual([]);

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

  it('音声の合計に映像を合わせ、0.75〜0.8 秒のカットに刻む', () => {
    const r = fitCutsToNarration(base(), two(), {clipDurationOf: clip6});
    expect(r.ok).toBe(true);
    // 各ブロックの映像 ≥ 音声（フレーム切り上げ）で、はみ出しは無い
    expect(r.blocks.map((b) => b.videoSec >= b.audioSec)).toEqual([true, true]);
    expect(r.blocks.map((b) => b.shortSec)).toEqual([0, 0]);
    expect(totalSec(r.cuts)).toBeGreaterThanOrEqual(5.5);
    expect(totalSec(r.cuts)).toBeLessThan(5.5 + 0.2);
    // 平均は目標の範囲
    expect(r.after.avgCutSec).toBeGreaterThanOrEqual(0.75);
    expect(r.after.avgCutSec).toBeLessThanOrEqual(0.8);
    expect(r.after.cutCount).toBe(7);
    // narration.at はブロックの頭、videoSec は新しい合計
    expect(r.narration.segments.map((s) => s.at)).toEqual([0, r.blocks[0].videoSec]);
    expect(r.narration.videoSec).toBe(r.after.totalSec);
    expect(checkNarration(r.narration, {estimate: () => 1})).toEqual([]);
    noE(r.cuts);
  });

  it('テロップは順番どおり全部残り、同じ文言は連続する', () => {
    const r = fitCutsToNarration(base(), two(), {clipDurationOf: clip6});
    expect(texts(r.cuts)).toEqual(['A', 'B', 'C']);
    // 元カットの並びも保たれる（同じ src は連続でしか現れない）
    const srcs = r.cuts.cuts.map((c) => c.src);
    expect([...new Set(srcs)]).toEqual(['a.mp4', 'b.mp4', 'c.mp4']);
  });

  it('カットの尺はフレームで揃い、outSec から同じフレーム数が出る', () => {
    const r = fitCutsToNarration(base(), two(), {clipDurationOf: clip6});
    const fr = frames(r.cuts);
    for (const f of fr) expect(f).toBeGreaterThanOrEqual(Math.ceil(0.6 * FPS));
    expect(fr.reduce((a, b) => a + b, 0)).toBe(Math.round(totalSec(r.cuts) * FPS));
    // ブロックのフレーム数 = ceil(音声 × fps) 以上
    const ranges = cutRanges(r.cuts);
    const n1 = r.blocks[0].cutCount;
    expect(ranges[n1 - 1].from + ranges[n1 - 1].dur).toBeGreaterThanOrEqual(Math.ceil(3.1 * FPS));
  });

  it('同じ素材から複数取るときは場所をずらす（ジャンプカット）', () => {
    // 1 カット 6 秒（テロップ A）を 3.1 秒の音声に → 4 カット。素材の中で in がずれていく
    const r = fitCutsToNarration(reel([cut('c01', 'a.mp4', 0, 6, 'A')]), narr([{id: 'n1', at: 0, durSec: 3.1, text: 'あ'}]), {clipDurationOf: clip6});
    expect(r.after.cutCount).toBe(4);
    const ins = r.cuts.cuts.map((c) => c.inSec);
    for (let i = 1; i < ins.length; i++) expect(ins[i]).toBeGreaterThan(r.cuts.cuts[i - 1].outSec);
    expect(r.notes.some((n) => n.includes('ジャンプカット'))).toBe(true);
    expect(texts(r.cuts)).toEqual(['A']);
  });

  it('元の区間が足りなければ素材の残りを使い、素材そのものが短ければ重ねて使って注記する', () => {
    // 元は 1 秒しか採っていないが素材は 6 秒ある → 区間の外を使う
    const a = fitCutsToNarration(reel([cut('c01', 'a.mp4', 1, 2, 'A')]), narr([{id: 'n1', at: 0, durSec: 3.1, text: 'あ'}]), {clipDurationOf: clip6});
    expect(a.blocks[0].shortSec).toBe(0);
    expect(a.cuts.cuts.every((c) => c.outSec <= 6)).toBe(true);
    expect(a.notes.some((n) => n.includes('素材の残り'))).toBe(true);
    // 素材が 1.2 秒しか無い → 重ねて使う。それでも音声ぶんは埋まらない（shortSec > 0）
    const b = fitCutsToNarration(reel([cut('c01', 'a.mp4', 0, 1.2, 'A')]), narr([{id: 'n1', at: 0, durSec: 3.1, text: 'あ'}]), {clipDurationOf: () => 1.2});
    expect(b.cuts.cuts.every((c) => c.outSec <= 1.2 && c.inSec >= 0)).toBe(true);
    expect(b.notes.some((n) => n.includes('重ねて使った'))).toBe(true);
    // 重ねて使えば時間は埋まる（同じ場面が繰り返るだけ）
    expect(b.blocks[0].shortSec).toBe(0);
    // 素材が 1 カットぶん（0.8 秒）にも満たなければ映像が音声より短いまま → 注記（スローや別クリップの流用はしない）
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
    expect(a.cuts.cuts[0].inSec).toBe(0);
    expect(a.cuts.cuts[a.cuts.cuts.length - 1].outSec).toBe(2);
    for (let i = 1; i < a.cuts.cuts.length; i++) expect(a.cuts.cuts[i].inSec).toBeCloseTo(a.cuts.cuts[i - 1].outSec, 2);
    expect(a.cuts.cuts.every((c) => c.playbackRate === undefined)).toBe(true);
    expect(a.notes.some((n) => n.includes('重ねて使った'))).toBe(false);
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
    // 0〜2 の 2 秒しか無いので 3.1 秒は埋まらない → 重ねて使い、それでも足りないぶんは注記
    expect(r.notes.some((n) => n.includes('重ねて使った'))).toBe(true);
  });

  it('テロップが 1 カットしか無いところは 0.8 秒に伸ばす（読めない E を出さない）', () => {
    // 1.0 秒の音声に A・B の 2 テロップ → 2 カット（0.5 秒ずつ）になるところを 0.8 秒ずつに
    const r = fitCutsToNarration(reel([cut('c01', 'a.mp4', 0, 1, 'A'), cut('c02', 'b.mp4', 0, 1, 'B')]), narr([{id: 'n1', at: 0, durSec: 1.0, text: 'あ'}]), {clipDurationOf: clip6});
    expect(texts(r.cuts)).toEqual(['A', 'B']);
    for (const f of frames(r.cuts)) expect(f).toBeGreaterThanOrEqual(Math.ceil(0.8 * FPS));
    expect(r.notes.some((n) => n.includes('0.8 秒に伸ばして'))).toBe(true);
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
    const r = fitCutsToNarration(data, narr([{id: 'n1', at: 0, durSec: 4.65, text: 'あ'}]), {clipDurationOf: clip6});
    expect(r.after.cutCount).toBe(6);
    expect(r.cuts.cuts.map((c) => c.id)).toEqual(['c01', 'c02', 'c03', 'c04', 'c05', 'c06']);
    expect(r.cuts.meta?.slots?.map((s) => s.cutId)).toEqual(['c01', 'c02', 'c03', 'c04', 'c05', 'c06']);
    expect(r.cuts.meta?.slots?.map((s) => s.clipId)).toEqual(['01', '01', '01', '02', '02', '02']);
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

  it('短いブロックが混ざっても、長いブロックで刻み方を調整して全体の平均を 0.75〜0.8 秒に寄せる', () => {
    // ちるぷるー凪の実データに近い形: 0.99 / 1.10 / 2.65 / 3.35 / 0.72 秒。ブロック単位の丸めだけだと
    // 1+1+3+4+1 = 10 カットで平均 0.88 秒。3.35 秒のブロックを 5 カット（0.67 秒）にすると 11 カットで 0.80 秒
    // 元の構成は 1 文 1 カット（2.4 秒ずつ・テロップ 1 つずつ）で、ナレーションの窓と揃っている
    const cuts: Cut[] = ['A', 'B', 'C', 'D', 'E'].map((t, i) => cut(`c${String(i + 1).padStart(2, '0')}`, `s${i}.mp4`, 0, 2.4, t));
    const durs = [0.99, 1.1, 2.65, 3.35, 0.72];
    let at = 0;
    const segs = durs.map((d, i) => {
      const s = {id: `n${i}`, at, durSec: d, text: 'あ'};
      at += 2.4;
      return s;
    });
    const r = fitCutsToNarration(reel(cuts), narr(segs), {clipDurationOf: clip6});
    expect(r.ok).toBe(true);
    expect(r.after.avgCutSec).toBeGreaterThanOrEqual(0.75);
    expect(r.after.avgCutSec).toBeLessThanOrEqual(0.82); // 0.8 秒の最低表示で少しだけ超えることがある
    expect(r.blocks.map((b) => b.cutCount)).toEqual([1, 1, 3, 5, 1]);
    // 0.6 秒未満のカットは作らない
    for (const f of frames(r.cuts)) expect(f).toBeGreaterThanOrEqual(Math.ceil(0.6 * FPS));
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

  it('長いナレーション（30 秒）でも平均は 0.75〜0.8 秒に収まり、E は出ない', () => {
    const cuts: Cut[] = [];
    for (let i = 0; i < 12; i++) cuts.push(cut(`c${String(i + 1).padStart(2, '0')}`, `s${i}.mp4`, 0.2, 2.7, i % 3 === 2 ? undefined : `テロップ${i}`));
    const segs = [];
    let at = 0;
    for (let i = 0; i < 8; i++) {
      const dur = 2.3 + (i % 3) * 0.9;
      segs.push({id: `n${i}`, at, durSec: dur, text: 'あ'});
      at += 3.75; // 元は 30 秒 = 12 カット × 2.5 秒。ナレーションは合計 ≈ 25.6 秒
    }
    const r = fitCutsToNarration(reel(cuts), narr(segs), {clipDurationOf: clip6});
    expect(r.ok).toBe(true);
    expect(r.after.avgCutSec).toBeGreaterThanOrEqual(0.75);
    expect(r.after.avgCutSec).toBeLessThanOrEqual(0.8);
    expect(r.blocks.every((b) => b.shortSec === 0)).toBe(true);
    expect(texts(r.cuts)).toEqual(cuts.filter((c) => c.main).map((c) => c.main!.text));
    noE(r.cuts);
    expect(checkNarration(r.narration, {estimate: () => 1})).toEqual([]);
  });
});
