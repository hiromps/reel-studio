# Reel Studio

**Reel Studio** is a local GUI + CLI that turns raw footage from a restaurant visit into a
9:16 short reel (Instagram Reels / TikTok / YouTube Shorts): it catalogs the clips, plans the
cut order from a set of proven formats, writes the telops and the narration script with
Claude Code, synthesizes the voice with Fish Audio, renders with Remotion, mixes, and drops a
deliverable (video + caption) into an `outputs/` folder.

Everything runs on your machine. Your API key and your "personas" (voice, tone, caption style)
live in `~/.reel-studio/`, outside the repository.

- **Requirements**: Node.js 20+, `ffmpeg` / `ffprobe` on PATH,
  [Claude Code](https://claude.com/claude-code) installed and logged in (`claude` on PATH),
  optionally a [Fish Audio](https://fish.audio/) API key for narration audio, and optionally
  Python 3.10+ for automatic face mosaic ([deface](https://github.com/ORB-HD/deface); installed from the Settings tab).
- **Quick start**

  ```bash
  git clone https://github.com/hiromps/reel-studio.git
  cd reel-studio
  npm install
  npm start          # builds the GUI once, starts the server on :4310, opens the browser
  ```

  Then open the **Settings** tab (Ctrl+6): pick a data folder, paste your Fish Audio key,
  check that `claude` is detected, and give a persona a voice. The UI is in Japanese.
- **License**: MIT. Remotion (the renderer) has its own license: free for individuals and
  companies of up to three people, otherwise a company license is required — see
  [remotion.dev/license](https://www.remotion.dev/license).

---

## これは何

飲食店で撮った素材動画から、縦型 9:16 のショート動画（リール）を仕上げるためのローカルツールです。
ブラウザで動く GUI と、同じ処理を叩ける CLI（`bin/reel`）があります。

```
素材フォルダ ──カタログ化──▶ 素材ごとの長さ・サムネイル・プロキシ（4K/HEVC → H.264）
                              │ Claude Code がサムネイルを見てタグを付ける
brief（意図）──構成プラン──▶ 型（F0〜F7）どおりのカット順と役割
台本 ──台本から組み立て──▶ cuts + ナレーション原稿
                              │ Timeline で並び・尺・テロップ・ナレーション・効果音を 1 画面で調整
検証 E ゼロ ──仕上げ──▶ 音声生成（Fish Audio）→ レンダー（Remotion）→ 合成 → outputs/ に納品
```

AI に任せる工程（タグ付け・並べ替え・テロップ・ナレーション原稿・キャプション・店舗情報の裏取り）は、
**ローカルにインストールされた Claude Code（`claude` コマンド）を裏で走らせて**行います。
API キーは要りません。ログイン済みの Claude Code がそのまま使われます（実行のたびに利用枠を消費します）。

## 必要なもの

| もの | 用途 | 確認 |
|---|---|---|
| Node.js 20 以上 | 本体 | `node -v` |
| ffmpeg / ffprobe（PATH に通っていること） | 素材の解析・サムネイル・プロキシ・合成 | `ffmpeg -version` |
| Claude Code（`claude` が PATH にあり、ログイン済み） | タグ付け・テロップ・原稿・キャプション | `claude --version` |
| Fish Audio の API キー（任意） | ナレーション音声の生成 | Settings の「接続テスト」 |
| Smartgram の MCP 用 API キー（任意） | 店舗情報の裏取りで店の公式 Instagram を読む（ログイン壁を回避） | Settings の「Instagram の情報取得」 |
| Python 3.10 以上（任意） | 素材の顔モザイク（[deface](https://github.com/ORB-HD/deface) を専用の venv に入れる） | Settings の「顔モザイク（deface）」 |

Windows 11 で開発・運用しています。macOS / Linux でも動く作りですが、フォルダ選択ダイアログ（Settings・Materials の「フォルダを選ぶ」）は Windows 専用で、他 OS ではパスを手で入力してください。

## はじめかた

```bash
git clone https://github.com/hiromps/reel-studio.git
cd reel-studio
npm install
npm start            # 画面をビルド → サーバー（:4310）起動 → ブラウザを開く
```

Windows なら `Reel Studio.cmd` をダブルクリックしても同じです。デスクトップにショートカットを作るには
`powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1`。

開発時は `npm run server`（API :4310）と `npm run dev`（Vite :5173、HMR）を別々に起動します。
テストは `npm test`、型検査は `npm run typecheck`。

## 更新のしかた

新しい機能や修正は GitHub に置いています。**案件データ・設定・人格はリポジトリの外**
（`~/.reel-studio/` とデータフォルダ）にあるので、更新で失われることはありません。

```bash
npm run update      # git pull → 依存の導入 → 画面のビルド をまとめて行う
```

そのあと **Reel Studio を起動し直してください**（起動中なら一度閉じる）。

画面からも更新できます。**Settings（Ctrl+6）の「版と更新」**に、更新の有無と入る変更が出ます。
「更新する」を押すと `git pull` まで行うので、あとは再起動するだけです。

- 手元でコードを直している場合は、先に `git stash` で退避するか、コミットしてください
  （勝手にマージせず、その旨を表示して止まります）
- zip で展開した場合は更新コマンドが使えません。`git clone` で入れ直してください
  （設定と案件データはフォルダの外なので引き継がれます）
- エンジン（テロップ描画）が変わった更新のあとは、各案件は次のレンダーで自動的に揃います
- 何が変わったかは [CHANGELOG.md](CHANGELOG.md) にあります

## 初期設定（Settings タブ・Ctrl+6）

最初に一度だけ。設定は `~/.reel-studio/settings.json` と `~/.reel-studio/personas.json` に保存されます
（リポジトリの外なので誤ってコミットする経路がありません。置き場は環境変数 `REEL_STUDIO_HOME` で変えられます）。

1. **データフォルダ** — 案件（`work/`）・生素材（`uploads/`）・納品（`outputs/`）・効果音（`sfx/`）を置く親フォルダ。
   空欄ならアプリ内の `data/`（gitignore 済み）。既にある素材フォルダを使いたいときは、そのフォルダを指定するか個別に上書きします。
2. **音声生成（Fish Audio）** — API キーを入れて「接続テスト」。鍵は画面には戻ってこず（末尾 4 桁だけ表示）、平文で `settings.json` に保存されます。
   Windows ではユーザープロファイルのアクセス権だけで守られる点に注意してください。環境変数 `FISH_API_KEY` があればそちらが優先されます。
   人格の既定ボイス以外に選びたいモデル（他の人の公開モデルなど）は「追加ボイス」に reference_id を登録します。
3. **AI（Claude Code CLI）** — `claude` の検出結果とバージョンが出ます。PATH に無ければ実行ファイルの場所を指定できます。
   既定モデル（opus / sonnet / haiku）とタグ付けの並列数もここ。
4. **Instagram の情報取得（Smartgram MCP）** — キャプションを書く前の「店舗情報の裏取り」で、店の公式 Instagram を
   [Smartgram](https://app.smartgram.jp/) の MCP サーバー経由で読めるようにします（任意）。MCP 用 API キーを入れて「接続テスト」。
   無ければ Web 検索だけで裏取りしますが、Instagram はログイン壁で読めないことが多く、検索スニペット頼みになります。
   鍵は Fish Audio と同じく平文で `settings.json` に保存され（画面には末尾 4 桁だけ）、環境変数 `SMARTGRAM_MCP_KEY` があればそちらが優先されます。
   「実行アカウント」は Smartgram に登録済みのアカウント名で、空なら AI が一覧から有効なものを選びます。
5. **テロップのフォント** — 自前のフォント（ttf / otf / ttc / woff / woff2）を取り込むと、テロップをそのフォントで描けます。
   置き場は `~/.reel-studio/fonts/`。ここで選んだものが**これから作る動画**の既定になり、案件ごとの変更は
   Timeline の「動画全体 → フォント」で行います（`cuts.json` の `font`）。テロップは太字前提なので **Bold / 太ゴシック・太明朝**が向いています。
   取り込まなければ同梱の Noto Serif JP Bold（SIL OFL 1.1・商用可）のままです。
   **持ち込むフォントのライセンス（商用利用・埋め込みの可否）は利用者が確認してください。**
6. **人格（persona）** — 「誰の声・文体で作るか」のまとまり。文体・締めの文言・フックの型・ボイス・話速・
   キャプションの型（markdown）をここで決めると、AI のテロップ・ナレーション・キャプションに効きます。
   同梱のサンプル 3 つ（スタンダード／発見型／カジュアル）はボイス未設定なので、**Fish Audio のボイスを入れてから**使ってください。
   自分の Claude Code スキル（`SKILL.md` と `references/hashtag-bank.md`）を型として使いたい人格は「外部のスキルフォルダ」に絶対パスを入れます。

CLI からは `bin/reel settings show` で現在の設定（鍵はマスク）、`bin/reel personas list` で人格の一覧が見られます。
以前 Claude Code の `settings.local.json` / `.mcp.json` に鍵を置いていた場合は `bin/reel settings import-legacy --from <そのフォルダ>` で取り込めます（値は表示されません）。

## 使い方の流れ

タブを左から右へ進めば 1 本できます。画面上の「次にやること」に従ってください。

1. **Projects** — 案件（動画 1 本）を作る。同じ素材で別バージョンも作れる（素材はハードリンクで共有）。投稿し終えた案件は「投稿済み（隠す）」で一覧から外せる（消えません。いつでも戻せます）
2. **Materials** — 素材フォルダを読み込み、1 本ずつタグを付ける（AI に任せられる）。店員さんや他のお客さんの顔には「顔モザイク」をかけられる
3. **Brief** — 何を伝えるかを決めて構成を自動生成。台本があるなら貼って「台本から組み立てる」。
   **他の人のバズった動画を渡して型を写す**こともできる（「バズ動画の型を写す」。区間・カット数・テロップの型・フック・締めを分析し、その型で自分の素材の台本を書いて組み立てる。映像・音声・文言そのものは使わない）
4. **Timeline** — 映像・テロップ・ナレーション・効果音を 1 つのタイムラインで整えて検証する
5. **Render** — 「仕上げ」で原稿 → 音声 → レンダー → 合成 → 納品まで一気に。声の設定・効果音・キャプション・トライアルもここ
6. **Settings** — 上記の初期設定

各案件は `work/<slug>-reel/` に Remotion プロジェクトとして作られ、`catalog.json`（素材）・`brief.json`（意図）・
`cuts.json`（構成とテロップ）・`narration.json`（ナレーション）の 4 つのファイルが正です。
参考動画の型を写した案件には `reference.json`（分析結果）も入ります（動画そのものは `.studio/reference/` に置かれ、公開されません）。
詳しい操作・CLI・設計は [docs/guide.md](docs/guide.md) にあります。

## 環境変数

すべて任意。設定ファイルより優先されます。

| 変数 | 意味 |
|---|---|
| `REEL_STUDIO_HOME` | 設定の置き場（既定 `~/.reel-studio`） |
| `REEL_STUDIO_DATA_ROOT` | データフォルダ（`work/ uploads/ outputs/ sfx/` の親） |
| `REEL_STUDIO_WORK_DIR` / `REEL_STUDIO_UPLOADS_ROOT` / `REEL_STUDIO_OUTPUTS_DIR` / `REEL_SFX_DIR` | 個別のフォルダ |
| `FISH_API_KEY` / `FISH_MODEL_ID` | Fish Audio の鍵とモデル（既定 `s2.1-pro-free`） |
| `REEL_STUDIO_CLAUDE_BIN` | `claude` 実行ファイルの場所 |
| `REEL_STUDIO_AGENT_MODEL` | AI の既定モデル |
| `REEL_STUDIO_MOSAIC_PYTHON` | 顔モザイク（deface）に使う python |
| `REEL_STUDIO_PORT` / `REEL_STUDIO_HOST` | サーバーのポート（既定 4310）とホスト（既定 127.0.0.1） |
| `REEL_STUDIO_JOB_CONCURRENCY` | 同時に走らせるジョブ数（既定 2。ffmpeg / Remotion 系は常に 1） |
| `REEL_CLOUD_URL` / `REEL_WORKER_TOKEN` | クラウドモードの接続先とトークン（[docs/cloud.md](docs/cloud.md)） |

## 注意事項

- **Remotion のライセンス** — レンダーに使う Remotion は独自ライセンスです。個人および従業員 3 名以下の会社は無償、それ以外は会社ライセンスが必要です（[remotion.dev/license](https://www.remotion.dev/license)）。
- **効果音** — 効果音ラボなどの音源は再配布が禁止されているため同梱していません。`sfx/` に自分で置いて Render の「ライブラリを読み直す」を押してください。
- **鍵の保存** — Fish Audio の鍵は `~/.reel-studio/settings.json` に平文で保存されます。共有 PC では環境変数 `FISH_API_KEY` を使うか、使い終わったら Settings で消してください。
- **AI の費用** — AI の各ボタンは Claude Code を起動します。ジョブのログに 1 回ごとの費用（USD）が出ます。
- **ローカル専用** — サーバーは 127.0.0.1 にだけ bind し、別オリジンからのリクエストを拒否します。外部に公開する設計ではありません。

## スマホから使う（クラウドモード・任意）

ローカル専用のままでも使えますが、**Vercel に置いて PWA としてスマホから全機能を使う**構成もあります。

```
[スマホ PWA] ──HTTPS──▶ [Vercel] 画面 + API（Neon / Blob）
                            ▲
                            │ ポーリング（PC からの発信だけ）
                       [自宅 PC] Reel Studio  ← ffmpeg・Remotion・Claude Code はここで動く
```

重い処理（素材のカタログ化・AI・レンダー）は Vercel では実行できないので、**自宅の PC が受け取って実行します**。
そのため AI は今までどおりログイン済みの Claude Code CLI を使い、**クラウド化による API 課金は発生しません**。
原本の 4K 素材も PC に置いたまま（クラウドに載るのはサムネ・軽量プロキシ 540x960・完成動画だけ）。
代わりに **PC で Reel Studio が動いていないとジョブは待機します**（画面に「PC オフライン」と出て、起動後に順に実行されます）。

PC 側でやることは、いつもどおり **デスクトップのショートカットから Reel Studio を起動するだけ**です。
接続先（Settings の「クラウド接続」か環境変数）を入れてあれば、サーバーと一緒にワーカーが立ち上がり、
その窓を開けているあいだスマホから使えます。Reel Studio を開いていない間も繋げておきたい場合だけ、
ワーカーを単体で常駐させます。

作り方・環境変数・常駐のさせ方・費用のめやすは [docs/cloud.md](docs/cloud.md) にあります。

```bash
# 常駐させる場合だけ（ショートカットから起動しているなら不要。二重には走りません）
npm run worker
```

## ドキュメント

- [CHANGELOG.md](CHANGELOG.md) — 版ごとの変更（更新したときはここを見る）
- [docs/guide.md](docs/guide.md) — 画面と CLI の詳細、AI ジョブ、台本からの組み立て、トライアル、契約ファイル、設計とセキュリティ
- [docs/cloud.md](docs/cloud.md) — クラウドモード（Vercel + PWA + 自宅 PC ワーカー）の構成と運用
- [engine/README.md](engine/README.md) — Remotion エンジン（案件に複製されるテンプレート）

## 開発

```bash
npm run update      # 更新（git pull + 依存 + ビルド）
npm run server      # API サーバー（tsx）
npm run dev         # Vite dev server（HMR）
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run build       # dist/
npm run ci          # typecheck + test + build
```

コードを直したら Reel Studio を再起動してください（サーバーは起動時のコードで動き、画面に「サーバーが古い」と出ます）。
