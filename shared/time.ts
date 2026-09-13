/**
 * 時刻の**表示とファイル名**は日本時間（JST）で揃える。
 *
 * 保存する値は今まで通り `new Date().toISOString()`（UTC）のまま触らない。
 * あれは機械が読むもので、どこで書いても同じ瞬間を指すので正しい。
 * 問題は、それを人に見せるときに UTC のまま切り出していたこと
 * （`iso.slice(11, 19)`）で、17:47 に押したジョブが 08:47 と表示され、
 * 午前 9 時前は日付まで前日になっていた。
 *
 * ここでは OS のタイムゾーン設定に頼らず Asia/Tokyo を明示する。
 * 別のタイムゾーンに変えるときは TIME_ZONE の 1 行だけ直せばよい。
 */
export const TIME_ZONE = 'Asia/Tokyo';

const FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

type Parts = {y: string; mo: string; d: string; h: string; mi: string; s: string};

const partsOf = (input: Date | string | number | undefined): Parts | null => {
  if (input === undefined) return null;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const o: Record<string, string> = {};
  for (const p of FORMATTER.formatToParts(d)) if (p.type !== 'literal') o[p.type] = p.value;
  return {y: o.year, mo: o.month, d: o.day, h: o.hour, mi: o.minute, s: o.second};
};

/** '2026-09-13'。日付が取れなければ空文字（表示側で分岐させないため） */
export const localDate = (input: Date | string | number | undefined): string => {
  const p = partsOf(input);
  return p ? `${p.y}-${p.mo}-${p.d}` : '';
};

/** '17:47:31'（withSeconds=false なら '17:47'） */
export const localTime = (input: Date | string | number | undefined, withSeconds = true): string => {
  const p = partsOf(input);
  if (!p) return '';
  return withSeconds ? `${p.h}:${p.mi}:${p.s}` : `${p.h}:${p.mi}`;
};

/** '2026-09-13 17:47'（withSeconds=true なら秒まで） */
export const localDateTime = (input: Date | string | number | undefined, withSeconds = false): string => {
  const p = partsOf(input);
  if (!p) return '';
  return `${p.y}-${p.mo}-${p.d} ${localTime(input, withSeconds)}`;
};

/**
 * ファイル名用のスタンプ '20260913-174731'。
 * 辞書順＝時系列順になるので、バックアップの間引き（古い順に消す）がそのまま動く。
 */
export const fileStamp = (input: Date | string | number = new Date()): string => {
  const p = partsOf(input);
  if (!p) return fileStamp(new Date());
  return `${p.y}${p.mo}${p.d}-${p.h}${p.mi}${p.s}`;
};
