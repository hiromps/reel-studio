// Fish Audio の音声モデル（API の model ヘッダーに入れる値）。設定画面の選択肢と、感情タグが使えるかの判定に使う。
// ⚠ 綴りを間違えても API はエラーにせず s2.1-pro で作ってしまう（公式ドキュメント）ので、ここの値は正確に保つ。
// 価格は 2026-11-24 に docs.fish.audio で確かめた値（UTF-8 100 万バイトあたり）

export type FishModel = {id: string; label: string; note: string; /** [感情の指示]・<emphasis> などのタグが使える */ tags: boolean};

export const FISH_MODELS: readonly FishModel[] = [
  {id: 's2.1-pro-free', label: 'S2.1 Pro（無料枠）', note: '2026-11-30 まで無料', tags: true},
  {id: 's2.1-pro', label: 'S2.1 Pro', note: '$15 / 100 万バイト', tags: true},
  {id: 'drama-3', label: 'Drama 3（感情表現が最も豊か・有料）', note: '$50 / 100 万バイト（11/30 までは $10）', tags: true},
  {id: 's2-pro', label: 'S2 Pro', note: '旧版', tags: true},
  {id: 's1', label: 'S1', note: '2026-12-31 で終了予定・感情タグ不可', tags: false},
];

/** 感情タグ付きの音声を作れるモデル */
export const FISH_TAG_MODEL_IDS = ['s2-pro', 's2.1-pro', 's2.1-pro-free', 'drama-3'] as const;
export type FishTagModelId = (typeof FISH_TAG_MODEL_IDS)[number];

export const fishModelSupportsTags = (id: string): boolean => (FISH_TAG_MODEL_IDS as readonly string[]).includes(id);

export const fishModelLabel = (id: string): string => FISH_MODELS.find((m) => m.id === id)?.label ?? id;
