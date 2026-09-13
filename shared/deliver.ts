// 納品ファイルの名前付け。純粋（ファイルは触らない）。
//
// 納品物は outputs/ に置く。**名前だけ見て「どの店・どの人格・ナレーションの有無」が分かること**が
// 要件（過去にナレーション未合成のまま納品して保存率が落ちた事故があるため、有無を名前に出す）。
// 既存の outputs/ の多数派に合わせた形:
//   <店名>_<人格>_ナレーション付き.mp4 / <店名>_<人格>_ナレーションなし.mp4 / <店名>_<人格>_caption.txt

/** 納品物の種類 */
export type DeliverKind = 'narration' | 'silent' | 'caption';

export const DELIVER_LABEL: Record<DeliverKind, string> = {
  narration: 'ナレーション付き',
  silent: 'ナレーションなし',
  caption: 'caption',
};

export const DELIVER_EXT: Record<DeliverKind, string> = {
  narration: '.mp4',
  silent: '.mp4',
  caption: '.txt',
};

/** Windows で使えない文字と、前後の空白・ドットを落とす。店名そのものは変えない（勝手に短くしない） */
export const safeFileName = (s: string): string =>
  s
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .trim();

/**
 * 納品ファイル名。version は 2 以上のときだけ `_v2` が付く（既存を上書きしないため）。
 * label は「修正版」「送料無料強調」のような任意の追記。
 */
export const deliverFileName = (opt: {shop: string; persona: string; kind: DeliverKind; version?: number; label?: string}): string => {
  const shop = safeFileName(opt.shop) || '案件';
  const parts = [shop, opt.persona, DELIVER_LABEL[opt.kind]];
  if (opt.label?.trim()) parts.push(safeFileName(opt.label));
  if (opt.version && opt.version > 1) parts.push(`v${opt.version}`);
  return `${parts.join('_')}${DELIVER_EXT[opt.kind]}`;
};

/** 案件フォルダ内の、その種類の元ファイル（プロジェクト相対） */
export const deliverSource = (kind: DeliverKind): string =>
  kind === 'narration' ? 'out/final_narration.mp4' : kind === 'silent' ? 'out/final.mp4' : 'caption.txt';
