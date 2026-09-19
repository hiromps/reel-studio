# クラウドモード（スマホの PWA ＋ 自宅 PC ワーカー）

Reel Studio を **スマホから全機能使えるようにする**ための構成です。ローカル専用の使い方
（`npm start`）は今までどおり動きます。クラウドモードは置き換えではなく追加です。

```
[スマホ / PC のブラウザ]
        │  HTTPS（Cookie 認証・パスワード 1 つ）
        ▼
[Vercel]  画面（PWA）＋ API
        │  Neon（案件・契約ファイル・ジョブ）／Vercel Blob（サムネ・軽量プロキシ・完成動画）
        ▲
        │  ポーリング（**PC からの発信だけ**。PC のポートは開けない）
        │
[自宅 PC]  npm run worker
        ffmpeg・Remotion・Claude Code CLI を実行 ／ work/ uploads/ outputs/ は PC の中
```

## なぜこの形か

Vercel の Functions では ffmpeg による 4K 素材の変換も Remotion（Chrome Headless）のレンダーも
実行できません（実行時間・バンドルサイズ・読み取り専用のファイルシステム）。
重い処理は必ず Vercel の外に出す必要があるので、**自宅の PC をワーカーにしています**。

この形の良いところ:

- **AI の追加課金が無い** — タグ付け・テロップ・原稿・キャプションは今までどおり、PC の
  ログイン済み Claude Code CLI が動きます（API キーを別に買う必要がない）
- **Remotion もローカル実行のまま** — ライセンス上の扱いが変わらない
- **4K 素材の転送量がかからない** — 原本は PC に置いたまま。クラウドに載るのはサムネと
  軽量プロキシ（540x960）と完成動画だけ

代わりの制約:

- **PC の電源が入っていないとジョブが実行されません。** 押したジョブはキューに残り、PC が
  起きると順に実行されます（画面上部に「PC オフライン」と出ます）
- スマホで再生できるのは軽量プロキシがあるクリップだけです（Timeline に作成状況が出ます）

## 何がどこにあるか

| 種類 | 置き場 | 正 |
|---|---|---|
| 案件・契約ファイル（catalog / brief / cuts / narration / caption / script / hooks） | Neon（`docs` テーブル） | **クラウド** |
| ジョブとログ | Neon（`jobs` / `job_logs`） | クラウド |
| 人格・設定・効果音の一覧 | Neon（`personas` / `kv`） | クラウド（PC に反映される） |
| サムネ・ストリップ・軽量プロキシ・完成動画・ナレーション音声 | Vercel Blob（`assets` テーブルが索引） | PC（生成元） |
| **原本の素材（4K）** | PC の `uploads/` | PC のみ。クラウドには上げない |
| Remotion プロジェクト（`work/<slug>-reel/`） | PC | PC のみ |

契約ファイルはクラウドを正にしていますが、PC 側のローカル GUI でも編集できます。
ワーカーが双方向に同期し、**両方が変わっていたらクラウドを採って PC 側の版を
`<案件>/.studio/conflicts/` に残します**（消えはしません）。

## 作り方

### 1. Neon（Postgres）

```bash
# プロジェクトを作って接続文字列を得る（Neon のコンソール、または MCP / CLI）
# スキーマは cloud/db/migrations/0001_init.sql を適用する
psql "$DATABASE_URL" -f cloud/db/migrations/0001_init.sql
```

### 2. Vercel

```bash
npx vercel link              # プロジェクトを作って紐づける
npx vercel blob create-store reel-studio-media
# 作った Blob ストアをプロジェクトに接続する（BLOB_READ_WRITE_TOKEN が自動で入る）
npx vercel api "/v1/storage/stores/<storeId>/connections?teamId=<teamId>" -X POST \
  --input connect.json   # {"projectId":"<prj_...>","envVarEnvironments":["production","preview","development"]}
```

**デプロイ保護（SSO）は切ってください。** 有効なままだと、スマホからも PC のワーカーからも
Vercel のログイン画面に弾かれます。

### 3. 環境変数（Vercel）

| 変数 | 作り方 |
|---|---|
| `DATABASE_URL` | Neon の接続文字列（pooler のもの） |
| `AUTH_PASSWORD_HASH` | `node scripts/hash-password.mjs` の出力（`scrypt$…`） |
| `AUTH_JWT_SECRET` | 32 文字以上のランダム文字列（`openssl rand -base64 48`） |
| `WORKER_TOKEN` | ランダム文字列。PC のワーカーと同じ値にする |
| `BLOB_READ_WRITE_TOKEN` | Blob ストアを接続すると自動で入る |
| `FISH_API_KEY`（任意） | 音声のボイス一覧と試聴をクラウドから使う場合。生成そのものは PC が行う |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`（任意） | 通知を使う場合。`node -e "console.log(JSON.stringify(require('web-push').generateVAPIDKeys()))"` |
| `VAPID_SUBJECT`（任意） | 通知の連絡先。`mailto:you@example.com` |

```bash
npx vercel deploy --prod
```

### 4. PC 側（ワーカー）

GUI の Settings「クラウド接続」で入れるか、コマンドで入れます（どちらも
`~/.reel-studio/settings.json` の `cloud` に入ります。他の設定には触りません）。

```bash
node scripts/set-cloud.mjs https://<あなたのアプリ>.vercel.app <WORKER_TOKEN と同じ値>
npm run worker
```

繋ぐのを一時的にやめるなら `node scripts/set-cloud.mjs --off`。
`reel settings show` の最終行に、いまの接続先が出ます。

起動すると `ffmpeg=ok claude=ok 案件=N 件` と出て、クラウドに繋がります。
画面の `/api/config` の `worker.online` が `true` になれば通っています。

環境変数で渡す場合は `REEL_CLOUD_URL` と `REEL_WORKER_TOKEN`（設定ファイルより優先）。

#### Windows で常駐させる

タスクスケジューラで「ログオン時に起動」にするのが簡単です（コマンドプロンプトで 1 行）。

```bat
schtasks /Create /TN "Reel Studio Worker" /SC ONLOGON /RL LIMITED /F /TR "cmd /c cd /d C:\path\to\reel-studio && npm run worker"
```

スリープすると止まります（ジョブは消えず、復帰後に続きます）。レンダー中に寝ないよう、
電源設定を見直してください。

## ワーカーの動き

1. `POST /api/worker/hello` — 生きていることと環境（ffmpeg / claude / 空きメモリ）を送り、
   Blob の書き込みトークンと「PC に反映すべき変更」（設定・人格・効果音）を受け取る
2. `POST /api/worker/claim` — 始められるジョブを 1 つもらう。同時実行の可否は
   ローカル版と同じ `canStartJob`（`shared/jobs.ts`）で判定される
3. ジョブ実行 — 実体は `server/jobs.ts` の `runJobBody`（ローカル版とまったく同じコード）
4. 進捗・ログを 1.2 秒ごとに送る。返りの `cancelRequested` が立っていたら自分で中断する
5. 終わったら契約ファイルを書き戻し、生成物（サムネ・軽量プロキシ・完成動画）を Blob に上げる

間隔はアイドル 15 秒 / 稼働中 3 秒。5 分ごとに全案件の棚卸し（同期）を行います。

## 通知（レンダーが終わったら知らせる）

レンダーや仕上げは 10 分以上かかることがあるので、終わったらスマホに通知を出せます
（失敗したときは必ず出ます）。Settings の「通知」で端末ごとに有効にします。

- **iPhone / iPad は「ホーム画面に追加」した PWA からでないと届きません**（iOS 16.4 以降）。
  Safari のタブで開いたままでは受け取れません
- 通知を出すのは時間のかかるジョブだけです（レンダー・仕上げ・合成・納品・カタログ化・
  顔モザイク・素材の取り込み・音声生成・AI 各種）。一瞬で終わるものでは鳴りません
- 実体は Web Push（VAPID）。鍵が未設定なら機能そのものが画面に出ません
- 端末を機種変更したり通知を切ったりすると購読が失効します。失効したものは送信時に自動で消えます

## クラウドでは使えないもの

| もの | 理由と代わり |
|---|---|
| フォルダ選択ダイアログ（📂 参照…） | PC のダイアログは開けない。パスを手で入力するか、スマホから動画を上げる |
| 並べ替え用の書き出し（order/export） | 手元の claude に読ませるためのファイル出力。PC の Reel Studio で行う |
| カット頭のフレーム切り出し（ffmpeg） | 代わりに catalog のストリップ（1 秒刻みの静止画）から一番近いコマを返す |

## 費用のめやす

- **Neon** — 契約ファイルとジョブだけなので数 MB。無料枠で足りる
- **Vercel Blob** — 軽量プロキシが 1 案件あたり 50〜200MB。案件が増えたら古いものを消す
  （消しても PC に原本があるので、`preview-proxy` ジョブで作り直せる）
- **Vercel Functions** — SSE は 55 秒で切って繋ぎ直す形。画面を開いている間だけ動く
- **AI** — PC の Claude Code をそのまま使うので、クラウド化による追加課金は無い

## 気をつけること

- **メディアの URL は推測困難なランダム URL による保護**です（Blob のプライベート配信には
  制限があるため）。URL を知られると中身は見られます
- ログインは自分専用の 1 アカウント（パスワード 1 つ）。パスワードを変えるときは
  `node scripts/hash-password.mjs` で作り直して `AUTH_PASSWORD_HASH` を差し替え、再デプロイ
- `Vercel Hobby` プランは商用利用不可です。仕事で使うなら Pro のチームに置いてください

## 困ったとき

| 症状 | 見るところ |
|---|---|
| ジョブが `queued` のまま | PC のワーカーが動いているか（画面上部の「PC オフライン」） |
| Timeline の映像が真っ黒 | 軽量プレビューが未作成。Timeline 上部の「軽量プレビューを作る」 |
| 「PC のワーカーがまだ繋がっていません」 | `npm run worker` のログ。`WORKER_TOKEN` の食い違いなら 401 が出る |
| ジョブが「ワーカーとの通信が途切れました」で失敗 | PC がスリープした。押し直せば再実行される |
| デプロイした関数が 500 | `npx vercel logs <url>`。`api/_app.cjs` が生成されているか（`npm run build`） |
| 通知が来ない | iPhone はホーム画面から開いているか。Settings の「テスト送信」で `sent` が 1 以上か |
