// ビルド前の下ごしらえ。テロップのフォントを public/fonts/ に置く。
//
// なぜ要るか: クラウド版では素材は PC にあるが、**フォントはブラウザ側で要る**
// （Remotion Player がテロップを描くため）。案件ごとに配るものではないので、
// アプリの静的ファイルとして 1 つだけ配信する（cloud/routes/media.ts が /fonts/ へ飛ばす）。
// public/fonts/ は生成物なので .gitignore 済み。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = path.join(root, 'engine', 'public', 'fonts');
const dst = path.join(root, 'public', 'fonts');

fs.mkdirSync(dst, {recursive: true});
let copied = 0;
for (const name of fs.existsSync(src) ? fs.readdirSync(src) : []) {
  const s = path.join(src, name);
  const d = path.join(dst, name);
  if (!fs.statSync(s).isFile()) continue;
  // 同じ大きさのものが既にあれば触らない（7MB を毎回コピーしない）
  if (fs.existsSync(d) && fs.statSync(d).size === fs.statSync(s).size) continue;
  fs.copyFileSync(s, d);
  copied++;
}
console.log(`public/fonts: ${copied} 件コピー（${fs.readdirSync(dst).length} 件）`);
