// 同一素材を「離れた位置から」読み直すときの別名（alias）の決め方。純粋なので画面からもサーバーからも使う。
// Windows + Remotion では同じファイルを飛び飛びに参照するとレンダーが不安定になるため、2 ブロック目以降は
// **中身が同じ別名のコピー**を参照させる（validate の E SAME_SRC_NONCONSECUTIVE）。
// 実ファイルのコピーは core/alias.ts。
import type {AliasOp, Cut, ReelData} from './schema/cuts';

/** "uploads/08_giant-tank.mp4" の 2 ブロック目 → "uploads/08b_giant-tank-seg2.mp4" */
const aliasName = (src: string, blockOrdinal: number): string => {
  const letter = String.fromCharCode('a'.charCodeAt(0) + blockOrdinal); // 2 回目 → b
  const m = /^(.*\/)?(\d+)_([^/]+)\.([^./]+)$/.exec(src);
  if (m) return `${m[1] ?? ''}${m[2]}${letter}_${m[3]}-seg${blockOrdinal + 1}.${m[4]}`;
  const m2 = /^(.*)\.([^./]+)$/.exec(src);
  if (m2) return `${m2[1]}-seg${blockOrdinal + 1}.${m2[2]}`;
  return `${src}-seg${blockOrdinal + 1}`;
};

/** cuts を順に見て、2 ブロック目以降の src を別名に書き換える（**cuts を破壊的に変える**。plan が使う） */
export const applyAliasNames = (cuts: Cut[]): AliasOp[] => {
  const ops: AliasOp[] = [];
  const blocks = new Map<string, number>(); // src → これまでのブロック数
  let prevSrc: string | null = null;
  let currentAlias: string | null = null;
  for (const c of cuts) {
    const src = c.src;
    if (src === prevSrc) {
      if (currentAlias) c.src = currentAlias;
      continue;
    }
    prevSrc = src;
    const k = blocks.get(src) ?? 0;
    blocks.set(src, k + 1);
    if (k === 0) {
      currentAlias = null;
      continue;
    }
    currentAlias = aliasName(src, k);
    ops.push({from: src, to: currentAlias, applied: false});
    c.src = currentAlias;
  }
  return ops;
};

export type AliasRename = {cutIndex: number; cutId?: string; from: string; to: string};
export type AliasRealign = {data: ReelData; ops: AliasOp[]; renames: AliasRename[]};

/** meta.aliases を辿って元の素材名に戻す（別名の別名も辿る） */
const originResolver = (aliases: readonly AliasOp[]) => {
  const toFrom = new Map(aliases.map((a) => [a.to, a.from]));
  return (src: string): string => {
    let cur = src;
    const seen = new Set<string>([src]);
    for (;;) {
      const prev = toFrom.get(cur);
      if (!prev || seen.has(prev)) return cur;
      seen.add(prev);
      cur = prev;
    }
  };
};

/**
 * 出来上がった cuts を見て、**同じ src を非連続で参照しているブロックだけ**を別名に振り直す。
 * plan と違って並びには触らない（手で並べ替えたタイムラインをそのまま活かす）。
 *
 * - 既に正しい別名になっているブロックは触らない（何度押しても結果は同じ）
 * - 別名の元（from）は「いま参照している実在するファイル」にする（コピー元が無いと適用できないため）
 * - 名前が他のカットや別の元を持つ既存の別名とぶつかるときは seg3, seg4… とずらす
 */
export const realignAliases = (data: ReelData): AliasRealign => {
  const existing = data.meta?.aliases ?? [];
  const origin = originResolver(existing);
  const cutSrcs = new Set(data.cuts.map((c) => c.src));
  // src ごとの「ブロック数」（連続して使う分は 1 つと数える）。1 なら今のままでよい src
  const blockCount = new Map<string, number>();
  data.cuts.forEach((c, i) => {
    if (i > 0 && data.cuts[i - 1].src === c.src) return;
    blockCount.set(c.src, (blockCount.get(c.src) ?? 0) + 1);
  });
  const made = new Set<string>();
  const ops: AliasOp[] = [...existing];
  const renames: AliasRename[] = [];
  const blocks = new Map<string, number>(); // 元の素材 → これまでのブロック数
  const cuts = data.cuts.map((c) => ({...c}));
  // 同じ名前の別ファイルを指してしまうとレンダーの中身が入れ替わる。元が違う既存の別名とは必ずずらす
  const taken = (name: string, from: string) => cutSrcs.has(name) || made.has(name) || existing.some((a) => a.to === name && a.from !== from);

  let prevSrc: string | null = null;
  let currentAlias: string | null = null;
  cuts.forEach((c, i) => {
    const src = c.src;
    if (src === prevSrc) {
      // 連続して同じ素材を使うのは問題ない（ブロックとして 1 つに数える）
      if (currentAlias) c.src = currentAlias;
      return;
    }
    prevSrc = src;
    const key = origin(src);
    const k = blocks.get(key) ?? 0;
    blocks.set(key, k + 1);
    currentAlias = null;
    if (k === 0) return; // 初出のブロックはそのまま
    // 今の名前を他のブロックが使っていなければ、それが正しい別名（何度押しても結果が変わらない）
    const keepOk = (blockCount.get(src) ?? 0) <= 1;
    let ord = k;
    let name = aliasName(key, ord);
    while (name === src ? !keepOk : taken(name, src)) name = aliasName(key, ++ord);
    if (name === src) return; // 既に正しい別名になっている
    made.add(name);
    currentAlias = name;
    c.src = name;
    ops.push({from: src, to: name, applied: false});
    renames.push({cutIndex: i, cutId: c.id, from: src, to: name});
  });

  if (!renames.length) return {data, ops: existing, renames};
  return {data: {...data, meta: {...(data.meta ?? {}), aliases: ops}, cuts}, ops, renames};
};

/** 振り直しが必要なカット数（0 なら何もしなくてよい）。ボタンの出し分け用 */
export const aliasFixCount = (data: ReelData | null | undefined): number => (data ? realignAliases(data).renames.length : 0);
