// テロップ文の計測・禁則（telop-style.md の規則を関数化）。

/** 文字数（コードポイント単位。「・・・」は 3 文字として数える） */
export const countChars = (text: string): number => Array.from(text).length;

export const PLACEHOLDER_RE = /\{\{[^}]*\}\}/;
export const isPlaceholder = (text: string): boolean => PLACEHOLDER_RE.test(text);

/** プレースホルダ "{{g03:access}}" → {group:"g03", intent:"access"} */
export const parsePlaceholder = (text: string): {group: string; intent: string} | null => {
  const m = /^\{\{([^:}]+)(?::([^}]*))?\}\}$/.exec(text.trim());
  if (!m) return null;
  return {group: m[1], intent: m[2] ?? ''};
};

export const hasTrailingPeriod = (text: string): boolean => /[。．.]\s*$/.test(text);

const EMOJI_RE = /\p{Extended_Pictographic}/u;

/** 禁則文字（半角括弧・絵文字）。見つかった文字の配列を返す */
export const forbiddenChars = (text: string): string[] => {
  const found: string[] = [];
  for (const ch of Array.from(text)) {
    if (ch === '(' || ch === ')') found.push(ch);
    else if (EMOJI_RE.test(ch)) found.push(ch);
  }
  return found;
};

/** 正確な価格表記（「540円」「1,500円」等）。「千円台」「5千円前後」は対象外 */
export const EXACT_PRICE_RE = /\d{1,3}(,\d{3})+円|\d{3,}円/;
export const hasExactPrice = (text: string): boolean => EXACT_PRICE_RE.test(text);

/** 最低表示時間（秒）= max(floor, 文字数 × secPerChar) */
export const minDisplaySec = (text: string, opt: {secPerChar?: number; floorSec?: number} = {}): number => {
  const secPerChar = opt.secPerChar ?? 0.25;
  const floorSec = opt.floorSec ?? 1.2;
  return Math.max(floorSec, countChars(text) * secPerChar);
};

export const ellipsisCount = (text: string): number => (text.match(/・・・|…/g) ?? []).length;

/**
 * 「エリア名＋一桁数字」型のフックか（persona.hookStyle = areaDigit の人格）。
 * エリア名をバッジに出すようになったので、**本文に一桁数字があれば型として満たす**
 * （「9割が知らない」だけでも、バッジに「生野区」が出ていれば「生野区の9割が知らない」と読める）。
 */
export const looksLikeAreaDigitHook = (text: string, hasAreaBadge = false): boolean =>
  hasAreaBadge ? /[1-9１-９]/.test(text) : /[、,].*[1-9１-９]|[1-9１-９]割/.test(text);

/** エリア名のあとに来る助詞・区切り。「生野区、」「梅田で」「西九条の」など */
const AREA_TAIL = /^[、,，･・\s]*(?:で|の|に|には|だと|なら)?[、,，･・\s]*/;

/**
 * フック本文の頭がエリア名かどうか。頭にあるときだけ「バッジへ移す」対象にする
 * （文中の地名は言い回しの一部なので触らない）。
 */
export const leadingArea = (text: string, area: string): {matched: boolean; rest: string} => {
  const t = text.trim();
  const a = area.trim();
  if (!a || !t.startsWith(a)) return {matched: false, rest: t};
  const rest = t.slice(a.length).replace(AREA_TAIL, '').trim();
  // 残りが無い（＝本文がエリア名だけ）ときは移しても本文が空になるので対象外
  return rest ? {matched: true, rest} : {matched: false, rest: t};
};
