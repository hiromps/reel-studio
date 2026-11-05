# Reel Studio × Modal Cloud GPU

## Modalの用途（0.4.16）

Modalは、Reel Studioで編集した動画をクラウドで書き出すための実行環境です。画像・動画をAIで新しく生成する用途では使用しません。旧生成画面を取り除き、旧画面・APIからのAI生成要求もGPU起動と料金予約の前に拒否します。

1. 撮影済みの動画を素材として追加します。スマホでは素材画面からアップロード、PCの既存案件は書き出し画面から素材を転送します。
2. 必要に応じて軽量プレビューを作り、編集画面でカット・字幕・ズーム・色・生成済み音声を調整して保存します。
3. 書き出し画面で「書き出す場所」を「Modalクラウド」にします。PCの対応GPUを自動優先する設定でも、手動選択でModalへ切り替えられます。
4. 品質を選び、概算確認 → GPU利用許可 →「クラウドで書き出す」。字幕・生成済み音声・効果音を合成したMP4を再生・保存できます。

接続診断を除く通常の新規ジョブは、軽量プレビューと編集済み動画の書き出しです。PCのローカルGPU優先、料金・実行時間の保護、既存案件と認証情報は維持します。新しい料金プランや機能制限による有料化は行っていません。

## GPU優先と手動切り替え（0.4.15）

書き出し画面の「書き出す場所」で「自動」「PC」「Modalクラウド」を選べます。選択はブラウザごとに保存し、Modalを明示した場合はローカルGPUを検出しても切り替えません。管理者は両方を利用できます。新しい料金プラン・権限制限は導入していません。

ローカルGPUは、GPU名やVRAMの申告だけで判断せず、Remotion同梱FFmpegで1080×1920のH.264を試験エンコードして検証します。Windows/LinuxのNVIDIA NVENC、macOSのVideoToolboxに対応します。未対応GPUやドライバー不具合があっても、従来のCPU書き出しとModalを選べます。検出結果は5分間キャッシュします。

PCの書き出しはGPUを優先し、実行失敗時はCPUへ切り替えます。GPUではビットレート（本番8Mbps、確認用2Mbps）、CPUでは従来のCRFを使います。CRFを明示した場合は品質指定を優先してCPUを使用します。Remotionのフレーム描画すべてをGPU化する機能ではありません。画像・動画のAI生成は提供しません。

Web/PWAでPCを自動選択するのは、ワーカー接続中・対応GPU検証済み・編集と音声の版が一致・必要な素材と生成済み音声がPCに存在する場合だけです。PCにないクラウド素材を自動でPCへ振り分けません。PCが切れた場合は自動選択をModalへ戻し、実行前の素材転送・概算・GPU利用許可は維持します。

画面上の案内は×で隠せます。右上「使い方」の「PCなしで使える機能の案内を表示する」で戻せます。非表示はこのブラウザに保存し、PC未接続をアプリ全体の停止として表示しません。

## 通常動画のクラウド書き出し（0.4.14）

PCのGPUを使わず、既存のRemotion動画をModal上で書き出せます。Remotionは4.0.540です。AIで新しい映像を生成する機能とは別に、編集済みの動画・字幕・クロップ・ズーム・色調整・生成済み音声を合成します。

### スマホから始める

1. Web/PWAで案件を作るか、既存案件を開き、素材画面の「スマホから素材を追加」でMP4・MOV・M4V・WebMを選びます。
2. 動画の転送を許可してアップロードします。GPUは起動しません。転送中は画面を開いたままにし、通信失敗時は「転送を再開」を使います。未完了の転送で既存の案件素材は切り替わりません。
3. 概算を確認し、GPU利用・料金予約を許可して「軽量プレビューを作成」を実行します。完了後に「編集に取り込む」を押します。解析済みの素材と、最初の3秒を使った初期カットを追加します。既存の編集やタグは保持します。
4. 編集画面で映像・字幕・配置を調整し、保存します。プレビューは540px以内・30fpsのH.264/AACを使い、書き出しには元動画を使います。
5. 書き出し画面で「Modalクラウド」と品質を選び、概算確認 → GPU利用許可 →「クラウドで書き出す」。完了後にMP4を再生・保存できます。GPU処理は画面を閉じても継続し、再び開くと状態を取得します。

### PC上の既存案件を使う

PC版で編集と音声生成を済ませて保存し、書き出し先を「Modalクラウド」に変更します。転送を許可して「素材をアップロード」を押すと、この案件の動画・選択フォント・生成済みWAV・使用効果音だけを転送します。Web接続を設定済みなら自動同期し、失敗時は「スマホへ同期」で再送できます。以後はWeb/PWAでも編集・クラウド書き出しができます。音声を作り直した場合は素材も再アップロードしてください。配置・音量・トリムの変更は既存の音声を再利用します。

### 制限と処理場所

- 1ファイル512MiB、1案件1GiB・128ファイル、全案件合計4GiB・16セッションまで。保存期間は7日。明示削除と期限切れの清掃に対応します。期限切れ時は再転送してください。
- 書き出しは180秒・120カット・整数60fps以内。軽量プレビューは元動画1本180秒・合計600秒以内です。
- GPU同時処理1件、待機時0台、月間予約上限$25以下、実行上限30〜600秒の既存設定を維持します。概算・予約額とModalの実請求額・クレジット残高は異なります。
- Remotionのフレーム描画にはクラウドCPUを使います。NVENCを試して利用できる場合はGPUエンコードし、使えない場合はクラウドCPUのlibx264へ切り替えます。実際に使ったエンコーダーと警告を結果に表示します。
- 音声の新規生成、文章AI、PCのファイル管理をすべてModalへ移す機能ではありません。生成済み音声を転送した案件ではPCを起動せず音声付きMP4を作れます。スマホから新規に始めた案件は動画の元音声と字幕で書き出せます。
- 素材と動画は認証付きAPIで配信します。PCのパスやModalのProxy TokenをメディアURLへ埋め込みません。転送途中の再送とGPUジョブのUUIDによる二重実行防止、編集競合の拒否、素材・タイムラインの一括保存を備えます。

## 構造調査（フェーズ1、2026-11-04）

以下は画像・動画AI生成を含めて検証した当時の開発記録です。現在の利用手順と有効な用途は、上の「Modalの用途（0.4.16）」を参照してください。

- TypeScript、React 18、Vite 6、Express 4、Zod 3。Remotion が編集済み動画をレンダリングする。Electron 版も同じローカル Express API を使う。
- `shared/schema/settings.ts` の AgentProvider は Claude / DeepSeek / Codex。`core/ai.ts` は台本・タグ・キャプションを生成する。画像・動画をゼロから生成する既存プロバイダーはない。GPU 生成はこの文章用 enum に混ぜず、素材の生成プロバイダーとして追加する。
- `core/settings.ts` は `REEL_STUDIO_HOME` またはユーザープロファイルの `.reel-studio` に設定を保存する。既存の SecretView と同様に秘密値は応答しない。Modal の新規秘密情報は既存の平文 settings.json から分離し、暗号化する。
- `server/jobs.ts` はインメモリのジョブキューと EventEmitter/SSE。GPU 処理は Modal Function.spawn / FunctionCall によって非同期実行し、Modal 側の永続履歴・予算予約を使う。ブラウザを閉じても処理と予算保護を保持する。
- 既存素材は `core/local-upload.ts` → uploads → `core/catalog.ts` →案件の public 素材へ取り込む。Modal の生成物も同じ素材インポート経路に接続する。既存のレンダリングと納品形式は変えない。
- 拡張点: Express の `/api/modal` ルーター、Settings の独立カード、Materials の素材生成カード。クラウドPWAの認証・PCワーカー設定とは区別する。
- 作業開始時点で多数の未コミット変更あり。既存の変更を保持し、今回のファイルを追加する。

## 参照した公式仕様

- GPU指定: https://modal.com/docs/guide/gpu (`RTX-PRO-6000`、GPUには支払方法の登録が必要)
- リソース料金・Starter: https://modal.com/pricing
- スケール設定: https://modal.com/docs/guide/scale
- SDKとHTTP認証の違い: https://modal.com/docs/guide/trigger-deployed-functions
- HTTP Proxy Token: https://modal.com/docs/guide/webhook-proxy-auth
- 予算・支出上限: https://modal.com/docs/guide/budgets
- 非同期呼び出し: https://modal.com/docs/guide/function-invocation-methods
- キャンセル: https://modal.com/docs/sdk/py/latest/FunctionCall

確認時点のRTX PRO 6000料金は $0.000842/秒（GPUのみ）。Starterの $30/月はクレジットであり、無制限無料ではない。公式のWorkspace budgetはクレジット適用前の利用額、spend limitは適用後の支払額。Environment単位の予算はTeam/Enterprise。実際の支出上限はUsage & Billingで設定する。Reel Studioは公式の請求額を取得したようには表示しない。

## 設定と利用方法

1. ソース版Reel Studioを再起動し、設定 → Modal Cloud GPUを開く。今回のPCでは既存の `hiromps` SDK認証を使い、専用HTTP Proxy Tokenを作成・暗号化保存済み。配布済みの古いインストーラーには今回のコードは入っていない。
2. 「認証・接続テスト」は公式Python SDKのAPI認証と `/health` のHTTP認証を確認する。GPUを起動しない。
3. 「GPU接続テスト・課金の保護」を開き、概算確認 → そのテストの利用料金を許可 → GPU接続テスト。実際にCUDAで行列計算し、GPU名・総VRAM・使用VRAM・CUDA/PyTorchバージョンを記録する。
4. 案件を開き、素材 → AIプロバイダー・素材生成 → Modal Cloud GPUを選ぶ。プロンプト・生成方法・入力画像等を指定し、概算を確認してから、ジョブの利用料金を許可して生成する。
5. 実行中だけ10秒ごとに状態を取得する。画面を閉じてもジョブと予算予約はModal側に残る。再度開くと履歴を取得できる。
6. 「結果を見る・保存」で画像/動画を表示・ダウンロード。「この案件の素材に追加」で既存のローカルジョブキュー経由でカタログに追加する。画像は3秒・30fps・H.264のMP4に変換する。元の撮影素材・タグ・色調整・素材フォルダを保持し、元フォルダの再解析でも生成素材を保持する。

### 新しい環境の接続

Python 3.11以上とModal SDKが必要なのはデプロイ・APIトークンのテスト時。通常のジョブ送信と結果取得はNode.jsのHTTPSだけで動く。ローカルCUDA・ローカルGPUは不要。

```powershell
python -m pip install "modal==1.6.3"
python -m modal setup
python -m modal deploy -m modal_backend.app
# 上で表示された認証付きAPIのURLを渡す。秘密値は表示・引数化しない。
npx tsx scripts/setup-modal.ts https://YOUR-WORKSPACE--reel-studio-gpu-api.us-east.modal.run
```

手入力する場合は設定画面にAPI Token (`ak-` / `as-`)、HTTP Proxy Token (`wk-` / `ws-`)、エンドポイントURLを入力する。HTTP Proxy TokenはModal DashboardのSettings → Proxy Tokens、API TokenはSDK認証またはDashboardから取得する。両者は交換できない。GPU利用にはModalに有効な支払方法の登録が必要。

バックエンド上限: 予算$25/月、1ジョブ600秒、RTX PRO 6000のみ。アプリ設定ではこれより低い予算・上限時間に変更できる。初期時間は300秒。上限拡大は、コード・料金見積もり・デプロイのレビューを伴う変更として扱う。

## モデル選定とライセンス

任意のモデルID・リモートコード・ComfyUIカスタムノードは受け付けない。選定済みモデルのリビジョンとPythonパッケージを固定した。ライセンス原文・モデルカードの条件は利用者も確認すること。モデルの生成物に第三者の権利や品質を保証するものではない。

| 処理 | モデルと公式資料 | 公開ライセンス | 初期検証と要件 |
|---|---|---|---|
| Text to Image / Image to Image | [segmind/SSD-1B](https://huggingface.co/segmind/SSD-1B) | Apache-2.0 | SDXLから蒸留された1.3Bモデル。fp16、既定512px・20ステップ。実機検証時の使用VRAMは約7GiB |
| Text to Video | [Wan 2.1 T2V 1.3B](https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B-Diffusers) | Apache-2.0 | bf16、VAEはfp32。メーカー公表の最小VRAMは8.19GB（オフロード等の構成に依存）。本実装は96GB GPU、64GiB CPUメモリ |
| Image to Video | [Wan 2.2 TI2V 5B](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B-Diffusers) | Apache-2.0 | bf16、VAEはfp32、`WanImageToVideoPipeline`を使用。メーカーは単一コンシューマーGPUでの実行を案内。本実装は最大640px・49フレームに制限 |

SD-Turboも比較したが、商用利用条件の追加確認が必要なため今回の初期実装には採用しなかった。高解像度・長尺・多数ステップは無料クレジットを早く消費する。4ステップ・256px等のスモークテストは配線確認用であり、完成映像の品質基準ではない。

固定モデルSHAは `modal_backend/models.py`、依存バージョンは `modal_backend/app.py` に記載。Blackwellで実動確認したPyTorchは2.8.0+cu128、CUDA 12.8。パッケージ変更時はGPU疎通・全生成方法の再確認が必要。

## 課金保護の実装と限界

- GPUは1つのFunctionに集約。`min_containers=0`、`max_containers=1`、`buffer_containers=0`、`single_use_containers=True`、`scaledown_window=2`。常時GPU・定期GPUジョブは作成しない。コンテナ終了の実際のタイミングはModal側の管理による。
- 受付前に、実行上限時間＋起動180秒＋停止2秒のGPU/CPU/メモリ料金、転送分、25%の余裕を予約する。キャンセル・失敗でも予約を自動返金しないため、実請求より高めになる。
- GPUワーカーはCPU最大4物理コア、RAM最大64GiB。子プロセスの壁時計でモデルの取得・読込・推論・エンコードを含めて停止する。GPUテストも同じ上限処理を通る。Modal Function自体の650秒上限と起動180秒上限も設定する。
- 毎月ストレージ80GiB相当の$7.20とCPU API余裕$0.50を確保する。無料の保存/転送枠は他用途と共有されるため、見積もりでは差し引かない。Hugging Faceのキャッシュリンクは二重計上しない。80GiBを超えたときは生成を停止する。
- モデルキャッシュは次の起動を速くするためVolumeに残る。GPU停止後も保存料金が発生し得る。生成物は7日より古いものを次の明示GPUジョブで削除する。必要な結果は先にPCへ保存する。PCの保存済み結果は自動削除しない。
- 月はUTC暦月。実際の請求サイクルと異なる場合がある。月をまたぐ実行は翌月にも予約を持ち越す。
- 予算・全GPU処理の排他・UUIDによる再送防止はModal Dictで永続化する。原子的な受付ロックはデプロイの切替中も重複受付を防ぐ。受付直後の通信切断では同じUUIDで再送する。
- 停止が確認できない障害では予算と実行枠を保持して新規受付を止める。プロセスクラッシュ時に残った受付ロックやcallIdのない予約は、Modalの実行状況と照合して運用者が復旧する。確認せずにDictや予約を削除しない。`python -m modal_backend.operator` はGPUを起動せず状態を確認する。
- **アプリ内の概算はModalの実請求に対する保証ではない。** 他アプリ、直接SDK実行、APIへの大量アクセス、料金変更、プラットフォーム側の再実行・課金仕様等を完全に制御できない。実際の請求・クレジットはModal Dashboardで確認する。Workspace budgetとspend limitを併用する。
- [Modal公式手順](https://modal.com/docs/guide/budgets): Workspace Owner/ManagerでUsage & Billingを開き、Workspace budget（クレジット適用前）とspend limit（クレジット適用後）を設定する。無料枠に収めたい場合は残クレジットに合わせた予算と、可能な最小の支出上限を設定する。この開発作業ではアカウント全体の請求設定は変更していない。

## 認証・保存・API

- 秘密情報はリポジトリ外の `~/.reel-studio/modal-cloud.json`（または `REEL_STUDIO_HOME`）に暗号文として保存する。WindowsはDPAPI CurrentUser。別OSはAES-256-GCM＋ユーザーのみ読めるローカル鍵（または32バイトBase64の `REEL_MODAL_ENCRYPTION_KEY`）。暗号文・鍵ファイルを無断で共有・移動しない。
- 環境変数による上書き: `MODAL_TOKEN_ID`、`MODAL_TOKEN_SECRET`、`REEL_MODAL_PROXY_TOKEN_ID`、`REEL_MODAL_PROXY_TOKEN_SECRET`。秘密値はコード・URL・ブラウザ応答・ログに含めない。SDKテストはshellを使わず子プロセス環境に渡す。
- Modal Web Functionは `requires_proxy_auth=True`。Modalインフラで未認証アクセスを拒否する。SDK/APIトークンをHTTP認証に流用しない。
- ローカル `/api/modal` は同一オリジンの起動時セッション、Host/Origin制限、レート制限、Zod検証を必須とする。結果表示も認証付きfetchからBlob URLを作り、認証トークンをURLに入れない。
- エンドポイントはHTTPSのModal Web Functionドメインのみ許可し、ユーザー情報・クエリ・リダイレクト・ローカルIPを拒否する。NodeとPythonの両方で入力のサイズ・種類・寸法・ステップ・フレーム・時間を検証する。
- 0.4.12から公開Web/PWAでも設定・生成・履歴・結果確認に対応する。既存の所有者Cookie認証とModal操作用CSRF認証を両方必須とする。生成物はストリームで返し、動画バイナリはDBへ保存しない。PCへの素材追加は認証済みPCワーカー経由。PCが停止中でも生成と結果確認は使え、素材追加はPC起動後に実行される。
- Web版の入力画像はVercelの本文制限を考慮して2MB以下。PC版は6MB以下。Webの認証情報を変更した場合も、PC取り込みにModalの鍵をコピーする必要はない。PCワーカーは既存のワーカー認証で生成物を取得する。
- Webの変更済み設定は既存DBのkvへ保存し、秘密値はAES-256-GCMで暗号化する。暗号鍵はサーバーの `AUTH_JWT_SECRET` からHKDFで用途を分離して導出する。JWT秘密鍵を変更する場合はModal認証情報も再設定する。初期HTTP接続はVercelのSensitive環境変数で設定し、SDK用APIトークンを公開Webへ移送しない。

| 操作 | Reel Studio | Modal |
|---|---|---|
| 接続・履歴・予算 | GET /api/modal/health | GET /health |
| 前回確認済みGPU情報（起動なし） | GET /api/modal/gpu/info | GET /gpu/info |
| 明示許可付きジョブ受付 | POST /api/modal/jobs | POST /jobs |
| 進捗 | GET /api/modal/jobs/:id | GET /jobs/{job_id} |
| キャンセル | POST /api/modal/jobs/:id/cancel | POST /jobs/{job_id}/cancel |
| PNG・MP4取得 | GET /api/modal/jobs/:id/result | GET /jobs/{job_id}/result |
| 概算（起動なし） | POST /api/modal/estimate | POST /estimate |
| 既存の素材へ追加 | POST /api/modal/jobs/:id/import | 保存済み生成物を取得 |

## 検証コマンド

```powershell
npm run typecheck
npm test
npm run build
python -m unittest modal_backend.test_api -v
# GPU起動なし
npx tsx scripts/check-modal.ts
python -m modal_backend.operator
# 次は明示的にGPUを1件起動する（課金対象）
npx tsx scripts/check-modal.ts --gpu
```

ローカルHTTPスモークは `scripts/smoke-modal.ts`。`--submit` が付くと課金対象のGPUジョブを送るため、通常のCIからは呼ばない。検証用案件・スクリーンショット・生成サンプルはgitignore済みの `.runtime/modal-qa/` に保存し、既存案件を検証用に書き換えない。

## フェーズ別の変更・検証結果（2026-11-04）

| フェーズ | 主な変更ファイル | 検証結果 |
|---|---|---|
| 1 構造解析 | 本文書 | フレームワーク・文章AI・設定・SSE/ジョブ・メディア保存と追加経路を確認 |
| 2 接続・認証 | `core/modal-vault.ts`, `core/modal-client.ts`, `server/routes/modal.ts`, `shared/modal.ts`, `scripts/setup-modal.ts`, `server/index.ts` | hirompsワークスペースのSDK認証、専用Proxy Tokenの作成・DPAPI保存、認証付きHTTP疎通に成功。秘密値のAPI応答・保存ファイルへの平文混入なし |
| 3 GPU疎通 | `modal_backend/app.py`, `modal_backend/contracts.py`, `scripts/check-modal.ts` | 実機 NVIDIA RTX PRO 6000 Blackwell Server Edition、VRAM 97,291MiB、CUDA 12.8、compute capability 12.0。CUDA上の行列計算に成功。終了後コンテナ0 |
| 4 モデル | `modal_backend/models.py`, `modal_backend/app.py`, `scripts/smoke-modal.ts` | SSD-1BのT2I/I2Iで512px PNG生成・取得、Wan 2.1のT2VとWan 2.2のI2Vで小規模MP4生成・取得に成功。MP4はffprobeでH.264・寸法・フレーム数を確認 |
| 5 UI | `src/components/ModalCloud.tsx`, `src/modal-api.ts`, `src/modal.css`, `src/pages/Settings.tsx`, `src/pages/Materials.tsx` | 実ブラウザで390/1024/1440px、横はみ出しなし、JSエラーなし、保存済み秘密欄は空。許可前の生成ボタン無効、概算取得だけではGPU起動なし。PNG表示・MP4再生を確認 |
| 6 ジョブ・料金・取り込み | `modal_backend/app.py`, `modal_backend/contracts.py`, `core/modal-results.ts`, `core/catalog.ts`, `shared/schema/catalog.ts`, `shared/jobs.ts`, `server/jobs.ts` | 設定・履歴・予算予約を再デプロイ後も保持。検証用案件に元の撮影素材を残し、画像の3秒MP4化・生成MP4の直接追加に成功（素材1→2→3本）。再スキャン保持も回帰テスト済み |
| 7 保護・回帰 | `test/modal.test.ts`, `test/modal-routes.test.ts`, `test/modal-catalog.test.ts`, `test/beginner-ui.test.ts`, `modal_backend/test_api.py`, `scripts/verify-modal-guards.ts`, `modal_backend/operator.py` | 型検査・ビルド成功。TypeScriptテスト1,067件成功（1件は既存の実データ指定時のみのためskip）、Python12件成功。実APIの未認証401、予算拒否429、同時実行拒否409、同一UUIDの再送防止、実ジョブのcancelled、30秒上限のJOB_TIMEOUTを確認 |

途中の失敗履歴も隠さず残している。最初のGPUテストではPyTorch独自型のシリアライズを修正。I2VではHugging Faceのキャッシュリンク二重計上を修正し、その後成功。タイムアウト検証の失敗状態は上限停止が機能した記録。再試行分を含め予算予約は取り消していない。

検証終了時のジョブ予約合計は$6.534833、保存領域・API余裕は$7.70、アプリ予算残額の目安は$10.765167。これは**実請求額ではない**。最終確認時はGPUコンテナ0・実行入力0・待機0。Modalアカウント全体の請求額・支払上限・無料クレジット残高は本作業では変更・認定していない。

デプロイ: https://modal.com/apps/hiromps/main/deployed/reel-studio-gpu

初回の実装ではソース版とModalを更新し、続く「全てに反映」の依頼で0.4.12としてWindows版・インストーラー・公開Web/PWA・更新配信も揃える。作業開始前の未コミット変更は元の作業フォルダに保持する。Webの接続は https://reel-studio-sandy.vercel.app の設定 → Modal Cloud GPUから利用できる。Windows版は通常のデスクトップショートカット、ソース版はこのフォルダの `Reel Studio.cmd` から起動する。
