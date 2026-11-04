# メディアのローカル保存

2026-10-21 以降、素材・生成音声・書き出し動画・プレビュー・サムネ・フォントはローカルに保持する。
Supabase は台本JSON、ローカルパス、設定・メタデータ、ジョブ・ログのみ。バイナリをアップロードしない。
旧 Vercel Blob の SDK・アップロード・削除・Storage トークン配布も廃止した。

## 保存先

Settings の保存先設定（`~/.reel-studio/settings.json`）または環境変数で指定する。環境変数が優先。

| 対象 | 環境変数 | 既定 |
|---|---|---|
| データ全体 | `REEL_STUDIO_DATA_ROOT` | `<アプリ>/data` |
| 取り込む原本 | `REEL_STUDIO_UPLOADS_ROOT` | `<dataRoot>/uploads` |
| 案件・生成音声・作業用書き出し | `REEL_STUDIO_WORK_DIR` | `<dataRoot>/work` |
| 納品先 | `REEL_STUDIO_OUTPUTS_DIR` | `<dataRoot>/outputs` |
| 効果音 | `REEL_SFX_DIR` | `<dataRoot>/sfx` |
| Storage からの移行ファイル・索引 | `REEL_STUDIO_MEDIA_ROOT` | `<dataRoot>/media` |
| 音声ライブラリ・フォント・設定 | `REEL_STUDIO_HOME` | `~/.reel-studio` |

生成音声は `work/<slug>/narration/*.wav`、書き出しは `work/<slug>/out/` に置く。
納品処理の出力は outputsDir。再利用音声は設定フォルダの narration-library に置く。
既存のローカルデータは自動で移動しない。保存先を変えるときは既存の work / uploads 等を新しい場所へコピーしてから切り替える。

PowerShell の例（このシェルから起動したプロセスに適用）:

```powershell
$env:REEL_STUDIO_DATA_ROOT = 'D:\ReelStudio'
$env:REEL_STUDIO_MEDIA_ROOT = 'D:\ReelStudio\media'
npm start
```

環境変数を `.env.local` に置く場合、Node 22 以降で明示的に読み込ませる:

```powershell
node --env-file=.env.local scripts/launch.mjs
```

GUI では Materials の「動画を選ぶ」でローカルへ直接取り込める。続いてカタログ化→編集→書き出し。
同名・同内容の再取り込みは既存ファイルを再利用し、同名・異内容はエラーにする。
中断した取り込みは完成ファイルとして公開しない。

## DB とキャッシュ

- assets.url は既存カラム名を互換維持し、**新規の値には絶対ローカルパス**を保存する。スキーマ変更は不要。
- ワーカーは実ファイルを送らず、パス・サイズ・MIME・変更検出用ハッシュだけを差分登録する。
- サイズ・mtime・ctime が同じファイルは再ハッシュしない。登録済み参照を `.studio/cloud-sync.json` に保存する。
- 変更のない台本JSONは hash を照合し、SQL の CASE で本文の返却を省く。PC 上のコピーを参照する。
- SSE の2秒ポーリングではジョブの状態・進捗・ログ連番だけを取得し、状態が変わったジョブだけ詳細を取得する。
- 静的配信はローカルサーバーの Range / ETag / 304 を使う。Storage URL へ戻る配信処理はない。
- DB 書き込みでは音声・動画・画像の data URL、大きな base64、Buffer を拒否する。

同期先を変更した・DB を空にした場合は、案件の `.studio/cloud-sync.json` の assets 部分と設定フォルダの
`local-font-sync.json` をバックアップ後にリセットして、参照を再登録する。

## 既存 Storage の移行

**アプリとワーカーを停止してから実行する。バケット・オブジェクトを削除する機能はない。**
通常実行は一覧だけの dry-run。`--apply` を付けたときだけダウンロードする。
移行には一度だけ転送量が発生する。サービスキーは環境変数で渡し、ブラウザやリポジトリへ置かない。

Supabase Storage:

```powershell
$env:SUPABASE_URL = 'https://<project-ref>.supabase.co'
$env:SUPABASE_SERVICE_ROLE_KEY = '<service-role-key>'
npm run media:migrate -- --bucket <bucket-name>
npm run media:migrate -- --bucket <bucket-name> --apply
```

`--bucket` を省略すると全バケットが対象。非公開バケット・階層・ページングに対応する。
認証付き取得は [Supabase公式の配信API](https://supabase.com/docs/guides/storage/serving/downloads)を使用する。

このチェックアウトで実際に使っていた **Vercel Blob** は、既存の assets テーブルから移す:

```powershell
$env:DATABASE_URL = '<Postgres connection URL>'
npm run media:migrate -- --source assets
npm run media:migrate -- --source assets --apply --update-db
```

Supabase の移行でも `DATABASE_URL` と `--apply --update-db` を渡すと、取得済みオブジェクトに対応する
assets.url をローカルパスへ更新する。取得・検証が全件成功してから DB をトランザクションで更新し、途中の索引変更を検出したら更新を取り消す。
`--source assets` は公開URL用。Supabase の非公開URL・署名URLは `--source supabase` を使う。

`.env.local` を利用する場合の移行コマンド:

```powershell
node --env-file=.env.local --import tsx scripts/migrate-media.ts --apply --update-db
```

移行ファイルは mediaRoot/imported 配下に保存し、`migration-manifest.json` に元オブジェクト識別子・パス・サイズ・SHA-256 を記録する。
`--root` で移行先を指定する場合は、アプリ起動時の `REEL_STUDIO_MEDIA_ROOT` も同じ場所に設定する。
再実行時はファイルを検証して再取得を省く。破損・未記録の既存ファイルは上書きせずエラーにする。
移行先のパストラバーサル・シンボリックリンク越しの範囲外書き込みを拒否する。
多重実行は `.migration.lock` で拒否する。異常終了で錠だけ残ったときは記載された PID の停止を確認してから錠ファイルを取り除く。

assets の対応関係または `p/<slug>/<mode>/<kind>/<rel>` 形式のキーは `asset-index.json` に記録し、
ローカル配信がファイルを複製せず参照する。既存案件で欠けている public/uploads・narration・out 等は一度だけコピーして復元する
（対応FSではcopy-on-write）。生成処理で移行元まで上書きしないため、作業用ファイルとのハードリンクは作らない。
すでにあるPC側のファイルは上書きしない。任意の形式の Storage キーは manifest から手動で対応付ける。
既存案件の作業フォルダ・台本JSONはそのまま利用する。このスクリプトはDBの台本を新規Remotion案件へ復元するものではない。

## クラウド画面の扱い

Vercel のプロセスは PC のディスクへアクセスできず、一時ディスクへの保存も永続保存にならない。
そのため **動画の取り込み・プレビュー・音声再生・保存・ダウンロードは PC の Reel Studio で行う**。
クラウド側の旧アップロードAPIやメディア配信はエラーでPC版へ案内する。Storageへの自動フォールバックはしない。
クラウドの台本・メタデータ・ジョブ同期は継続できる。

## 検証

```powershell
npm run typecheck
npm test
npm run build
npm run test:export
```

test:export は独立した一時案件で、ネットワークを禁止した取り込み・カタログ化・再利用確認、
カット・テロップ・ズーム編集、Remotionレンダー、ローカルWAV合成、ffprobeによる映像音声検証を行う。
外部TTSの実APIは呼ばず、検証用WAVを使用する。結果は `.runtime/last-export-test.json`。
本番DB・既存Storageの移行と削除は自動実行しない。
