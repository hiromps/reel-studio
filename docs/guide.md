# Reel Studio 詳細ガイド

グルメリール制作（Remotion × Claude Code × Fish Audio）の **CLI と GUI** の詳細。導入と設定は [README](../README.md) を先に読むこと。
「素材だけ渡したとき」に format-patterns.md の型どおりの構成を決定論で組み立て、
テロップ文だけを Claude が書き、GUI（Phase 2）でプレビューしながら手直しできるようにする。

```
素材フォルダ ──reel catalog──▶ catalog.json（probe・サムネ・プロキシ）
                                │  Claude がサムネイルを見て tags を書く（reel ai tag）
brief.json（意図） ──reel plan──▶ cuts.json の骨組み（src/in/out/役割/テロップグループ/alias）
script.md（台本）──reel ai script▶ cuts.json + narration.json（台本が正）
                                │  Timeline（GUI）で並び・尺・テロップ・ナレーション・効果音を 1 画面で整える
                    reel validate ▶ E ゼロ ──▶ reel build（音声 → レンダー → mix → 納品を一気に）
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
cd reel-studio
npm install
npm test          # vitest（エンジンとの一致・validate・plan の回帰）
npm run build     # dist/ を作る（npm start が必要に応じて自動実行）
```

CLI は Git Bash から `bin/reel <cmd>`（cmd.exe は `bin\reel.cmd`）。

## CLI

| コマンド | 内容 |
|---|---|
| `reel projects` | `work/*-reel` の一覧（契約ファイルの有無・エンジン差分・node_modules） |
| `reel new <slug> --persona <人格id> [--shop 店名] [--no-install]` | テンプレ複製・`brief.json` 雛形・npm install |
| `reel new <slug> --from <既存slug> [--shop 別ブランド名] [--persona p] [--no-facts]` | **同じ素材で別バージョン**。素材はハードリンク共有、`catalog.json`（タグ）を引き継ぐ |
| `reel catalog <素材フォルダ> --project P [--no-proxy] [--no-thumbs] [--scenes] [--speech] [--force]` | `catalog.json`。HEVC/4K は H.264 1080x1920 プロキシ。`--scenes` はカット済み単一ファイル用、`--speech` は会話クリップの無音検出 |
| `reel tag --project P --export [file]` / `--import <file>` | Claude のタグ付け用エクスポート／取り込み（`user.lock` は保護、`slug` 変更でファイルもリネーム） |
| `reel order --project P [--check]` / `--export [file]` / `--import <file> [--write] [--force]` | 並び順（構成）。無印は現在の並びの構成チェック、`--export` は Claude に渡す判断材料、`--import` は並び替え案の取り込み＋再 plan |
| `reel ai tag --project P [--force] [--batch n] [--model m]` | **裏で claude を起動**してタグ付けを代行させる |
| `reel ai order --project P [--write] [--force] [--model m]` | 同じく並び替えを代行させる |
| `reel ai telop --project P [--force] [--model m]` | 同じく `{{gNN:intent}}` のテロップ文を書かせる |
| `reel ai edit --project P "<直したいこと>" [--model m]` | 自由文の指示で `cuts.json` / `narration.json` を直させる |
| `reel ai narration --project P [--model m]` | 完成したテロップと映像を見てナレーション原稿を書かせる（`narration.json`） |
| `reel ai script --project P [--model m] [--force] [--dry]` | **`script.md` の台本から** cuts + narration を組み立てる（`--dry` は書かずに割り当ての案だけ `.studio/script-plan.json` に残す） |
| `reel ai script --project P --apply` | `--dry` で残した案を**承認して書き込む**（AI は走らせない。台本が変わっていたり E があれば書かない） |
| `reel ai facts --project P [--force] [--model m]` | 店の住所・営業時間を Web で裏取りして `brief.facts` に入れる（**Instagram 優先**。Settings に Smartgram の鍵があれば Instagram は MCP 経由で直接読む） |
| `reel ai caption --project P [--model m] [--no-research] ["<追加の指示>"]` | 裏取り → 人格の SKILL.md Step 4 と過去の実例を読んで `caption.txt` を書かせる |
| `reel sfx scan` / `reel sfx list` | 効果音ライブラリ（`sfx/`）の棚卸し・一覧 |
| `reel sfx role <file> <役割> [--trim s] [--fade s] [--gain dB] [--label 名]` | どの音をどの役割に使うか（自動配置はこれを見る） |
| `reel sfx auto --project P [--max n] [--gap s] [--exclude role,..] [--dry]` | cuts.json から効果音を自動配置して `narration.json` の `sfx` に書く |
| `reel tts --project P [--force] [--id a,b]` | `narration.json` → `narration/<id>.wav`（Fish Audio。実測尺を書き戻す） |
| `reel fit --project P [--min 0.75] [--max 0.8] [--lead s] [--tail s] [--estimate] [--dry] [--json]` | **ナレーション音声に映像の尺を合わせる**。各ブロックの実測尺に映像区間を揃え、0.75〜0.8 秒のカットに刻み直す（`--dry` は書かずに結果だけ、`--estimate` は音声の無いブロックを文字数見積もりで） |
| `reel plan --project P [--write] [--no-reuse] [--no-copy] [--json]` | 構成の生成。`--write` で `cuts.json` に書き込み＋alias コピー |
| `reel validate --project P [--json] [--strict-proxy]` | E/W の検証（exit 1 = E あり） |
| `reel table --project P` | 現在の `cuts.json` をカット表で表示 |
| `reel aliases --project P` | 同一 src 非連続参照の別名コピーを適用 |
| `reel sync --project P [--check]` | エンジン（src/*.tsx）をマスターに同期 |
| `reel draft\|render --project P [--out f] [--gl swiftshader] [--concurrency n] [--crf n] [--cache-size 256mb] [--retries 3] [--force] [--no-sync] [--strict-proxy] [--props f]` | preflight → レンダー（段階リトライ）→ フレーム数検証 → QC タイル |
| `reel still --project P --cut N [--offset 0.3]` / `--frame F` | 1 フレーム書き出し（カット頭から 0.3 秒後が既定） |
| `reel ai hooks --project P [--count 3] [--cut-count 3] [--fresh] [--force] [--model m] ["<追加の指示>"]` | トライアル用の**フック案（A は今の形・B/C は別の切り口）とパターン別キャプション**を書かせて `hooks.json` に入れる |
| `reel ai reference --project P --file <動画> [--model m] [--no-analyze]` | **他の人のバズ動画を取り込んで型を分析**し `reference.json` に入れる（`--no-analyze` は取り込みだけ）。`--show` で分析を表示、`--from <別案件>` で別案件の分析を写す、`--remove` で取り消す |
| `reel ai mimic --project P [--model m] [--dry] [--force] [--no-assemble]` | **分析した型を写した台本**を `script.md` に書き、そのまま「台本から組み立てる」まで行う（`--dry` は割り当てを見るだけ、`--no-assemble` は台本だけ） |
| `reel trial --project P [--ids A,B] [--draft] [--no-deliver] [--force] [--force-errors]` | **フックだけ差し替えた複数版**を作る（レンダー→音声→mix→納品。キャプションもパターンごとに出す） |
| `reel winner --project P [--id A] [--tail "締め"] [--tail-narration "締めナレ"] [--caption-file f] [--speed 1.1] [--draft] [--no-deliver] [--force] [--force-errors] [--model m]` | **勝ちパターンの二次活用**：締めの一言だけ変えて倍速で書き出し直し、新しいキャプションで納品 |
| `reel build --project P [--plan] [--steps a,b] [--model m] [--force-errors] [--label 修正版]` | **仕上げ**。案件の状態から残っている工程（キャプション/原稿/音声/レンダー/mix/納品）を順に走らせる |
| `reel deliver --project P [--label 修正版] [--allow-silent] [--overwrite]` | 完成品だけ `outputs/` へ（`<店名>_<人格>_ナレーション付き.mp4` と `_caption.txt`） |
| `reel mosaic status` / `reel mosaic setup [--gpu]` | 顔モザイク（deface）が使えるか／`~/.reel-studio/deface-venv` に導入（`--gpu` は Windows なら DirectML 版） |
| `reel mosaic apply --project P (--ids 01,02 \| --all \| --kinds person,interior) [--threshold 0.6] [--cells 8] [--mask-scale 1.3] [--detect-short 720] [--detect-every 1] [--hold-sec 0.1]` | 素材の顔にモザイクをかける（顔が無いクリップは変えない） |
| `reel mosaic revert --project P (--ids 01,02 \| --all)` / `reel mosaic list --project P` | 元のファイルに戻す／クリップごとの状態 |

`--project` は slug（`work/<slug>-reel`）でもパスでもよい。

## 同じ素材で複数バージョンを作る

同じ撮影素材から 2 本以上作る場面が多い（**人格違い**＝人格 A 版 / 人格 B 版、**同じ店の別ブランド**＝
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

### 台本もそのまま引き継ぐ場合（`--carry-timeline`）

**同じ構成・同じ原稿でボイスだけ変えたい**、**フックの一部だけ書き換えたい**、といった「台本は完成済みで、
差分だけ作りたい」場面向け。Projects の「同じ素材から作る」の**「台本（cuts・ナレーション原稿）も引き継ぐ」**
チェック（`reel new <slug> --from <既存slug> --carry-timeline`）を付けると、上記に加えて `cuts.json` と
`narration.json` もそのままコピーする。

- `cuts.json` は無加工でコピー（構成・トリミング・テロップはそのまま）
- `narration.json` はコピーした上で**全ブロックを要再生成にする**（`needsTts: true` を立てて `durSec` を消す）。
  音声ファイル（`narration/*.wav`）はコピーしない（ボイスが変わる前提のため）ので、そのままでは再生できない
- 元の案件に `cuts.json` が無ければ（構成がまだ無い案件）、ここはスキップされて通常どおり Brief から作ることになる

作ったあとは Brief をやり直す必要はなく、そのまま Render でボイスを選び、Timeline でフックなど変えたい
ブロックの文言だけ直してから、「音声を生成」で全ブロック作り直す。

### 実測（焼肉伍龍 → 焼肉たべる）

```
素材: 308 本をリンクで共有（ディスクは増えません）
catalog.json: 50 クリップ分のタグを引き継ぎ
brief.json: 店名「焼肉たべる」／人格 hiro／型 F3
! 引き継いだ facts のうち 営業時間・定休日・Instagram・予約・備考 は版で変わることがあります
```

元の `public/` は 376MB、増えた分は実質ゼロ（ハードリンク数 2 で共有）。

## GUI：はじめて使うとき

初回起動時に**ガイドツアー**（20 ステップ）が自動で開き、各画面の役割をスポットライトで順に説明する。
閉じたあとは右上の **「? 使い方」**（`?` キーでも開く）から、ツアーの再表示・全体の流れ・タイムラインの見方・
ショートカット一覧・用語集を見られる。タブは `Ctrl+1〜5` でも切り替えられる。

タブの上には **「次にやること」** バーが出る。案件の状態（catalog / タグ / brief / cuts / 未記入テロップ /
未保存）から、いま一番やるべきことを 1 行で出し、ボタンでその画面へ飛ぶ。判定は `src/components/nextStep.ts`
（純粋関数・テストあり）で、上から順に

1. 案件を開く → 2. カタログ実行 → 3. 未タグの素材 → 4. brief を作る → 5. 構成を作る（台本／プラン／素材ビン）→
6. テロップの未記入（`{{gNN:intent}}`）→ 7. 未保存の保存 → 8. ナレーション原稿 → 9. 音声生成 →
10. キャプション → 11. 仕上げ（レンダー → mix → 納品）

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

### 投稿し終えた案件を一覧から隠す

案件は増える一方で、投稿し終えたものも一覧に残り続ける。Projects の各行の
**「投稿済み（隠す）」** を押すと、その案件を一覧と上部の案件選択から外せる。
**隠すだけで、消さない**（案件フォルダ・素材・書き出し・契約ファイルには一切触らない）。

- 戻すときは見出しの **「隠した案件も表示（N 件）」** にチェック → その行の **「一覧に戻す」**
- **スマホでは一覧が 1 案件＝1 枚のカードになる**（`styles.css` の `@media (max-width: 860px)` で
  `.table.projects` を積み直す）。11 列の表を横スクロールさせると、右端の操作列＝「開く」と
  「投稿済み（隠す）」に指が届かないため。まだ無い項目（catalog / brief / cuts の空欄）は `td:empty` で消し、
  どこまで進んだかだけを並べる
- **開いている案件は、隠しても一覧に残る**（`（非表示）` と出る）。開いたまま消えて操作できなくなるのを防ぐため
- 「同じ素材から作る」の選択肢には隠した案件も出る（投稿済みの案件から第 2 弾を作る場面が多いため）
- `reel projects` では隠さず、slug に `※非表示` と付けるだけ（CLI は棚卸し用なので全部出す）

状態は案件フォルダの **`.studio/meta.json`**（`{"version":1,"archivedAt":"…"}`）に入れる。
クラウドでは docs の `meta` として持ち、**ワーカーの同期が双方向に流す**ので、PC で隠せばスマホでも、
スマホで隠せば PC でも隠れる。brief.json に入れないのは、Brief を編集している最中に一覧から隠すと
ETag がぶつかって「外部で変更されました」になるため（一覧の都合で書き換わる値は契約ファイルと分ける）。

### ジョブの同時実行

ジョブは**案件が違えば同時に走る**。ただし次の 2 つは守る（`shared/jobs.ts` の `canStartJob`・テストあり）:

- **同じ案件では 1 本だけ** — 同じ契約ファイルを取り合わせない
- **重いジョブは全体で 1 本だけ** — `catalog` / `thumbs` / `proxy` / `preview-proxy` / `render` /
  `draft` / `still` / `qc-tile` / `mix` / `mosaic` など（一覧は `HEAVY_JOBS`）。ffmpeg と Remotion がメモリを食い合って落ちるため

全体の上限は 2（`REEL_STUDIO_JOB_CONCURRENCY` で変更可）。つまり「A 案件をレンダーしながら
B 案件のテロップを AI に書かせる」はできるが、「2 案件を同時にレンダー」はできない（順番待ちになる）。

## AI に任せる（裏で claude を走らせる）

タグ付けと並べ替えは、**このPCに入っている Claude Code CLI（`claude.exe`）を子プロセスとして起動**して
代行させられる。API キーの設定は不要で、ユーザーの既存ログインをそのまま使う。

| どこ | 何が起きるか |
|---|---|
| Materials の **「AI にタグ付けしてもらう」** | 未タグのクリップを 8 本ずつに分け、コンタクトシートを見せて `kind` / `angle` / `signage` / `sizzleScore` / `subject` / `description` / `slug` を書かせ、`catalog.json` に反映する。看板・メニューから読み取れた事実は `catalog.facts` に入る |
| Timeline の **「AI ▾ → 並べ替えてもらう」** | `.studio/order-export.json` を書き出し、それを読ませて並び順を決めさせ、`brief.order.fixed` → 再 plan → `cuts.json` まで書く |
| Timeline の **「AI ▾ → テロップを書いてもらう」** | 未記入（`{{gNN:intent}}`）のグループについて、**そのカット頭の実フレームを 1 枚ずつ見せて**文言を書かせ、`cuts.json` に入れる |
| Timeline の **「AI ▾ → 直してもらう」**（自由入力＋送信） | 書いた指示に沿って、テロップ文言・ナレーションのセリフと位置・カットの IN/OUT・倍速・削除・並び替え・theme を直す |
| Timeline の **「AI ▾ → ナレーション原稿」**／Render の **「AI にナレーションを書いてもらう」** | 完成したテロップ・カットの役割・各カット頭の実フレームを見て `narration.json` を書く。**テロップの内容に沿った原稿**を最優先にし（一字一句同じにはしない）、`caption.txt` と裏取り済みの事実で肉付けして動画の尺（6〜8 割を声で埋める）に合わせる |
| Render の **「AI にキャプションを書いてもらう」** | まず店舗情報を Web で裏取り（Instagram 優先）して `brief.facts` を埋め、人格の SKILL.md Step 4 と過去の実例を読んで `caption.txt` を書く |
| Render の **「店舗情報だけ調べる」** | キャプションは書かず、裏取りだけして `brief.facts` に入れる |
| CLI | `reel ai tag` / `reel ai order` / `reel ai telop` / `reel ai narration` / `reel ai facts` / `reel ai caption` / `reel ai edit "<直したいこと>"`（同じ処理。GUI はこれをジョブとして走らせているだけ） |

### フックのエリア名はバッジに出す

hookStyle=areaDigit の人格のフックは「エリア＋一桁数字」型だが、**エリア名は縦書きの本文には書かず、
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

**Instagram は Smartgram の MCP 経由で読む（鍵があるとき）。** Instagram のページは `WebFetch` だと
ログイン壁で読めないことが多く、検索スニペット頼みだった。Settings の「Instagram の情報取得」に
[Smartgram](https://app.smartgram.jp/) の MCP 用 API キーを入れると、`ai-facts` はそのサーバー
（`growgram-insights`）を `--mcp-config` で claude に渡し、登録済みアカウント経由で店の公開アカウントを直接読ませる。

- 許可するのは読むだけのツール 5 つ（`list_instagram_accounts` / `search_users` / `get_profile` /
  `get_user_posts` / `get_api_usage`。`shared/instagram-mcp.ts` の `INSTAGRAM_MCP_TOOLS`）。
  HikerAPI のトークンを消費する `get_user_stories` / `download_reel_video` や、投稿・フォローの操作は渡さない
- 進め方はプロンプトで固定: `search_users`（店名）で公式アカウントを探す → `get_profile`（自己紹介・外部リンク）→
  `get_user_posts`（最近 12 件のキャプションから営業時間・定休日・価格）。**自己紹介や投稿に住所かエリアが出ていて
  この店だと確認できたものだけ採る**。呼び出しは合計 6 回程度まで（Smartgram 側に 1 時間あたりの上限がある）
- MCP ツールの `username` 引数は「API を実行する Smartgram 登録済みアカウント」。Settings の「実行アカウント」が
  あればそれ、無ければ `list_instagram_accounts` で `isActive: true` のものを選ばせる
- **鍵は argv にもファイルにも出さない。** `--mcp-config` の JSON には `${SMARTGRAM_MCP_KEY}` と書き、値は
  子プロセスの環境変数で渡す（Claude Code が展開する。`core/instagram-mcp.ts` の `instagramMcpForAgent`）。
  鍵の置き場は Fish Audio と同じ `settings.json`（環境変数 `SMARTGRAM_MCP_KEY` が優先）
- 接続テスト（Settings・`POST /api/settings/test/instagram`）は claude を通さず、この Node から JSON-RPC
  （`initialize` → `tools/list` → `list_instagram_accounts`）を直接叩く。Instagram 本体にはアクセスしない
- 鍵が無ければ従来どおり（`WebSearch` / `WebFetch` だけ）。ログの 1 行目に「Smartgram MCP 経由」か
  「Web 検索のみ」かが出る

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
`WebFetch`、さらに Smartgram の鍵があれば `mcp__smartgram__*` の読み取りツールを追加）だけを与え、権限プロンプトが出たら
自動で拒否する（`--permission-prompts none`）。返ってくるのは `--json-schema` で形を固定した JSON だけで、
契約ファイルへの反映は `core/ai.ts` が zod 検証を通してから `importTags` / `importOrder` で行う。
ワークスペースの MCP サーバーは読み込まない（`--strict-mcp-config`）——タグ付けには 1 つも要らず、
システムプロンプトが数万トークン膨らむだけなので。裏取りで Smartgram を使うときも、`--mcp-config` で
明示したその 1 つだけが読み込まれる（`runAgent` の `mcp` オプション）。

**作業中は「動いているか」が見える。** `claude -p` を `--output-format stream-json` で走らせ、
起動（`system/init`）・思考（`thinking`）・本文・ツール呼び出し・最終結果の書き出し（`StructuredOutput`）を
全部拾い、さらに **5 秒ごとの heartbeat** で経過秒を流す（`core/agent.ts` の `onEvent` →
`shared/agent-progress.ts` の `createAgentTracker` / `progressView` → `core/ai.ts` の `agentProgress`）。

```
● [AI がナレーション原稿を作成中]  原稿を考えています（1分35秒・ツール 2 回・出力 640 文字）  1分36秒 経過  最終反応 3 秒前  [中止]
▒▒▒▒▒▒▒░░░░░░░░░░░  （流れる帯）
  claude が起動しました（claude-opus-4-1）
  ▸ Glob **/*.json
  … 動いています（1分30秒・ツール 2 回・出力 640 文字・直前 Glob）
```

- **数えられる作業（見せた画像の Read）があるときだけ** `4/10` のような確定的な進捗になる。それ以外は
  流れる帯＋「何をしているか・経過・ツール回数・出力文字数」の文で出す。以前は Read の回数だけを
  進捗にしていたので、画を見ずに原稿を書く工程（ナレーション原稿・自由指示）で `0/18` のまま
  何分も止まって見えた
- **最終反応 N 秒前**はサーバーから進捗かログが届いてからの秒数。heartbeat があるので普段は 10 秒以内。
  90 秒以上届かなければ黄色で「止まっている可能性」と出す（中止して再実行の目安）
- ログには 30 秒に 1 行「… 動いています」を入れ、ツール呼び出しは `▸ Read xxx.jpg` のように 1 行ずつ残す
- タグ付けは 3 本並列なので、バッチ単位の進捗（`3/8 完了`）＋各バッチのログ（`[2/8] 画 5/8`）になる

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

### E の自動修正（`shared/script.ts` の `repairScriptPlan`・テストあり）

AI の返答のうち**機械的に直せる E は、AI を走らせ直さずにその場で直す**（1 回 5〜7 分・課金があるうえ、
同じ間違いを繰り返しやすい）。検算の前に必ず通し、直したことは「割り当ての結果」に **「自動修正」** として出る
（`.studio/script-plan.json` の `autoFixes` にも残る）。

| E | 直し方 |
|---|---|
| `SCRIPT_NARR_AFTER_END`（ナレーションが動画尺より後ろ） | その秒が**台本のどの区間か**を見て、その区間の映像が実際に出ている位置に写す。台本の終わりよりさらに後ろなら最後の区間の頭。前のブロックより前には戻さない |
| `SCRIPT_OUT_OF_RANGE`（素材の長さ超え） | 同じ長さのまま素材の終わりに詰める |
| `SCRIPT_BAD_RANGE`（区間が逆） | 入れ替える（0 秒は直せない） |
| `SCRIPT_UNKNOWN_CLIP`（catalog に無い id） | パス・拡張子・大小文字の違いで 1 つに決まるときだけ読み替える |
| `SCRIPT_NARR_NEWLINE` / `SCRIPT_NARR_EMPTY` / `SCRIPT_NARR_DUP_ID` | 1 行にする / 外す / 連番を足す |

いちばん多いのは 1 つ目。AI は `at` を台本の秒（【13〜16秒】なら 14 秒）で書きがちで、カットの合計が台本より短いと
最後のブロックが動画からはみ出て `06_close: 動画尺（13.5 秒）より後ろに置かれています` で止まっていた。
NG にした素材・0 秒の区間・id が決まらない素材は直せないので E のまま残る（そのときは台本か素材を直す）。
`SCRIPT_SECTION_LENGTH` などの W は直さない（尺のずれは「音声を生成」→「ナレーションに尺を合わせる」で詰める）。

### 割り当てを見てから書き込む（承認）

Brief の **「割り当てを見るだけ」** は、AI に組み立てを作らせて**書き込まずに**結果だけ残す
（`.studio/script-plan.json`）。カードの下に **「割り当ての結果」**（区間ごとのカット・検算の E/W・素材が無かった区間・意図）が出るので、
見て良ければ **「この割り当てで書き込む」** を押す。置き換える内容（いまの cuts.json のカット数、narration.json のブロック数・
効果音・声と音量の設定）の確認が出て、承認すると **AI を走らせずに**その案をそのまま書き込む
（組み立ては 1 回 5〜7 分・課金があるので、見た結果を捨てて作り直さない）。

| 状態 | 表示 | 書き込めるか |
|---|---|---|
| 見たあと、まだ書いていない | 未反映（承認待ち） | 書ける |
| 案を作ったあとに `script.md` を直した | 書き込めません（台本が変わっています） | 書けない。「見るだけ」をやり直す |
| いまの素材で検算し直して E がある（あとから NG にした素材が入っている等） | 書き込めません | 書けない |
| 書き込んだ | 書き込み済み | もう一度書ける（Timeline で直した分は失われる） |

書く直前にも、**いまの台本と素材で検算し直す**（案を作ったときの結果を信用しない）。src はいまの catalog から引き直すので、
あとで slug を変えていても合う。このときも E の自動修正を先に通すので、自動修正が入る前に作った案（E で止まっていたもの）も
承認すればそのまま書ける。Timeline に未保存の変更があるとき・同じ案件でジョブが動いているときは書き込まない。
「台本から組み立てる」（すぐ書き込む）の結果も同じ場所に残るので、E で書けなかったときも理由を見られる。

2026-09-18 までは「見るだけ」が**必ず失敗**していた（書かないのが正常なのに「書いていない＝E」と判定し、
`検算で E が出たので書いていません:` の後ろが空のまま終わって、7 分かけた結果も捨てていた）。

そのあとは Timeline で微調整 →「音声を生成」→「ナレーション合成（mix）」で仕上げる。
**8 割方できた状態から始められる**のが狙いで、残りは人が詰める前提。

## バズ動画の型を写す（`ai-reference` / `ai-mimic`）

**他の人が投稿して伸びたリールがあるとき**、その動画を渡すと「型」を分析し、**同じ型で自分の素材の動画**を作れる。
場所は Brief 画面の「バズ動画の型を写す」（`ScriptCard` の上）。写すのは**構成・テンポ・テロップの型・フックの掛け方・
店名の明かし方・締め方**で、参考動画の映像・音声・文言そのものは一切使わない（中身は自分の素材と裏取り済みの事実で作る）。

```
参考動画 ──取り込み──▶ .studio/reference/source.mp4（クラウドには上げない）
         ──ffmpeg────▶ シーン検出（カット境界）・カット頭のコマ・コンタクトシート（0.5 秒ごと・3×4）・無音検出（声の区間）
         ──claude────▶ reference.json：カットごとのテロップ（読めた通り）と映像・区間（役割・目的・テロップの型）・
                        pattern（フックの型・リビールの秒・締め・テロップとテンポの癖・保存理由）・写すときの規則
reference.json ＋ 素材のタグ ＋ 店の事実 ＋ 人格 ──claude──▶ script.md（同じ区間・秒数・カット数・テロップの型）
script.md ──「台本から組み立てる」（ai-script）──▶ cuts.json + narration.json
```

### 使い方

1. **動画を選ぶ**（ローカルは PC のファイル、スマホからは素材と同じく Blob へ直接上げて PC が受け取る）。
   取り込むと自動で **「型を分析する」**（`ai-reference`）が走る。3 分までのショート動画だけ受け付ける
2. 分析結果（尺・カット数・平均カット秒・声の割合、フック・リビール・締め・テロップとテンポの癖、区間の表、
   カットの一覧、写すときの規則）を見る。「別の案件の分析を使う」で、前に分析した型をそのまま持ってこられる
3. **「この型で台本を作って組み立てる」**（`ai-mimic`）。参考と**同じ区間数・同じ秒数・同じカット数**で `script.md` を書き、
   続けて `ai-script` が素材を割り当てて `cuts.json` と `narration.json` を作る。
   「台本を作って割り当てを見るだけ」なら `script.md` は書くが構成は書き込まず、「割り当ての結果」で承認してから入れる
4. あとは通常どおり Timeline で微調整 → Render の「仕上げ」

### 分析で何を見ているか

- **シーン検出**（`select='gt(scene,0.25)'`。平均 4 秒超なら 0.12 でもう一度）でカット境界を取り、0.3 秒未満の揺れは同じカットにまとめる。
  多すぎるときは間隔を広げて 120 カット以下にする（`shared/reference.ts` の `cutBoundaries`）
- **コンタクトシート**は 1 秒 2 コマを 3 列 × 4 段（1 枚 = 6 秒・コマ 360px）。テロップの文字が読める大きさで、
  30 秒の動画なら 5 枚の Read で済む。カット頭のコマは画面の一覧用（AI は必要なときだけ見る）
- **声の区間**は無音検出の補集合。中身は聞けない（文字起こしはしない）が「どこで喋っているか」は分かるので、
  型を写すときに「参考で声がある区間だけナレーションを書く」に使う
- AI に渡すのはシートとカット一覧・声の区間だけ。返ってくるのは `--json-schema` で形を固定した JSON で、
  `mergeAnalysis`（純粋・テストあり）がシーン検出の秒数に重ねて `reference.json` にする。**秒数は AI が変えられない**

### 型を写すときの決まり

- **区間の数・秒数は参考どおり**（`fitMimicToReference` が強制する。AI の丸めやずれで動かない）。カット数も参考のもの
- テロップは参考の**型**（文の形・文字数・語尾・記号・数字の使い方）を写し、中身はこの店の事実に置き換える。
  **参考動画のテロップと同じ文言が残っていたら `MIMIC_TELOP_COPIED`（W）**で指摘する。店名・料理名・地名・数字を残さない
- 映像は参考のショット（寄り／引き・被写体の種類・動き）を写しつつ、**手元の素材にあるもの**を id を添えて指す。無い画は `unmatched`（撮り足しの候補）
- ナレーションは参考で声がある区間だけ、人格の文体で。無い区間に書かせない（`MIMIC_NARRATION_MISSING` は逆の欠けを W）
- 人格の規則はそのまま効く（`hookStyle=areaDigit` ならエリア名はバッジへ、締めは `cta` の語族、テロップ 13 文字・句点なし）
- 検算（`checkMimicPlan`・テストあり）で **E があれば `script.md` を書かない**。前の台本は `.studio/backups/` に残る

| コード | 内容 |
|---|---|
| `MIMIC_NO_SECTIONS` / `MIMIC_SECTION_COUNT` / `MIMIC_SECTION_TIME` / `MIMIC_BAD_RANGE`（E） | 区間が無い／参考と数が違う／秒数が違う／区間が逆 |
| `MIMIC_CUTS_DIFFER`（W） | 参考とカット数が違う |
| `MIMIC_TELOP_COPIED`（W） | 参考動画のテロップと同じ文言（型だけ写して中身は置き換える） |
| `MIMIC_TELOP_LONG` / `MIMIC_TELOP_PERIOD`（W） | 文字数・文末の句点 |
| `MIMIC_NARRATION_MISSING` / `MIMIC_NARRATION_NEWLINE`（W） | 参考では声がある区間に原稿が無い／改行がある |

### ファイルと同期

- `reference.json`（案件直下）が分析結果。取り消すとファイルを消す代わりに**墓標（`source: null`）**を書く
  ——クラウドとの同期は「ファイルが無い」を伝えられない（無い＝送らない）ので、消したことも 1 つの版として送る
- 動画とコマは `.studio/reference/`（`source.<ext>` / `frames/NNN.jpg` / `sheets/NN.jpg`）。
  ワーカーは **コマとシートだけ**を Blob に上げる（動画は上げない）ので、スマホでも分析の一覧が見える
- 「別の案件の分析を使う」はローカルではその場でコピー、クラウドでは `ai-reference` ジョブ（`copyFrom`）として PC が複製する
- ジョブは `ai-reference`（`url` があれば先に取り込む／`copyFrom` なら複製だけ／`analyze: false` で取り込みだけ）と
  `ai-mimic`（`write: false` で見るだけ／`assemble: false` で台本だけ）。どちらも軽いジョブ扱い（ffmpeg は数秒で終わり、あとは AI の待ち時間）

**参考動画の扱い。** 分析のためだけに案件フォルダに置き、動画本体は公開もクラウド同期もしない。
型（構成・テンポ・見せ方）を学ぶのは正当なやり方だが、映像・音声・文言の流用は他人の投稿の盗用になるので、
ツールはそこを分けて作ってある（プロンプトでも禁じ、検算でも指摘する）。

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
Timeline の V 段か絵コンテでドラッグする（`cuts.json` の配列順だけが変わる）。

Timeline 画面のインスペクタ下「検証 → 構成」タブに今の並びのチェック結果が出て、
「AI ▾」に **「並べ替え用の素材リストを書き出すだけ」**（＝`--export` と同じ）がある。

## GUI：編集（Timeline）

Timeline タブは **1 画面のエディタ**で、`cuts.json` と `narration.json` をここだけで編集する
（以前は Materials の横トラック・Timeline の絵コンテ＋カット行・Render のナレーション表に分かれていた）。

```
┌ ツールバー：保存 ↶ ↷ 読み直す │ AI ▾ 音声を生成 │ 吸着 テロップ単位 段 T N S 絵コンテ │ 固定順にする Render → ┐
├─────────────┬──────────────────────────┬───────────────────────────────┤
│ 素材ビン      │  プレビュー（9:16）          │ インスペクタ                     │
│  検索・絞込   │  ⏮ ◀ ▶ ▶ ⏭  0.00s / 20.25s │  選んでいるものの編集欄            │
│  ドラッグで   │                            │  （カット／テロップ／ナレーション／効果音）│
│  V 段へ       │                            │  ▾ 検証  カット 構成 ナレーション 効果音 │
├─────────────┴──────────────────────────┴───────────────────────────────┤
│ 0s     1s     2s     3s     4s     5s   …                                    │
│ V ▌1 ▌2   ▌3 ▌4      ▌5 ▌…      ← 両端で尺・中を掴んで並べ替え・Alt+ドラッグでスリップ │
│ T [g01 9割が中身を…][g02 割ったら…][ ＋ ][g03 …]  ← 同じ文言が続く範囲。クリックで文言 │
│ N [01_hook 見た目は…] [02_box カス…] [03_shopfront …]  ← 横にドラッグで配置秒。境界に吸着 │
│ S [hook]                                          ← 効果音。横にドラッグ             │
└───────────────────────────────────────────────────────────────────────┘
```

| 段 | 何が乗るか | 操作 |
|---|---|---|
| **V**（映像） | カットの列。幅＝実時間（倍速で縮む）。背景は catalog のストリップ | 両端で IN/OUT、中をドラッグで並べ替え、Alt+ドラッグで中身をずらす（スリップ）。右上の `!`/`?` は検証の E/W |
| **T**（テロップ） | 同じ文言が続く範囲（テロップグループ）。色は絵コンテと同じ。黄＝未記入 `{{gNN:intent}}`、破線＝テロップ無し | クリックでグループを選び、インスペクタで文言・向き・バッジをまとめて直す。破線をクリックするとそのカットを選んで書ける |
| **N**（ナレーション） | `narration.json` のブロック。幅＝実測 `durSec`（破線は文字数からの見積）。黄＝要再生成、赤枠＝前と重なる、縞＝動画尺をはみ出す | 横にドラッグで `at`。**カット境界に吸着**（Alt で無効、ツールバーの「吸着」で常時無効）。左の ＋ で再生ヘッドの位置に追加 |
| **S**（効果音） | `narration.sfx`。赤＝音源がライブラリに無い | 横にドラッグで `at`。左の ＋ で追加（音源はライブラリの先頭） |

**どの段でもクリック＝選ぶ＋そこへシーク**。段の表示は「段 T N S」で切り替えられ、
「絵コンテ」でサムネ一覧（テロップ単位でまとめて動かす・Alt+←→）も出せる。

### 合成音（プレビューで声と効果音を鳴らす）

トランスポートの **「合成音」** が ON だと、再生に合わせて**生成済みの `narration/<id>.wav` と効果音**を重ねて鳴らす
（既定 ON）。レンダー（Remotion）には入れない——声は mix 工程で載せるもので、エンジンに入れると二重になるため。
GUI 側で Web Audio に wav を読み込み、Player の `frameupdate` に合わせて `at` の位置から鳴らす
（`src/editor/mixPreview.ts` が「何を・いつ・どこから」を決める。純粋・テストあり。DOM 側は `useMixPreview.ts`）。

- 鳴るのは **音声が生成済みのブロックだけ**（`needsTts` のものは古い wav が残っていても鳴らさない）。
  表示は `声 11/13・効果音 1（未生成 2）` のように出る
- ON の間は素材の音を `ambientGain`（既定 0.22）に下げ、声は `narrationGainDb`、効果音は `sfxGainDb`＋各 `gainDb` を
  反映する。mix-narration.js の -14 LUFS 正規化までは再現しないので、音量のバランスは目安
- 再生ヘッドを動かした・ループで頭に戻った・ナレーションをドラッグした、のいずれでも鳴らし直す
  （予測位置と Player の位置が 0.25 秒以上ずれたら再スケジュール）

| キー | 動き |
|---|---|
| `Space` | 再生／一時停止 |
| `← →`（Shift で 10） | 1 コマ戻る／進む（入力欄の外で） |
| `Home` / `End` | 先頭／末尾 |
| `Delete` | 選んでいるもの（カット・ナレーション・効果音）を消す。最後の 1 カットは消せない |
| `S` | 再生ヘッドの位置でカットを分割（前半が元の id と slot、後半は新 id。テロップは両方に残る） |
| `Ctrl+D` | 選んでいるカットを複製 |
| `Alt+← →` | V 段でフォーカスしたカットを 1 つ前後へ |
| `Ctrl+Z` / `Ctrl+Y` | 取り消し／やり直し（cuts と narration をまとめて 1 手。50 手） |
| `Ctrl+S` | cuts.json と narration.json を保存 |
| `Ctrl+ホイール` | 拡大縮小（ポインタの下の時刻を動かさない） |
| `Esc` | 選択を外す・ドラッグを取り消す |

### 素材ビン（左）

catalog のクリップを小さいカードで並べる。検索（id・内容・種別）と絞り込み（未使用／★フック候補／未タグ）。
**カードを V 段へドラッグ**（青い縦線の位置に入る）、ダブルクリックか「＋」で末尾に追加。`cuts.json` が無い
案件は最初の 1 本で作られる（fps は catalog の主力 fps、theme は brief か型の既定）。追加時の長さは
`usableRanges` の best（無ければ ok）の先頭、無ければ planCuts と同じ既定（2.5 秒以上は頭尾 0.2 秒を避ける）を
**型の `maxCutSec`（既定 3 秒）で切る**。会話クリップは全尺。使用回数（×N）が出るので使い残しが分かる。
タグ・使える区間・NG の編集は Materials 画面。

### インスペクタ（右）

| 選んでいるもの | 編集できること |
|---|---|
| 何も無し | 動画全体：テーマ・フォント・バッジの濃さ・カット数と尺・**ナレーション音声に尺を合わせる**・ショートカット一覧 |
| カット | 素材の差し替え・フィルム帯（IN/OUT。つまみは Tab → ← → で 1 フレーム、Shift で 10）・倍速・テロップ文と向き・バッジ・字幕（subs）・複製／分割／削除・🔒 固定 |
| テロップグループ | 文言（グループ内の全カットに入る）・向き・バッジ（先頭カット）・テロップを外す |
| ナレーション | 本文（変えると要再生成）・id・配置秒（±0.1 / 再生位置に置く）・「かなに開く」（TTS 誤読）・▶ 聴く・この 1 本だけ生成・削除 |
| 効果音 | 音源・役割・配置秒・尺（trim）・音量・fade・削除 |

その下の **検証** はカット（`validateCuts`）・構成（`checkOrder`）・ナレーション（`checkNarration`）・効果音（`checkSfx`）の
4 タブ。行をクリックでその場面へ、「適用」で自動修正できるものはボタンが出る。ナレーションの重なりは
「重なりを自動で直す」で `at` を後ろにずらす（音声の作り直しは不要）。重なり・はみ出しがあるときは
「映像を音声に合わせる」も出る（次節）。

### ナレーション音声に尺を合わせる（`reel fit` / `shared/fit.ts`）

「台本から組み立てる」→「音声を生成」のあと、**Fish Audio の実測尺は台本の想定とずれる**（同じ文でも 2 倍
ばらつく）ので、組み立て直後の構成は音声より長かったり短かったりする。以前は `at` を後ろにずらすか、カットを
1 つずつ引き伸ばすしかなかった。インスペクタの「動画全体」→ **「ナレーション音声に尺を合わせる」**を押すと、
**音声を正として映像の側を合わせ直す**。

- **各ブロックの映像区間 ＝ その wav の実測 `durSec`**（フレーム切り上げ）。ブロックは前から詰めて置き、
  `narration.json` の `at` はブロックの頭に置き直す。**音声は作り直さない**
- 区間の中は **0.75〜0.8 秒（中央 0.775）のカットに刻み直す**。カット数 ＝ round(区間 ÷ 0.775)。
  0.6 秒未満のカットは作らないので、1 秒前後の短いブロックは 1 カットにしかできない。そのぶん
  **動画全体の平均**が 0.75〜0.8 秒に入るよう、刻める余地のある長いブロックでカット数を増減して釣り合いを取る
  （1 文 1 秒の短いブロックばかりだと平均は 0.9 秒近くに寄る。結果にその旨と「文をつなげると刻める」旨が出る）
- 素材は**いまのカット列から**取る（新しい素材は選ばない）。いまのタイムラインでそのナレーションの窓
  （`at` 〜 次の `at`）に掛かっているカットがそのブロックの材料で、テロップ・バッジ・切り出し（crop）は元カットから引き継ぐ。
  **いまあるクリップは全部残す**：ブロックのカット数はそのブロックに掛かっているクリップの数を下回らない
  （1.1 秒の文の下に 2 クリップあれば 0.6 秒ずつ 2 カット。窓をまたぐカットは取り分の大きい側のブロックが担う）
- **テロップも 1 つも落とさない**。1 カットしか無いテロップとフック（先頭）は読めるよう 0.8 秒に伸ばす
  （`TELOP_MIN_DISPLAY` の E を出さないため）
- **会話（字幕つき）とロック済み（🔒）のカットは刻まない**（尺も倍速もそのまま）。刻んだカットは等速になる
- 同じ素材から複数カットを取るときは、素材の中で場所をずらす（ジャンプカット）。元の区間で足りなければ素材の残り
  （`catalog` の長さまで）を使い、素材そのものが短ければ同じ場面を重ねて使って注記する
- **映像が音声より短いブロックは作らない**（次のナレーションが食い込まないように）。素材が尽きたら元のクリップの
  トリミングを広げて埋める（後ろへ伸ばし、後ろが無ければ頭を前へ）。それでも足りなければ、続くナレーションを
  その分だけ後ろへ送る（被らないが映像より遅れるので「!」付きで出る。素材を足すか文を短くする）。
  スロー再生や別クリップの流用はしない。`catalog` に無い素材（手で置いたファイル）は GUI では長さが分からず
  元カットの範囲までしか使えない。CLI（`reel fit`）は `public/` の実体を ffprobe で測って使う
- 効果音（`sfx`）は元の窓の中の相対位置で新しいブロックへ写す
- 結果は「合わせた結果」に出る（ブロックごとの 音声 → 映像 の秒数とカット数、注記）。**Ctrl+Z で cuts と
  narration が一緒に戻る**。cut の id は `c01…` で振り直され、`meta.slots` / `meta.telopGroups` は新しい id に付け替わる

CLI は `reel fit --project P`。`--dry` で書かずに結果だけ、`--min` / `--max` で刻みの範囲、`--lead` / `--tail` で
先頭・末尾の余白（秒）、`--estimate` で音声の無いブロックを文字数見積もりで合わせる（既定では音声が無いブロックが
あると止まる。音声が正なので）。旧版は `.studio/backups/` に残る。

### テロップのフォント（自前フォントの取り込み）

既定は同梱の Noto Serif JP Bold（`engine/public/fonts/`・SIL OFL 1.1）。自前のフォントを使うときは
Settings の「テロップのフォント」で取り込む。流れは 3 段階になっている。

1. **置き場** `~/.reel-studio/fonts/`（`core/fonts.ts`）。案件の外なので、案件をまたいで使え、更新でも消えない。
   受け付けるのは ttf / otf / ttc / woff / woff2 で、拡張子だけでなく**先頭 4 バイトの署名**も見る（1 ファイル 40MB まで）
2. **指定** `cuts.json` の `font`（ファイル名）。Settings で選んだものは「これから作る動画」の既定として
   `planCuts` / `scriptPlanToCuts` / Timeline の新規作成に入る。**既存の `cuts.json` の指定が常に優先**なので、
   構成を作り直しても案件で選んだフォントは戻らない
3. **配り** 指定されたフォントは案件の `public/fonts/` へコピーされる（`ensureProjectFont`）。
   タイミングは `cuts.json` の保存時（`server/routes/files.ts`）とレンダー直前（`core/render.ts` の preflight）。
   Remotion は `staticFile('fonts/<file>')` しか読めないので、この 1 コピーで**プレビューと書き出しが同じ絵**になる

エンジン側は `engine/src/telops.tsx` の `TelopFont`（Context）が `FontFace` で読み込み、読み終わるまで
`delayRender` でレンダーを待たせる。読めなかったときは同梱の明朝 → OS の明朝へ落ちるだけで止まらない
（レンダーの警告に「フォントが見つかりません」を出す）。family 名の付け方（`reel-font-<拡張子を除いた名前>`）は
`shared/schema/fonts.ts` の `fontFamilyOf` と同じ規則にしてあり、ズレると絵に出ないのでテストで縛ってある。

クラウドモード（スマホ）では、ワーカーが置き場のフォントを `_global` のアセットとして Blob に上げ、
`/p/<slug>/<mode>/fonts/<file>` がそれを返す。取り込み・削除は PC の Reel Studio でのみ行える
（実体が PC にあり、Vercel の Function は本文 4.5MB までのため）。

### AI ▾（ツールバー）

テロップを書いてもらう（未記入だけ／全部書き直す）・直してもらう（自由指示）・ナレーション原稿・並べ替え（再 plan）・
並べ替え用の素材リストの書き出し。**未保存の変更があると押せない**（AI はディスクの `cuts.json` を読むため。
実際に「18 カットあるのに 11 しか見てくれない」形で踏んだ）。走っている間はツールバーの下に進捗と「中止」が出る。

### 実装

- 純粋ロジック：`src/editor/tracks.ts`（T/N/S 段の配置・吸着・`draggedAt`）、`src/components/track.ts`（V 段の配置・挿入・既定区間・cuts の書き換え）、`src/components/trim.ts`（IN/OUT）、`src/components/reorder.ts`（並べ替え）、`src/hooks/undoStack.ts`（取り消し）。いずれもテストあり
- 状態と操作：`src/editor/useEditorModel.ts`（選択・履歴・cuts/narration の書き換え・検証の memo）。DOM に触らない
- 画面：`src/editor/EditorPage.tsx`（3 列＋タイムラインの配置とショートカット）、`Timeline.tsx`（4 段）、`Bin.tsx`、`Inspector.tsx`、`ValidationPanel.tsx`、`AiMenu.tsx`、`Transport.tsx`
- 共通フック：`src/hooks/usePref.ts`（localStorage）、`useAiModel.tsx`（モデル選択。以前は 5 画面に同じコードがあった）、`useHotkeys.ts`（入力欄の中では発火しない）

## ナレーション（Render 画面）

**レンダーしただけの動画には声が入っていない。** `out/final.mp4` はテロップ付きの映像＋素材の音だけで、
納品物は声を混ぜた `out/final_narration.mp4` になる。

- **原稿（文言・配置秒）は Timeline の N 段とインスペクタで編集する**（前節）。「AI ▾ → ナレーション原稿を書いてもらう」で
  `narration.json` を書かせることもできる。**テロップの内容に沿った原稿が最優先**で、一字一句同じにはせず
  言い換え・主語や理由の補足・`caption.txt` と裏取り済みの事実での肉付けをする（2026-09-13 のユーザー指示。
  それ以前の「テロップに無い情報を載せる」原則は廃止）。人格の実測話速（`shared/personas.ts` の `charsPerSec`）で
  各テロップ区間の文字数上限を決め、全体で動画尺の 6〜8 割を声で埋める。全ブロックが `needsTts: true` で出る
- **Render 画面のナレーションカードは声の設定**：ボイス・速度・試聴・「音声を生成」・声の大きさ・環境音。
  ブロック一覧は読むだけ（直すなら「原稿を Timeline で直す →」）
- 音声生成と mix は「仕上げ」（次節）に含めるのが普通。単発でやるなら「音声を生成」→「合成と納品（手動）」の「ナレーション合成（mix）」

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

- **鍵**：環境変数 `FISH_API_KEY` → Settings「音声生成」（`~/.reel-studio/settings.json`）の順に探す。
  値はログにも API レスポンスにも出さない（出るのは「どこで見つけたか」だけ）。見つからなければボタンが
  無効になり、理由が横に出る
- **作り直す範囲**：既定は `needsTts` が立っているブロックと wav が無いブロックだけ。「全部作り直す」で全件
- **1 本作るごとに `narration.json` を書き戻す**ので、途中で中断しても済んだ分は残る
- 生成後に実測 `durSec` で重なり・無音・尺はみ出しを再点検する。Fish Audio の wav は前後に 0.09 秒ほど
  無音が付くため、`durSec` 基準で 0.15 秒までの重なりは警告しない（鳴っていないので）
- **未保存の編集があると押せない。** サーバーはディスクの `narration.json` を読むので、先に保存させる

### 声と環境音の音量

`narration.json` の `narrationGainDb`（−6〜+12 dB）と `ambientGain`（0〜0.6・既定 0.22）をスライダーで変える。
`scripts/mix-narration.cjs`がこれを読む。**変えても音声の再生成は不要**で、mix をやり直すだけでよい。

## 仕上げ（Render 画面・`reel build`）

台本や構成ができたあと、完成動画までは「原稿 → 音声 → レンダー → mix → 納品」と 5〜6 個のボタンを
順番に押す必要があった。Render の一番上の **「仕上げ」** は、案件の状態から**残っている工程だけ**を
チェック済みにして並べ、「仕上げを実行」で 1 つのジョブ（`build`）として順に走らせる。

| 工程 | 済と判定する条件 | 走らせられない（blocked）条件 |
|---|---|---|
| キャプションを書く（AI） | `caption.txt` がある | cuts が無い／claude が無い |
| ナレーション原稿を書く（AI） | `narration.json` に segments がある | cuts が無い／テロップ未記入がある／claude が無い |
| 音声を生成する | 全ブロックに wav があり `needsTts` が無い | `FISH_API_KEY` が無い |
| 本番レンダー | `out/final.mp4` が `cuts.json` と、使っている素材ファイルより新しい（顔モザイクで中身を差し替えたら古い扱い） | 素材が無い等の致命的な E |
| ナレーション合成（mix） | `out/final_narration.mp4` が最新（`narrationReady` が OK） | 上 2 つのどちらかが blocked |
| 納品 | （常に候補。同じ中身なら何もしない） | mix が blocked |

順番はキャプション → 原稿（キャプションは原稿の肉付け材料になるため先）→ 音声 → レンダー → mix → 納品。
チェックを外した工程は飛ばす。**途中で失敗したらそこで止まる**（エラーにどの工程か・残りは何かが出る）。
直してからもう一度押せば、済んだ工程は自動で「済」になる。「指摘を承知でレンダー」で検証の E を無視できる
（素材が無い等の致命的なものは通らない）。

段取りの判断は `shared/build.ts` の `planBuild`（純粋・テストあり）、事実の収集と実行は `core/build.ts`。
`GET /api/projects/<slug>/build` が段取りを返し、GUI はジョブ完了やファイル保存のたびに取り直す。
CLI は `reel build --project P`（`--plan` で段取りだけ、`--steps tts,render,mix` で選ぶ）。
`build` はレンダーと mix を含むので重いジョブ扱い（全体で 1 本）。

**台本からなら 3 手。** Brief の「台本から組み立てる」→ Timeline で確認・微調整 → Render の「仕上げを実行」。

### ファイル名を最適化（同一素材の非連続参照）

Windows + Remotion では、**同じファイルを離れた位置から読み直すとレンダーが固まる・映像が入れ替わる**
ことがある。そのため `validateCuts` は `E SAME_SRC_NONCONSECUTIVE` で止め、2 ブロック目以降は
**中身が同じ別名のコピー**（`08_tank.mp4` → `08b_tank-seg2.mp4`）を参照させる。

`reel plan` で組んだ構成は最初からこの形になっているが、Timeline で手で並べ替えたり同じ素材を足したりすると
新しく出る。そのときは **仕上げカード／レンダーカード／Timeline の検証パネルに出る「ファイル名を最適化」**
を押す（承知で通すより確実）。押すと:

1. `cuts.json` の `src` を別名に振り直す（`meta.aliases` に `from`/`to` を足す。並びもテロップも変えない）
2. `aliases` ジョブが PC で実ファイルをコピーする（軽量プレビューも一緒にコピーするのでスマホでも黒くならない）

名前の決め方は `shared/alias.ts` の `realignAliases`（純粋・テストあり）。**既に正しい別名なら何もしない**ので
何度押しても結果は同じ。既存の別名と名前がぶつかるときは `seg3`, `seg4`… とずらす（中身の取り違えを防ぐ）。
CLI は `reel aliases --project P`（振り直しはせず、未適用のコピーだけを行う）。

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

**1 個ずつの位置・音源・音量は Timeline の S 段とインスペクタで直す。** Render の効果音カードは自動配置・
ライブラリの役割・ダッキング・全体音量。

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
| `HASHTAG_COUNT`（W） | 本数が人格の規定と違う（人格の caption.hashtags） |
| `HASHTAG_PR`（W） | ハッシュタグ列の `#PR`（PR 表記は店名の直後の小文字 `pr` だけ） |
| `TRAILING_PERIOD`（W） | 文末の句点「。」 |
| `PLACEHOLDER`（W） | `＿＿＿` が残っている＝裏取りがまだ |
| `TOO_LONG`（W） | 長さの目安超え（人格の caption.maxChars。0 なら上限なし） |
| `PR_MISSING` / `PR_UNEXPECTED`（W） | `brief.shop.pr` と本文の `pr` 表記が食い違う |
| `REPOST_ACCOUNT`（W） | 自分のアカウントへの誘導行が無い（人格の caption.repostAccount） |

テキスト欄で直接直せる（保存で `caption.txt`、旧版は `.studio/backups/`）。「追加の指示」を入れて
書き直させることもできる（例「頂いたものに値段を入れて」）。「本文をコピー」でクリップボードへ。

## トライアルリール（フックだけ差し替えた複数版）

どのフックが効いたかを見るために、**冒頭のフックだけを変えた 3 本**を投げて比べる。
Render の **「トライアル（フック差し替え）」**（`reel trial`）で作る。
フック案は **「AI に 3 パターン書いてもらう」**（`reel ai hooks`）で書かせられる。

### 運用（ユーザー指示・2026-09-14。`shared/hooks.ts` の `TRIAL_POSTING_RULES` が正）

1 本のベース企画から**冒頭のフックだけ異なる 3 パターン**を作る。本編（フック以降）は共通。
A / B / C は**それぞれ違う切り口**（疑問形・結果先出し・煽り／警告形 など）にする。
**キャプションはパターンごとに文面を変える**（同じ文面で複数投稿すると使い回しとして扱われる）。

投稿は Instagram 側の操作なのでツールは代行しない。代わりに納品のたびに画面・ログに出す:

- 投稿は 18:00 / 19:00 / 20:00 の 1 時間おきに、A → B → C の順で 3 本
- トライアル設定の「全員に自動的にシェア」を必ず OFF にする
- 投稿後は最低 24 時間空けてから、保存率・再生数で伸びを比べる
- 一番伸びたパターンだけ「全員にシェア」で全フォロワーに展開する
- 伸びた 1 本が出たら**勝ちパターンの二次活用**（下記）

### AI にフック案を書かせる（`reel ai hooks` / `core/ai-trial.ts`）

既定では**今のフックを A（基準）としてそのまま残し**、B / C を A とも互いとも違う切り口で書かせる
（`--fresh` で全部新しく）。書くのはカットごとのテロップ・バッジ・フック区間のナレーション 1 文・
そのパターン専用のキャプション。素材の差し替えは書かせない（フックの素材選びはユーザーが決める決まり）。

- **差し替え範囲はテロップの切れ目まで自動で伸ばす**（`alignedHookCutCount`、上限 6 カット・5.5 秒）。
  同じ文言が続くカットの途中で範囲が切れると、前半だけ変わって古い文言が 1 カット残り、
  つながらない並びになるため（那由多: 3 カット 3.51 秒 → 4 カット 4.86 秒）
- キャプションは共通の `caption.txt` を元に、**事実（店名・住所・営業時間・価格・頂いたもの）を変えずに
  文面を変えて**書かせる。冒頭の一文はそのパターンのフックに合わせる。A は共通の `caption.txt` のまま
- 書いたあとは `checkHooks` と `checkCaption` で点検してログに出す。hooks.json は上書き前に `.studio/backups/` へ

### 変わるもの・変わらないもの

**差し替えるのは冒頭 3 カット**（`cutCount`。1〜6 で変更可）。1 カット（1 秒前後）だけ変えても
見た印象がほとんど変わらず A/B の差が出ないため（2026-09-12 のユーザー指示）。
`meta.slots` の `1_hook` がそれより長い型では、そちらの長さに合わせる。

| 変わる | 冒頭 N カットの**カットごとの**テロップと素材、バッジ（1 枚目）、**フック区間のナレーション**、**キャプション** |
|---|---|
| **変わらない** | それ以外のカット・テロップ・ナレーション。**cuts.json を書き換えない** |

テロップは `telops[i]` が i 枚目に入る。**空文字と、配列が足りないぶんのカットは今の文言のまま**なので、
「1 枚目だけ変える」「3 枚とも変える」「店名リビールのカットだけ残す」が選べる。
素材を差し替えても**カットの尺は元のまま**にするので、パターン間で総尺がずれない。

差し替えた cuts は `.studio/trial/<id>.cuts.json` に書き、レンダーには `--props` で渡す。
元の `cuts.json` はそのままなので、フック以降は**1 フレームも変わらない**（実測：フック後の
フレームハッシュが 3 パターンで完全一致）。

ナレーションは**フック区間に属するブロック**（中点が区間内にあるもの。`hookNarrationIds`）を
**1 本にまとめて差し替える**。id は `01_hook__B` のように変えて生成する（共有の `narration/` で wav が
ぶつからないように）。それ以外の wav はそのまま使い回す。次のテロップ用に区間の終わり 0.2 秒前から
始まるブロックは巻き込まない。差し替えた 1 本が次のブロックに食い込むときは W を出す。

### 先に「音声を生成」を済ませておく

トライアルが自分で作る音声は**フック区間の 1 本だけ**（`01_hook__B` など）。それ以外のブロックの
wav は共有の `narration/` にあるものを使い回すので、**先に Render の「音声を生成」を済ませておく**。
揃っていなければ**レンダーを始める前に**止める（`missingMixAssets`。効果音のファイル欠けも同じ）。
画面でも、音声が揃うまでトライアルと二次活用版のボタンは押せない。

> 2026-09-21: wav を 1 本も作っていない案件でトライアルを回し、80 秒のレンダーのあと
> 「mix に失敗 (exit 1)」とだけ出て原因が分からなかった。mix は `scripts/mix-narration.cjs` という
> 別プロセスなので、落ちても終了コードしか呼び出し側に返らない。だから**呼ぶ前に確かめる**。

### 書き出し

```
out/trial_A_narration.mp4                          ← 案件フォルダ（確認用）
outputs/<店名>_<人格>_ナレーション付き_フックA.mp4   ← 納品
outputs/<店名>_<人格>_caption_フックA.txt            ← パターン別キャプション（専用が無ければ共通の caption.txt）
```

### 点検（`shared/hooks.ts` の `checkHooks`・テストあり）

| コード | 内容 |
|---|---|
| `HOOK_DUP_ID`（E） | id の重複 |
| `HOOK_EMPTY`（E） | テロップ・素材・ナレーションのどれも変えていない |
| `HOOK_NO_CUT`（E） | cuts.json にフック区間が無い |
| `HOOK_SAME`（W） | 中身が同じパターンが 2 つある＝比較にならない |
| `HOOK_CAPTION_SHARED`（W） | キャプションが同じ文面になるパターンがある（共通 caption.txt を 2 つが使う場合も） |
| `HOOK_ONLY_ONE_CUT`（W） | 1 カットしか変えていない＝違いが伝わりにくい |
| `HOOK_OVER_SPAN`（W） | 差し替え範囲より多い枚数の文言が入っている |
| `HOOK_TOO_FEW`（W） | 1 パターンだけ |
| `HOOK_TELOP_LONG` / `HOOK_TELOP_PERIOD`（W） | 13 文字超え / 文末の句点 |

**パターンの数だけレンダーが走る**（1 本あたり通常のレンダーと同じ時間）。見た目だけ先に見たいときは
「ドラフトで試す」（0.25 倍・納品しない）。draft の出力は `trial_<id>_draft_narration.mp4` で、
本番と混ざらない。

レンダーは通常レンダーと同じ preflight（`validateCuts`）を通る。検証の E（F7 の看板温存
`F7_SIGNAGE_EARLY`・画角の連続・フックの型など「構成の意見」）で止まったときは、
カードの **「指摘を承知でレンダー」** にチェック（CLI は `--force-errors`）で通せる。二次活用版も同じ。
素材が無い・尺を超えている等の致命的なものは承知でも通らない（`FATAL_CODES`）。
2026-09-15: ある案件（F7）で看板クリップを自分で 4・12・15 カット目に置いた構成が、
トライアルにだけこの配線が無くて止まったので追加した。

実測（bonjour arima・冒頭 3 カット = 3.9 秒）: 1 枚目と 2 枚目のフレームハッシュが 3 パターンで
すべて異なり、3 枚目（文言を空にした店名リビール）とそれ以降は完全一致した。

**音声は各パターンで独立に −14 LUFS へ正規化される**ので、フック以降の音も数値上はわずかに違う
（全体のラウドネスを測ってから一律ゲインをかける方式のため）。映像は完全に同一。

### 勝ちパターンの二次活用（`reel winner` / `core/winner.ts` / `shared/winner.ts`）

伸びた 1 本が決まったら、**締めの一言（テロップとナレーション）だけ変えて 1.1 倍速で書き出し直し、
キャプションを新しく書いて、新しいトライアルリールとして再投稿する**。映像は締め以外変えない。

```
reel winner --project P --id B                       ← 締め・締めナレ・キャプションは AI が書く
reel winner --project P --id B --tail "一度は行っとこ" --tail-narration "いちどは行っといて" --caption-file new.txt
```

| 工程 | 何をするか |
|---|---|
| 1 | パターン B のフックを当てた cuts に、**末尾のテロップグループ**（同じ文言が続く範囲）だけ新しい締めを入れて `.studio/trial/BW.cuts.json` に書く |
| 2 | `--props` でレンダー → `out/winner_B.mp4` |
| 3 | 締めのナレーションだけ音声生成（id `05_cta__WB`）→ mix → `out/winner_B_narration.mp4`。フックの wav はトライアルのものを使い回す |
| 4 | ffmpeg で倍速（映像 `setpts=PTS/1.1`・音声 `atempo=1.1` でピッチを保つ）→ `out/winner_B_x1.1_narration.mp4` |
| 5 | `outputs/<店名>_<人格>_ナレーション付き_フックB_二次.mp4` と `_caption_フックB_二次.txt` |

点検（`checkWinner`）: 締めが今と同じ（E）、締めが来店を促す語族でない（W）、キャプションが元と同じ文面（止める。`--force` で通す）、
倍速が 1.0〜1.5 の外（E）。GUI は Render の「トライアル」カードの「勝ちパターンの二次活用」。

## 顔モザイク（Materials 画面・`reel mosaic`）

店員さんや他のお客さんの顔が映った素材に、**自動でモザイクをかける**。顔の検出は
[deface](https://github.com/ORB-HD/deface)（MIT）の CenterFace を使い、塗りと書き出しは
`scripts/face-mosaic.py` が行う。

### 導入（1 回だけ）

Python 3.10 以上が要る。Settings の **「顔モザイク（deface）」→「導入する」**（`reel mosaic setup`）で
`~/.reel-studio/deface-venv` に専用の venv を作り、`deface` / `onnx` / `onnxruntime` を入れる
（グローバルの Python には入れない。消すときはフォルダごと消す）。`onnx` が無いと deface は遅い OpenCV 版に落ちるので一緒に入れる。

| ボタン | 入るもの | 実測（検出 720x1280・1 フレーム） |
|---|---|---|
| 導入する（CPU 版） | onnxruntime | 89 ms |
| GPU 版で導入する（DirectML・Windows） | onnxruntime-directml | 15 ms（RTX 3060 Ti。書き出し込みで 1 秒あたり約 32 フレーム） |

使う python は `REEL_STUDIO_MOSAIC_PYTHON` > Settings の python > 導入した venv > PATH の順に探す。

### 使い方

1. Materials の **「顔モザイク（deface）」** を開き、一覧の検索で人が映っていそうなクリップに絞る（例「人物」「店内」）
2. **「表示中の N 本にかける」**（NG は除く）。1 本ずつ検出し、顔があればモザイク版に差し替え、無ければ何もしない
3. クリップの詳細の「顔モザイク」で、顔の区間（`▶ 0.4〜2.3 秒`）を押して確認する。料理にかかっていたら
   しきい値を上げて「今の設定でかけ直す」、外したければ「元に戻す」

一覧のカードに `モザイク` / `顔なし` のバッジが付き、絞り込みに「顔モザイク済み」がある。

### 何が起きるか

- **`catalog.json` の `src` のパスは変えずに、中身だけモザイク版に入れ替える。** cuts.json・alias・
  トライアルの cuts を書き換えずに、Timeline のプレビュー・レンダー・納品のすべてに効く
- 元のファイルは `.studio/mosaic/originals/` に退避し、`clip.mosaic.original` に場所を残す。
  **かけ直しは必ず元のファイルから**（モザイクの上にモザイクを重ねない）
- 入れ替えは rename（新しい実体）で行う。「同じ素材から作る」の案件は素材をハードリンクで共有しているので、
  上書きするともう片方の案件の素材までモザイクになる。退避ファイルもリンクで共有するので、複製先でも「元に戻す」ができる
- 顔が 1 つも無ければファイルは差し替えない（再エンコードで画質を落とさない）。`mosaic.applied: false` で「顔なし（確認済み）」と記録する。
  モザイク済みのクリップをかけ直して顔が見つからなかったら、元のファイルに戻す
- サムネイル・軽量プレビュー・alias コピーは作り直す（alias が古いと、同じ素材を離れた位置で使ったカットだけ顔が映る）
- **仕上げの「本番レンダー」は、使っている素材が `out/final.mp4` より新しければ「やり直し」になる。**
  以前は cuts.json の時刻しか見ておらず、モザイク前の映像でレンダーしたものを「最新」と判定していた。
  元に戻したときも、戻したファイルの時刻を今にして同じように判定させる
- カタログを再実行しても、モザイク版は上書きしない（元の素材から作るコピー・プロキシは退避先に作る）
- 書き出しは H.264（crf 16・GOP 30）で、fps は素材の公称値（`60000/1001` など）の固定フレームレート。尺は 1 フレーム以内で変わることがある

### 既定値の根拠（2026-09-17 実測）

deface の既定（しきい値 0.2）は人の写真向けで、料理の寄りだと**麻婆豆腐の 1 フレームに 8 個「顔」を見つける**。
スコアを測った結果:

| 素材 | 最大スコア |
|---|---|
| 料理の寄り（卵黄・麻婆豆腐・パスタ・刺身） | 0.46〜0.59（誤検出） |
| 店の奥に小さく映る客 | 0.6〜0.85 |
| 正面の店員・実食する人 | 0.85〜0.93 |

なので既定は **0.6**。それでも料理で 1 フレームだけ出ることがあるため、**前後のフレームに同じ位置の検出が無いものは捨てる**
（本物の顔は続けて映る）。この 2 つで料理の寄り 5 本の誤検出は 0 フレームになり、店員 144/144・奥の客 110/136・実食 674/677 フレームで検出した。

| 設定 | 既定 | 意味 |
|---|---|---|
| しきい値 | 0.6 | 下げると横顔・遠くの顔も拾うが、料理を取り違えやすい |
| マス数 | 8 | 顔 1 つを何マスに割るか（少ないほど粗い）。升目は画面全体の格子にそろえるので、顔が少し動いても模様がちらつかない |
| 隠す範囲 | ×1.3 | 検出枠を広げて髪・輪郭まで隠す |
| 検出サイズ（CLI `--detect-short`） | 720 | 検出に使う短辺。下げると速いが遠くの顔を落とす（540 で CPU 48 ms） |
| 間引き（CLI `--detect-every`） | 1 | CPU で遅いとき 2 |
| 保持（CLI `--hold-sec`） | 0.1 秒 | 検出した位置を前後に隠し続ける（取りこぼしたフレームで顔が一瞬映らないように） |

横顔・後ろ姿・マスク・小さすぎる顔は検出できないことがある。**必ず区間を再生して確かめる**こと。

### deface の CLI をそのまま使わない理由

`scripts/face-mosaic.py` は deface の顔検出器（`deface.centerface.CenterFace`）だけを使い、読み書きは自前で行う。
deface の CLI（1.5.0）には、この用途で次の問題があった:

| deface の CLI | ここでの対処 |
|---|---|
| 出力を 16 の倍数にリサイズする（1080x1920 → 1088x1920） | 素材の実寸のまま書き出す |
| RGB を経由するので色がずれ、色の情報（BT.709）も落ちる | YUV のまま読み書きし、`setparams` で色の情報を付け直す（ffmpeg 7 以降は `-color_trc` 等の出力オプションが効かない） |
| 固定 fps で書き出すので、可変フレームレート素材の尺と音声がずれる | `fps` フィルタで素材の公称 fps にそろえ、音声は `-c:a copy` |
| 開けないファイルでも終了コード 0 | 終了コードと読めたフレーム数で判定する |
| onnxruntime の自動選択だと CPU 版で `AzureExecutionProvider` と表示される（何で動いているか分からない） | GPU 系 → CPU の順に明示し、ログに出す |
| フレームごとに独立に検出する | 前後のフレームで裏付けを取り、前後 0.1 秒に広げて塗る |

純粋ロジックは `shared/mosaic.ts`、実行とファイルの入れ替えは `core/mosaic.ts`（どちらもテストあり）。
ジョブは `mosaic` / `mosaic-revert` / `mosaic-setup`（いずれも重いジョブ）。

## 納品（`outputs/`）

Render の **「納品（outputs/ へ）」**（`reel deliver`）で、**完成品だけ**を `outputs/` に書き出す。
**draft と音声なしの mp4 は出さない**（作業用なので案件フォルダの `out/` に置いたまま）。

名前だけ見て「どの店・どの人格・ナレーションの有無」が分かる形にしている:

```
outputs/活魚センター_hiro_ナレーション付き.mp4
outputs/活魚センター_hiro_caption.txt
outputs/ドミノピザ_--persona <人格id>_ナレーション付き_修正版.mp4   ← 「名前に足す語」を入れた場合
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

- `catalog.json` — 素材の事実（probe・thumbs・proxy）＋タグ（Claude/ユーザー）＋ユーザー判断（hook/ng/lock/usableRanges）＋顔モザイクの結果（`mosaic`）。スキーマ `shared/schema/catalog.ts`
- `brief.json` — edit-pipeline.md Step 0 の回答。persona / format / hook / reveal / savePriorities / order / units / precut …。スキーマ `shared/schema/brief.ts`
- `cuts.json` — 既存互換。`id` と `meta.slots` / `meta.telopGroups` / `meta.aliases` / `meta.generated` を追加（Remotion は無視）。スキーマ `shared/schema/cuts.ts`
- `script.md` — 自然言語の台本（`ai-script` の入力）。無い案件がふつう。AI の割り当ての案は `.studio/script-plan.json`（承認して書き込む前の結果）
- `hooks.json` — トライアルリールのフック候補（`shared/hooks.ts`）。パターンごとの `angle`（切り口）と `caption`（専用キャプション）を持つ。無い案件がふつう
- `reference.json` — 参考動画（バズ動画の型を写す元）の分析（`shared/reference.ts`）。カットごとのテロップと映像・区間・型・写すときの規則。動画本体とコマは `.studio/reference/`。無い案件がふつう
- `narration.json` — 既存契約（narration-tts.md §6）＋ 音の設計（`narrationGainDb` / `ambientGain` / `sfx` / `sfxGainDb` / `sfxDuck`）
- 派生物は `.studio/`（thumbs / strips / cutframes / backups / logs / tags-export.json / render-result.json / mosaic/originals＝顔モザイク前の元ファイル）
- `.studio/meta.json` — 一覧の都合だけの値（`archivedAt`＝投稿済みにして一覧から隠した日時）。契約ファイルではないが、PC とスマホで揃うよう docs の `meta` として同期される

## 設計

- `shared/` はブラウザ・Node 両用の純粋コード。`format-specs/F0〜F7.json` が format-patterns.md の機械可読版、`personas.ts` が 4 人格の既定値の単一ソース
- `shared/plan.ts` の `planCuts` は乱数なし。同じ catalog / brief なら同じ cuts.json
- `shared/order.ts` は並び順だけを扱う純粋モジュール（`checkOrder` / `orderFromCuts` / `orderPrinciples`）。AI の判断（並び）と型の保証（尺・役割）を分離するのが狙い。ファイル入出力は `core/order.ts`
- `core/agent.ts` が `claude -p --output-format json --json-schema …` の薄いラッパ。stdout だけを JSON として読む（stderr が混ざると壊れる）。`core/ai.ts` がタグ付け・並べ替えのプロンプトとスキーマを持ち、返ってきた JSON を既存の import 経路に流す
- ジョブ種別は `shared/jobs.ts` の `JOB_TYPES` が唯一の定義。受け口（`server/routes/jobs.ts`）も GUI もこれを見る。`build` は `core/build.ts` が既存の関数（`aiCaption` / `aiNarration` / `generateTts` / `renderProject` / `mixNarration` / `deliver`）をそのまま順に呼ぶ＝ボタンを順に押すのと同じ結果
- 編集画面は `src/editor/`。状態と操作は `useEditorModel`（DOM に触らない）、配置計算は `tracks.ts` と `components/track.ts`（純粋）。取り消しは cuts と narration の組を 1 手として `hooks/undoStack.ts` に積む
- `shared/validate.ts` の `validateCuts` は edit-pipeline.md / telop-style.md / format-patterns.md の規則をコード化。context（catalog / brief / spec / persona）が無いルールは `skipped` に列挙
- エンジン（`engine/src/`）。`shared/timeline.ts` はエンジンの `cutFrames` / `calcTotalFrames` / telopGroups と同一式で、テストで突合している
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

- Phase 1（済）：shared / core / CLI、hiro・--persona <人格id> スキル文書の Studio 連携モード
- Phase 2（済）：server（express :4310、SSE、静的配信）＋ GUI（Projects / Materials / Brief / Timeline+Player / Render）
- Phase 3（済）：ナレーション原稿（`ai-narration`）・編集・音声生成（`tts`）・mix・音量調整・キャプション（`ai-caption`）・効果音（`sfx-auto`）
- Phase 4（一部済）：複数案件の並行作業（タブごとの案件・ジョブの同時実行）。残り＝Tailscale 公開、インサイト記録、--persona <人格id> / bonjiri のスキル文書に Studio 連携モードを追記
- Phase 5（済・2026-09-14）：編集画面の統合（素材ビン｜プレビュー｜インスペクタ＋ V/T/N/S の 4 段タイムライン。cuts と narration を 1 画面で）、仕上げパイプライン（`build`：残っている工程だけを順に実行）、共通フックへの整理（設定・モデル選択・取り消し・ショートカット）
