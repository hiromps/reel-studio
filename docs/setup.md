# 一般利用者向けセットアップ（Windows）

Windows 10/11の64bit（x64）PC向けです。インターネット接続と、アプリ用に数GBの空き容量が必要です。素材と完成動画には別途空き容量を用意してください。Windows ARM64はこの配布版の対象外です。

## はじめかた

1. 配布ZIPをダウンロードし、右クリック→「すべて展開」。ZIPの中から直接起動しないでください。
2. 展開した`reel-studio`フォルダの「Reel Studio セットアップ.cmd」をダブルクリックします。
3. セットアップ完了後、「Reel Studio.cmd」またはデスクトップのショートカットで起動します。
4. ブラウザに編集画面が開きます。設定で保存先を確認し、案件を作成して素材を読み込みます。新しい案件の描画部品は自動で導入されます。
5. Timelineでカット・並び・尺・テロップ・画角を調整し、Renderの本番レンダーでMP4を書き出します。

Node.jsやnpmの知識、手動のPATH設定、Gitのインストールは初回利用に必要ありません。初回はダウンロードと画面構築に数分かかります。起動用ウィンドウを閉じると処理も終了するため、書き出し中は開いておいてください。

## 自動で準備するもの

| 要素 | 用途 | 導入方法 |
|---|---|---|
| Node.js 24 LTS + npm | アプリと依存パッケージの実行 | 対応版がなければ公式ZIPをSHA256検証して`.runtime/node`へ展開 |
| アプリの依存パッケージ | 編集画面・API・同梱Codex CLI | lockファイルに従って`npm ci` |
| Remotion / CLI / Player | 動画プレビューと書き出し | 4.0.522で統一・固定 |
| Chrome Headless Shell | 動画描画 | Remotionがダウンロード、案件間で共有 |
| FFmpeg / FFprobe | 素材解析・変換・音声合成 | 対応版がなければSHA256検証したGyan full buildを`.runtime/ffmpeg`へ展開 |
| 日本語フォント | テロップ | Noto Serif JPをライセンス付きで同梱 |

FFmpegは`libx264`、AAC、`speechnorm`、`loudnorm`、`alimiter`、`libsoxr`を実行して確認します。Essentials buildだけではこのアプリの音声合成に不足するため、Full buildを使います。導入済みの対応ツールは再利用します。システム全体のPATHや既存のNode.jsは変更しません。

## 利用者が設定するもの

手動編集・MP4書き出しにはAPIキーは不要です。

- AIで台本・タグ付けなどを行う場合：設定でClaude / DeepSeek / Codexを選びます。Claude Codeは別途導入・ログイン、DeepSeekはAPIキー、同梱Codexはログインが必要です。Codexのログインは、設定したNode環境で`npx codex login`を実行します。
- AI音声を生成する場合：Fish AudioのAPIキーと使用する声を設定します。
- 顔モザイクを使う場合：Python 3.10以上を導入してから、設定画面の顔モザイクで専用環境をインストールします。
- 効果音や音楽：使用権のあるファイルを利用者が用意してください。

認証情報はセットアップでは入力・変更しません。各サービスの利用契約や料金は各利用者の接続先によります。

## 保存・更新

新規セットアップでは案件・素材・完成動画の親フォルダを`ユーザーフォルダ/Reel Studio Data`に設定します。設定・人格は`ユーザーフォルダ/.reel-studio`です。既存の設定や従来の`data/`がある場合は保存先を変更しません。設定画面で保存先を確認・変更できます。

ZIP配布版を更新するときは新しいZIPを別フォルダへ展開してセットアップしてください。従来の`data/`を利用している方は、設定画面の保存先を引き継いでください。Git版では「Reel Studio 更新.cmd」を使えます。更新・再セットアップの前に起動用ウィンドウを閉じてください。

## 不具合を調べる

「Reel Studio 診断.cmd」をダブルクリックすると、必要部品の導入状態を確認します。「Reel Studio 書き出し確認.cmd」では実際の1秒の動画を生成し、カット・テロップ・音声合成・1080×1920 H.264/AAC・30フレームを検証します。動作確認結果は`.runtime/smoke-*/out/`に残ります。既存案件は変更せず、AIへの課金もありません。

コマンドを使える方は`npm run setup`、`npm run doctor`、`npm run test:export`も利用できます。`.runtime/node`のNodeを導入したPCでは同じフォルダの`npm.cmd`を使ってください。ダウンロードが失敗した場合は通信を確認してセットアップを再実行します。macOS/LinuxではNode.js 22以上・対応するFFmpegを手動で導入してから`npm run setup`を実行してください（Windows版のみ動作確認済み）。

## 配布者向け

`npm run package:windows`で`releases/Reel-Studio-<version>-Windows.zip`とSHA256を生成します。実行環境・APIキー・素材・既存案件・`.git`は含めません。必要部品は利用者の初回セットアップ時に提供元から取得するため、初回はオンラインが必要です。アップロードや公開はこのコマンドでは行いません。

Reel Studio本体はMITですが、[Remotionには別のライセンス条件](https://www.remotion.dev/license)があります。一般向け配布・商用利用の形態に合う条件を配布者と利用者それぞれが確認してください。FFmpegは配布ZIPに同梱せず、[Gyanのビルド](https://www.gyan.dev/ffmpeg/builds/)を取得します。フォントのOFLライセンスは`engine/public/fonts/OFL_license.txt`です。

この配布版は各PCで動作するローカルアプリです。インストール不要のWebサービスとして一般公開するには、利用者ごとの認証・データ分離とサーバー側の動画処理環境を別途整備する必要があります。
