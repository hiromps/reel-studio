// 同一 src の非連続再参照を別名ファイルにする（Windows でレンダーが不安定になる既知問題の回避）。
// 「どの名前にするか」は shared/alias.ts（純粋）。ここは実ファイルのコピーだけを受け持つ。
import fs from 'node:fs';
import path from 'node:path';
import {studioConfig} from '../studio.config';
import type {AliasOp, ReelData} from '../shared/schema/cuts';

/** スマホ（PWA）の Timeline が見る軽量プレビュー。別名にも同じものを置かないと真っ黒になる */
const previewPath = (projectDir: string, rel: string) => path.join(projectDir, studioConfig.studioDirName, 'preview', path.basename(rel));

/** meta.aliases の未適用分を public/ にコピーし applied=true にする。戻り値は今回コピーしたもの */
export const applyAliases = (projectDir: string, data: ReelData): AliasOp[] => {
  const done: AliasOp[] = [];
  for (const a of data.meta?.aliases ?? []) {
    const from = path.join(projectDir, 'public', a.from);
    const to = path.join(projectDir, 'public', a.to);
    if (!fs.existsSync(to)) {
      if (!fs.existsSync(from)) continue;
      fs.mkdirSync(path.dirname(to), {recursive: true});
      fs.copyFileSync(from, to);
      done.push(a);
    }
    // 中身は同じなので軽量プレビューも作り直さずコピーで足りる（無ければ何もしない）
    const pFrom = previewPath(projectDir, a.from);
    const pTo = previewPath(projectDir, a.to);
    if (fs.existsSync(pFrom) && !fs.existsSync(pTo)) fs.copyFileSync(pFrom, pTo);
    a.applied = true;
  }
  return done;
};

export const pendingAliases = (projectDir: string, data: ReelData): AliasOp[] =>
  (data.meta?.aliases ?? []).filter((a) => !fs.existsSync(path.join(projectDir, 'public', a.to)));
