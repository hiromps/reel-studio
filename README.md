# Reel Studio

グルメリール制作（hiro / nagi / sayuri / bonjiri の daihon スキル × Remotion）の **CLI と GUI**。
「素材だけ渡したとき」に format-patterns.md の型どおりの構成を決定論で組み立て、
テロップ文だけを Claude が書き、GUI（Phase 2）でプレビューしながら手直しできるようにする。

```
素材フォルダ ──reel catalog──▶ catalog.json（probe・サムネ・プロキシ）
                                │  Claude がサムネイルを見て tags を書く（reel tag）
                                │  Claude が並び順を決める（reel order。省略可＝型どおりの自動割当）
brief.json（意図） ──reel plan──▶ cuts.json の骨組み（src/in/out/役割/テロップグループ/alias）
                                │  Claude が {{gNN:intent}} を埋める
                    reel validate ▶ E ゼロ ──▶ reel draft / reel render / reel still
```

## 起動（ワンクリック）

デスクトップの **「Reel Studio」** ショートカットをダブルクリックすると、必要なら依存の導入と
画面のビルドを済ませてサーバーを立ち上げ、ブラウザで <http://localhost:4310/> を開く。
黒いコンソールが出たままになるのが正常で、**閉じると終了**する。すでに起動している場合は
二重に立ち上げず、ブラウザだけを開き直す。

ショートカットを作り直す・消すとき：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1              # 作成・上書き
powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1 -Dev         # HMR 版（別名で作成）
powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1 -Uninstall   # 削除
```

ショートカットの参照先は絶対パスなので、**リポジトリを移動したら作り直す**こと。
アイコンを作り直すときは `node scripts/make-icon.mjs`（ffmpeg を使う）。

コマンドラインからは次のとおり。

```bash
npm start                # ワンクリックと同じ（dist を配信。ソースが新しければ自動ビルド）
npm run start:dev        # Vite dev server 併用（HMR あり・:5173）
npm start -- --rebuild   # dist を作り直してから起動
```

## セットアップ（開発）

```bash
cd tools/reel-studio
npm install
npm test          # vitest（エンジンとの一致・validate・plan の回帰）
npm run build     # dist/ を作る（npm start が必要に応じて自動実行）
```

CLI は Git Bash から `tools/reel-studio/bin/reel <cmd>`（cmd.exe は `bin\reel.cmd`）。

## CLI

| コマンド | 内容 |
|---|---|
| `reel projects` | `work/*-reel` の一覧（契約ファイルの有無・エンジン差分・node_modules） |
| `reel new <slug> --persona hiro\|nagi\|sayuri\|bonjiri [--shop 店名] [--no-install]` | テンプレ複製・`brief.json` 雛形・npm install |
| `reel new <slug> --from <既存slug> [--shop 別ブランド名] [--persona p] [--no-facts]` | **同じ素材で別バージョン**。素材はハードリンク共有、`catalog.json`（タグ）を引き継ぐ |
| `reel catalog <素材フォルダ> --project P [--no-proxy] [--no-thumbs] [--scenes] [--speech] [--force]` | `catalog.json`。HEVC/4K は H.264 1080x1920 プロキシ。`--scenes` はカット済み単一ファイル用、`--speech` は会話クリップの無音検出 |
| `reel tag --project P --export [file]` / `--import <file>` | Claude のタグ付け用エクスポート／取り込み（`user.lock` は保護、`slug` 変更でファイルもリネーム） |
| `reel order --project P [--check]` / `--export [file]` / `--import <file> [--write] [--force]` | 並び順（構成）。無印は現在の並びの構成チェック、`--export` は Claude に渡す判断材料、`--import` は並び替え案の取り込み＋再 plan |
| `reel ai tag --project P [--force] [--batch n] [--model m]` | **裏で claude を起動**してタグ付けを代行させる |
| `reel ai order --project P [--write] [--force] [--model m]` | 同じく並び替えを代行させる |
| `reel ai telop --project P [--force] [--model m]` | 同じく `{{gNN:intent}}` のテロップ文を書かせる |
| `reel ai edit --project P "<直したいこと>" [--model m]` | 自由文の指示で `cuts.json` / `narration.json` を直させる |
| `reel ai narration --project P [--model m]` | 完成したテロップと映像を見てナレーション原稿を書かせる（`narration.json`） |
| `reel ai script --project P [--model m] [--force] [--dry]` | **`script.md` の台本から** cuts + narration を組み立てる |
| `reel ai facts --project P [--force] [--model m]` | 店の住所・営業時間を Web で裏取りして `brief.facts` に入れる（**Instagram 優先**） |
| `reel ai caption --project P [--model m] [--no-research] ["<追加の指示>"]` | 裏取り → 人格の SKILL.md Step 4 と過去の実例を読んで `caption.txt` を書かせる |
| `reel sfx scan` / `reel sfx list` | 効果音ライブラリ（`sfx/`）の棚卸し・一覧 |
| `reel sfx role <file> <役割> [--trim s] [--fade s] [--gain dB] [--label 名]` | どの音をどの役割に使うか（自動配置はこれを見る） |
| `reel sfx auto --project P [--max n] [--gap s] [--exclude role,..] [--dry]` | cuts.json から効果音を自動配置して `narration.json` の `sfx` に書く |
| `reel tts --project P [--force] [--id a,b]` | `narration.json` → `narration/<id>.wav`（Fish Audio。実測尺を書き戻す） |
| `reel plan --project P [--write] [--no-reuse] [--no-copy] [--json]` | 構成の生成。`--write` で `cuts.json` に書き込み＋alias コピー |
| `reel validate --project P [--json] [--strict-proxy]` | E/W の検証（exit 1 = E あり） |
| `reel table --project P` | 現在の `cuts.json` をカット表で表示 |
| `reel aliases --project P` | 同一 src 非連続参照の別名コピーを適用 |
| `reel sync --project P [--check]` | エンジン（src/*.tsx）をマスターに同期 |
| `reel draft\|render --project P [--out f] [--gl swiftshader] [--concurrency n] [--crf n] [--cache-size 256mb] [--retries 3] [--force] [--no-sync] [--strict-proxy] [--props f]` | preflight → レンダー（段階リトライ）→ フレーム数検証 → QC タイル |
| `reel still --project P --cut N [--offset 0.3]` / `--frame F` | 1 フレーム書き出し（カット頭から 0.3 秒後が既定） |
| `reel trial --project P [--ids A,B] [--draft] [--no-deliver] [--force]` | **フックだけ差し替えた複数版**を作る（レンダー→音声→mix→納品） |
| `reel deliver --project P [--label 修正版] [--allow-silent] [--overwrite]` | 完成品だけ `outputs/` へ（`<店名>_<人格>_ナレーション付き.mp4` と `_caption.txt`） |

`--project` は slug（`work/<slug>-reel`）でもパスでもよい。

## 同じ素材で複数バージョンを作る

同じ撮影素材から 2 本以上作る場面が多い（**人格違い**＝hiro 版 / さゆり版、**同じ店の別ブランド**＝
焼肉たべる版 / 焼肉伍龍版のような二毛作、**別構成**＝フックを変えた第 2 弾）。
1 案件フォルダ = 1 本なので**案件は分ける**が、素材をコピーすると 1 件 400MB 前後が丸ごと増え、
プロキシ・サムネイル・タグ付け（AI で一番お金のかかる工程）まで作り直しになる。

Projects の **「同じ素材から作る」**（`reel new <slug> --from <既存slug>`）を使うと:

| 引き継ぐ | やり方 |
|---|---|
| 素材（`public/`） | **ハードリンク**。中身は 1 つのまま両方から見える＝ディスクは増えない |
| サムネイル・ストリップ・軽量プレビュー（`.studio/`） | 同じくリンク。ffmpeg のやり直しが不要 |
| `catalog.json` | コピー。**タグ付けの成果をそのまま使える**（AI タグ付けを 2 回払わない） |
| `brief.json` | コピー。店名と人格は指定で差し替え |

| 引き継がない | 理由 |
|---|---|
| `cuts.json` / `narration.json` / `narration/` / `caption.txt` / `out/` | 版ごとに作るもの |
| `brief.hook` / `brief.order.fixed` | フックの選定は版ごとにユーザーが選ぶ決まり |

**ジャンクション（ディレクトリのリンク）は使わない。** `rm -rf` でリンク先の実ファイルまで消えるため。
ハードリンクなら片方の案件フォルダを消しても、もう片方に素材が残る。同じボリュームに置けないときは
自動で実体コピーに落ちる。

**引き継いだ `facts` の確認を促す。** 二毛作のように**ブランドで営業時間が変わる**ことがあるので、
`営業時間` / `定休日` / `Instagram` / `予約` / `備考` が引き継がれたときは警告を出す
（`--no-facts` で引き継がない）。

作ったあとは **Materials のカタログ実行は不要**で、Brief でフックのクリップを選んで「プラン生成」から始められる。

### 実測（焼肉伍龍 → 焼肉たべる）

```
素材: 308 本をリンクで共有（ディスクは増えません）
catalog.json: 50 クリップ分のタグを引き継ぎ
brief.json: 店名「焼肉たべる」／人格 hiro／型 F3
! 引き継いだ facts のうち 営業時間・定休日・Instagram・予約・備考 は版で変わることがあります
```

元の `public/` は 376MB、増えた分は実質ゼロ（ハードリンク数 2 で共有）。

## GUI：はじめて使うとき

初回起動時に**ガイドツアー**（16 ステップ）が自動で開き、各画面の役割をスポットライトで順に説明する。
閉じたあとは右上の **「? 使い方」**（`?` キーでも開く）から、ツアーの再表示・全体の流れ・絵コンテの見方・
ショートカット一覧・用語集を見られる。

タブの上には **「次にやること」** バーが出る。案件の状態（catalog / タグ / brief / cuts / 未記入テロップ /
未保存）から、いま一番やるべきことを 1 行で出し、ボタンでその画面へ飛ぶ。判定は `src/components/nextStep.ts`
（純粋関数・テストあり）で、上から順に

1. 案件を開く → 2. カタログ実行 → 3. 未タグの素材 → 4. brief を作る → 5. プラン生成 →
6. テロップの未記入（`{{gNN:intent}}`）→ 7. 未保存の保存 → 8. ナレーション原稿 → 9. 音声生成 →
10. キャプション → 11. レンダー（→ mix → 納品）

の最初に引っかかったものを出す。不要なら × で消せる（「? 使い方 → 全体の流れ」で戻せる）。
データがまだ無い画面（素材ゼロ・cuts なし等）は、行き止まりではなく**次の手順と移動ボタン**を出す。

## 複数の案件を並行して進める

**案件はタブごとに独立している。** URL の `?p=<slug>` がそのタブの案件で、案件を切り替えると
URL とタブのタイトルが書き換わる。タブを複製しても、そのあと片方の案件を変えたときに
もう片方は変わらない。Projects の **「別タブで開く」** から、いまのタブを保ったまま別案件を開ける。

そのために素材の URL には案件が入っている（`/p/<slug>/<mode>/uploads/...`。mode は `full` か
`light`＝軽量プレビュー）。Remotion Player には `window.remotion_staticBase` でこの先頭パスを渡している。
`/uploads/...` のような案件なしの旧 URL も残してあるが、これはサーバー側の「最後に開いた案件」で
解決するので、古いビルドの画面が残っていた場合の保険でしかない。

URL の `<slug>` は必ず `work/` の直下に閉じる（`resolveProjectDirStrict`）。ブラウザから来る
slug でリポジトリの外を読ませないため、案件を URL で受ける口はすべてこれを通す。

| 何がタブごとか | どこに持つか |
|---|---|
| 編集中の案件 | URL の `?p=` |
| 軽量プレビューの ON/OFF | `sessionStorage`（タブ単位。複製直後は同じ値で、あとから別々にできる） |
| 選択中のカット・Undo 履歴・絵コンテの表示状態 | 各画面の state（案件を切り替えると捨てる。App が `key={active}` で作り直す） |
| ジョブの通知・ファイルの読み直し | そのタブの案件のものだけ（他の案件のジョブでは動かない） |

### ジョブの同時実行

ジョブは**案件が違えば同時に走る**。ただし次の 2 つは守る（`shared/jobs.ts` の `canStartJob`・テストあり）:

- **同じ案件では 1 本だけ** — 同じ契約ファイルを取り合わせない
- **重いジョブは全体で 1 本だけ** — `catalog` / `thumbs` / `proxy` / `preview-proxy` / `render` /
  `draft` / `still` / `qc-tile` / `mix`。ffmpeg と Remotion がメモリを食い合って落ちるため

全体の上限は 2（`REEL_STUDIO_JOB_CONCURRENCY` で変更可）。つまり「A 案件をレンダーしながら
B 案件のテロップを AI に書かせる」はできるが、「2 案件を同時にレンダー」はできない（順番待ちになる）。

## AI に任せる（裏で claude を走らせる）

タグ付けと並べ替えは、**このPCに入っている Claude Code CLI（`claude.exe`）を子プロセスとして起動**して
代行させられる。API キーの設定は不要で、ユーザーの既存ログインをそのまま使う。

| どこ | 何が起きるか |
|---|---|
| Materials の **「AI にタグ付けしてもらう」** | 未タグのクリップを 8 本ずつに分け、コンタクトシートを見せて `kind` / `angle` / `signage` / `sizzleScore` / `subject` / `description` / `slug` を書かせ、`catalog.json` に反映する。看板・メニューから読み取れた事実は `catalog.facts` に入る |
| Timeline の **「AI に並べ替えてもらう」** | `.studio/order-export.json` を書き出し、それを読ませて並び順を決めさせ、`brief.order.fixed` → 再 plan → `cuts.json` まで書く |
| Timeline の **「AI にテロップを書いてもらう」** | 未記入（`{{gNN:intent}}`）のグループについて、**そのカット頭の実フレームを 1 枚ずつ見せて**文言を書かせ、`cuts.json` に入れる |
| Timeline の **「AI に直してもらう」**（自由入力＋送信） | 書いた指示に沿って、テロップ文言・ナレーションのセリフと位置・カットの IN/OUT・倍速・削除・並び替え・theme を直す |
| Render の **「AI にナレーションを書いてもらう」** | 完成したテロップ・カットの役割・各カット頭の実フレームを見て `narration.json` を書く。**テロップの内容に沿った原稿**を最優先にし（一字一句同じにはしない）、`caption.txt` と裏取り済みの事実で肉付けして動画の尺（6〜8 割を声で埋める）に合わせる |
| Render の **「AI にキャプションを書いてもらう」** | まず店舗情報を Web で裏取り（Instagram 優先）して `brief.facts` を埋め、人格の SKILL.md Step 4 と過去の実例を読んで `caption.txt` を書く |
| Render の **「店舗情報だけ調べる」** | キャプションは書かず、裏取りだけして `brief.facts` に入れる |
| CLI | `reel ai tag` / `reel ai order` / `reel ai telop` / `reel ai narration` / `reel ai facts` / `reel ai caption` / `reel ai edit "<直したいこと>"`（同じ処理。GUI はこれをジョブとして走らせているだけ） |

### フックのエリア名はバッジに出す

hiro / 凪のフックは「エリア＋一桁数字」型だが、**エリア名は縦書きの本文には書かず、
バッジ（中央上部のラベル）に出す**（2026-09-12 のユーザー指示）。本文はエリア名が無くても
意味が通る言い回しにし、**残った断片をそのまま置かない**——言い換えて語感を作ってよい。

| | |
|---|---|
| ✕ | 本文「生野区、9割が知らない」（エリア名が本文に入っている） |
| ✕ | バッジ「生野区」＋本文「、9割が知らない」（読点が残った断片） |
| ◯ | バッジ「生野区」＋本文「地元の9割が知らない」 |
| ◯ | バッジ「生野区」＋本文「大阪の9割が素通りする」 |

`ai-telop` はこの形で書く（グループごとに `badge` を返せるようにしてある。バッジはグループの
先頭カットにだけ付く）。既にエリア名が本文の頭にある案件は
`HOOK_AREA_IN_TELOP`（W）で指摘し、言い換え例をメッセージに出す。

**`HOOK_TEXT_PATTERN` はバッジを見る。** バッジにエリア名があれば本文に一桁数字があるだけで
型を満たしたと判定する（「9割が知らない」だけでも、バッジの「生野区」と合わせて読めるため）。
判定は `shared/telop-text.ts` の `leadingArea` / `looksLikeAreaDigitHook`（テストあり）。

### 店舗情報の裏取り（`ai-facts`）

キャプションには住所・営業時間が入るが、Reel Studio は素材と cuts しか知らない。なので
**キャプションを書く前に Web で裏取りして `brief.facts` を埋める**（「AI にキャプションを
書いてもらう」を押すと自動で先に走る。チェックを外せば手持ちの情報だけで書く）。
このときだけエージェントに `WebSearch` / `WebFetch` を渡す（書き込み系は渡さない）。

**出典の優先順位（上が強い。食い違ったら上を採る）:**

1. **素材映像・店内の掲示**（`catalog.facts`）— Web より強い。Web の価格が改定前で、素材の
   メニュー映像の方が正しかった実例があるため
2. **店の公式 Instagram** — **Google マップより優先**（ユーザー指示。実際こちらが正しいことが多い）
3. Google マップ
4. その他（食べログ・ぐるなび等）

取れた値には出典が付く（`営業時間: 10:00〜19:00（Instagram）`）。1 か所でしか確認できなかった
ものは `・要確認` が付き、**キャプションには使わせない**（`＿＿＿` で残して missing に挙げる）。
食い違いは `conflicts` として GUI とログに出す。

**既存の facts は上書きしない。** 素材から読めた値や人が直した値の方が強いので、既定では
「Web はこう言っていたが既存を残した」とだけ報告する（「既存の情報も上書きする」で入れ替え）。

実測（bonjour arima / sonnet・2026-09-12）: **$0.77 / 10 項目**。Instagram から営業時間・定休日・
IG ハンドルが取れ、住所と電話は集約サイト経由（Google マップのページは JS 描画で読めないことが
多く、検索結果や集約サイトに落ちる）。看板の「ご予約も承ります」と食べログの「予約不可」が
食い違い、**素材映像が優先されて看板側が採用された**。

### 自由指示（`ai-edit`）の作り

エージェントは**ファイルを書き換えず、差分だけを決まった形で返す**（`summary` / `telops` / `narration` / `cuts` / `order` / `theme` / `unapplied`）。
それを `core/ai.ts` が 1 件ずつ適用し、`ReelDataSchema` / `NarrationSchema` に通してから書く。形が壊れる差分は書かずに `unapplied` に落ちる。
変更前のファイルは `.studio/backups/` に残る。渡す文脈は、全カットの行（id・役割・区間・素材・テロップ・**カット頭のフレーム画像のパス**）と、
ナレーション各ブロック（`at`・実測尺・**次のブロックまでの空き秒から計算した目安文字数**・現在の文言）。

**ナレーションの文言を変えたら音声は作り直しになる。** 既存の `narration/<id>.wav` は古いままなので、
変えたブロックには `needsTts: true` を立てて `durSec` を消し、GUI とログで警告する。
そのまま Render の**「音声を生成」**を押せば、`needsTts` の付いたブロックだけが作り直される。

テロップ生成に渡すもの：グループごとの**役割（intent）・表示秒数・目安文字数・映っているものの説明・カット頭の実フレーム画像**と、
人格の文体、`spec.telop` の規則（13 文字・句点なし・半角括弧と絵文字の禁止・「・・・」の上限）、
そして **`catalog.facts` と `brief.facts`（裏取り済みの事実）**。「ここに無いことは書かない・料理名や数字を推測で作らない」を明示する。

**記入済みのテロップは触らない**（未記入のグループだけを埋める）。全部書き直したいときだけ「全部書き直す」。
会話字幕（`subs`）のカットは対象外。書いたものは `meta.slots[].textStatus` が `draft` になる——**AI の文言は下書き扱いで、人が読み直す前提**。

**エージェントには書き込みをさせない。** `--allowedTools Read Glob`（裏取りのときだけ `WebSearch` /
`WebFetch` を追加）だけを与え、権限プロンプトが出たら
自動で拒否する（`--permission-prompts none`）。返ってくるのは `--json-schema` で形を固定した JSON だけで、
契約ファイルへの反映は `core/ai.ts` が zod 検証を通してから `importTags` / `importOrder` で行う。
ワークスペースの MCP サーバーは読み込まない（`--strict-mcp-config`）——タグ付けには 1 つも要らず、
システムプロンプトが数万トークン膨らむだけなので。

**作業中は Timeline に進捗が出る。** `claude -p` を `--output-format stream-json` で走らせ、エージェントが
どの画像を Read したかを数えて進捗にしている（`core/agent.ts` の `onEvent` → `core/ai.ts` の `watchReads`）。

```
[AI がテロップを作成中]  画を確認中 4/10（a1b2….jpg）   0分42秒 経過   [中止]
████████░░░░░░░░░░  4 / 10
```

総数が分からない段階（起動中）は流れる帯で「動いている」ことだけ示す。
タグ付けは 3 本並列なので、バッチ単位の進捗（`3/8 完了`）＋各バッチのログ（`[2/8] 画 5/8`）になる。

**弱いモデルの出力は書き込まない。** テロップに改行や `【役割】…（10文字）` のような注釈を混ぜてくることがあるため、
改行を含むもの・上限文字数の 2 倍を超えるもの・一覧に無い id は `cuts.json` に入れず `skipped` に落とす
（haiku で実際に発生した。opus / sonnet を推奨する理由でもある）。

**課金される。** 実測（2026-09-11）:

| 作業 | モデル | 実測 |
|---|---|---|
| タグ付け 3 本（1 回） | sonnet | $0.33 / 70 秒 |
| タグ付け 2 本（1 回） | haiku | $0.14 / 40 秒 |
| 並べ替え 39 本から 10 カット | sonnet | $0.75 / 5 分 |
| テロップ 7 グループ | sonnet | $0.61 / 5 分 |
| 自由指示（ナレーション 2 行の言い換え） | sonnet | $0.64 / 4 分 |
| ナレーション原稿 13 ブロック | sonnet | $0.82 / 8 分 45 秒 |
| キャプション 1 本（12 カット＋実例 1 件） | sonnet | $0.57 / 2 分 |
| 店舗情報の裏取り 10 項目（Web 検索あり） | sonnet | $0.77 / 3 分 |

既定は `opus`（`studio.config.ts` の `agent.model`、環境変数 `REEL_STUDIO_AGENT_MODEL`、GUI のモデル選択で変更可）。
haiku は description の質が目に見えて落ちる（実測で料理名の推測混じり）ので、タグ付けは opus か sonnet を推奨。

`claude` が PATH に無い環境では `REEL_STUDIO_CLAUDE_BIN` に実行ファイルの場所を入れる。
見つからないときはボタンを押した時点でジョブが失敗し、その旨がログに出る。

## 台本から組み立てる（`ai-script`）

**人が書いた台本があるとき**は、型（F0 等）に素材を流し込む「プラン生成」ではなく、こちらを使う。
台本が正で、それに素材を合わせる。**型に収まらない長尺（90 秒など）もこちらなら作れる。**
場所は Brief 画面の「台本から組み立てる」（`script.md` に保存される）。

### 台本の書き方

書式は決め打ちにしていない（もらった台本をそのまま貼れることが大事）。
ただし **`【0〜3秒】フック` のような時間の見出し**があると、区間ごとの尺を検算できる:

```
【0〜3秒】フック
映像： 盛り合わせの全体を一気に見せる。肉のアップ
テロップ： 価格論争が起きた焼肉盛り
ナレーション： これ、いくらに見えますか？
```

`【1:00〜1:30】` `[0-3秒]` のような書き方も読む。見出しが無くても動くが、尺の検算はできない。

### 何を見て素材を選ぶか

**`catalog` のタグ（AI が映像を見て書いた description）**と台本の「映像：」を突き合わせる。
フレーム画像は見せない——素材 50 本に画を付けると重く、description があれば
「黒毛和牛大満足盛りをテーブルに置くシーン」のような指示には十分当たるため。
なので**先に「AI にタグ付けしてもらう」を済ませておくほど当たりが良くなる**（未タグの本数は画面に出る）。

| 台本の要素 | どうなるか |
|---|---|
| 映像： | 合う素材を選び、区間の尺に合わせて IN/OUT を決める（`usableRanges` の中から取る） |
| テロップ： | そのカットの `main.text` に。長ければ意味を保って縮める。エリア名は `badge` へ |
| ナレーション： | **台本の文のまま** `narration.json` へ（勝手に書き換えない） |
| 合う素材が無い区間 | 無理に埋めず `unmatched` に出す（撮り足しの指示になる） |

### 検算（`shared/script.ts` の `checkScriptPlan`・テストあり）

書き出す前に必ず通す。**E が 1 つでもあれば何も書かない**（壊れた構成で上書きしない）。

| コード | 内容 |
|---|---|
| `SCRIPT_UNKNOWN_CLIP` / `SCRIPT_NG_CLIP`（E） | catalog に無い素材 / NG にした素材 |
| `SCRIPT_BAD_RANGE` / `SCRIPT_OUT_OF_RANGE`（E） | 区間が逆・0 / 素材の長さを超えている |
| `SCRIPT_NARR_*`（E） | ナレーションの id 重複・空・改行・尺より後ろ |
| `SCRIPT_SECTION_LENGTH`（W） | **区間の尺が台本とずれている**（既定 1.5 秒まで許容） |
| `SCRIPT_SECTION_EMPTY`（W） | カットが割り当てられていない区間 |
| `SCRIPT_SAME_CLIP_RUN`（W） | 同じ素材の連続（切り替わって見えない） |
| `SCRIPT_TELOP_LONG` / `SCRIPT_TELOP_PERIOD`（W） | テロップの文字数・文末の句点 |

そのあとは Timeline で微調整 →「音声を生成」→「ナレーション合成（mix）」で仕上げる。
**8 割方できた状態から始められる**のが狙いで、残りは人が詰める前提。

## AI に並べ替えてもらう（`reel order`）

`reel plan` は format-spec の区間テンプレに沿って**決定論で**クリップを割り当てる。これに対し
`reel order` は、**Claude が素材を 1 本ずつ見て並び順そのものを決める**ための入口。
Claude が決めるのは「どのクリップを何番目に置くか」だけで、尺・役割・テロップグループは
`reel plan` が型どおりに決める（役割分担を分けているので、AI の判断が型を壊さない）。

```
reel order --project P --export          # .studio/order-export.json（サムネの場所・タグ・型の要求・今の並び）
  → Claude が clips[].sheet を 1 枚ずつ view して order を書く
reel order --project P --import f --write # 構成チェック → brief.order.fixed → 再 plan → cuts.json
reel order --project P                    # 今の cuts.json の並びを診断するだけ
```

取り込み時は `shared/order.ts` の `checkOrder` が並び**そのもの**を検査し、**E が 1 つでもあれば
何も書かずに終わる**（`--force` で無視できる）。見るのは次の規則で、いずれも
`format-patterns.md` / `edit-pipeline.md` に書かれているもの：

| コード | 重さ | 内容 |
|---|---|---|
| `ORDER_UNKNOWN_CLIP` / `ORDER_NG_CLIP` / `ORDER_CLIP_UNUSABLE` | E | catalog に無い・NG 指定・0.8 秒以上使える区間が無い |
| `ORDER_HOOK_FIRST` | E | 先頭が `brief.hook.clipId` でない（フック素材はユーザーが選ぶ規則） |
| `ORDER_HOOK_SIGNAGE` | E | 先頭に店名・看板が映る |
| `ORDER_SIGNAGE_EARLY` | E | F7 で看板クリップが最後の 2 カットより前にある |
| `ORDER_REVEAL_MISSING` / `ORDER_REVEAL_POSITION` | W | 看板クリップが未使用／リビールが型の位置にない |
| `ORDER_OPENING_NOT_FOOD` | W | 冒頭が外観・店内・人物（店紹介から入っている） |
| `ORDER_SAME_ANGLE_RUN` / `ORDER_SAME_SUBJECT_RUN` | W | 同じ画角・同一被写体が 3 連続 |
| `ORDER_SAME_CLIP_NONCONSECUTIVE` | W | 同じクリップを離れた位置で再使用（alias コピーが要る） |
| `ORDER_CUT_COUNT` / `ORDER_UNUSED_GOOD` / `ORDER_UNTAGGED` | W | カット数が型の推奨外／見せ場の使い残し／未タグのまま並べている |

`cuts.json` ができたあとの検証は従来どおり `reel validate`（`shared/validate.ts`）が行う。
`checkOrder` はその前段で、**plan する前に並びだけを見る**軽いチェック。
`planCuts` が自分で組んだ並びは E ゼロで通ることをテストで固定している。

**注意**：`--import --write` は固定順で plan をやり直すので、**記入済みのテロップは作り直しになる**
（CLI が該当カット数を警告する）。テロップを書いたあとで並びだけ直したいときは、
Timeline の絵コンテでドラッグする（`cuts.json` の配列順だけが変わる）。

Timeline 画面には検証カードの下に **「構成（並び順）」** パネルが出て、今の並びのチェック結果と
**「AI に並べ替えてもらう用に書き出す」** ボタン（＝`--export` と同じ）がある。

## GUI：カットの順番を決める（Timeline）

Timeline の一番上に **絵コンテ**（横いっぱいのサムネ一覧）がある。サムネは
**そのカットの IN 位置のフレームを素材から直接切り出したもの**なので、実際に映る画のまま並べ替えられる
（`catalog.json` を経由しないので、daihon スキル側で手作りした `cuts.json` のように src がカタログと
一致しない案件でもちゃんと出る。切り出しは `.studio/cutframes/` にキャッシュされ、2 回目以降は即座）。

| 操作 | 内容 |
|---|---|
| サムネをドラッグ | 順番を入れ替える。黄色い縦線が入る位置に落ちる。ドラッグ中は掴んだカードと「→ N 番目」が指に付いてくる |
| サムネをクリック | その位置へシーク。下のカット詳細もそこまでスクロールする |
| Alt + ← / → | 選択中のカードを 1 つ前／後ろへ。← / → だけなら選択の移動 |
| Esc（ドラッグ中） | 取り消して元の位置のまま離す |
| カット詳細行の ⠿ | 詳細リスト側でも同じようにドラッグで並べ替えられる（▲▼ も従来どおり） |
| カット詳細行の badge | 左上に出すバッジ。**F0 はエリア名（任意）**、F2 は順位、F6 は店名。`badge:none` の型（F1/F3/F4/F5/F7）に入れると検証が E を出す |
| **カット詳細行のフィルム帯** | 素材 1 本の全長を帯にして、**頭（IN）と尻（OUT）を掴んで尺を決める**。帯の中（明るい部分）を掴むと尺を保ったまま前後に動く。背景は catalog のストリップ（1 秒刻みのコマ）で、`usableRanges` は帯の下に細い線で出る |
| ↶ 元に戻す / Ctrl+Z | カットの並び・追加・複製・削除を 1 手戻す（30 手まで。入力欄の中では効かない） |
| 「テロップ単位で動かす」 | 既定 ON。同じテロップ文言が続くカット（絵コンテの色帯と `gNN` が同じ範囲）を 1 かたまりとして動かし、テロップが分断されるのを防ぐ。カードにマウスを乗せると、まとめて動く範囲が明るくなる |
| 「大きさ」小 / 中 / 大 | カードの大きさ。▾ で絵コンテ自体を畳める（どちらもブラウザに記憶する） |

### 尺のトリミング（フィルム帯）

カット詳細行の帯は**素材の全長**で、明るい部分が採用区間。掴めるところは 3 つ:

| 掴む場所 | 動き |
|---|---|
| 左のつまみ | IN だけ動く。OUT は動かない |
| 右のつまみ | OUT だけ動く。IN は動かない |
| 帯の中（明るい部分） | 尺を保ったまま窓ごと前後へ |

つまみは **Tab で選んで ← → でも動かせる**（1 フレームずつ、Shift で 10 フレーム）。
値は必ずフレームグリッドに乗り、0〜素材尺の外には出ず、最小 0.2 秒より短くはならない。
右端まで寄せたときは端数を出さず素材の末尾にぴったり付く。ドラッグ 1 回が **Ctrl+Z の 1 手**になる。
判定は `src/components/trim.ts`（純粋関数・テストあり）で、DOM 側は `TrimBar.tsx`。

カードには番号・役割（フック／証拠／リビール …）・尺・倍速・🔒 固定・テロップ文と、
そのカットに出ている検証の指摘（`!` = エラー、`?` = 警告）が出る。並べ替えは `cuts.json` の
配列順を書き換えるだけで、`id` と `meta.slots` はそのまま残る（保存は Ctrl+S）。

## GUI：素材から直接タイムラインを組む（Materials）

並び順が頭の中で決まっているとき（「この 19 本を撮った順に」「フックはこれ」）は、Brief の自動生成を
経由せずに **Materials のタイムライン**で組める。素材フォルダのカードの下、クリップ一覧の上に
**横一列・時間に比例した幅のトラック**があり、ここが `cuts.json` の実体。Timeline 画面と同じファイルを
同じ store で触っているので、どちらで直しても同じ（未保存の印も共通）。

```
素材カード ──ドラッグ──▶ ┌─────┬───┬────────┬──────┐ ← ブロック幅 = 実時間（倍速で縮む）
                        │ 1   │ 2 │ 3      │ 4    │    背景 = catalog のストリップ（採用区間ぶん）
                        └─────┴───┴────────┴──────┘
                         ↑両端をつまむと尺   ↑中を掴むと並べ替え   Alt+ドラッグ = 中身をずらす（尺は保つ）
```

| 操作 | 内容 |
|---|---|
| 素材カードをトラックへドラッグ | 青い縦線の位置に挿入。カードの「＋」か詳細の「＋ タイムラインに追加」なら末尾へ。`cuts.json` が無い案件は最初の 1 本で作られる（fps は catalog の主力 fps、theme は brief か型の既定） |
| 追加時の長さ | `usableRanges` の best（無ければ ok）の先頭。無ければ planCuts と同じ既定（2.5 秒以上は頭尾 0.2 秒を避ける）を**型の `maxCutSec`（既定 3 秒）で切る**。会話クリップ（hasSpeech / conversation / speech あり）は全尺。右端を引けば伸びる |
| ブロックの左端 / 右端 | IN / OUT。フレームグリッドに乗り、素材の外に出ず、0.2 秒より短くならない（Timeline のフィルム帯と同じ `applyTrim`）。**IN を引いている間は掴んだ端だけが指に付いてきて右側は動かず、離した瞬間に詰まる**（リップル） |
| ブロックの中をドラッグ | 並べ替え（絵コンテと同じ `useDragReorder`）。Esc で取り消し |
| Alt + ドラッグ | スリップ＝尺を保ったまま採用区間を前後にずらす |
| 目盛りをクリック／ドラッグ | 再生ヘッド（赤い線）を動かす。プレビューも追従。再生中は画面外に出たら自動で追いかける |
| ブロックをクリック | 選択＋そのカットの頭 0.3 秒後へシーク。右のクリップ詳細もその素材に切り替わり、**IN/OUT をドラッグしている間は詳細の video がその秒に追従**する |
| 下の詳細行 | IN / OUT の数値と ±1f、**再生位置で分割**（S キー。前半が元の id と slot を持ち、後半は新 id。テロップは両方に残る）、**削除**（Delete キー。最後の 1 カットは消せない） |
| ← → / Alt + ← → | 選択の移動／1 つ前後へ動かす |
| 拡大スライダー・「全体」・Ctrl + ホイール | 24〜400 px/秒。Ctrl+ホイールはポインタの下の時刻を動かさない |
| ↶ 元に戻す / Ctrl + Z | 追加・削除・分割・並べ替え・尺を 30 手まで戻す |
| プレビュー | Remotion Player（テロップ付き）。重いときはチェックを外す。カードは折りたためる |
| 「この並びを brief の固定順にする」 | `brief.order = fixed` と `brief.hook`（先頭カットの clip と IN/OUT）に写す。Brief で「cuts.json に書き込む」と型どおりの役割・テロップ枠（`{{gNN:intent}}`）が付くが、**尺は型に合わせて組み直される**（フックだけ IN/OUT が守られる） |

素材カードには **「使用中 ×N」** が出るので、どれをまだ使っていないかが分かる。ブロックの右上には
Timeline と同じ `!` / `?`（検証の E / W）が出るが、内容は Timeline の検証カードで見る。

ここで組んだ `cuts.json` にはテロップも `meta.slots` も無い。テロップは Timeline 画面で書く
（「AI にテロップを書いてもらう」は `{{gNN:intent}}` の穴を埋めるものなので、穴の無いこの cuts には
効かない。「AI に直してもらう」に「全カットにテロップを付けて」と頼むか、手で書く）。

秒 ⇄ px、挿入位置、既定区間、`cuts.json` の書き換えは `src/components/track.ts`（純粋関数・テストあり）、
DOM 側は `ClipTimeline.tsx`、素材カードからのドラッグは `useBinDrag.ts`。ストリップのコマ位置は
生成側と同じ `shared/strip.ts` の `stripFps` で逆算する（3 秒未満のクリップは刻みが細かい）。

## ナレーション（Render 画面）

**レンダーしただけの動画には声が入っていない。** `out/final.mp4` はテロップ付きの映像＋素材の音だけで、
納品物は声を混ぜた `out/final_narration.mp4` になる。Render 画面の「ナレーション」カードで一本道になっている。

1. **「AI にナレーションを書いてもらう」** — 完成したテロップ・カットの役割・各カット頭の実フレームを見せて、
   `narration.json` を書かせる。**テロップの内容に沿った原稿が最優先**で、一字一句同じにはせず
   言い換え・主語や理由の補足・`caption.txt` と裏取り済みの事実での肉付けをする（2026-09-13 のユーザー指示。
   それ以前の「テロップに無い情報を載せる」原則は廃止）。人格の実測話速（`shared/personas.ts` の
   `charsPerSec`）で各テロップ区間の文字数上限を決め、全体で動画尺の 6〜8 割を声で埋める。
   全ブロックが `needsTts: true` で出る
2. **文言と `at` を直す** — 同じカードの表で、id・配置秒・本文をその場で編集できる（`+0.1` / `-0.1`、
   `at` 順に整列、追加・削除）。本文を変えたブロックは自動で「要再生成」になる。
   重なり・2 秒以上の無音・尺はみ出しはその場で警告に出る（判定は `shared/narration.ts`）
3. **「音声を生成」** — Fish Audio を直接叩いて `narration/<id>.wav` を作り、`durSec` を実測して書き戻す
4. **「ナレーション合成（mix）」** — `out/final.mp4` に声を混ぜて `out/final_narration.mp4` を作る

### ボイスの選択

Render のナレーションカードの **「ボイス」** で読み上げるモデルを切り替えられる。一覧は
`GET /api/tts/voices` が返す:

- **自分が Fish Audio に登録したモデル**（`GET /model?self=true`）— 題名は Fish Audio 側のものを使う
- **`shared/personas.ts` が使っているボイス** — 他人の公開モデルが混ざっていて `self` には出てこないので、
  これを足さないと人格の既定ボイスが選べない

**他人の公開モデルは `studio.config.ts` の `voices` に書く。** `self=true` に出てこないので、
書かないと一覧に現れない。ここで付けた `title` は Fish Audio 側の題名より優先される
（呼び名の方が分かりやすいため）。例: `{id: '86ed1bd…', title: '大阪グルメボイス'}`。

鍵が無い・API が落ちているときは人格のボイスだけ出す（画面が空にならないように）。
人格・追加ボイスは**一覧を出す前に生存確認**し、Fish Audio から消えていたら落とす。

**ボイスを変えると全ブロックが「要再生成」になる。** すでにある wav は別人の声なので、
`needsTts` を立てて実測 `durSec` を捨てる（消し忘れると声が混ざったまま mix される）。
そのあと「音声を生成」→「ナレーション合成（mix）」をやり直す。

人格ごとの既定ボイスと実測話速は `shared/personas.ts` が正。ここで一時的に変えても
`personas.ts` は書き換わらない（案件の `narration.json` にだけ入る）。

### 速度と試聴

**速度**（`narration.speed`）は Render のスライダーで 0.5〜2.0。人格の既定から変えると
「既定に戻す」が出る。**変えると全ブロックが「要再生成」になる**（話速が変わって wav の長さが
変わるため、実測 `durSec` も捨てる）。

**試聴は 3 通り。**

| ボタン | 何をするか |
|---|---|
| ▶ この速度で試聴 | いまのボイスと速度で 1 本だけ作って鳴らす。**ファイルは一切作らない**（`POST /api/tts/preview` が wav のバイト列を返すだけ） |
| 行の ▶ | 生成済みなら `narration/<id>.wav` を鳴らす（`/p/<slug>/<mode>/narration/…` で配信）。未生成ならいまの速度で作って鳴らすだけ |
| 行の「作り直す」 | そのブロックだけ `tts` ジョブで作り直す（`ids` 指定） |

**同じ文・同じ速度でも長さがばらつく。** 実測（`s2.1-pro-free`）:

| ボイス | 文字数 | 同じ入力での尺 |
|---|---|---|
| 好青年ボイス | 16 | 0.96 / 1.28 / 1.40 / 2.09 / 2.29 秒（2.4 倍） |
| 大阪グルメボイス | 21 | 1.02 / 1.05 / 1.40 / 2.59 / 2.61 / 11.50 / 29.78 秒（**29 倍**） |

出力が決定的でないため**速度の数値から仕上がりは読めない**。だから試聴と「作り直す」が要る。

**極端に長い当たりは生成時に弾く。** 29 秒の当たりをそのまま採用すると後続のブロックに
かぶって全体の音が壊れるので、`generateTts` は文字数から見た想定尺（人格の `charsPerSecMeasured`）
と比べて `OUTLIER_RATIO`（2.5 倍）＋`OUTLIER_MARGIN_SEC`（1 秒）の範囲を外れたら最大 2 回引き直す。
それでも外れたらそのまま採用し、「聴いて確認してください」と出す。

この揺れがあるので、**速度を変えたときの「見積」は当てにならない**（`charsPerSec` は人格の既定速度で
測った値。narration-tts.md のとおり話速は速度に比例しない）。正しい尺は生成後の実測 `durSec` に出て、
重なり・尺はみ出しは `checkNarration` が生成後に拾う。

### 音声生成（`tts` ジョブ / `reel tts`）

`core/tts.ts` が `POST https://api.fish.audio/v1/tts` を直接呼ぶ（MCP は経由しない）。
パラメータは `narration-tts.md` §2 と同じ固定値 — `format: wav` / `latency: normal` / `prosody.speed` /
`reference_id` はブロックごとの `narration.voice`。`sample_rate` は wav では 400 になるので渡さない。

- **鍵**：`FISH_API_KEY` を環境変数 → `.claude/settings.local.json` の `env` → `.mcp.json` の順に探す。
  値はログにも API レスポンスにも出さない（出るのは「どこで見つけたか」だけ）。見つからなければボタンが
  無効になり、理由が横に出る
- **作り直す範囲**：既定は `needsTts` が立っているブロックと wav が無いブロックだけ。「全部作り直す」で全件
- **1 本作るごとに `narration.json` を書き戻す**ので、途中で中断しても済んだ分は残る
- 生成後に実測 `durSec` で重なり・無音・尺はみ出しを再点検する。Fish Audio の wav は前後に 0.09 秒ほど
  無音が付くため、`durSec` 基準で 0.15 秒までの重なりは警告しない（鳴っていないので）
- **未保存の編集があると押せない。** サーバーはディスクの `narration.json` を読むので、先に保存させる

### 声と環境音の音量

`narration.json` の `narrationGainDb`（−6〜+12 dB）と `ambientGain`（0〜0.6・既定 0.22）をスライダーで変える。
`mix-narration.js`（hiro / nagi / sayuri）がこれを読む。**変えても音声の再生成は不要**で、mix をやり直すだけでよい。

## 効果音（Render 画面）

**入れれば飽きないわけではない。** 効果音は置きどころを絞って、**毎回同じ役割に同じ音を当てる**のが要点で、
そうすると視聴者が音で構成を覚える（＝統一感）。全カットに音を付けると耳が慣れて逆効果になる。
そのため配置は「役割（role）を決める → ライブラリからその役割の音を引く」の 2 段になっている。

### 音源の置き場（`sfx/`）

効果音ラボの素材は**商用でも無料で使えるが、素材そのものの再配布が禁止**されている。このリポジトリは
public なので `sfx/` は `.gitignore` 済みで、**音源はコミットしない**。ダウンロードした mp3 を `sfx/` に
置いて「ライブラリを読み直す」（`reel sfx scan`）を押すと `sfx/library.json` に台帳ができる。
スキャンは**既存の役割・trim・gain を消さない**（役割の割り当ては人が決めるもの）。

| 役割 | 置く場所 |
|---|---|
| `hook` | 冒頭 0 秒。手を止めさせる 1 発 |
| `telop` | 前半のテロップ出現（1 枚目は hook と重なるので除く。未記入 `{{...}}` も対象外） |
| `transition` | **被写体が変わる**カット境界だけ（同じ被写体の連続では鳴らさない） |
| `reveal` | 店名が読める看板カット／`meta.slots` の reveal |
| `eat` | 実食・シズルのカット（`sizzleScore` 4 以上） |
| `outro` | 締めのテロップ |

### 自動配置（`sfx-auto` / `reel sfx auto`）

`shared/sfx.ts`（純粋・テストあり）が cuts.json から候補を出し、**間隔と個数で間引く**:

- 最小間隔 1.2 秒。近すぎる候補は**優先度の高い役割を残す**（hook > reveal > outro > eat > telop > transition）
- 個数の目安は 1 秒あたり 0.3 個（20 秒なら 6 個まで）。超えたら優先度の低いものから落とす
- 役割に音が登録されていなければ**何も置かない**（`missing` に出す）

点検は `checkSfx`: 音源が無い（E）／id 重複（E）／尺より後ろ（E）／鳴り終わりのはみ出し（W）／
近すぎる（W）／多すぎる（W）／**ナレーションに被る（W）**。

### 声に被ったときは効果音を下げる（ダッキング）

置きどころは映像で決めたいのに、ナレーションと重なると声が埋もれる。そこで `mix-narration.js` が
`sidechaincompress` で**効果音側だけを声の裏で沈ませる**（声は下げない）。実測（bonjour arima の
フック区間 0〜1.2 秒）:

| | 区間の mean_volume |
|---|---|
| 効果音なし | −14.8 dB |
| 効果音あり・ダッキングなし | −11.8 dB（アラームが声を覆う） |
| 効果音あり・ダッキングあり | −13.0 dB（アラームは出るが声の居場所が残る） |

`narration.json` の `sfxDuck: false` で切れる。強さは `sfxDuckThreshold` / `sfxDuckRatio`。

### narration.json の形

```jsonc
{
  "sfxGainDb": 0,      // 効果音全体の増減
  "sfxDuck": true,     // 声に被ったら効果音を沈ませる
  "sfx": [
    {
      "id": "hook",
      "at": 0,                    // 動画の先頭からの秒
      "file": "alarm-clock.mp3",  // sfx/ からの相対パス
      "role": "hook",
      "trimSec": 1.2,             // 頭から使う長さ（長い素材を丸ごと鳴らさない）
      "fadeOutSec": 0.3,          // trim の切り口を目立たせない
      "gainDb": -3,
      "label": "目覚まし時計のアラーム"
    }
  ]
}
```

効果音は**レンダーではなく mix で乗る**（映像は `-c:v copy` のまま）。だから効果音を変えても
レンダーのやり直しは不要で、「ナレーション合成（mix）」だけで反映される。

## キャプション（Render 画面）

投稿にそのまま貼る本文を `caption.txt` として作る。**書き方の規則はコードに写していない** ——
エージェントに人格の `SKILL.md`「Step 4: キャプションの生成」と `references/hashtag-bank.md`、
さらに**同じ人格で過去に書いた `caption.txt`（新しい順に 2 件）**を Read させて、その型に沿って書かせる。
スキル文書を直せばそのまま反映される。

渡す文脈は、店（名前・エリア・駅・ジャンル・PR かどうか）、テロップ全文、ナレーション全文、
`catalog.facts` + `brief.facts`、そして**各カット頭の実フレーム**。フレームを渡すのは「頂いたもの」のためで、
`facts` に値札の価格があるだけの品（棚に並んでいただけ）を食べたことにしないよう、実食・手持ちが
映っているかを画で確かめさせる。裏取りできない住所・営業時間・IG ハンドルは捏造させず、
`＿＿＿` で残させて `missing` に挙げさせる。

書いたあとは `shared/caption.ts` が機械的に点検する（文章の良し悪しは見ない）:

| コード | 内容 |
|---|---|
| `ENGAGEMENT_BAIT`（E） | 保存・いいね・シェア・コメント・フォローを促す文言（来店を促す一文は可） |
| `HASHTAG_COUNT`（W） | 本数が人格の規定と違う（hiro / 凪 / ぼんじり = 3、さゆり = 5） |
| `HASHTAG_PR`（W） | ハッシュタグ列の `#PR`（PR 表記は店名の直後の小文字 `pr` だけ） |
| `TRAILING_PERIOD`（W） | 文末の句点「。」 |
| `PLACEHOLDER`（W） | `＿＿＿` が残っている＝裏取りがまだ |
| `TOO_LONG`（W） | 長さの目安超え（hiro / 凪 / ぼんじり 600 文字。さゆりは上限なし） |
| `PR_MISSING` / `PR_UNEXPECTED`（W） | `brief.shop.pr` と本文の `pr` 表記が食い違う |
| `REPOST_ACCOUNT`（W） | 自分のアカウントへの誘導行が無い（さゆりの `@gurupo_chan_`） |

テキスト欄で直接直せる（保存で `caption.txt`、旧版は `.studio/backups/`）。「追加の指示」を入れて
書き直させることもできる（例「頂いたものに値段を入れて」）。「本文をコピー」でクリップボードへ。

## トライアルリール（フックだけ差し替えた複数版）

どのフックが効いたかを見るために、**冒頭のフックだけを変えた 3 本**を投げて比べる。
Render の **「トライアル（フック差し替え）」**（`reel trial`）で作る。

### 変わるもの・変わらないもの

**差し替えるのは冒頭 3 カット**（`cutCount`。1〜6 で変更可）。1 カット（1 秒前後）だけ変えても
見た印象がほとんど変わらず A/B の差が出ないため（2026-09-12 のユーザー指示）。
`meta.slots` の `1_hook` がそれより長い型では、そちらの長さに合わせる。

| 変わる | 冒頭 N カットの**カットごとの**テロップと素材、バッジ（1 枚目）、ナレーション 1 本目 |
|---|---|
| **変わらない** | それ以外のカット・テロップ・ナレーション。**cuts.json を書き換えない** |

テロップは `telops[i]` が i 枚目に入る。**空文字と、配列が足りないぶんのカットは今の文言のまま**なので、
「1 枚目だけ変える」「3 枚とも変える」「店名リビールのカットだけ残す」が選べる。
素材を差し替えても**カットの尺は元のまま**にするので、パターン間で総尺がずれない。

差し替えた cuts は `.studio/trial/<id>.cuts.json` に書き、レンダーには `--props` で渡す。
元の `cuts.json` はそのままなので、フック以降は**1 フレームも変わらない**（実測：フック後の
フレームハッシュが 3 パターンで完全一致）。

ナレーション 1 本目は id を `01_hook__B` のように変えて生成する（共有の `narration/` で wav が
ぶつからないように）。2 本目以降の wav はそのまま使い回すので、作り直すのは 1 本だけ。

### 書き出し

```
out/trial_A_narration.mp4                          ← 案件フォルダ（確認用）
outputs/<店名>_<人格>_ナレーション付き_フックA.mp4   ← 納品
```

キャプションは全パターン共通なので、通常の「納品」ボタンで 1 つだけ出す。

### 点検（`shared/hooks.ts` の `checkHooks`・テストあり）

| コード | 内容 |
|---|---|
| `HOOK_DUP_ID`（E） | id の重複 |
| `HOOK_EMPTY`（E） | テロップ・素材・ナレーションのどれも変えていない |
| `HOOK_NO_CUT`（E） | cuts.json にフック区間が無い |
| `HOOK_SAME`（W） | 中身が同じパターンが 2 つある＝比較にならない |
| `HOOK_ONLY_ONE_CUT`（W） | 1 カットしか変えていない＝違いが伝わりにくい |
| `HOOK_OVER_SPAN`（W） | 差し替え範囲より多い枚数の文言が入っている |
| `HOOK_TOO_FEW`（W） | 1 パターンだけ |
| `HOOK_TELOP_LONG` / `HOOK_TELOP_PERIOD`（W） | 13 文字超え / 文末の句点 |

**パターンの数だけレンダーが走る**（1 本あたり通常のレンダーと同じ時間）。見た目だけ先に見たいときは
「ドラフトで試す」（0.25 倍・納品しない）。draft の出力は `trial_<id>_draft_narration.mp4` で、
本番と混ざらない。

実測（bonjour arima・冒頭 3 カット = 3.9 秒）: 1 枚目と 2 枚目のフレームハッシュが 3 パターンで
すべて異なり、3 枚目（文言を空にした店名リビール）とそれ以降は完全一致した。

**音声は各パターンで独立に −14 LUFS へ正規化される**ので、フック以降の音も数値上はわずかに違う
（全体のラウドネスを測ってから一律ゲインをかける方式のため）。映像は完全に同一。

## 納品（`outputs/`）

Render の **「納品（outputs/ へ）」**（`reel deliver`）で、**完成品だけ**を `outputs/` に書き出す。
**draft と音声なしの mp4 は出さない**（作業用なので案件フォルダの `out/` に置いたまま）。

名前だけ見て「どの店・どの人格・ナレーションの有無」が分かる形にしている:

```
outputs/活魚センター_hiro_ナレーション付き.mp4
outputs/活魚センター_hiro_caption.txt
outputs/ドミノピザ_sayuri_ナレーション付き_修正版.mp4   ← 「名前に足す語」を入れた場合
outputs/musch_hiro_ナレーション付き_v2.mp4              ← 同名で中身が違うとき
```

店名は `brief.shop.name`、人格は `brief.persona`。判定は `shared/deliver.ts`（純粋・テストあり）。

**「ナレーション付き」と名乗る前に必ず確かめる。** 過去に mix を忘れて素材の音だけの動画を納品し、
保存率が 0.27% まで落ちた事故があるので、`narrationReady()` が次を全部通らないと納品を止める:

- `out/final_narration.mp4` がある
- `narration.json` に segments がある／`needsTts` のブロックが無い
- `narration/*.wav` が全部ある
- **その mp4 が `out/final.mp4`・`narration/*.wav`・`narration.json` より新しい**
  （レンダーし直した／音声を作り直した／音量や効果音を変えたあと mix していない、を検出する）

**過去の納品物は上書きしない。** 同名で中身が同じなら何もせず、違えば `_v2`, `_v3`… を付ける
（`--overwrite` で上書き）。ナレーションを使わない案件だけ `--allow-silent` で
`<店名>_<人格>_ナレーションなし.mp4` を出せる。

## 契約ファイル（`work/<slug>-reel/`）

- `catalog.json` — 素材の事実（probe・thumbs・proxy）＋タグ（Claude/ユーザー）＋ユーザー判断（hook/ng/lock/usableRanges）。スキーマ `shared/schema/catalog.ts`
- `brief.json` — edit-pipeline.md Step 0 の回答。persona / format / hook / reveal / savePriorities / order / units / precut …。スキーマ `shared/schema/brief.ts`
- `cuts.json` — 既存互換。`id` と `meta.slots` / `meta.telopGroups` / `meta.aliases` / `meta.generated` を追加（Remotion は無視）。スキーマ `shared/schema/cuts.ts`
- `script.md` — 自然言語の台本（`ai-script` の入力）。無い案件がふつう
- `hooks.json` — トライアルリールのフック候補（`shared/hooks.ts`）。無い案件がふつう
- `narration.json` — 既存契約（narration-tts.md §6）＋ 音の設計（`narrationGainDb` / `ambientGain` / `sfx` / `sfxGainDb` / `sfxDuck`）
- 派生物は `.studio/`（thumbs / strips / cutframes / backups / logs / tags-export.json / render-result.json）

## 設計

- `shared/` はブラウザ・Node 両用の純粋コード。`format-specs/F0〜F7.json` が format-patterns.md の機械可読版、`personas.ts` が 4 人格の既定値の単一ソース
- `shared/plan.ts` の `planCuts` は乱数なし。同じ catalog / brief なら同じ cuts.json
- `shared/order.ts` は並び順だけを扱う純粋モジュール（`checkOrder` / `orderFromCuts` / `orderPrinciples`）。AI の判断（並び）と型の保証（尺・役割）を分離するのが狙い。ファイル入出力は `core/order.ts`
- `core/agent.ts` が `claude -p --output-format json --json-schema …` の薄いラッパ。stdout だけを JSON として読む（stderr が混ざると壊れる）。`core/ai.ts` がタグ付け・並べ替えのプロンプトとスキーマを持ち、返ってきた JSON を既存の import 経路に流す
- ジョブ種別は `server/jobs.ts` の `JOB_TYPES` が唯一の定義。受け口（`server/routes/jobs.ts`）もこれを見る
- `shared/validate.ts` の `validateCuts` は edit-pipeline.md / telop-style.md / format-patterns.md の規則をコード化。context（catalog / brief / spec / persona）が無いルールは `skipped` に列挙
- エンジン（`.claude/skills/hiro-daihon/assets/remotion-template/src/`）は無改変。`shared/timeline.ts` はエンジンの `cutFrames` / `calcTotalFrames` / telopGroups と同一式で、テストで突合している
- Windows 対策：spawn は args 配列のみ（shell 不使用）。`npm` と `remotion` は `node <cli.js>` で起動。kill は `taskkill /T /F`
- 依存：GUI 側は `remotion` / `@remotion/player` 4.0.522（`npm audit` 0 件）。**レンダーは案件フォルダ側の `node_modules/@remotion/cli` を使う**ので、案件側のバージョンとは独立している
- 低メモリ対策：空き RAM 1.2GB 未満で concurrency 1・cache 128MB。失敗時は 5s/15s/30s 待って段階的に保守化して再試行
- 起動：`scripts/launch.mjs` が「依存導入 → 必要ならビルド → サーバー起動 → ブラウザを開く」を行い、終了時に子プロセスを `taskkill /T /F` で片付ける。ビルドの要否は `src` / `shared` / `index.html` / `vite.config.ts` / エンジンの最終更新時刻と `dist/index.html` の比較で決めるので、コードを直したら次回起動時に自動で作り直される
- 素材フォルダの「参照…」は `core/pick-folder.ts` が PowerShell の `FolderBrowserDialog` を開く（サーバー側で開くのでローカル利用専用）。日本語パスが化けないよう選択結果は UTF-8 ファイル経由で受け取り、`SelectedPath` はスラッシュ区切りだと無視されるため `path.win32.resolve` で正規化してから渡す。ダイアログは同時に 1 つだけ（多重に開くと 409）
- ローカル専用サーバーなので、`Origin` が localhost 以外のリクエストは 403 で弾く（外部サイトから勝手に契約ファイルを書き換えられないようにするため）
- `Reel Studio.cmd` は **ASCII のみで書く**（cmd.exe は OEM コードページでバッチを解釈するため、UTF-8 の日本語を入れると構文が壊れる）。日本語表示は Node 側の出力に任せる。`%~dp0` は `cd` 後に再評価されて相対起動時にパスが二重になるので、先に `REEL_DIR` へ退避してから使う

## 既知のセキュリティ事項

**HTTP から来る案件名（slug）は `work/` の直下に閉じる。** URL に案件を入れるようになった
（`/p/<slug>/...`、`/api/projects/<slug>/...`）ので、パスや絶対パスを含む slug を弾かないと
ブラウザからリポジトリの外のファイルを読めてしまう。サーバーの受け口は全部
`resolveProjectDirStrict` を通し、不正なら 400 / 404 を返す（`resolveProjectDir` はパスも受けるが、
これは CLI の `--project <dir>` のためのもので HTTP からは使わない）。

`work/*-reel/node_modules` の remotion は **4.0.245** のままで、`@remotion/studio-server` に
CVE-2026-30120（RCE）/ CVE-2026-30121（任意ファイル書き込み）がある（修正は 4.0.410）。
**脆弱なのは `remotion studio`（開発サーバー）だけ**で、CLI レンダー（`remotion render` / `still`）と
`@remotion/player` は対象外。Reel Studio はレンダーとスチルしか呼ばないため、通常運用では
到達しない。ただし各案件の `package.json` に `"studio": "remotion studio"` が残っているので、
**`npm run studio` は実行しないこと**。全案件を 4.0.522 へ上げる場合は 277 バージョン分の差分に
なるため、既存案件の再レンダー結果が変わらないかを 1 案件で検証してから一括適用する
（`startFrom` は 4.0.522 でも deprecated 扱いで動作する）。

## ロードマップ

- Phase 1（済）：shared / core / CLI、hiro・nagi スキル文書の Studio 連携モード
- Phase 2（済）：server（express :4310、SSE、静的配信）＋ GUI（Projects / Materials / Brief / Timeline+Player / Render）
- Phase 3（済）：ナレーション原稿（`ai-narration`）・編集・音声生成（`tts`）・mix・音量調整・キャプション（`ai-caption`）・効果音（`sfx-auto`）
- Phase 4（一部済）：複数案件の並行作業（タブごとの案件・ジョブの同時実行）。残り＝Tailscale 公開、インサイト記録、sayuri / bonjiri のスキル文書に Studio 連携モードを追記
