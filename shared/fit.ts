// ナレーション音声に映像の尺を合わせる（1 カット 0.70〜0.80 秒）。純粋（ファイルも AI も触らない）。
//
// 使いどころは「台本から組み立てる」→「音声を生成」のあと。Fish Audio の尺は台本の想定とずれる
// （同じ文でも 2 倍ばらつく）ので、組み立て直後の cuts.json は音声より長かったり短かったりする。
//
// 方針:
// - **音声が正。** ブロック i の映像区間 ＝ その wav の実測尺（切り上げでフレームに乗せる）。ブロックは前から詰めて置き、
//   narration の at はブロックの頭に置き直す（音声は作り直さない）
// - **1 カットは 0.70〜0.80 秒**（ユーザー指示 2026-10-03。以前は「平均」0.75〜0.8 秒）。ブロックのカット数は
//   音声 ÷ 0.8 秒の切り上げ。カットが 0.70 秒を下回るほど短いブロックは、映像を少し長くして（次のナレーションを後ろへ）守る
// - **同じ素材を 2 カット以上続けて使わない**（2026-10-03）。以前は 1 本の素材を場所をずらして刻んで（ジャンプカット）
//   カット数を稼いでいたが、同じ画が続いて動きが無く見えた（カニ蔵の卓上全景 3 連続）。1 つの素材は 1 カットだけ
// - **似た構図はまとめる。** 近く（3 カット以内）に同じような構図が続いたら 1 本にし、その中で最も鮮明な素材を使う
//   （判定は shared/shot-variety.ts。catalog を渡したときだけ。渡さなければ同じ src だけをまとめる）
// - **足りないカットは、まだ使っていない素材で補う。** 撮影順（id は 01 から時系列）で前後に撮った素材を優先し、
//   近くに似た構図があるものは使わない。それでも足りなければ、まとめた似た構図を戻し、最後はカットを 0.8 秒より長くする
// - **選んだクリップはなるべく全部残す。** 似た構図の重なり以外は、ブロックのカット数を担うクリップの数より減らさない
// - ブロックの中の並びは撮影順（フックの先頭カットは動かさない）
// - **映像が音声より短いブロックは作らない**（次のナレーションが食い込むため）。素材が尽きたら元のクリップの
//   トリミングを広げる（後ろへ伸ばし、後ろが無ければ頭を前へ）。それでも足りなければ次のナレーションを後ろへ送る。
//   スロー再生はしない（ユーザー指示 2026-09-23）
// - 窓をまたぐカットは**取り分の大きい側のブロックがそのテロップとクリップを担う**（端切れの側では使わない）
// - テロップは 1 つも落とさない。1 カットしか無いテロップとフック（先頭）は 0.8 秒（読める長さ）を守る
// - 会話（subs）とロック済みのカットは刻まない（尺も倍速もそのまま）
import {ReelDataSchema, type Cut, type ReelData, type Slot} from './schema/cuts';
import type {Clip} from './schema/catalog';
import type {Narration, NarrationSegment} from './schema/narration';
import {cutFrames, cutRanges, round3, totalSec} from './timeline';
import {HOOK_TOO_SHORT_SEC, TELOP_UNREADABLE_SEC} from './validate';
import {SIMILAR_WINDOW, clipSeq, isSimilarShot, nextStage, pickSupplement, sharperFirst, shotStage, usableSpan} from './shot-variety';

/** 1 カットの尺（秒）。どのカットもこの範囲に入れる（ユーザー指示 2026-10-03: 各クリップ 0.70〜0.8 秒） */
export const FIT_DEFAULTS = {minCutSec: 0.7, maxCutSec: 0.8} as const;

export type FitOptions = {
  /** 1 カットの尺の下限（秒）。既定 0.7 */
  minCutSec?: number;
  /** 1 カットの尺の上限（秒）。既定 0.8 */
  maxCutSec?: number;
  /** 素材の長さ（src → 秒）。あると元カットの範囲の外（素材の残り）まで使える。無ければ元カットの範囲の中だけ */
  clipDurationOf?: (src: string) => number | undefined;
  /**
   * catalog の素材。渡すと似た構図をまとめ（最も鮮明なものを残す）、足りないカットを撮影順で前後の未使用素材から補う。
   * 渡さなければ同じ src だけをまとめ、補いはしない
   */
  clips?: readonly Clip[];
  /** src → catalog の素材（別名コピー・プロキシを辿る）。無ければ clips の src / proxyOf で引く */
  clipOf?: (src: string) => Clip | undefined;
  /** durSec が無いブロックの見積もり。**渡さなければ音声が無いブロックがあるだけで止まる**（音声が正のため） */
  estimate?: (seg: NarrationSegment) => number;
  /** 先頭の余白（秒）。最初のナレーションをこの分だけ遅らせる。既定 0 */
  leadSec?: number;
  /** 末尾の余白（秒）。最後のナレーションのあとに映像を残す。既定 0 */
  tailSec?: number;
};

export type FitBlock = {
  id: string;
  /** 音声の長さ（秒） */
  audioSec: number;
  /** 新しい配置秒（ブロックの頭。前の音声が長引いたぶん後ろにずれることがある） */
  at: number;
  /** 映像の長さ（秒）。音声以上になるのが普通（フレーム切り上げ・カットの最低尺） */
  videoSec: number;
  /** このブロックのカット数（会話・ロック済みも含む） */
  cutCount: number;
  /** 素材が尽きて、映像が音声より短い秒数（この分だけ次のナレーションが後ろへずれる）。0 なら収まった */
  shortSec: number;
};

export type FitStats = {cutCount: number; totalSec: number; avgCutSec: number};

export type FitResult = {
  /** false なら blockers に理由。cuts / narration は入力のまま */
  ok: boolean;
  blockers: string[];
  cuts: ReelData;
  narration: Narration;
  blocks: FitBlock[];
  before: FitStats;
  after: FitStats;
  /** まとめた似た構図（残した素材 → まとめた素材）。素材の id が分かるものは id、分からなければ src */
  merged: {kept: string; dropped: string[]}[];
  /** 足りないカットを補った素材（id） */
  supplemented: string[];
  /** 人が読む説明（先頭が要約。"!" 付きは確認が要る） */
  notes: string[];
};

/** ghost = 似た構図としてまとめたカット（材料にはしない。補いが無いときだけ戻す）。must = そのテロップを担うのはこのカットだけ */
type Item = {cut: Cut; index: number; start: number; end: number; protected: boolean; ghost?: 'must' | 'soft'};
/** あるブロックの材料にする部分（素材内の秒）。primary = このブロックがそのカットを担う。supp = 補った素材 */
type Portion = {item: Item; from: number; to: number; primary: boolean; supp?: boolean; slot: boolean};
type FreeRun = {kind: 'free'; text: string | null; portions: Portion[]; durSec: number; mustShow: boolean};
type FixedRun = {kind: 'fixed'; item: Item};
type Run = FreeRun | FixedRun;
type Entry = {kind: 'free'; portion: Portion} | {kind: 'fixed'; item: Item};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 会話（subs）とロック済みは刻まない */
export const isFixedCut = (c: Cut, slot?: Slot): boolean => (c.subs?.length ?? 0) > 0 || !!slot?.locked;

/**
 * 重み比例で total 個を配る（最大剰余法）。mins は各要素の最低個数。
 * 最低個数の合計が total を超えるときは最低個数をそのまま返す（呼ぶ側で total を最低個数以上にしておく）
 */
export const allocateByWeight = (weights: number[], total: number, mins: number[] = []): number[] => {
  const n = weights.length;
  if (!n) return [];
  const min = weights.map((_, i) => mins[i] ?? 0);
  const rest = Math.max(0, total - min.reduce((a, b) => a + b, 0));
  const sumW = weights.reduce((a, b) => a + Math.max(0, b), 0);
  const raw = weights.map((w) => (sumW > 0 ? (rest * Math.max(0, w)) / sumW : rest / n));
  const base = raw.map((r) => Math.floor(r + 1e-9));
  let left = rest - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({i, frac: r - Math.floor(r + 1e-9)})).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    base[o.i]++;
    left--;
  }
  return base.map((b, i) => b + min[i]);
};

/** inSec から frames フレームぶんの outSec。3 桁丸めで 1 フレームずれたら直す（cutFrames と同じ式で検算） */
const outFor = (inSec: number, frames: number, fps: number): number => {
  let out = round3(inSec + frames / fps);
  for (let t = 0; t < 6; t++) {
    const got = cutFrames({inSec, outSec: out}, fps);
    if (got === frames) break;
    out = round3(out + (got < frames ? 0.001 : -0.001));
  }
  return out;
};

const statsOf = (d: ReelData): FitStats => {
  const t = totalSec(d);
  return {cutCount: d.cuts.length, totalSec: round3(t), avgCutSec: d.cuts.length ? round3(t / d.cuts.length) : 0};
};

/** 音声が無い（durSec が無い）ブロックの id。空なら全部そろっている */
export const missingAudioIds = (narration: Pick<Narration, 'segments'>): string[] => narration.segments.filter((s) => !(s.durSec && s.durSec > 0)).map((s) => s.id);

/** 画面のボタンを押せるか。押せなければ理由（音声が正なので、音声が無いブロックがあると止める） */
export const fitBlockedBy = (cuts: ReelData | null | undefined, narration: Narration | null | undefined): string | null => {
  if (!cuts) return '構成（cuts.json）がありません';
  if (!narration || !narration.segments.length) return 'ナレーションがありません';
  const missing = missingAudioIds(narration);
  if (missing.length) return `音声が無いブロックがあります（${missing.join(', ')}）。先に「音声を生成」してください`;
  return null;
};

const telopKey = (c: Cut): string | null => (c.main?.text?.trim() ? `${c.main.text}\u0000${c.main.orientation ?? 'vertical'}` : null);

export const fitCutsToNarration = (cuts: ReelData, narration: Narration, opt: FitOptions = {}): FitResult => {
  const minCut = opt.minCutSec ?? FIT_DEFAULTS.minCutSec;
  const maxCut = opt.maxCutSec ?? FIT_DEFAULTS.maxCutSec;
  const fps = cuts.fps;
  const before = statsOf(cuts);
  const blockers: string[] = [];
  const empty = {merged: [], supplemented: []};
  if (!(minCut > 0 && maxCut >= minCut)) blockers.push(`カット尺の範囲が不正です（${minCut}〜${maxCut} 秒）`);
  const segs = [...narration.segments].sort((a, b) => a.at - b.at);
  if (!segs.length) blockers.push('ナレーションのブロックがありません');
  const noAudio = missingAudioIds(narration);
  if (noAudio.length && !opt.estimate) blockers.push(`音声が無いブロックがあります: ${noAudio.join(', ')}（先に「音声を生成」してください。音声が正なので見積もりでは合わせません）`);
  if (blockers.length) return {ok: false, blockers, cuts, narration, blocks: [], before, after: before, ...empty, notes: []};
  const audioOf = (s: NarrationSegment): number => (s.durSec && s.durSec > 0 ? s.durSec : Math.max(0.1, opt.estimate!(s)));
  const audioFramesOf = (s: NarrationSegment): number => Math.ceil(audioOf(s) * fps - 1e-6);

  // ── 素材（catalog）の引き当て ──
  const bySrc = new Map<string, Clip>();
  for (const c of opt.clips ?? []) {
    bySrc.set(c.src, c);
    if (c.proxyOf) bySrc.set(c.proxyOf, c);
  }
  const clipOfSrc = (src: string): Clip | undefined => opt.clipOf?.(src) ?? bySrc.get(src);
  const clipDur = (src: string): number | undefined => {
    const d = opt.clipDurationOf?.(src) ?? clipOfSrc(src)?.probe.durationSec;
    return d !== undefined && Number.isFinite(d) && d > 0 ? d : undefined;
  };
  const nameOf = (src: string) => clipOfSrc(src)?.id ?? src;
  // clips を渡したときは、そこに無い catalog の素材（NG にしたもの）は使わない
  const allowed = opt.clips ? new Set(opt.clips.map((c) => c.id)) : null;
  const isNgSrc = (src: string): boolean => {
    const c = clipOfSrc(src);
    return !!allowed && !!c && !allowed.has(c.id);
  };

  // ── いまのタイムライン ──
  const slotById = new Map((cuts.meta?.slots ?? []).map((s) => [s.cutId, s]));
  const ranges = cutRanges(cuts);
  const allItems: Item[] = cuts.cuts.map((c, index) => ({cut: c, index, start: ranges[index].startSec, end: ranges[index].endSec, protected: isFixedCut(c, c.id ? slotById.get(c.id) : undefined)}));
  const oldTotal = totalSec(cuts);

  // ── 似た構図をまとめる（近く SIMILAR_WINDOW カット以内に同じ構図があれば 1 本に） ──
  const sameShot = (a: Cut, b: Cut): boolean => {
    if (a.src === b.src) return true;
    const ca = clipOfSrc(a.src);
    const cb = clipOfSrc(b.src);
    return !!ca && !!cb && isSimilarShot(ca, cb);
  };
  const kept: Item[] = [];
  const clusters = new Map<Item, Item[]>();
  for (const it of allItems) {
    if (it.protected) {
      kept.push(it);
      continue;
    }
    let host: Item | undefined;
    for (let j = kept.length - 1, seen = 0; j >= 0 && seen < SIMILAR_WINDOW; j--, seen++) {
      if (!kept[j].protected && sameShot(kept[j].cut, it.cut)) {
        host = kept[j];
        break;
      }
    }
    if (host) clusters.get(host)!.push(it);
    else {
      kept.push(it);
      clusters.set(it, [it]);
    }
  }
  const merged: FitResult['merged'] = [];
  /** その src が入っているまとまりの数。2 つ以上に入る素材を代表にすると、もう一方で使える画が無くなることがある */
  const clusterCountOf = new Map<string, number>();
  for (const members of clusters.values()) for (const src of new Set(members.map((m) => m.cut.src))) clusterCountOf.set(src, (clusterCountOf.get(src) ?? 0) + 1);
  const carried = new Set(kept.map((it) => telopKey(it.cut)).filter((k): k is string => !!k));
  for (const [host, members] of clusters) {
    if (members.length < 2) continue;
    const originalNames = members.map((m) => nameOf(m.cut.src));
    const rest = members.slice(1);
    for (const m of rest) {
      const key = telopKey(m.cut);
      if (key && !carried.has(key)) {
        m.ghost = 'must'; // このテロップを出すのはこのカットだけ。補いの素材に載せて出す（無ければこのカットを戻す）
        carried.add(key);
      } else m.ghost = 'soft';
    }
    // 残す画は、まとめた中で最も鮮明なもの（ほかの位置で使っている素材は選ばない：離れた再使用になる）
    const elsewhere = new Set(kept.filter((k) => k !== host).map((k) => k.cut.src));
    const cands = [host, ...rest.filter((m) => m.ghost === 'soft')].filter((m) => m === host || !elsewhere.has(m.cut.src));
    const known = cands.filter((m) => clipOfSrc(m.cut.src));
    const rep = known.length ? [...known].sort((a, b) => Number(isNgSrc(a.cut.src)) - Number(isNgSrc(b.cut.src)) || (clusterCountOf.get(a.cut.src) ?? 1) - (clusterCountOf.get(b.cut.src) ?? 1) || sharperFirst(clipOfSrc(a.cut.src)!, clipOfSrc(b.cut.src)!) || a.index - b.index)[0] : host;
    if (rep !== host && rep.cut.src !== host.cut.src) {
      const len = host.cut.outSec - host.cut.inSec;
      const dur = clipDur(rep.cut.src) ?? rep.cut.outSec;
      const inSec = round3(Math.max(0, Math.min(rep.cut.inSec, dur - len)));
      const swapped: Cut = {...host.cut, src: rep.cut.src, inSec, outSec: round3(Math.min(dur, inSec + len))};
      delete swapped.playbackRate;
      if (rep.cut.crop) swapped.crop = rep.cut.crop;
      else delete swapped.crop;
      host.cut = swapped;
    }
    // まとめたカットのバッジ（エリア名など）は残すカットへ移す（消えると冒頭のエリア名が出ない）
    if (!host.cut.badge) {
      const withBadge = rest.find((m) => m.cut.badge);
      if (withBadge) host.cut = {...host.cut, badge: withBadge.cut.badge};
    }
    const dropped = [...new Set(originalNames.filter((n) => n !== nameOf(host.cut.src)))];
    merged.push({kept: nameOf(host.cut.src), dropped});
  }
  // NG にした素材がまだ並びに残っていれば、補いの素材に差し替える（テロップはそのまま。補えなければそのテロップは隣のカットに任せる）
  const ngReplaced: string[] = [];
  for (const it of kept) {
    if (it.protected || !isNgSrc(it.cut.src)) continue;
    const key = telopKey(it.cut);
    const shared = key !== null && kept.some((o) => o !== it && !o.ghost && !isNgSrc(o.cut.src) && telopKey(o.cut) === key);
    it.ghost = key && !shared ? 'must' : 'soft';
    ngReplaced.push(nameOf(it.cut.src));
  }
  const timelineItems = allItems; // 並びは元のまま（まとめたカットも位置は持つ。材料にしないだけ）
  const live = kept.filter((it) => !it.ghost);
  const keptFree = live.filter((it) => !it.protected);

  // ブロック i の窓 = [at_i, at_{i+1})。先頭は 0 から、最後は末尾まで
  const windows = segs.map((s, i) => ({from: i === 0 ? 0 : Math.max(0, s.at), to: i === segs.length - 1 ? Infinity : Math.max(0, segs[i + 1].at)}));
  const borrowed: string[] = [];

  // 窓ごとの材料（まだ primary は決めない）
  const entriesOfBlock: Entry[][] = windows.map((w, bi) => {
    const entries: Entry[] = [];
    for (const it of timelineItems) {
      if (it.protected) {
        const mid = (it.start + it.end) / 2;
        if (mid >= w.from && mid < w.to) entries.push({kind: 'fixed', item: it});
        continue;
      }
      const a = Math.max(it.start, w.from);
      const b = Math.min(it.end, w.to);
      if (b - a <= 1e-6) continue;
      const rate = it.cut.playbackRate ?? 1;
      entries.push({kind: 'free', portion: {item: it, from: round3(it.cut.inSec + (a - it.start) * rate), to: round3(it.cut.inSec + (b - it.start) * rate), primary: false, slot: false}});
    }
    const fixedInWindow = entries.reduce((n, e) => n + (e.kind === 'fixed' ? cutFrames(e.item.cut, fps) : 0), 0);
    if (!entries.some((e) => e.kind === 'free') && keptFree.length && fixedInWindow < audioFramesOf(segs[bi])) {
      // 窓に映像が無い（at が同じ・動画尺の外）のに音声ぶんの時間が要る → その位置のカットを丸ごと借りる
      const it = keptFree.find((x) => w.from >= x.start && w.from < x.end) ?? keptFree[keptFree.length - 1];
      entries.push({kind: 'free', portion: {item: it, from: it.cut.inSec, to: it.cut.outSec, primary: true, slot: false}});
      borrowed.push(segs[bi].id);
    }
    return entries;
  });

  // 窓をまたぐカットは、取り分の大きいブロックがそのクリップとテロップを担う（primary）
  {
    const best = new Map<number, {bi: number; len: number}>();
    entriesOfBlock.forEach((entries, bi) => {
      for (const e of entries) {
        if (e.kind !== 'free' || e.portion.primary) continue;
        const len = e.portion.to - e.portion.from;
        const cur = best.get(e.portion.item.index);
        if (!cur || len > cur.len + 1e-6) best.set(e.portion.item.index, {bi, len});
      }
    });
    entriesOfBlock.forEach((entries, bi) => {
      for (const e of entries) if (e.kind === 'free' && best.get(e.portion.item.index)?.bi === bi) e.portion.primary = true;
    });
  }

  // 同じ文言が続く部分は 1 つの run（エンジンの telopGroups と同じ判定）。テロップ無しは 1 部分 1 run
  const runsOfBlock: Run[][] = entriesOfBlock.map((entries) => {
    const runs: Run[] = [];
    for (const e of entries) {
      if (e.kind === 'fixed') {
        runs.push({kind: 'fixed', item: e.item});
        continue;
      }
      const p = e.portion;
      const text = telopKey(p.item.cut);
      const len = p.to - p.from;
      const shows = text !== null && p.primary && (!p.item.ghost || p.item.ghost === 'must');
      const last = runs[runs.length - 1];
      if (last && last.kind === 'free' && last.text !== null && text !== null && last.text === text) {
        last.portions.push(p);
        last.durSec += len;
        last.mustShow = last.mustShow || shows;
      } else runs.push({kind: 'free', text, portions: [p], durSec: len, mustShow: shows});
    }
    return runs;
  });

  // ── カットを担う材料を決める（担うクリップ 1 つにつき 1 カット。足りなければ補う） ──
  const minF = Math.max(1, Math.round(minCut * fps));
  const maxF = Math.max(minF, Math.round(maxCut * fps));
  const guardFrames = Math.ceil(Math.max(TELOP_UNREADABLE_SEC, HOOK_TOO_SHORT_SEC) * fps - 1e-6);
  const leadFrames = Math.max(0, Math.round((opt.leadSec ?? 0) * fps));
  const tailFrames = Math.max(0, Math.round((opt.tailSec ?? 0) * fps));
  const availToOf = (p: Portion): number => Math.max(p.to, clipDur(p.item.cut.src) ?? p.item.cut.outSec);

  // 使っている素材（補いの重複・似た構図の判定に使う）
  const usedIds = new Set<string>();
  const usedClips: Clip[] = [];
  const markUsed = (src: string) => {
    const c = clipOfSrc(src);
    if (c && !usedIds.has(c.id)) {
      usedIds.add(c.id);
      usedClips.push(c);
    }
  };
  for (const it of live) markUsed(it.cut.src);
  /** 動画に出る（出る予定の）src。まとめた素材を戻すとき、離れた位置での再使用にならないよう見る */
  const placedSrcs = new Set(live.map((it) => it.cut.src));
  const supplemented: string[] = [];
  let revived = 0;
  /** 素材が尽きて、まとめた素材を離れた位置でもう一度使ったブロックの数 */
  let reusedFar = 0;
  let shortage = 0;

  /** タイムライン上で近い（前後 SIMILAR_WINDOW 本）素材。補いで似た構図を避けるため */
  const nearbyOf = (bi: number): Clip[] => {
    // このブロックで出すもの（元のカット・補い）＋ 時間の上で前後 SIMILAR_WINDOW 本の生きているカット＋ 直前のブロックで補った素材
    const own = runsOfBlock[bi].flatMap((r) => (r.kind === 'free' ? r.portions.filter((p) => p.slot || (p.primary && !p.item.ghost)).map((p) => p.item) : [r.item]));
    const w = windows[bi];
    const before = live.filter((it) => it.start < w.from).slice(-SIMILAR_WINDOW);
    const inside = live.filter((it) => it.start < w.to && it.end > w.from);
    const after = live.filter((it) => it.start >= w.to).slice(0, SIMILAR_WINDOW);
    const prevSupp = bi > 0 ? runsOfBlock[bi - 1].flatMap((r) => (r.kind === 'free' ? r.portions.filter((p) => p.slot && p.supp).map((p) => p.item) : [])) : [];
    return [...new Set([...before, ...inside, ...after, ...own, ...prevSupp].map((it) => clipOfSrc(it.cut.src)).filter((c): c is Clip => !!c))];
  };

  const plan = segs.map((seg, bi) => {
    const runs = runsOfBlock[bi];
    const wantFrames = audioFramesOf(seg) + (bi === 0 ? leadFrames : 0) + (bi === segs.length - 1 ? tailFrames : 0);
    const fixedFrames = runs.reduce((n, r) => n + (r.kind === 'fixed' ? cutFrames(r.item.cut, fps) : 0), 0);
    const freeRuns = runs.filter((r): r is FreeRun => r.kind === 'free');
    const freeFrames = wantFrames - fixedFrames;
    // 担うクリップ（まとめた似た構図は除く）は全部 1 カットずつ
    for (const r of freeRuns) for (const p of r.portions) if (p.primary && !p.item.ghost) p.slot = true;
    const capOf = () => freeRuns.reduce((n, r) => n + r.portions.filter((p) => p.slot).length, 0);
    const mustRuns = freeRuns.filter((r) => r.mustShow);
    const kMin = Math.max(freeRuns.length ? 1 : 0, capOf() + mustRuns.filter((r) => !r.portions.some((p) => p.slot)).length);
    const k = freeRuns.length ? Math.max(kMin, freeFrames > 0 ? Math.ceil(freeFrames / maxF - 1e-9) : 0) : 0;

    // 足りないぶんを補う。カットの無い run（テロップだけ残った所）→ 1 カットあたりが長い run の順
    const blockClips = freeRuns.flatMap((r) => r.portions.filter((p) => p.slot)).map((p) => clipOfSrc(p.item.cut.src)).filter((c): c is Clip => !!c);
    const context = [seg.text, ...freeRuns.map((r) => r.portions[0].item.cut.main?.text ?? ''), ...blockClips.map((c) => `${c.tags?.subject ?? ''} ${c.tags?.description ?? ''}`)].join(' ');
    const runNeed = (r: FreeRun) => (r.portions.some((p) => p.slot) ? r.durSec / (r.portions.filter((p) => p.slot).length + 1) : Infinity);
    const candidates = opt.clips ?? [];
    for (let guard = 0; guard < 50 && capOf() < k && candidates.length; guard++) {
      const target = [...freeRuns].sort((a, b) => (b.mustShow && !b.portions.some((p) => p.slot) ? 1 : 0) - (a.mustShow && !a.portions.some((p) => p.slot) ? 1 : 0) || runNeed(b) - runNeed(a))[0];
      const anchors = freeRuns.flatMap((r) => r.portions.filter((p) => !p.supp && (p.slot || p.primary))).map((p) => clipOfSrc(p.item.cut.src)).filter((c): c is Clip => !!c);
      const last = target.portions.filter((p) => p.slot).map((p) => clipOfSrc(p.item.cut.src)).filter((c): c is Clip => !!c).pop();
      const pick = pickSupplement({candidates, usedIds, nearby: nearbyOf(bi), used: usedClips, wantStage: nextStage(last ? shotStage(last) : undefined), context, anchors, minSec: minCut});
      if (!pick) break;
      const span = usableSpan(pick);
      const best = pick.usableRanges.find((r) => r.label === 'best' && r.outSec - r.inSec >= minCut);
      const from = round3(best?.inSec ?? span.inSec);
      const host = target.portions[0].item;
      const cut: Cut = {...host.cut, src: pick.src, inSec: from, outSec: round3(span.outSec)};
      delete cut.playbackRate;
      delete cut.subs;
      delete cut.badge;
      if (pick.crop) cut.crop = pick.crop;
      else delete cut.crop;
      target.portions.push({item: {...host, cut, ghost: undefined}, from, to: round3(span.outSec), primary: true, supp: true, slot: true});
      markUsed(pick.src);
      placedSrcs.add(pick.src);
      supplemented.push(pick.id);
    }
    // それでも足りなければ、まとめた似た構図を戻す（テロップを担うものから）
    for (const want of ['must', 'soft'] as const) {
      for (const r of freeRuns) {
        for (const p of r.portions) {
          if (capOf() >= k && !(want === 'must' && r.mustShow && !r.portions.some((q) => q.slot))) continue;
          if (p.slot || p.item.ghost !== want || !p.primary) continue;
          const prev = r.portions.filter((q) => q.slot).pop();
          if (prev && prev.item.cut.src === p.item.cut.src) continue; // 同じ素材は続けない
          if (isNgSrc(p.item.cut.src) || placedSrcs.has(p.item.cut.src)) continue; // NG と、もう出ている素材は戻さない
          p.slot = true;
          placedSrcs.add(p.item.cut.src);
          revived++;
        }
      }
    }
    if (!capOf()) {
      const fallback = freeRuns.flatMap((r) => r.portions).find((p) => p.item.ghost && !isNgSrc(p.item.cut.src));
      if (fallback) {
        fallback.slot = true;
        reusedFar++;
        revived++;
      }
    }
    if (capOf() < k) shortage++;
    // 撮影順に並べる。テロップごとの最初のカット（AI が選んだ画。テロップが指している画）と、id の分からない素材の位置は動かさない
    freeRuns.forEach((r) => {
      const head = r.portions.filter((p) => p.slot && !p.supp).slice(0, 1);
      const seqOf = (p: Portion) => {
        const c = clipOfSrc(p.item.cut.src);
        return c ? clipSeq(c) : null;
      };
      const rest = r.portions.filter((p) => !head.includes(p));
      const known = rest.filter((p) => seqOf(p) !== null).sort((a, b) => seqOf(a)! - seqOf(b)!);
      let ki = 0;
      r.portions = [...head, ...rest.map((p) => (seqOf(p) !== null ? known[ki++] : p))];
    });
    return {runs, fixedFrames, freeRuns, k, wantFrames};
  });

  const newCuts: Cut[] = [];
  const sourceIndexOf: number[] = []; // 新カット → 元カットの index
  const badgeDone = new Set<number>();
  const blocks: FitBlock[] = [];
  let cursorFrames = 0;
  let carry = 0;
  let extended = 0;
  let guardedCount = 0;
  let longCuts = 0;
  let fixedCount = 0;
  let stretched = 0;
  const unknownLen = new Set<string>();

  segs.forEach((seg, bi) => {
    const {runs, fixedFrames, freeRuns, k} = plan[bi];
    const audioSec = audioOf(seg);
    const offsetFrames = carry + (bi === 0 ? leadFrames : 0);
    const needFrames = offsetFrames + audioFramesOf(seg);
    const wantFrames = needFrames + (bi === segs.length - 1 ? tailFrames : 0);
    const freeFrames = wantFrames - fixedFrames;

    type Planned = {runIndex: number; portion: Portion; frames: number; guarded: boolean; inSec: number; outSec: number};
    const planned: Planned[] = [];
    freeRuns.forEach((r, ri) => {
      const mine = r.portions.filter((p) => p.slot);
      for (const p of mine) planned.push({runIndex: ri, portion: p, frames: 0, guarded: r.mustShow && mine.length === 1, inSec: 0, outSec: 0});
    });
    if (bi === 0 && runs[0]?.kind === 'free' && planned.length) planned[0].guarded = true;

    // フレームを配る。どのカットも 0.70〜0.80 秒（素材が足りずカット数が k に届かないときだけ 0.8 秒を超える）
    const n = planned.length;
    const short = n < k;
    const upper = short ? Infinity : maxF;
    let guardSum = 0;
    for (const p of planned) {
      if (!p.guarded) continue;
      p.frames = Math.max(guardFrames, minF, n ? Math.min(upper, Math.floor(Math.max(0, freeFrames) / n)) : 0);
      if (p.frames > maxF) guardedCount++;
      guardSum += p.frames;
    }
    const others = planned.filter((p) => !p.guarded);
    if (others.length) {
      const remaining = Math.max(0, freeFrames - guardSum);
      const each = clamp(Math.floor(remaining / others.length), minF, upper);
      let rem = Math.max(0, remaining - each * others.length);
      for (const p of others) {
        const add = rem > 0 && each + 1 <= upper ? 1 : 0;
        p.frames = each + add;
        rem -= add;
      }
    }
    if (short) longCuts += planned.filter((p) => p.frames > maxF).length;

    // 素材の中のどこを使うか。1 素材 1 カット。元の区間で足りなければ後ろへ、後ろが無ければ頭を前へ広げる
    for (const p of planned) {
      const availTo = availToOf(p.portion);
      const d = p.frames / fps;
      let start = p.portion.from;
      if (start + d > availTo + 1e-6) {
        start = Math.max(0, availTo - d);
        extended++;
      } else if (start + d > p.portion.item.cut.outSec + 1e-6 && !p.portion.supp) extended++;
      const inSec = round3(start);
      const frames = availTo - inSec + 1e-6 >= d ? p.frames : Math.max(1, Math.floor((availTo - inSec) * fps + 1e-6));
      p.frames = frames;
      p.inSec = inSec;
      p.outSec = outFor(inSec, frames, fps);
    }
    // 素材が尽きて足りないぶんは、トリミングを広げて埋める（後ろへ → 頭を前へ）。スローや同じ素材の重ね使いはしない
    const sum = () => planned.reduce((acc, p) => acc + p.frames, 0);
    for (let i = planned.length - 1; i >= 0 && freeFrames - sum() > 0; i--) {
      const p = planned[i];
      const room = Math.floor((availToOf(p.portion) - p.outSec) * fps + 1e-6);
      const add = Math.min(room, freeFrames - sum());
      if (add <= 0) continue;
      p.frames += add;
      p.outSec = outFor(p.inSec, p.frames, fps);
      stretched++;
    }
    for (let i = 0; i < planned.length && freeFrames - sum() > 0; i++) {
      const p = planned[i];
      const room = Math.floor(p.inSec * fps + 1e-6);
      const add = Math.min(room, freeFrames - sum());
      if (add <= 0) continue;
      p.frames += add;
      p.inSec = Math.max(0, round3(p.inSec - add / fps));
      p.outSec = outFor(p.inSec, p.frames, fps);
      stretched++;
    }

    // 並び順どおりに書き出す（会話・ロック済みはそのまま、刻んだカットは元カットの属性を引き継ぐ）
    const blockStart = cursorFrames;
    let ri = 0;
    let blockCuts = 0;
    for (const r of runs) {
      if (r.kind === 'fixed') {
        const c = JSON.parse(JSON.stringify(r.item.cut)) as Cut;
        newCuts.push(c);
        sourceIndexOf.push(r.item.index);
        cursorFrames += cutFrames(c, fps);
        fixedCount++;
        blockCuts++;
        continue;
      }
      const mine = ri++;
      for (const p of planned) {
        if (p.runIndex !== mine || p.frames <= 0) continue;
        const src = p.portion.item.cut;
        const c: Cut = {...src, inSec: p.inSec, outSec: p.outSec};
        delete c.playbackRate; // 刻んだカットは等速
        delete c.subs;
        if (c.badge && badgeDone.has(p.portion.item.index)) delete c.badge; // バッジは元カット 1 つにつき最初の 1 つだけ
        if (c.badge) badgeDone.add(p.portion.item.index);
        newCuts.push(c);
        sourceIndexOf.push(p.portion.item.index);
        cursorFrames += cutFrames(c, fps);
        blockCuts++;
      }
    }
    const videoFrames = cursorFrames - blockStart;
    const shortFrames_ = Math.max(0, needFrames - videoFrames);
    carry = shortFrames_;
    if (shortFrames_ > 0) for (const p of planned) if (p.frames > 0 && clipDur(p.portion.item.cut.src) === undefined) unknownLen.add(p.portion.item.cut.src);
    blocks.push({id: seg.id, audioSec: round3(audioSec), at: round3((blockStart + offsetFrames) / fps), videoSec: round3(videoFrames / fps), cutCount: blockCuts, shortSec: round3(shortFrames_ / fps)});
  });

  if (!newCuts.length) {
    return {ok: false, blockers: ['刻める映像がありません（カットが全部 会話・ロック済み で、ナレーションの窓に掛かっていません）'], cuts, narration, blocks: [], before, after: before, ...empty, notes: []};
  }

  // ── 同じ素材が続いた所（ブロックの境目など）は 1 カットにつなぐ。テロップが違えばつながない ──
  let joined = 0;
  for (let i = newCuts.length - 1; i > 0; i--) {
    const a = newCuts[i - 1];
    const b = newCuts[i];
    if (a.src !== b.src || a.subs?.length || b.subs?.length || telopKey(a) !== telopKey(b) || a.playbackRate || b.playbackRate) continue;
    const add = cutFrames(b, fps);
    const dur = clipDur(a.src) ?? Math.max(a.outSec, b.outSec);
    let inSec = a.inSec;
    let frames = cutFrames(a, fps) + add;
    if (inSec + frames / fps > dur + 1e-6) inSec = Math.max(0, round3(dur - frames / fps));
    if (inSec + frames / fps > dur + 1e-6) frames = Math.max(1, Math.floor((dur - inSec) * fps + 1e-6));
    // 尺が変わるとナレーションがずれるので、素材が足りずに縮むならつながない
    if (frames !== cutFrames(a, fps) + add) continue;
    newCuts[i - 1] = {...a, inSec: round3(inSec), outSec: outFor(round3(inSec), frames, fps)};
    newCuts.splice(i, 1);
    sourceIndexOf.splice(i, 1);
    joined++;
  }

  // ── id と meta を付け直す ──
  const ids = newCuts.map((_, i) => `c${String(i + 1).padStart(2, '0')}`);
  newCuts.forEach((c, i) => {
    c.id = ids[i];
  });
  const newIdsOfOld = new Map<string, string[]>();
  sourceIndexOf.forEach((oi, ni) => {
    const oldId = cuts.cuts[oi].id;
    if (!oldId) return;
    const arr = newIdsOfOld.get(oldId) ?? [];
    arr.push(ids[ni]);
    newIdsOfOld.set(oldId, arr);
  });
  const slots: Slot[] | undefined = cuts.meta?.slots
    ? sourceIndexOf.flatMap((oi, ni) => {
        const oldId = cuts.cuts[oi].id;
        const s = oldId ? slotById.get(oldId) : undefined;
        if (!s) return [];
        const cid = newCuts[ni].src !== cuts.cuts[oi].src ? clipOfSrc(newCuts[ni].src)?.id : undefined;
        return [{...s, cutId: ids[ni], ...(cid ? {clipId: cid} : {})}];
      })
    : undefined;
  const telopGroups = cuts.meta?.telopGroups?.map((g) => ({...g, cutIds: g.cutIds.flatMap((id) => newIdsOfOld.get(id) ?? []).sort((a, b) => ids.indexOf(a) - ids.indexOf(b))})).filter((g) => g.cutIds.length);
  const meta = cuts.meta ? {...cuts.meta, ...(slots ? {slots} : {}), ...(telopGroups ? {telopGroups} : {})} : undefined;
  const nextCuts = ReelDataSchema.parse({...cuts, cuts: newCuts, ...(meta ? {meta} : {})});
  const after = statsOf(nextCuts);

  // ── narration: at をブロックの頭へ。効果音は元の窓の中の位置を新しいブロックへ比例で写す ──
  // （つないだカットは尺を変えないので、ブロックの頭は変わらない）
  const atOfSeg = new Map<NarrationSegment, number>(segs.map((s, i) => [s, blocks[i].at]));
  const segments = narration.segments.map((s) => {
    const at = atOfSeg.get(s);
    return at !== undefined && at !== s.at ? {...s, at} : s;
  });
  let sfxMoved = 0;
  const sfx = narration.sfx?.map((x) => {
    let bi = windows.findIndex((w) => x.at >= w.from && x.at < w.to);
    if (bi < 0) bi = x.at < 0 ? 0 : windows.length - 1;
    const w = windows[bi];
    const b = blocks[bi];
    const oldLen = (Number.isFinite(w.to) ? w.to : Math.max(oldTotal, w.from + 0.001)) - w.from;
    const ratio = oldLen > 0 ? b.videoSec / oldLen : 1;
    const at = round3(clamp(b.at + (x.at - w.from) * ratio, b.at, Math.max(b.at, b.at + b.videoSec)));
    if (Math.abs(at - x.at) < 0.0005) return x;
    sfxMoved++;
    return {...x, at};
  });
  const nextNarration: Narration = {...narration, videoSec: after.totalSec, segments, ...(sfx ? {sfx} : {})};

  // ── 説明 ──
  const audioTotal = round3(segs.reduce((acc, s) => acc + audioOf(s), 0));
  const keptIdx = new Set(sourceIndexOf);
  const lostClips = cuts.cuts.filter((_, i) => !allItems[i].protected && !allItems[i].ghost && !keptIdx.has(i));
  const notes: string[] = [];
  notes.push(`ナレーション ${segs.length} ブロック（音声 計 ${audioTotal.toFixed(2)} 秒）に合わせて、${before.cutCount} カット / ${before.totalSec.toFixed(2)} 秒 → ${after.cutCount} カット / ${after.totalSec.toFixed(2)} 秒（平均 ${after.avgCutSec.toFixed(2)} 秒）にしました`);
  for (const b of blocks) notes.push(`  ${b.id}: 音声 ${b.audioSec.toFixed(2)}s → 映像 ${b.videoSec.toFixed(2)}s（${b.cutCount} カット・${b.at.toFixed(2)}s から）${b.shortSec ? ` ! 素材が ${b.shortSec.toFixed(2)} 秒足りず、次のナレーションをその分だけ後ろへ送りました` : ''}`);
  const realMerged = merged.filter((m) => m.dropped.length);
  if (realMerged.length) notes.push(`  似た構図をまとめました（最も鮮明なものを残す）: ${realMerged.map((m) => `${m.kept} ← ${m.dropped.join('・')}`).join(' / ')}`);
  const sameClipMerged = merged.filter((m) => !m.dropped.length).length;
  if (sameClipMerged) notes.push(`  同じ素材が続いていた ${sameClipMerged} か所は 1 カットにしました（同じ素材は続けて使いません）`);
  if (ngReplaced.length) notes.push(`  NG にした素材 ${[...new Set(ngReplaced)].join('・')} が並びに残っていたので、別の素材に差し替えました`);
  if (supplemented.length) notes.push(`  足りないカットを、撮影順で近いまだ使っていない素材で補いました: ${supplemented.join('・')}`);
  if (revived) notes.push(`  補える素材が無かったので、まとめた似た構図を ${revived} か所戻しました`);
  if (reusedFar) notes.push(`  ! 素材が尽きたブロックが ${reusedFar} つあり、同じ素材を離れた位置でもう一度使いました（別名コピーが要ります。検証の「適用」で直せます）`);
  notes.push(`  元のクリップ ${cuts.cuts.length} 本のうち ${keptIdx.size} 本を残しています${lostClips.length ? `（! 残せなかった: ${lostClips.map((c) => c.id ?? c.src).join('・')}）` : ''}`);
  if (fixedCount) notes.push(`  会話・ロック済みの ${fixedCount} カットは刻んでいません`);
  if (guardedCount) notes.push(`  テロップが 1 カットしか無い所とフックは、読めるよう ${TELOP_UNREADABLE_SEC} 秒以上にしています（${guardedCount} か所）`);
  if (extended) notes.push(`  元の区間の外（素材の残り）を使った所が ${extended} か所あります`);
  if (stretched) notes.push(`  素材が足りないぶんは、元のクリップのトリミングを広げて埋めました（${stretched} か所）`);
  if (joined) notes.push(`  ブロックの境目で同じ素材が続いた ${joined} か所は 1 カットにつなぎました`);
  if (longCuts) notes.push(`  ! 使える素材が足りず、${maxCut} 秒より長いカットが ${longCuts} か所あります（同じ素材を続けて刻まないため）。Materials で素材を足すか、NG を外してください`);
  else if (shortage) notes.push(`  ! 使える素材が足りないブロックが ${shortage} つあります（同じ素材を続けて刻まないため）。Materials で素材を足すか、NG を外してください`);
  if (unknownLen.size) notes.push(`  ! ${[...unknownLen].join('・')} は catalog に無いので素材の長さが分からず、元のカットの範囲までしか使えませんでした（Materials で読み込み直すと直ります）`);
  if (borrowed.length) notes.push(`  ! ${borrowed.join('・')} は、いまのタイムラインに対応する映像が無かったので隣のカットを借りました`);
  const shortBlocks = blocks.filter((b) => b.shortSec > 0);
  if (shortBlocks.length) notes.push(`  ! ${shortBlocks.map((b) => b.id).join('・')} は素材が尽きて映像が音声より短いので、続くナレーションを後ろへ送りました（被りはありませんが映像より遅れます）。素材を足すか文を短くしてください`);
  if (noAudio.length) notes.push(`  ! ${noAudio.join('・')} は音声が無いので文字数からの見積もりで合わせました。音声を作ったらもう一度合わせてください`);
  if (sfxMoved) notes.push(`  効果音 ${sfxMoved} 個の位置をブロックに合わせて動かしました`);
  notes.push('  音声は作り直していません（narration の at をブロックの頭に置き直しただけ）');

  return {ok: true, blockers: [], cuts: nextCuts, narration: nextNarration, blocks, before, after, merged: realMerged, supplemented, notes};
};
