# ローカル保存への切り替え調査（2026-10-21）

対象はこのチェックアウトのソース。Supabase の実使用量・本番の行サイズ・Storage の内容は未計測。

## Storage とバイナリの経路（変更前）

Supabase SDK、`storage.from()`、`/storage/v1` 呼び出しは **0 件**。Supabase は postgres.js + Drizzle で DB として使用。
現行のバイナリ保存先は **Vercel Blob**。従って Blob の再生転送を Supabase Storage Egress と断定できない。

| 場所 | 動作 |
|---|---|
| `worker/sync.ts` syncAssets / syncFonts | 生成音声・動画・プロキシ・サムネ・QC・フォントを Blob にアップロード |
| `worker/sync.ts` pullNarrationAudio | assets.url の音声をダウンロード |
| `cloud/blob.ts` putBlob / delBlob | Blob の書き込み・削除共通処理 |
| `cloud/routes/plan.ts` /frame | ストリップ画像を assets で検索し Blob URL へリダイレクト |
| `cloud/routes/media.ts` | メディアを assets で検索し Blob URL へリダイレクト |
| `cloud/routes/misc.ts` | 音声ライブラリの取得→再アップロード、音声・効果音再生のリダイレクト、素材・フォント用のアップロードトークン発行 |
| `cloud/routes/worker.ts` | Blob 書き込み鍵の配布、差し替え・案件削除時の Blob 削除 |
| `src/components/UploadMaterials.tsx` | ブラウザ→Blob→ingest ジョブ |
| `src/components/ReferenceCard.tsx` | 参考動画をブラウザ→Blob→分析ジョブ |
| `src/pages/Settings.tsx` | フォントをブラウザ→Blob→fonts ジョブ |
| `worker/cloud-jobs.ts` runIngest / runFontJob | ジョブで受け取った URL のダウンロード |
| `core/reference.ts` fetchReferenceToInbox | URL の参考動画をダウンロード（Instagram 等の外部ソースにも使用） |

原本はすでに PC の uploads、生成物は work 内に存在する。既存のローカル版には Range・ETag 付きファイル配信がある。

## DB 取得（変更前）

Drizzle の引数なし `.select()` は全カラム取得。SQL の文字列 `SELECT *` は見つからなかった。

| 場所・関数 | 全カラム／大きいカラム | 頻度・影響 |
|---|---|---|
| `cloud/store.ts` readDoc | docs 全カラム、data JSONB | 単一 doc。条件付き GET でも本文を取得 |
| 同 readDocs | docs 全カラム、全 doc の data | worker の定期同期、loadCtx の解析処理ごと |
| 同 listProjects / projectInfo | projects 全カラム、info JSONB | 案件一覧・詳細 |
| 同 listProjects | meta / reference の data 全体 | reference は分析を含み大きくなり得る |
| 同 projectInfo / readProjectMeta | reference / meta の data 全体 | 存在確認にも本文を取得 |
| 同 listJobs / getJob / claimJob | jobs 全カラム、params / result JSONB、error | SSE は **2 秒ごとに直近30件**を取得 |
| 同 jobLogLines | seq / line（列指定） | 動作中・完了後ログをSSEで問い合わせ、最大2000行 |
| 同 findAsset / listAssets | URL / hash / bytes 等（列指定） | バイナリなし。旧同期では各案件ごと索引取得 |
| 同 listPersonaRows / kvGet | data JSONB（列指定） | 設定、ライブラリ、worker 状態等。サイズ制限なし |
| `cloud/push.ts` sendToAll | push_subs 全カラム | 通知送信時。小さいデータ |
| 同 countSubscriptions | endpoint 全件 | 件数だけ必要なのに URL を取得 |
| `cloud/events-source.ts` docsChangedSince | slug / name / rev / hash（列指定） | 本文は取得しない |

全カラム取得は store に9箇所、pushに1箇所。その他のSQLはカラム指定。INSERT/UPDATE RETURNING にも全カラム返却がある。
メディアを base64 化して DB に保存する処理は見つからなかった。
`catalog.clips[].look.sig` は336バイトの画像指紋（base64文字列448文字）であり動画本体ではない。

## Egress 原因候補（未計測の推定）

1. **高：SSE の2秒ポーリング**。タブごとに jobs.params/result を含む30件と末尾ログを再取得する。長時間開くほど累積する。
2. **高：worker の全案件 doc 定期取得**。変更なしの catalog / cuts / reference / script 等を毎回DBから取得する。
3. **中：loadCtx / 一覧・存在確認での JSON 全体取得**。単純な操作でも参考分析や契約JSONを読む。
4. **低〜中：assets 索引、kv / personas / ログ**。小さいが頻度・件数に比例する。
5. **別枠：Blob の動画・音声転送**。ここは Vercel 側の通信。Supabase Storage の費用なら別デプロイや旧版も要調査。

移行時の既存 Storage ダウンロードには一度だけ転送が発生する。バケット・オブジェクトの削除は実行しない。

## 対応した内容

- Storage SDK・アップロードトークン発行・メディアの外部URL配信・通常ジョブでのStorageダウンロードを廃止。
- ローカル取り込み、同内容の再利用、同名異内容の上書き防止、Range・ETag配信を実装・検証。
- DBの引数なしselectをすべて列指定に変更。SSEは状態だけの問い合わせと差分ログ取得へ変更。
- workerのdoc取得はSQL側で一致hashの本文を省略。条件付きGETも版番号だけで304を返す。
- 一覧のreference分析JSONは取得せず、sourceの存在とarchivedAtだけを取得。
- 全バケットまたは既存assetsの読み取り専用移行スクリプトを追加。dry-run・SHA-256・再実行・DB参照更新に対応。

実際のSupabase使用量の計測、本番デプロイ、実Storageの移行・削除は実行していない。
ローカルのみでも動作するが、DBの台本・ジョブ同期を有効にするとその小規模なDB通信は残る。
VercelからPCのファイルは読めないため、メディア操作はローカルアプリで行う。
