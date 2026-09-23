// ナレーション音声に映像の尺を合わせる（0.75〜0.8 秒刻み）。純粋（ファイルも AI も触らない）。
//
// 使いどころは「台本から組み立てる」→「音声を生成」のあと。Fish Audio の尺は台本の想定とずれる
// （同じ文でも 2 倍ばらつく）ので、組み立て直後の cuts.json は音声より長かったり短かったりする。
// これまでは narration の at を後ろにずらす（fixNarrationOverlaps）しかなく、映像の側を音声に合わせるのは
// カットを 1 つずつ引き伸ばす手作業だった。
//
// 方針:
// - **音声が正。** ブロック i の映像区間 ＝ その wav の実測尺（切り上げでフレームに乗せる）。ブロックは前から詰めて置き、
//   narration の at はブロックの頭に置き直す（音声は作り直さない）
// - 区間の中は 0.75〜0.8 秒（中央 0.775）のカットに刻む。カット数 = round(区間 ÷ 0.775)。
//   1 秒前後の短いブロックは 1 カットにしかできない（0.6 秒未満のカットは作らない）。そのぶん**動画全体の平均**が
//   0.75〜0.8 秒に入るよう、刻める余地のある長いブロックでカット数を増減して釣り合いを取る
// - 素材は**いまのカット列から**取る（新しい素材を勝手に選ばない）。いまのタイムラインで、そのナレーションの窓
//   （at 〜 次の at）に掛かっているカットをそのブロックの材料にし、テロップ・バッジ・切り出しは元カットから引き継ぐ。
//   窓をまたぐカットは**取り分の大きい側のブロックがそのテロップを担う**（端切れの側は材料としてだけ使い、
//   足りなければ捨てる。両側で 0.8 秒ずつ確保すると映像が音声より膨らむため）
// - テロップは 1 つも落とさない（同じ文言が続く範囲＝run ごとに、担うブロックで最低 1 カット）。0.8 秒未満だと読めない
//   （TELOP_MIN_DISPLAY の E）ので、1 カットしか無い run とフック（先頭）は 0.8 秒に伸ばす
// - 会話（subs）とロック済みのカットは刻まない（尺も倍速もそのまま）
// - 同じ素材から複数カットを取るときは、素材の中で場所をずらして「切り替わった」ように見せる（ジャンプカット）。
//   素材が足りなければ元の範囲の外（素材の長さまで）を使い、それでも足りなければ同じ場面を重ねて使って注記する
import {ReelDataSchema, type Cut, type ReelData, type Slot} from './schema/cuts';
import type {Narration, NarrationSegment} from './schema/narration';
import {cutFrames, cutRanges, round3, totalSec} from './timeline';
import {CUT_TOO_SHORT_SEC, HOOK_TOO_SHORT_SEC, TELOP_UNREADABLE_SEC} from './validate';

/** 1 カットの目標尺（秒）。平均がこの範囲に入るように刻む（ユーザー指示: 平均 0.75〜0.8 秒） */
export const FIT_DEFAULTS = {minCutSec: 0.75, maxCutSec: 0.8} as const;

/** 素材不足の埋め合わせで 1 カットをこれ以上には伸ばさない（長くなりすぎると刻んだ意味が無い） */
const SLOT_MAX_SEC = 1.5;

export type FitOptions = {
  /** 1 カットの目標尺の下限（秒）。既定 0.75 */
  minCutSec?: number;
  /** 1 カットの目標尺の上限（秒）。既定 0.8 */
  maxCutSec?: number;
  /** 素材の長さ（src → 秒）。あると元カットの範囲の外（素材の残り）まで使える。無ければ元カットの範囲の中だけ */
  clipDurationOf?: (src: string) => number | undefined;
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
  /** 新しい配置秒（ブロックの頭） */
  at: number;
  /** 映像の長さ（秒）。音声以上になるのが普通（フレーム切り上げ・テロップの最低表示） */
  videoSec: number;
  /** このブロックのカット数（会話・ロック済みも含む） */
  cutCount: number;
  /** 素材が足りず、映像が音声より短い秒数。0 なら収まった */
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
  /** 人が読む説明（先頭が要約。"!" 付きは確認が要る） */
  notes: string[];
};

type Item = {cut: Cut; index: number; start: number; end: number; protected: boolean};
/** 既存カットのうち、あるブロックの材料にする部分（素材内の秒）。primary = このブロックがそのカットのテロップを担う */
type Portion = {item: Item; from: number; to: number; primary: boolean};
type FreeRun = {kind: 'free'; text: string | null; portions: Portion[]; durSec: number; mustShow: boolean};
type FixedRun = {kind: 'fixed'; item: Item};
type Run = FreeRun | FixedRun;
type PlannedSlot = {runIndex: number; portion: Portion; frames: number; guarded: boolean; mustShow: boolean};
type PlacedSlot = PlannedSlot & {inSec: number; outSec: number};
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

export const fitCutsToNarration = (cuts: ReelData, narration: Narration, opt: FitOptions = {}): FitResult => {
  const minCut = opt.minCutSec ?? FIT_DEFAULTS.minCutSec;
  const maxCut = opt.maxCutSec ?? FIT_DEFAULTS.maxCutSec;
  const fps = cuts.fps;
  const before = statsOf(cuts);
  const blockers: string[] = [];
  if (!(minCut > 0 && maxCut >= minCut)) blockers.push(`カット尺の範囲が不正です（${minCut}〜${maxCut} 秒）`);
  const segs = [...narration.segments].sort((a, b) => a.at - b.at);
  if (!segs.length) blockers.push('ナレーションのブロックがありません');
  const noAudio = missingAudioIds(narration);
  if (noAudio.length && !opt.estimate) blockers.push(`音声が無いブロックがあります: ${noAudio.join(', ')}（先に「音声を生成」してください。音声が正なので見積もりでは合わせません）`);
  if (blockers.length) return {ok: false, blockers, cuts, narration, blocks: [], before, after: before, notes: []};
  const audioOf = (s: NarrationSegment): number => (s.durSec && s.durSec > 0 ? s.durSec : Math.max(0.1, opt.estimate!(s)));
  const audioFramesOf = (s: NarrationSegment): number => Math.ceil(audioOf(s) * fps - 1e-6);

  // ── いまのタイムライン → ブロックごとの材料 ──
  const slotById = new Map((cuts.meta?.slots ?? []).map((s) => [s.cutId, s]));
  const ranges = cutRanges(cuts);
  const items: Item[] = cuts.cuts.map((c, index) => ({cut: c, index, start: ranges[index].startSec, end: ranges[index].endSec, protected: isFixedCut(c, c.id ? slotById.get(c.id) : undefined)}));
  const freeItems = items.filter((it) => !it.protected);
  const oldTotal = totalSec(cuts);
  // ブロック i の窓 = [at_i, at_{i+1})。先頭は 0 から、最後は末尾まで
  const windows = segs.map((s, i) => ({from: i === 0 ? 0 : Math.max(0, s.at), to: i === segs.length - 1 ? Infinity : Math.max(0, segs[i + 1].at)}));
  const borrowed: string[] = [];
  const sameTelop = (a: Cut, b: Cut) => a.main?.text === b.main?.text && (a.main?.orientation ?? 'vertical') === (b.main?.orientation ?? 'vertical');

  // 窓ごとの材料（まだ primary は決めない）
  const entriesOfBlock: Entry[][] = windows.map((w, bi) => {
    const entries: Entry[] = [];
    for (const it of items) {
      if (it.protected) {
        const mid = (it.start + it.end) / 2;
        if (mid >= w.from && mid < w.to) entries.push({kind: 'fixed', item: it});
        continue;
      }
      const a = Math.max(it.start, w.from);
      const b = Math.min(it.end, w.to);
      if (b - a <= 1e-6) continue;
      const rate = it.cut.playbackRate ?? 1;
      entries.push({kind: 'free', portion: {item: it, from: round3(it.cut.inSec + (a - it.start) * rate), to: round3(it.cut.inSec + (b - it.start) * rate), primary: false}});
    }
    const fixedInWindow = entries.reduce((n, e) => n + (e.kind === 'fixed' ? cutFrames(e.item.cut, fps) : 0), 0);
    if (!entries.some((e) => e.kind === 'free') && freeItems.length && fixedInWindow < audioFramesOf(segs[bi])) {
      // 窓に映像が無い（at が同じ・動画尺の外）のに音声ぶんの時間が要る → その位置のカットを丸ごと借りる
      const it = freeItems.find((x) => w.from >= x.start && w.from < x.end) ?? freeItems[freeItems.length - 1];
      entries.push({kind: 'free', portion: {item: it, from: it.cut.inSec, to: it.cut.outSec, primary: true}});
      borrowed.push(segs[bi].id);
    }
    return entries;
  });

  // 窓をまたぐカットは、取り分の大きいブロックがそのテロップを担う（primary）。他のブロックでは材料としてだけ使う
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
      const text = e.portion.item.cut.main?.text ?? null;
      const last = runs[runs.length - 1];
      const len = e.portion.to - e.portion.from;
      if (last && last.kind === 'free' && last.text !== null && text !== null && sameTelop(last.portions[0].item.cut, e.portion.item.cut)) {
        last.portions.push(e.portion);
        last.durSec += len;
        last.mustShow = last.mustShow || e.portion.primary;
      } else runs.push({kind: 'free', text, portions: [e.portion], durSec: len, mustShow: text !== null && e.portion.primary});
    }
    return runs;
  });

  // ── ブロックごとに刻む ──
  const targetFrames = ((minCut + maxCut) / 2) * fps;
  const shortFrames = Math.ceil(CUT_TOO_SHORT_SEC * fps - 1e-6);
  const guardFrames = Math.ceil(Math.max(TELOP_UNREADABLE_SEC, HOOK_TOO_SHORT_SEC) * fps - 1e-6);
  const maxSlotFrames = Math.round(SLOT_MAX_SEC * fps);
  const leadFrames = Math.max(0, Math.round((opt.leadSec ?? 0) * fps));
  const tailFrames = Math.max(0, Math.round((opt.tailSec ?? 0) * fps));
  const clipDur = (src: string): number | undefined => {
    const d = opt.clipDurationOf?.(src);
    return d !== undefined && Number.isFinite(d) && d > 0 ? d : undefined;
  };
  /** この部分で使ってよい素材の終端。素材の長さが分かればそこまで、分からなければ元カットの範囲まで */
  const availToOf = (p: Portion): number => Math.max(p.to, clipDur(p.item.cut.src) ?? p.item.cut.outSec);

  const newCuts: Cut[] = [];
  const sourceIndexOf: number[] = []; // 新カット → 元カットの index
  const badgeDone = new Set<number>(); // バッジは元カット 1 つにつき最初の 1 カットだけ
  const blocks: FitBlock[] = [];
  let cursorFrames = 0;
  let extended = 0;
  let repeated = 0;
  let jumps = 0;
  let guardedCount = 0;
  let fixedCount = 0;
  let dropped = 0;

  // ブロックごとに、何カットに刻むか（k）を先に決める。担うテロップのある run は最低 1、
  // 短くなりすぎる（CUT_TOO_SHORT の 0.6 秒未満）なら減らす
  const plan = segs.map((seg, bi) => {
    const runs = runsOfBlock[bi];
    const wantFrames = audioFramesOf(seg) + (bi === 0 ? leadFrames : 0) + (bi === segs.length - 1 ? tailFrames : 0);
    const fixedFrames = runs.reduce((n, r) => n + (r.kind === 'fixed' ? cutFrames(r.item.cut, fps) : 0), 0);
    const freeRuns = runs.filter((r): r is FreeRun => r.kind === 'free');
    const freeFrames = wantFrames - fixedFrames;
    const must = freeRuns.filter((r) => r.mustShow).length;
    const kMin = freeRuns.length ? Math.max(1, must) : 0;
    let k = 0;
    if (freeRuns.length) {
      const k0 = freeFrames > 0 ? Math.round(freeFrames / targetFrames) : 0;
      k = Math.max(kMin, k0);
      while (k > kMin && freeFrames / k < shortFrames) k--;
    }
    return {runs, wantFrames, fixedFrames, freeRuns, freeFrames, kMin, k, fixedCount: runs.length - freeRuns.length};
  });

  // 動画全体の平均が 0.75〜0.8 秒に入るように k を増減する（ブロック単位の丸めだけだと、1 秒台のブロックが
  // 多いとき平均が 0.9 秒近くに寄る）。増やすのは「増やしても 0.6 秒を切らない」ブロックから、
  // 増やしたあとのカットが長い順。減らすのは、いまのカットが短いブロックから。目標に近づくあいだだけ動かす
  {
    const totalWant = plan.reduce((n, p) => n + p.wantFrames, 0);
    const count = () => plan.reduce((n, p) => n + p.k + p.fixedCount, 0);
    const avg = () => (count() > 0 ? totalWant / count() : 0);
    for (let guard = 0; guard < 500; guard++) {
      const cur = avg();
      let pick: (typeof plan)[number] | null = null;
      let delta = 0;
      if (cur > maxCut * fps + 1e-6) {
        let bestLen = 0;
        for (const p of plan) {
          if (!p.freeRuns.length) continue;
          const len = p.freeFrames / (p.k + 1);
          if (len >= shortFrames && len > bestLen) {
            pick = p;
            bestLen = len;
          }
        }
        delta = 1;
      } else if (cur < minCut * fps - 1e-6) {
        let bestLen = Infinity;
        for (const p of plan) {
          if (p.k <= p.kMin) continue;
          const len = p.freeFrames / p.k;
          if (len < bestLen) {
            pick = p;
            bestLen = len;
          }
        }
        delta = -1;
      }
      if (!pick) break;
      pick.k += delta;
      if (Math.abs(avg() - targetFrames) >= Math.abs(cur - targetFrames)) {
        pick.k -= delta; // 動かしても目標に近づかないならそこで止める
        break;
      }
    }
  }

  segs.forEach((seg, bi) => {
    const {runs, wantFrames, fixedFrames, freeRuns, freeFrames, k} = plan[bi];
    const audioSec = audioOf(seg);
    const perRun = allocateByWeight(
      freeRuns.map((r) => r.durSec),
      k,
      freeRuns.map((r) => (r.mustShow ? 1 : 0)),
    );

    // run → 部分（元カット）→ スロット。担うテロップが 1 カットしか無い run は読めるよう 0.8 秒を守る
    const planned: PlannedSlot[] = [];
    freeRuns.forEach((r, ri) => {
      const n = perRun[ri];
      if (!n) return;
      const perPortion = allocateByWeight(
        r.portions.map((p) => p.to - p.from),
        n,
        r.portions.map(() => (n >= r.portions.length ? 1 : 0)),
      );
      r.portions.forEach((p, pi) => {
        for (let j = 0; j < perPortion[pi]; j++) planned.push({runIndex: ri, portion: p, frames: 0, guarded: r.mustShow && n === 1, mustShow: r.mustShow});
      });
    });
    // 先頭カット（フック）も 0.8 秒未満だと W になるので守る
    if (bi === 0 && runs[0]?.kind === 'free' && planned.length) planned[0].guarded = true;

    const base = k > 0 ? Math.floor(freeFrames / k) : 0;
    let guardSum = 0;
    for (const p of planned) {
      if (!p.guarded) continue;
      p.frames = Math.max(base, guardFrames);
      if (p.frames > base) guardedCount++;
      guardSum += p.frames;
    }
    const others = planned.filter((p) => !p.guarded);
    if (others.length) {
      const remaining = freeFrames - guardSum;
      const each = Math.max(Math.floor(remaining / others.length), shortFrames);
      let rem = Math.max(0, remaining - each * others.length);
      for (const p of others) {
        p.frames = each + (rem > 0 ? 1 : 0);
        if (rem > 0) rem--;
      }
    }

    // 素材の中のどこを使うか（部分ごと）。足りるなら等間隔にずらして置く（ジャンプカット）、
    // 足りなければ元の範囲の外（素材の残り）→ それでも足りなければ重ねて使う
    const byPortion: {portion: Portion; slots: PlannedSlot[]}[] = [];
    for (const p of planned) {
      const last = byPortion[byPortion.length - 1];
      if (last && last.portion === p.portion) last.slots.push(p);
      else byPortion.push({portion: p.portion, slots: [p]});
    }
    const placed: PlacedSlot[] = [];
    for (const {portion, slots} of byPortion) {
      const availTo = availToOf(portion);
      const ds = slots.map((s) => s.frames / fps);
      const needed = ds.reduce((a, b) => a + b, 0);
      const len = portion.to - portion.from;
      const n = slots.length;
      const starts: number[] = [];
      const ends: number[] = [];
      if (needed <= len + 1e-6) {
        const gap = n > 1 ? (len - needed) / (n - 1) : 0;
        if (n > 1 && gap > 1e-6) jumps += n - 1;
        let cursor = portion.from;
        for (const d of ds) {
          starts.push(cursor);
          ends.push(cursor + d);
          cursor += d + gap;
        }
      } else if (portion.from + needed <= availTo + 1e-6) {
        if (portion.from + needed > portion.item.cut.outSec + 1e-6) extended++;
        let cursor = portion.from;
        for (const d of ds) {
          starts.push(cursor);
          ends.push(cursor + d);
          cursor += d;
        }
      } else {
        repeated++;
        const avail = availTo - portion.from;
        ds.forEach((d, j) => {
          const room = Math.max(0, avail - d);
          const st = portion.from + (n > 1 ? (room * j) / (n - 1) : 0);
          starts.push(st);
          ends.push(Math.min(st + d, availTo));
        });
      }
      slots.forEach((s, j) => {
        const inSec = round3(starts[j]);
        // 素材が尽きて縮んだときはその分だけ（最低 1 フレーム）
        const frames = ends[j] - starts[j] + 1e-6 >= s.frames / fps ? s.frames : Math.max(1, Math.floor((availTo - inSec) * fps + 1e-6));
        placed.push({...s, frames, inSec, outSec: outFor(inSec, frames, fps)});
      });
    }

    // 縮んで 0.6 秒に満たない端切れは捨てる（同じ run に他のカットがある・担うテロップでない なら文言は残る）
    for (const p of placed) {
      if (p.frames >= shortFrames) continue;
      const siblings = placed.filter((q) => q !== p && q.runIndex === p.runIndex && q.frames > 0).length;
      if (!p.mustShow || siblings > 0) {
        p.frames = 0;
        dropped++;
      }
    }

    // 素材が尽きて足りないぶんは、各部分の最後のカットを素材の残りへ伸ばして埋める
    let deficit = wantFrames - fixedFrames - placed.reduce((n, p) => n + p.frames, 0);
    if (deficit > 0) {
      const seen = new Set<Portion>();
      for (let i = placed.length - 1; i >= 0 && deficit > 0; i--) {
        const p = placed[i];
        if (p.frames <= 0 || seen.has(p.portion)) continue;
        seen.add(p.portion); // 部分の中で最後に残っているカットだけ伸ばす（途中を伸ばすと次と重なる）
        const room = Math.floor((availToOf(p.portion) - p.outSec) * fps + 1e-6);
        const add = Math.min(room, deficit, Math.max(0, maxSlotFrames - p.frames));
        if (add <= 0) continue;
        p.frames += add;
        p.outSec = outFor(p.inSec, p.frames, fps);
        deficit -= add;
      }
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
      for (const p of placed) {
        if (p.runIndex !== mine || p.frames <= 0) continue;
        const src = p.portion.item.cut;
        const c: Cut = {...src, inSec: p.inSec, outSec: p.outSec};
        delete c.playbackRate; // 刻んだカットは等速（倍速は元の尺を縮める手段だったので要らない）
        delete c.subs;
        if (src.badge && badgeDone.has(p.portion.item.index)) delete c.badge; // バッジはカット頭にポップインするので最初の 1 つだけ
        if (src.badge) badgeDone.add(p.portion.item.index);
        newCuts.push(c);
        sourceIndexOf.push(p.portion.item.index);
        cursorFrames += p.frames;
        blockCuts++;
      }
    }
    const videoFrames = cursorFrames - blockStart;
    blocks.push({
      id: seg.id,
      audioSec: round3(audioSec),
      at: round3((blockStart + (bi === 0 ? leadFrames : 0)) / fps),
      videoSec: round3(videoFrames / fps),
      cutCount: blockCuts,
      shortSec: round3(Math.max(0, wantFrames - videoFrames) / fps),
    });
  });

  if (!newCuts.length) {
    return {ok: false, blockers: ['刻める映像がありません（カットが全部 会話・ロック済み で、ナレーションの窓に掛かっていません）'], cuts, narration, blocks: [], before, after: before, notes: []};
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
        return s ? [{...s, cutId: ids[ni]}] : [];
      })
    : undefined;
  const telopGroups = cuts.meta?.telopGroups?.map((g) => ({...g, cutIds: g.cutIds.flatMap((id) => newIdsOfOld.get(id) ?? [])})).filter((g) => g.cutIds.length);
  const meta = cuts.meta ? {...cuts.meta, ...(slots ? {slots} : {}), ...(telopGroups ? {telopGroups} : {})} : undefined;
  const nextCuts = ReelDataSchema.parse({...cuts, cuts: newCuts, ...(meta ? {meta} : {})});
  const after = statsOf(nextCuts);

  // ── narration: at をブロックの頭へ。効果音は元の窓の中の位置を新しいブロックへ比例で写す ──
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
  const audioTotal = round3(segs.reduce((n, s) => n + audioOf(s), 0));
  const notes: string[] = [];
  notes.push(`ナレーション ${segs.length} ブロック（音声 計 ${audioTotal.toFixed(2)} 秒）に合わせて、${before.cutCount} カット / ${before.totalSec.toFixed(2)} 秒 → ${after.cutCount} カット / ${after.totalSec.toFixed(2)} 秒（平均 ${after.avgCutSec.toFixed(2)} 秒）にしました`);
  for (const b of blocks) notes.push(`  ${b.id}: 音声 ${b.audioSec.toFixed(2)}s → 映像 ${b.videoSec.toFixed(2)}s（${b.cutCount} カット・${b.at.toFixed(2)}s から）${b.shortSec ? ` ! 素材が ${b.shortSec.toFixed(2)} 秒足りません` : ''}`);
  if (fixedCount) notes.push(`  会話・ロック済みの ${fixedCount} カットは刻んでいません`);
  if (guardedCount) notes.push(`  テロップが 1 カットしか無い所とフックは、読めるよう ${TELOP_UNREADABLE_SEC} 秒に伸ばしています（${guardedCount} か所）`);
  if (jumps) notes.push(`  同じ素材の中で場所をずらして続けた所が ${jumps} か所あります（ジャンプカット）`);
  if (extended) notes.push(`  元の区間の外（素材の残り）を使った所が ${extended} か所あります`);
  if (dropped) notes.push(`  素材が尽きて ${CUT_TOO_SHORT_SEC} 秒に満たなかった端切れを ${dropped} か所捨てました（文言は他のカットに残っています）`);
  if (repeated) notes.push(`  ! 素材が短く、同じ場面を重ねて使った所が ${repeated} か所あります。Timeline で別の素材に差し替えてください`);
  if (borrowed.length) notes.push(`  ! ${borrowed.join('・')} は、いまのタイムラインに対応する映像が無かったので隣のカットを借りました`);
  const short = blocks.filter((b) => b.shortSec > 0);
  if (short.length) notes.push(`  ! ${short.map((b) => b.id).join('・')} は素材が尽きて音声より短いままです（次のナレーションと重なります）。素材を足すか文を短くしてください`);
  if (noAudio.length) notes.push(`  ! ${noAudio.join('・')} は音声が無いので文字数からの見積もりで合わせました。音声を作ったらもう一度合わせてください`);
  if (sfxMoved) notes.push(`  効果音 ${sfxMoved} 個の位置をブロックに合わせて動かしました`);
  if (after.avgCutSec > maxCut + 0.05) {
    const single = blocks.filter((b) => b.cutCount === 1).length;
    notes.push(`  ! 平均 ${after.avgCutSec.toFixed(2)} 秒は目標の ${minCut}〜${maxCut} 秒より長めです${single ? `（1 秒前後の短いナレーション ${single} 本は 1 カットにしかできません。文をつなげて 1 ブロックを長くすると刻めます）` : ''}`);
  } else if (after.avgCutSec < minCut - 0.05) notes.push(`  ! 平均 ${after.avgCutSec.toFixed(2)} 秒は目標の ${minCut}〜${maxCut} 秒より短めです（テロップの多いブロックで刻みが細かくなっています）`);
  notes.push('  音声は作り直していません（narration の at をブロックの頭に置き直しただけ）');

  return {ok: true, blockers: [], cuts: nextCuts, narration: nextNarration, blocks, before, after, notes};
};
