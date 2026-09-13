// 同一 src の非連続再参照を別名ファイルにする（Windows でレンダーが不安定になる既知問題の回避）。
import fs from 'node:fs';
import path from 'node:path';
import type {AliasOp, ReelData} from '../shared/schema/cuts';

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
    a.applied = true;
  }
  return done;
};

export const pendingAliases = (projectDir: string, data: ReelData): AliasOp[] =>
  (data.meta?.aliases ?? []).filter((a) => !fs.existsSync(path.join(projectDir, 'public', a.to)));
