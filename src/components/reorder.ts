// ドラッグ並べ替えの純粋ロジック（DOM API に触らない＝node 環境でテストできる）。
// useDragReorder から使う。座標は clientX/clientY と getBoundingClientRect() と同じ viewport 基準。

/** getBoundingClientRect() の必要な部分だけ */
export type Rect = {left: number; top: number; right: number; bottom: number; width: number; height: number};

/** grid = 折り返しあり（絵コンテ）／y = 縦一列（カット詳細リスト） */
export type DragAxis = 'grid' | 'y';

export type Caret = {left: number; top: number; width: number; height: number};

/**
 * 連続ブロック [s,e] を to へ動かした新しい配列。
 * to は「削除前の配列での挿入位置」（0 = 先頭、arr.length = 末尾）。
 */
export const reorderBlock = <T>(arr: T[], [s, e]: [number, number], to: number): T[] => {
  if (s < 0 || e >= arr.length || s > e) return arr;
  const block = arr.slice(s, e + 1);
  const rest = [...arr.slice(0, s), ...arr.slice(e + 1)];
  const at = to <= s ? Math.max(0, to) : Math.min(rest.length, to - block.length);
  rest.splice(at, 0, ...block);
  return rest;
};

/** 移動後にブロック先頭が来る index（選択状態を追従させるのに使う） */
export const destIndexOf = ([s, e]: [number, number], to: number): number => (to <= s ? to : to - (e - s + 1));

/** 挿入位置がブロックの内側（動かしても並びが変わらない）なら null にする */
export const normalizeTarget = (to: number, [s, e]: [number, number]): number | null => (to >= s && to <= e + 1 ? null : to);

/** DOM 順に並んだ矩形を、行（折り返し単位）ごとの index 配列に分ける */
export const rowsOf = (rects: Rect[]): number[][] => {
  const rows: number[][] = [];
  rects.forEach((r, i) => {
    const last = rows[rows.length - 1];
    // 直前の行の top と近ければ同じ行。カードの高さは揃っている前提
    if (last && Math.abs(rects[last[0]].top - r.top) < Math.max(4, r.height * 0.5)) last.push(i);
    else rows.push([i]);
  });
  return rows;
};

/** ポインタ位置から挿入 index（0〜rects.length）を求める */
export const insertIndexAt = (rects: Rect[], x: number, y: number, axis: DragAxis): number => {
  if (rects.length === 0) return 0;
  if (axis === 'y') {
    for (let i = 0; i < rects.length; i++) if (y < rects[i].top + rects[i].height / 2) return i;
    return rects.length;
  }
  // grid：まずポインタに一番近い行を選び、その行の中で左右を見る
  const rows = rowsOf(rects);
  let best = rows[0];
  let bestDist = Infinity;
  for (const row of rows) {
    const r = rects[row[0]];
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < bestDist) {
      bestDist = d;
      best = row;
    }
  }
  for (const i of best) if (x < rects[i].left + rects[i].width / 2) return i;
  return best[best.length - 1] + 1;
};

/**
 * 挿入キャレットの位置。コンテナの content 座標（position:absolute の子で使える値）で返す。
 * @param origin コンテナの padding box 左上を viewport 基準で表した点からスクロール量を引いたもの
 */
export const caretRectFor = (
  rects: Rect[],
  to: number,
  axis: DragAxis,
  origin: {left: number; top: number},
  containerWidth: number,
  gap: number,
): Caret | null => {
  if (rects.length === 0) return null;
  const T = 4; // キャレットの太さ
  const tail = to >= rects.length;
  const r = tail ? rects[rects.length - 1] : rects[to];
  if (axis === 'y') {
    const y = tail ? r.bottom + gap / 2 : r.top - gap / 2;
    return {left: 0, top: y - origin.top - T / 2, width: containerWidth, height: T};
  }
  const x = tail ? r.right + gap / 2 : r.left - gap / 2;
  return {left: x - origin.left - T / 2, top: r.top - origin.top, width: T, height: r.height};
};
