// 編集画面で「いま何を選んでいるか」。インスペクタはこれを見て表示を切り替える。
export type Selection =
  | {kind: 'cut'; index: number}
  | {kind: 'telop'; group: number}
  | {kind: 'narr'; index: number}
  | {kind: 'sfx'; index: number}
  | null;

export const sameSelection = (a: Selection, b: Selection): boolean => {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'telop') return a.group === (b as {group: number}).group;
  return (a as {index: number}).index === (b as {index: number}).index;
};

/** 配列の要素を消したあと、選択が指す先を直す（消した要素なら解除、後ろなら 1 つ前へ） */
export const selectionAfterRemove = (sel: Selection, kind: 'cut' | 'narr' | 'sfx', removed: number): Selection => {
  if (!sel || sel.kind !== kind) return sel;
  if (sel.index === removed) return null;
  return sel.index > removed ? {kind, index: sel.index - 1} : sel;
};
