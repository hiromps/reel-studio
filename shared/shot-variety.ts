// 構図の重なりと流れ（純粋）。似た構図の素材をまとめ、提供→寄り→シズルの順に並べるための判定。
//
// ユーザー指示（2026-10-03・カニ蔵）:
// - 並びの中に「ほとんど同じ構図」が続くと動きが無く見える。同じような構図は 1 本にまとめ、より鮮明なものを使う
// - 流れは 提供 → 寄り → シズル（持ち上げる・浸ける・垂らす）が大事
// - 同じ素材を 2 カット以上続けて使わない。足りないカットは、その素材の前後に撮った素材（ファイル番号が近いもの）でつなぐ（2026-10-03 追加指示）
// - 素材は 01 から撮影順。フックなど特別な所以外は撮影順を参考に並べ、選んだ素材はなるべく全部使う
// - 1 カットは 0.70〜0.80 秒
//
// 似ているかは、まず見た目の指紋（core/look.ts が測る catalog の look）で決める。無ければタグ（被写体・画角・種別）で代わりに決める。
import type {Clip} from './schema/catalog';

/** 見た目の指紋の距離（0〜255 の平均絶対差）がこれ以下なら同じ構図。カニ蔵の実素材で、卓上全景どうしが 31 以下・カニ桶どうしが 32 以下、寄りの別料理どうしは 36 以上 */
export const SIMILAR_LOOK_MAX = 33;

/** 似た構図を探す範囲（何カット前まで見るか）。遠く離れていれば同じ構図でもよい（冒頭と締めで同じ全景を使う等） */
export const SIMILAR_WINDOW = 3;

export type ShotStage = 'serve' | 'close' | 'sizzle';
/** 提供 → 寄り → シズル */
export const STAGE_ORDER: Record<ShotStage, number> = {serve: 0, close: 1, sizzle: 2};
export const STAGE_LABEL: Record<ShotStage, string> = {serve: '提供', close: '寄り', sizzle: 'シズル'};

const sigCache = new Map<string, Uint8Array>();
const decodeSig = (s: string): Uint8Array | null => {
  const hit = sigCache.get(s);
  if (hit) return hit;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    if (sigCache.size > 2000) sigCache.clear();
    sigCache.set(s, out);
    return out;
  } catch {
    return null;
  }
};

/** 見た目の指紋の距離。どちらかが測っていなければ null */
export const lookDistance = (a: Clip, b: Clip): number | null => {
  if (!a.look || !b.look) return null;
  const x = decodeSig(a.look.sig);
  const y = decodeSig(b.look.sig);
  if (!x || !y || x.length !== y.length || !x.length) return null;
  let s = 0;
  for (let i = 0; i < x.length; i++) s += Math.abs(x[i] - y[i]);
  return s / x.length;
};

/** 同じ構図か。同じクリップは常に同じ。指紋があれば指紋、無ければ「被写体・画角・種別がすべて同じ」 */
export const isSimilarShot = (a: Clip, b: Clip): boolean => {
  if (a.id === b.id) return true;
  const d = lookDistance(a, b);
  if (d !== null) return d <= SIMILAR_LOOK_MAX;
  const ta = a.tags;
  const tb = b.tags;
  if (!ta || !tb) return false;
  return !!ta.subject.trim() && ta.subject.trim() === tb.subject.trim() && ta.angle === tb.angle && ta.kind === tb.kind;
};

/** 動き（シズル）を表す言葉。説明文にあればシズルの段とみなす */
const ACTION_WORDS = /持ち上げ|箸上げ|すくい|浸け|つけ|漬け|垂ら|垂れ|注|かけ|割る|割っ|伸び|とろけ|溶け|焼|炙|沸|湯気|頬張|かぶりつ|ほぐ|引き上げ|絡め|混ぜ/;

/**
 * 流れの段。提供（置く・全体）→ 寄り（料理のアップ）→ シズル（持ち上げる・浸ける・垂らす・食べる）。
 * タグが無ければ提供の扱い（先頭寄りに置く）
 */
export const shotStage = (c: Clip): ShotStage => {
  const t = c.tags;
  if (!t) return 'serve';
  if (t.kind === 'eating' || t.kind === 'cooking' || t.motion === 'action') return 'sizzle';
  // 提供（serving）は手で持ち上げて見せていても提供の画（桶を差し出す等）。シズル・ディテールで動きがあればシズル
  if (t.kind !== 'serving' && t.angle !== 'wide' && ACTION_WORDS.test(t.description)) return 'sizzle';
  if (t.angle !== 'wide' && (t.angle === 'close' || t.kind === 'sizzle' || t.kind === 'detail')) return 'close';
  return 'serve';
};

/** 使える範囲（avoid を除いた区間の最初〜最後）。usableRanges が無ければ長回しは頭尾 0.2 秒を避ける（plan.ts の既定と同じ） */
export const usableSpan = (c: Clip): {inSec: number; outSec: number} => {
  const dur = c.probe.durationSec;
  const rs = c.usableRanges.filter((r) => r.label !== 'avoid' && r.outSec > r.inSec);
  if (rs.length) return {inSec: Math.max(0, Math.min(...rs.map((r) => r.inSec))), outSec: Math.min(dur, Math.max(...rs.map((r) => r.outSec)))};
  const margin = dur >= 2.5 ? 0.2 : 0;
  return {inSec: margin, outSec: Math.max(margin, dur - margin)};
};

/** 撮影順の番号（id は 01 から撮影順）。数字でなければ null */
export const clipSeq = (c: Pick<Clip, 'id'>): number | null => {
  const n = Number(c.id);
  return Number.isFinite(n) ? n : null;
};

/** 撮影順でどれだけ離れているか（近いほど同じ場面の前後）。比べる相手が無ければ Infinity */
export const seqGap = (c: Clip, anchors: readonly Clip[]): number => {
  const a = clipSeq(c);
  if (a === null) return Infinity;
  let best = Infinity;
  for (const x of anchors) {
    const b = clipSeq(x);
    if (b !== null && x.id !== c.id) best = Math.min(best, Math.abs(a - b));
  }
  return best;
};

/** 鮮明さの比較（大きいほど先）。指紋が無ければタグの quality で代える */
export const sharperFirst = (a: Clip, b: Clip): number => {
  const sa = a.look?.sharp;
  const sb = b.look?.sharp;
  if (sa !== undefined && sb !== undefined && sa !== sb) return sb - sa;
  return (b.tags?.quality ?? 0) - (a.tags?.quality ?? 0) || (b.tags?.sizzleScore ?? 0) - (a.tags?.sizzleScore ?? 0);
};

export type ShotGroup = {ids: string[]; sharpest: string};

/**
 * 似た構図のまとまり（AI への素材一覧に添える）。鮮明な順に見て、代表（最も鮮明）に似ていれば同じまとまりに入れる
 * （数珠つなぎで別の構図まで巻き込まないよう、比べるのは代表とだけ）。2 本以上のまとまりだけ返す
 */
export const shotGroups = (clips: readonly Clip[]): ShotGroup[] => {
  const sorted = [...clips].sort((a, b) => sharperFirst(a, b) || a.id.localeCompare(b.id, 'en', {numeric: true}));
  const groups: {rep: Clip; members: Clip[]}[] = [];
  for (const c of sorted) {
    const g = groups.find((x) => isSimilarShot(x.rep, c));
    if (g) g.members.push(c);
    else groups.push({rep: c, members: [c]});
  }
  return groups
    .filter((g) => g.members.length > 1)
    .map((g) => ({ids: [...g.members].map((m) => m.id).sort((a, b) => a.localeCompare(b, 'en', {numeric: true})), sharpest: g.rep.id}))
    .sort((a, b) => a.ids[0].localeCompare(b.ids[0], 'en', {numeric: true}));
};

/** 素材一覧の行に添える注記（「似た構図: 25,26,27（この中で最も鮮明）」） */
export const shotGroupNote = (groups: readonly ShotGroup[], id: string): string => {
  const g = groups.find((x) => x.ids.includes(id));
  if (!g) return '';
  return `似た構図: ${g.ids.join(',')}${g.sharpest === id ? '（この中で最も鮮明）' : `（最も鮮明なのは ${g.sharpest}）`}`;
};

/** AI に渡す並べ方の規則（台本の組み立て・型を写す・並び替えで共通） */
export const VARIETY_RULES: readonly string[] = [
  '同じ素材（同じ id）を 2 カット以上続けて使わない。1 つの素材は 1 カットだけ使う',
  '素材の id は 01 から撮影順。フックなど特別な所以外は撮影順（id の小さい順）を参考に並べ、前後に撮った素材どうしをつないで一貫性を出す',
  '選んだ素材（使える素材）はなるべく全部使う。外すのは「似た構図」の重なりと NG だけ',
  '「似た構図」に書いた素材どうしは同じ画に見える。近い位置（3 カット以内）には 1 本だけ置き、その中で最も鮮明なものを使う',
  '料理ごとに 提供（置く・全体）→ 寄り（アップ）→ シズル（持ち上げる・浸ける・垂らす・頬張る）の流れにする。同じ構図を続けて動きを止めない',
  '1 カットは 0.7〜0.8 秒。カットの数が足りないときは同じ素材を刻まず、その前後に撮った別の構図の素材で足す',
];

// ───────────────────────── 足りないカットを補う素材を選ぶ ─────────────────────────

const bigrams = (s: string): Set<string> => {
  const t = s.replace(/[\s、。・「」（）()／/,，.!！?？〜~ー-]/g, '');
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};

/** 文脈（テロップ・ナレーション・近くの素材の被写体）との近さ。0〜1 */
export const relevance = (c: Clip, context: string): number => {
  const ctx = bigrams(context);
  if (!ctx.size || !c.tags) return 0;
  const own = bigrams(`${c.tags.subject} ${c.tags.description}`);
  let hit = 0;
  for (const g of own) if (ctx.has(g)) hit++;
  return Math.min(1, hit / 4);
};

/** 補いに使ってよい種別（料理の画だけ。人物・看板・外観・会話は文脈を壊すので使わない） */
const SUPPLEMENT_KINDS = new Set(['serving', 'sizzle', 'eating', 'cooking', 'detail']);

export const isSupplementCandidate = (c: Clip, minSec: number, untaggedOk = false): boolean => {
  const t = c.tags;
  if (c.user.ng) return false;
  if (!t) return untaggedOk && !(c.speech?.length) && usableSpan(c).outSec - usableSpan(c).inSec >= minSec;
  if (t.signage || t.hasSpeech || (c.speech?.length ?? 0) > 0) return false;
  if (!SUPPLEMENT_KINDS.has(t.kind)) return false;
  const s = usableSpan(c);
  return s.outSec - s.inSec >= minSec;
};

export type SupplementQuery = {
  /** 候補（catalog の素材） */
  candidates: readonly Clip[];
  /** もう使っている素材（動画のどこかに出ている）。候補から外す */
  usedIds: ReadonlySet<string>;
  /** 近く（前後 SIMILAR_WINDOW カット）に出ている素材。これと似た構図は外す */
  nearby: readonly Clip[];
  /** 動画のどこかに出ている素材。似た構図は後回しにする */
  used: readonly Clip[];
  /** 欲しい段（直前の段の次）。合えば加点 */
  wantStage?: ShotStage;
  /** 文脈（テロップ・ナレーション・近くの素材の被写体） */
  context: string;
  /** 撮影順の基準（この区間に出ている素材）。前後に撮った素材ほど先に選ぶ */
  anchors: readonly Clip[];
  /** 1 カットに要る秒数 */
  minSec: number;
};

/**
 * 足りないカットを補う素材を 1 本選ぶ。無ければ null。
 * 近くに似た構図があるものは使わない。シズル感・文脈・欲しい段・鮮明さで選ぶ（乱数なし）
 */
export const pickSupplement = (q: SupplementQuery): Clip | null => {
  // 未タグの素材は中身が分からないので、撮影順ですぐ隣（2 本以内）のものだけ使う（同じ場面の前後のはず）
  const pool = q.candidates.filter((c) => !q.usedIds.has(c.id) && isSupplementCandidate(c, q.minSec, seqGap(c, q.anchors) <= 2) && !q.nearby.some((n) => isSimilarShot(n, c)));
  if (!pool.length) return null;
  const score = (c: Clip): number => {
    const t = c.tags;
    let s = 0;
    // 撮影順で前後に撮った素材ほど一貫性が出る（隣 +12、2 本先 +9、3 本先 +6 …）
    const gap = seqGap(c, q.anchors);
    if (Number.isFinite(gap)) s += Math.max(0, 15 - 3 * gap);
    s += 10 * ((t?.sizzleScore ?? 3) / 5);
    s += 4 * ((t?.quality ?? 3) / 5);
    s += 8 * relevance(c, q.context);
    if (q.wantStage && shotStage(c) === q.wantStage) s += 5;
    if (shotStage(c) === 'sizzle') s += 2; // 迷ったらシズル感のあるもの
    if (q.used.some((u) => isSimilarShot(u, c))) s -= 6; // 離れていても同じ構図は後回し
    return s;
  };
  return (
    [...pool].sort((a, b) => score(b) - score(a) || sharperFirst(a, b) || a.id.localeCompare(b.id, 'en', {numeric: true}))[0] ?? null
  );
};

/** 直前の段の次に欲しい段（提供 → 寄り → シズル → シズル） */
export const nextStage = (prev: ShotStage | undefined): ShotStage => (prev === 'serve' ? 'close' : prev === 'close' ? 'sizzle' : prev === 'sizzle' ? 'sizzle' : 'serve');
