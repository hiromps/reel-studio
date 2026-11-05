# Windowsインストーラー版

## 利用者の使い方

1. `Reel-Studio-0.4.14-Setup.exe` を実行します。
2. インストール先を選び、完了後に「Reel Studio」を起動します。
3. デスクトップまたはスタートメニューの「Reel Studio」から次回も起動できます。

Windows 10/11の64ビット版が対象です。管理者権限を必要としないユーザー単位のインストールです。Node.js、npm、FFmpegの別途インストールやコマンド操作は必要ありません。Electron、Node.js、Remotion 4.0.540、FFmpeg/FFprobe 9.0.2、描画用Chrome、日本語フォントを同梱しています。素材の取り込み、カット・尺・クロップ・テロップの編集、プレビュー、動画の書き出しに使います。

AIによる台本作成には設定画面で接続先と認証を設定してください。Codexの実行部品は同梱していますが、ログイン・利用契約は利用者ごとに必要です。Claude Codeを選ぶ場合は別途インストール・ログインが必要です。Fish Audioの音声生成にはAPIキー、顔モザイクにはPythonとdefaceが必要です。これらの外部サービスの認証・料金・追加ツールはインストーラーで自動購入・設定しません。

初めて使う場合の保存先は「ドキュメント/Reel Studio Data」です。設定・人格は `%USERPROFILE%\.reel-studio`、画面の保存情報はElectronのユーザーデータフォルダに保存します。既存の設定がある場合はその保存先を使います。素材、案件、鍵はインストーラーに含めません。

## 更新とアンインストール

「Reel Studio 更新.cmd」を実行すると、GitHub Releasesの正式公開版・このフォルダ・インストール済みの版を比較し、新しい版だけを適用します。最新版ならビルドや再インストールをせず終了します。ソースをGitで上書き・退避する操作は行いません。実行中のアプリがあれば、編集を保存して閉じるまで待ってから自動で続けます。二重実行も先の更新の完了を待ちます。

配布済みEXEがある版は、SHA256とサイズを検証してからインストールします。ソースだけの公開版は、専用キャッシュへ取得し、必要な部品の準備・アプリの作成・書き出し検証・インストールまで自動で実行します（数分かかります）。手元のソースの版が公開版より新しい場合も、素材・鍵・依存部品を除いたコピーを専用キャッシュへ作ってからビルドします。開発中の `node_modules` は書き換えません。設定と案件は引き継ぎ、他の版へのダウングレードはしません。

更新処理自体はインストール先の外へコピーして実行するため、Windowsのファイル使用中エラーを防ぎます。インストール済みの新しい更新処理を次回以降も使います。Git・グローバルNode.js・管理者権限は不要です。途中の通信切断は再試行し、検証できないファイルをインストールしません。オフラインで最新版を確認できない場合はその旨を表示するので、接続復旧後に同じコマンドを再実行してください。

設定・人格の保護されたバックアップと結果は、ビルドしたソースの `.runtime/desktop-update-backups/` と `.runtime/desktop-update-result.json` に保存します。EXEを直接適用する場合の作業先は `%LOCALAPPDATA%\Reel Studio Updater\current` です。

```powershell
npm run desktop:update                 # 最新版を確認し、必要な場合だけ更新
npm run desktop:update -- --check-only # 最新版と更新先の確認のみ
npm run desktop:update -- --local-build # 手元の内容を同じ版でも作成・適用
npm run desktop:update -- --build-only # インストーラーの作成・検証まで
npm run update                         # GitHubからソースを更新（未コミット変更があれば停止）
```

Windowsの「インストールされているアプリ」からアンインストールできます。案件・素材・設定は削除しません。不要になったデータは利用者が保存先から削除してください。

起動や書き出しに問題がある場合は、アプリの「ヘルプ → ログフォルダを開く」を使ってください。部品が欠けている場合は同じインストーラーを再実行できます。

## 開発者が配布ファイルを作る

Windows x64で「Reel Studio インストーラー作成.cmd」を実行します。初回はネット接続が必要です。ソースの依存関係と描画部品を用意した後、配布用フォルダに実行用の依存関係だけを新規導入します。

```powershell
npm ci
npm run desktop:installer
npm run desktop:verify
```

成果物は `desktop-out/Reel-Studio-<version>-Setup.exe` です。`dist`は内部の編集画面であり、利用者への配布物はこのEXEです。`.runtime/desktop-stage` と `desktop-out/win-unpacked` はビルド・検証用です。

更新配信の対象は `hiromps/reel-studio` の正式なGitHub Releaseです。タグ `vX.Y.Z` と `package.json` の版を合わせて公開してください。EXE配布では `Reel-Studio-X.Y.Z-Setup.exe` とSHA256を添付します（GitHub APIのdigestまたは同名の `.sha256` を使用）。EXEがない版は公開タグのソースから自動作成します。下書き・プレリリースは対象にしません。未公開の版は別PCから検知できません。

`desktop:verify` は外部のNode.js・npm・FFmpegが見えないPATHを使い、日本語と空白を含む独立した保存先で新規案件を作ります。日本語テロップ、カット・速度・クロップ・キーフレームズーム・AI差分の適用、1080×1920の動画出力、音声合成、パッケージ化されたElectron起動、ローカルAPIの未認証拒否を確認します。既存の案件・設定・APIキーは使いません。結果は `desktop-out/verification.json` です。

展開版を作る場合は `npm run desktop:unpacked`、開発時の専用ウィンドウは準備後に `npm run desktop` で起動できます。GitHub Actionsの「Windows desktop installer」を手動実行しても作成できます。自動公開はしません。

## 一般公開前の配布条件

現時点のEXEはコード署名をしていません。Windowsが「不明な発行元」と表示する場合があります。一般公開する版には発行者のWindows用コード署名を設定してください。`desktop/electron-builder.cjs` の `win.signExecutable: false` を外して証明書・署名サービスを設定します。秘密鍵や証明書はリポジトリに置かないでください。

Reel Studio本体のMITと、同梱部品のライセンスは別です。各部品のライセンス・npm部品一覧はアプリの「ヘルプ → ライセンス」から開けます。Remotionを組み込む製品の配布には、開発者側を含む利用形態に適したRemotionのライセンスを確認してください。

同梱しているGyan版FFmpegはGPL v3で、Remotionのネイティブ描画部品にもGPLのFFmpegが含まれます。バイナリを一般配布する発行者は、FFmpegと有効化された外部ライブラリの対応ソース・ビルド資料をGPLに沿って提供する必要があります。このリポジトリには対応ソース一式を収録していません。部品の取得元リンクだけで対応済みとは扱わず、配布版に対応するソース提供方法を整えてから一般公開してください。これは署名と別の公開準備です。[Remotionの同梱部品の説明](https://www.remotion.dev/docs/acknowledgements)も確認してください。

公式資料:

- [Electronの配布](https://www.electronjs.org/docs/latest/tutorial/application-distribution)
- [electron-builderのWindows設定](https://www.electron.build/win.html)
- [Remotionのライセンス](https://www.remotion.dev/license)
- [FFmpegのライセンスと配布](https://ffmpeg.org/legal.html)
- [Gyan FFmpeg builds](https://www.gyan.dev/ffmpeg/builds/)
