# engine（Remotion 編集テンプレート）

Reel Studio が案件フォルダ（`work/<slug>-reel/`）に複製する Remotion プロジェクトの原本。
レンダーのたびに `src/*.tsx` が原本と突き合わされ、差分があれば原本で上書きされる（旧ファイルは
`.studio/backups/engine-<ts>/` に退避）。

- 編集の単一ソースは動画 1 本につき `cuts.json` 1 ファイル（カット＋テロップ＋テーマ定義）
- 素材動画は `public/uploads/` に置く。fps は素材準拠（60fps なら 60）
- デザイン調整は `src/telops.tsx` 冒頭の THEMES / LAYOUT 定数のみ触る
- フォントは `public/fonts/NotoSerifJP-Bold.ttf`（SIL OFL 1.1、`OFL_license.txt`）。ネット接続は不要
- Remotion のバージョンは GUI（`@remotion/player`）とは独立にここの `package.json` で固定する
