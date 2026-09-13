// 「次にやること」の判定。案件の状態から、いま一番やるべきことを 1 つだけ選ぶ。
// 初めての人がどの画面に行けばいいか迷わないようにするためのもの（DOM に触らないのでテストできる）。
import type {Brief, Catalog, Narration, ReelData} from '@shared/schema';
import {isPlaceholder} from '@shared/telop-text';

export type StepTab = 'projects' | 'materials' | 'brief' | 'timeline' | 'render';

export type NextStep = {
  id: string;
  tab: StepTab;
  /** やることの説明（1 行） */
  text: string;
  /** 移動ボタンの文言 */
  cta: string;
  /** 準備が全部終わっている状態か（バーの色を変える） */
  ready?: boolean;
};

export type StudioSnapshot = {
  active: string | null;
  catalog: Catalog | null;
  brief: Brief | null;
  cuts: ReelData | null;
  narration: Narration | null;
  /** caption.txt の中身（無ければ null）。契約ファイルではないので文字列で受ける */
  caption: string | null;
  dirty: {catalog: boolean; brief: boolean; cuts: boolean};
};

/** タグが付いていない素材（NG にしたものは除く） */
export const countUntagged = (catalog: Catalog): number => catalog.clips.filter((c) => !c.tags && !c.user.ng).length;

/** テロップが未記入（{{gNN:intent}} のまま）のカット・字幕の数 */
export const countPlaceholders = (cuts: ReelData): number =>
  cuts.cuts.reduce(
    (n, c) => n + (c.main && isPlaceholder(c.main.text) ? 1 : 0) + (c.subs ?? []).filter((s) => isPlaceholder(s.text)).length,
    0,
  );

export const nextStepOf = ({active, catalog, brief, cuts, narration, caption, dirty}: StudioSnapshot): NextStep => {
  if (!active) return {id: 'open', tab: 'projects', text: 'まず案件を開いてください（無ければ新しく作ります）', cta: '案件一覧へ'};

  if (!catalog || catalog.clips.length === 0)
    return {id: 'catalog', tab: 'materials', text: '素材フォルダを選んで「カタログ実行」を押すと、動画を読み込んでサムネイルを作ります', cta: 'Materials へ'};

  const untagged = countUntagged(catalog);
  if (untagged > 0)
    return {
      id: 'tag',
      tab: 'materials',
      text: `素材のタグ付けが ${untagged} 本 残っています（何が映っているかの記録。構成の自動生成に使います）`,
      cta: 'Materials へ',
    };
  if (dirty.catalog) return {id: 'save-catalog', tab: 'materials', text: 'catalog.json に未保存の変更があります', cta: '保存しに行く'};

  if (!brief) return {id: 'brief', tab: 'brief', text: '人格（hiro / 凪 / さゆり / ぼんじり）を選んで brief（何を伝えるか）を作ります', cta: 'Brief へ'};

  if (!cuts || cuts.cuts.length === 0)
    return {id: 'plan', tab: 'brief', text: 'Brief の「プラン生成」→「cuts.json に書き込む」でカット構成を作ります', cta: 'Brief へ'};

  const placeholders = countPlaceholders(cuts);
  if (placeholders > 0)
    return {
      id: 'telop',
      tab: 'timeline',
      text: `テロップが ${placeholders} 件 未記入です（{{...}} のまま）。Claude に埋めてもらうか、自分で書きます`,
      cta: 'Timeline へ',
    };

  if (dirty.cuts) return {id: 'save-cuts', tab: 'timeline', text: 'cuts.json に未保存の変更があります。Ctrl+S で保存してからレンダーしてください', cta: '保存しに行く'};
  if (dirty.brief) return {id: 'save-brief', tab: 'brief', text: 'brief.json に未保存の変更があります', cta: '保存しに行く'};

  // ナレーションは納品の必須要素。レンダーだけでは素材の音しか入らない
  if (!narration || narration.segments.length === 0)
    return {id: 'narration', tab: 'render', text: 'ナレーションがまだありません。「AI にナレーションを書いてもらう」で原稿を作ります（レンダーだけでは素材の音のままです）', cta: 'Render へ'};

  const needsTts = narration.segments.filter((s) => (s as {needsTts?: boolean}).needsTts || !s.durSec).length;
  if (needsTts > 0)
    return {id: 'tts', tab: 'render', text: `ナレーション ${needsTts} ブロックの音声がまだです。Render の「音声を生成」で作ります`, cta: 'Render へ'};

  if (!caption?.trim())
    return {id: 'caption', tab: 'render', text: 'キャプションがまだありません。Render の「AI にキャプションを書いてもらう」で作ります（投稿にそのまま貼れる本文です）', cta: 'Render へ'};

  return {id: 'render', tab: 'render', text: '準備できています。ドラフトで確認 → 本番レンダー → ナレーション合成（mix）で完成です', cta: 'Render へ', ready: true};
};
