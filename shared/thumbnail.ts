// サムネイル（投稿のカバー画像）の中身を決める。純粋（ファイルは触らない）ので、画面・サーバー・クラウドから同じものを使う。
//
// 型は決まっている（参考: 大阪グルメのカバー画像）:
//   上  … 英字の地名（OSAKA）
//   左  … 縦書きの「地域×エリア」（大阪×天満）
//   下  … 大きな横書きのキャッチ（神コスパ寿司酒場）
//   背景 … 動画の 1 コマ
// cuts.json の `thumbnail` に書いたものが優先で、空欄は brief とカットから埋める。
// 描くのは engine/src/Thumbnail.tsx。そちらには**ここで埋め終わったもの**を渡す。
import type {Brief} from './schema/brief';
import type {Crop, Cut, ReelData, ThumbnailDef} from './schema/cuts';
import {isPlaceholder} from './telop-text';

/** 英字・縦書きの地名が決められないときの既定（このスタジオの主戦場） */
export const DEFAULT_REGION = {ja: '大阪', en: 'OSAKA'} as const;

/**
 * エリア名 → 地域。上から順に「含まれていれば」当てる（長い名前を先に書く）。
 * 都道府県・大都市と、よく出る繁華街だけ。ここに無いエリアは DEFAULT_REGION になる。
 */
const REGIONS: {keys: string[]; ja: string; en: string}[] = [
  {keys: ['神戸', '三宮', '三ノ宮', '元町', '北野'], ja: '神戸', en: 'KOBE'},
  {keys: ['京都', '祇園', '河原町', '四条', '烏丸', '嵐山', '先斗町'], ja: '京都', en: 'KYOTO'},
  {keys: ['奈良'], ja: '奈良', en: 'NARA'},
  {keys: ['和歌山'], ja: '和歌山', en: 'WAKAYAMA'},
  {keys: ['滋賀', '大津'], ja: '滋賀', en: 'SHIGA'},
  {keys: ['兵庫', '姫路', '尼崎', '西宮', '芦屋'], ja: '兵庫', en: 'HYOGO'},
  {keys: ['東京', '渋谷', '新宿', '銀座', '六本木', '池袋', '表参道', '恵比寿', '浅草', '上野', '中目黒'], ja: '東京', en: 'TOKYO'},
  {keys: ['横浜'], ja: '横浜', en: 'YOKOHAMA'},
  {keys: ['名古屋'], ja: '名古屋', en: 'NAGOYA'},
  {keys: ['福岡', '博多', '天神', '中洲'], ja: '福岡', en: 'FUKUOKA'},
  {keys: ['札幌', 'すすきの'], ja: '札幌', en: 'SAPPORO'},
  {keys: ['仙台'], ja: '仙台', en: 'SENDAI'},
  {keys: ['広島'], ja: '広島', en: 'HIROSHIMA'},
  {keys: ['沖縄', '那覇'], ja: '沖縄', en: 'OKINAWA'},
  {keys: ['金沢'], ja: '金沢', en: 'KANAZAWA'},
  {keys: ['大阪', '梅田', '難波', 'なんば', '心斎橋', '天満', '北新地', '天王寺', '福島', '谷町', '本町', '堺'], ja: '大阪', en: 'OSAKA'},
];

export const regionOf = (...texts: (string | undefined)[]): {ja: string; en: string} => {
  const hay = texts.filter(Boolean).join(' ');
  for (const r of REGIONS) if (r.keys.some((k) => hay.includes(k))) return {ja: r.ja, en: r.en};
  return {...DEFAULT_REGION};
};

/** 「大阪×天満」。エリアが地域名そのもの（大阪・京都など）か空なら地域名だけ */
export const sideTextOf = (regionJa: string, area?: string): string => {
  const a = (area ?? '').trim();
  if (!a || a === regionJa || a.startsWith(regionJa)) return a || regionJa;
  return `${regionJa}×${a}`;
};

/** 下の横書きの既定。短いジャンル → 最初のテロップ → 店名 */
export const titleTextOf = (brief: Pick<Brief, 'shop'> | null | undefined, cuts: Pick<ReelData, 'cuts'> | null | undefined): string => {
  const genre = brief?.shop.genre?.trim() ?? '';
  if (genre && Array.from(genre).length <= 10) return genre;
  const hook = cuts?.cuts.map((c) => c.main?.text?.trim() ?? '').find((t) => t && !isPlaceholder(t));
  if (hook && Array.from(hook).length <= 12) return hook;
  return brief?.shop.name?.trim() ?? '';
};

export type ThumbnailBg = {src: string; atSec: number; crop?: Crop};

/**
 * 背景の既定。料理が出るカット（構成の役割が reveal → sizzle）の真ん中、無ければ 1 カット目の真ん中。
 * 会話カット（subs）は人物の顔になりやすいので後回しにする。
 */
export const defaultBgOf = (cuts: Pick<ReelData, 'cuts' | 'meta'> | null | undefined): ThumbnailBg | null => {
  const list = cuts?.cuts ?? [];
  if (!list.length) return null;
  const roleOf = (c: Cut) => cuts?.meta?.slots?.find((s) => s.cutId === c.id)?.role;
  const pick = list.find((c) => roleOf(c) === 'reveal') ?? list.find((c) => roleOf(c) === 'sizzle') ?? list.find((c) => !c.subs?.length) ?? list[0];
  return bgFromCut(pick, (pick.outSec - pick.inSec) / 2);
};

/** カットの中の位置（カット頭からの素材秒）を背景にする。切り出しはカットのものを引き継ぐ */
export const bgFromCut = (cut: Pick<Cut, 'src' | 'inSec' | 'outSec' | 'crop'>, offsetSec: number): ThumbnailBg => {
  const at = Math.min(Math.max(cut.inSec, cut.inSec + offsetSec), Math.max(cut.inSec, cut.outSec - 0.05));
  const bg: ThumbnailBg = {src: cut.src, atSec: Math.round(at * 1000) / 1000};
  if (cut.crop) bg.crop = cut.crop;
  return bg;
};

/**
 * 背景のコマが動画の何秒目にあたるか（タイムラインにピンを立てるため）。
 * 同じ素材を複数のカットで使っていれば、その秒を含む最初のカット。どのカットにも無ければ null
 */
export const bgTimelineSec = (cuts: Pick<ReelData, 'cuts'>, bg: ThumbnailBg | null | undefined): number | null => {
  if (!bg) return null;
  let start = 0;
  for (const c of cuts.cuts) {
    const rate = c.playbackRate ?? 1;
    if (c.src === bg.src && bg.atSec >= c.inSec && bg.atSec <= c.outSec) return start + (bg.atSec - c.inSec) / rate;
    start += (c.outSec - c.inSec) / rate;
  }
  return null;
};

/** 動画の sec 秒目のコマを背景にする（タイムラインのピンを動かしたとき）。カットが無ければ null */
export const bgAtTimelineSec = (cuts: Pick<ReelData, 'cuts'>, sec: number): ThumbnailBg | null => {
  let start = 0;
  const list = cuts.cuts;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const rate = c.playbackRate ?? 1;
    const dur = (c.outSec - c.inSec) / rate;
    if (sec < start + dur || i === list.length - 1) return bgFromCut(c, Math.max(0, sec - start) * rate);
    start += dur;
  }
  return null;
};

/** 画面の入力欄の「空欄ならこうなる」に出す、案件から決めた既定 */
export const thumbnailDefaults = (cuts: Pick<ReelData, 'cuts' | 'meta'> | null | undefined, brief: Pick<Brief, 'shop'> | null | undefined) => {
  const region = regionOf(brief?.shop.area, brief?.shop.station);
  return {
    en: region.en,
    side: sideTextOf(region.ja, brief?.shop.area),
    title: titleTextOf(brief, cuts),
    bg: defaultBgOf(cuts),
  };
};

/** thumbnail.font にこれを書くと、テロップのフォントに関係なく同梱の明朝（Noto Serif JP）で描く */
export const THUMBNAIL_BUILTIN_FONT = 'builtin';

/** エンジンに渡す、埋め終わったサムネイル。bg が null ＝ カットが無いので作れない */
export type ResolvedThumbnail = {en: string; side: string; title: string; font?: string; bg: ThumbnailBg | null};

/**
 * cuts.json の thumbnail（手で書いたもの）＋ 案件からの既定 → 描くもの。
 * フォントは「サムネに指定したもの → テロップのフォント → 設定の既定フォント」の順（どれも無ければ同梱の明朝）。
 */
export const resolveThumbnail = (cuts: Pick<ReelData, 'cuts' | 'meta' | 'font'> & {thumbnail?: ThumbnailDef}, brief: Pick<Brief, 'shop'> | null | undefined, fallbackFont?: string | null): ResolvedThumbnail => {
  const t = cuts.thumbnail ?? {};
  const d = thumbnailDefaults(cuts, brief);
  // 空白だけ＝未記入扱い（消したつもりの欄が空のまま焼き付かないように）
  const pick = (v: string | undefined, fallback: string) => (v !== undefined && v.trim() ? v.trim() : fallback);
  const font = t.font === THUMBNAIL_BUILTIN_FONT ? undefined : (t.font ?? cuts.font ?? fallbackFont ?? undefined);
  return {
    en: pick(t.en, d.en).toUpperCase(),
    side: pick(t.side, d.side),
    title: pick(t.title, d.title),
    ...(font ? {font} : {}),
    bg: t.bg ?? d.bg,
  };
};

/** 本番レンダーのたびに書き出すサムネイル（案件相対） */
export const THUMBNAIL_REL = 'out/thumbnail.jpg';
