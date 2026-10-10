# Windowsインストーラー版

## 利用者の使い方

1. `Reel-Studio-0.4.1-Setup.exe` を実行します。
2. インストール先を選び、完了後に「Reel Studio」を起動します。
3. デスクトップまたはスタートメニューの「Reel Studio」から次回も起動できます。

Windows 10/11の64ビット版が対象です。管理者権限を必要としないユーザー単位のインストールです。Node.js、npm、FFmpegの別途インストールやコマンド操作は必要ありません。Electron、Node.js、Remotion 4.0.522、FFmpeg/FFprobe 9.0.2、描画用Chrome、日本語フォントを同梱しています。素材の取り込み、カット・尺・クロップ・テロップの編集、プレビュー、動画の書き出しに使います。

AIによる台本作成には設定画面で接続先と認証を設定してください。Codexの実行部品は同梱していますが、ログイン・利用契約は利用者ごとに必要です。Claude Codeを選ぶ場合は別途インストール・ログインが必要です。Fish Audioの音声生成にはAPIキー、顔モザイクにはPythonとdefaceが必要です。これらの外部サービスの認証・料金・追加ツールはインストーラーで自動購入・設定しません。

初めて使う場合の保存先は「ドキュメント/Reel Studio Data」です。設定・人格は `%USERPROFILE%\.reel-studio`、画面の保存情報はElectronのユーザーデータフォルダに保存します。既存の設定がある場合はその保存先を使います。素材、案件、鍵はインストーラーに含めません。

## 更新とアンインストール

アプリを終了し、新しい版のインストーラーを実行してください。案件と設定は保持します。ソース版のGit更新はインストーラー版では使いません。自動更新サービスは未設定です。

Windowsの「インストールされているアプリ」からアンインストールできます。案件・素材・設定は削除しません。不要になったデータは利用者が保存先から削除してください。

起動や書き出しに問題がある場合は、アプリの「ヘルプ → ログフォルダを開く」を使ってください。部品が欠けている場合は同じインストーラーを再実行できます。

## 開発者が配布ファイルを作る

Windows x64で「Reel Studio インストーラー作成.cmd」を実行します。初回はネット接続が必要です。ソースの依存関係と描画部品を用意した後、配布用フォルダに実行用の依存関係だけを新規導入します。

```powershell
npm ci
npm run desktop:installer
npm run desktop:verify
```

成果物は `desktop-out/Reel-Studio-0.4.1-Setup.exe` です。`dist`は内部の編集画面であり、利用者への配布物はこのEXEです。`.runtime/desktop-stage` と `desktop-out/win-unpacked` はビルド・検証用です。

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
