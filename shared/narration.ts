// narration.json の並びを点検する（重なり・無音・尺はみ出し）。GUI と core/tts.ts で同じ判定を使う。
import type {Narration, NarrationSegment} from './schema/narration';

/**
 * ブロック同士の重なりを許容する秒数。
 *
 * Fish Audio の wav は前後にそれぞれ 0.09 秒前後の無音が付く（実測：01_hook.wav は
 * 冒頭 0.097 秒・末尾 0.089 秒が -45dB 以下）。durSec はその無音込みのファイル長なので、
 * 「前のブロックの durSec 終端」と次の at が 0.1 秒くらい重なっても、実際に喋っている
 * 区間は重ならない。ここを 0 にすると鳴らない重なりを毎回警告してしまう。
 */
export const OVERLAP_TOLERANCE_SEC = 0.15;

/** 2 ブロックの間にこれ以上の空きがあると「無音」として警告する */
export const SILENCE_WARN_SEC = 2;

/** 動画尺をこれ以上はみ出すと警告する */
export const OVERRUN_TOLERANCE_SEC = 0.05;

export type NarrationCheckOptions = {
  /** durSec が無いブロックの秒数見積もり（人格の charsPerSec から出す） */
  estimate: (seg: NarrationSegment) => number;
  /** 動画尺。省略時は narration.videoSec */
  videoSec?: number;
  /** 本文が空のブロックも指摘する（GUI の編集中だけ使う） */
  emptyText?: boolean;
};

/**
 * TTS が読み違えやすい表記 → 読ませたい表記。ナレーション本文は「読み方が一つに決まらない漢字・単位記号は
 * かなに開く」が規則（テロップは対象外）。実例：「牛すじ」が「うしすじ」と読まれた（焼肉伍龍・2026-09-13）。
 * 完全一致で置き換えられるものだけ載せる（文脈で読みが変わる単漢字は載せない＝誤置換の方が害が大きい）。
 */
export const TTS_MISREAD_WORDS: readonly [string, string][] = [
  ['牛すじ', 'ぎゅうすじ'],
  ['牛スジ', 'ぎゅうすじ'],
  ['牛タン', 'ぎゅうタン'],
  ['牛肉', 'ぎゅうにく'],
  ['牛丼', 'ぎゅうどん'],
  ['牛脂', 'ぎゅうし'],
  ['和牛', 'わぎゅう'],
  ['黒毛和牛', 'くろげわぎゅう'],
  ['生ビール', 'なまビール'],
  ['生肉', 'なまにく'],
  ['生卵', 'なまたまご'],
  ['生中', 'なまちゅう'],
  ['大盛り', 'おおもり'],
  ['大盛', 'おおもり'],
  ['中盛り', 'なかもり'],
  ['小盛り', 'こもり'],
  ['一人前', 'いちにんまえ'],
  ['二人前', 'ににんまえ'],
  ['三人前', 'さんにんまえ'],
  ['上ロース', 'じょうロース'],
  ['上ハラミ', 'じょうハラミ'],
  ['上ミノ', 'じょうミノ'],
  ['並盛', 'なみもり'],
  ['角打ち', 'かくうち'],
  ['丁目', 'ちょうめ'],
];

/** 半角の単位記号（数字に続くもの）→ かな。「350g」を「350ぐらむ」ではなく「350グラム」と読ませる */
const UNIT_KANA: readonly [RegExp, string][] = [
  [/(\d+(?:\.\d+)?)kg\b/gi, '$1キロ'],
  [/(\d+(?:\.\d+)?)g\b/gi, '$1グラム'],
  [/(\d+(?:\.\d+)?)ml\b/gi, '$1ミリリットル'],
  [/(\d+(?:\.\d+)?)cc\b/gi, '$1シーシー'],
  [/(\d+(?:\.\d+)?)cm\b/gi, '$1センチ'],
  [/(\d+(?:\.\d+)?)mm\b/gi, '$1ミリ'],
  [/(\d+(?:\.\d+)?)km\b/gi, '$1キロ'],
  [/(\d+(?:\.\d+)?)%/g, '$1パーセント'],
];

export type ReadingHint = {from: string; to: string};

/** 本文の中で TTS が誤読しやすい箇所と、かなに開いた候補（本文に出てくる順）。無ければ空 */
export const ttsReadingHints = (text: string): ReadingHint[] => {
  const found: (ReadingHint & {at: number})[] = [];
  const seen = new Set<string>();
  // 長い語から当てる（「黒毛和牛」を「和牛」で先に拾わない）
  for (const [from, to] of [...TTS_MISREAD_WORDS].sort((a, b) => b[0].length - a[0].length)) {
    const at = text.indexOf(from);
    if (at < 0 || seen.has(from)) continue;
    if ([...seen].some((s) => s.includes(from))) continue; // すでに長い語で拾った部分
    seen.add(from);
    found.push({from, to, at});
  }
  for (const [re, rep] of UNIT_KANA) {
    for (const m of text.matchAll(re)) {
      const from = m[0];
      if (seen.has(from)) continue;
      seen.add(from);
      found.push({from, to: from.replace(new RegExp(re.source, re.flags.replace('g', '')), rep), at: m.index ?? 0});
    }
  }
  return found.sort((a, b) => a.at - b.at).map(({from, to}) => ({from, to}));
};

/** 誤読しやすい箇所をかなに開いた本文（ユーザーが「開く」を押したとき用） */
export const applyReadingHints = (text: string): string => ttsReadingHints(text).reduce((t, h) => t.split(h.from).join(h.to), text);

/** 重なり・無音・尺はみ出し・誤読しやすい表記を日本語の 1 行にして返す */
export const checkNarration = (narration: Narration, opt: NarrationCheckOptions): string[] => {
  const out: string[] = [];
  for (const seg of narration.segments) {
    const hints = ttsReadingHints(seg.text);
    if (hints.length) out.push(`${seg.id}: TTS が誤読しやすい表記 ${hints.map((h) => `「${h.from}」→「${h.to}」`).join('・')}（かなに開いてください）`);
  }
  const sorted = [...narration.segments].sort((a, b) => a.at - b.at);
  const sec = (s: NarrationSegment) => s.durSec ?? opt.estimate(s);
  sorted.forEach((seg, i) => {
    if (opt.emptyText && !seg.text.trim()) out.push(`${seg.id}: 本文が空です`);
    const prev = sorted[i - 1];
    if (!prev) return;
    const end = prev.at + sec(prev);
    const gap = seg.at - end;
    // ちょうど許容ぶんだけ重なっている値（自動調整の出力など）が浮動小数の誤差で
    // 引っかからないよう、1ms の余裕を持たせる
    if (gap < -OVERLAP_TOLERANCE_SEC - 0.001) out.push(`${seg.id}: ${prev.id} の読み終わり（${end.toFixed(2)}s）と ${(-gap).toFixed(2)} 秒重なります`);
    else if (gap >= SILENCE_WARN_SEC) out.push(`${prev.id} と ${seg.id} の間に ${gap.toFixed(1)} 秒の無音があります`);
  });
  const last = sorted[sorted.length - 1];
  const videoSec = opt.videoSec ?? narration.videoSec;
  if (last && videoSec && last.at + sec(last) > videoSec + OVERRUN_TOLERANCE_SEC) out.push(`最後の ${last.id} が動画尺 ${videoSec.toFixed(2)} 秒を ${(last.at + sec(last) - videoSec).toFixed(2)} 秒はみ出します`);
  return out;
};

// ───────────────────────── 重なりの自動調整 ─────────────────────────

export type NarrationFix = {
  segments: NarrationSegment[];
  /** 動かしたブロック（元の at → 新しい at） */
  moved: {id: string; from: number; to: number}[];
  /** 直しきれずに動画尺をはみ出す秒数（0 なら収まった） */
  overrunSec: number;
  /** 人が読む説明 */
  notes: string[];
};

/**
 * 重なりを `at` を後ろにずらすだけで解消する。**音声は作り直さない**（at は混合時の配置位置なので）。
 *
 * 方針:
 * - **前へは動かさない。** at はその文が指す映像に合わせて置いてあるので、勝手に早めると絵と合わなくなる
 * - ずらす量は最小限。前のブロックの読み終わりの直後（無音ぶんの重なりは許容）に置く
 * - それでも動画尺に収まらないぶんは `overrunSec` で返す。**文を短くするしかない**ので、勝手に消さずに報告する
 */
export const fixNarrationOverlaps = (narration: Narration, opt: NarrationCheckOptions): NarrationFix => {
  const sec = (s: NarrationSegment) => s.durSec ?? opt.estimate(s);
  const sorted = [...narration.segments].sort((a, b) => a.at - b.at);
  const moved: NarrationFix['moved'] = [];
  const notes: string[] = [];
  let cursor = 0;

  const fixed = sorted.map((s) => {
    // 元の at より前には出さない。重なるときだけ後ろへ
    const at = Math.max(s.at, cursor);
    if (at - s.at > 0.001) moved.push({id: s.id, from: s.at, to: Math.round(at * 1000) / 1000});
    // 前後の無音ぶん（OVERLAP_TOLERANCE_SEC）は重なってよいので、その分だけ次を早く始められる
    cursor = at + sec(s) - OVERLAP_TOLERANCE_SEC;
    return {...s, at: Math.round(at * 1000) / 1000};
  });

  const last = fixed[fixed.length - 1];
  const videoSec = opt.videoSec ?? narration.videoSec;
  const end = last ? last.at + sec(last) : 0;
  const overrunSec = videoSec && end > videoSec + OVERRUN_TOLERANCE_SEC ? Math.round((end - videoSec) * 1000) / 1000 : 0;

  if (!moved.length) notes.push('動かす必要のあるブロックはありませんでした');
  else {
    notes.push(`${moved.length} ブロックを後ろにずらしました（音声の作り直しは不要です）`);
    for (const m of moved) notes.push(`  ${m.id}: ${m.from.toFixed(2)}s → ${m.to.toFixed(2)}s（+${(m.to - m.from).toFixed(2)}s）`);
    const far = moved.filter((m) => m.to - m.from >= 1);
    if (far.length) notes.push(`  ! ${far.map((m) => m.id).join('・')} は 1 秒以上ずれました。読みと映像が合っているか確認してください`);
  }
  if (overrunSec) notes.push(`! ${overrunSec.toFixed(2)} 秒が動画尺に収まりません。**文を短くする**か、動画を長くする必要があります（勝手には削りません）`);
  return {segments: fixed, moved, overrunSec, notes};
};
