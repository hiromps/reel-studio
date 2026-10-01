# Neon から Supabase への移行（計画と手順）

クラウドモードの DB を **Neon から Supabase（Postgres）に移します**。アプリの作り（Drizzle ORM・
`cloud/store.ts` の SQL・スキーマ）はそのままで、変わるのは「どこに繋ぐか」と「どう繋ぐか」だけです。
Vercel Blob（サムネ・軽量プロキシ・完成動画）は Supabase に移しません。URL は変わらないので、
`assets` 表の索引を写せばそのまま見えます。

## 要点

| | Neon（いままで） | Supabase（これから） |
|---|---|---|
| ドライバ | `@neondatabase/serverless`（HTTP） | `postgres`（postgres.js、TCP） |
| Drizzle のアダプタ | `drizzle-orm/neon-http` | `drizzle-orm/postgres-js` |
| Vercel から繋ぐ先 | Neon の pooler | Supabase の **Transaction pooler**（Supavisor、ポート 6543） |
| 接続の作法 | — | `prepare: false`（トランザクションモードの約束）、関数 1 インスタンスにつき 1 本 |
| 環境変数 | `DATABASE_URL` | `DATABASE_URL`（Vercel の Supabase 連携が入れる `POSTGRES_URL` も読む） |
| スキーマ | `0001_init.sql` / `0002_push.sql` | 同じ ＋ `0003_supabase_rls.sql`（REST から見えないように RLS） |
| スキーマを当てる | setup の中だけ | `npm run cloud:migrate`（setup の中からも同じものを呼ぶ） |
| データを写す | — | `npm run cloud:copy-db`（または `pg_dump` → `psql`） |

`cloud/store.ts` や各ルータの SQL・ロジックは変えていません。生 SQL の結果の受け取り方だけ、
ドライバの違い（Neon は `{rows}`、postgres.js は配列）を `rowsOf()` で吸収しています。

### なぜ Supabase の REST を使わないのか

`cloud/store.ts` は Drizzle と生 SQL（UPSERT の `WHERE docs.rev = …` による楽観ロック、`row_number()` での
ログ末尾取得など）で書かれています。これを PostgREST（supabase-js）に置き換えると全部書き直しになり、
楽観ロックは RPC（SQL 関数）にしないと表現できません。Supabase は素の Postgres なので、
接続文字列で直接繋げば今のコードがそのまま動きます。Supabase 公式も Drizzle からは
pooler に `prepare: false` で繋ぐ案内をしています。

### Supabase ならではの注意 —— RLS

Supabase は `public` スキーマの表を REST（PostgREST）でも公開します。anon キーは画面に埋める性質のもので
秘密ではないため、**RLS が無い表は anon キーだけで読み書きできてしまいます**。
`0003_supabase_rls.sql` が全表で RLS を有効にし、`anon` / `authenticated` の権限を外します。
アプリは接続文字列（`postgres` ロール＝表の持ち主）で繋ぐので RLS の対象外、つまり今までどおり動きます。
ダッシュボードの Security Advisor の「RLS disabled」も消えます。

## 手順

### A. 新しく始める人（Neon を使っていなかった）

`npm run cloud:setup` を実行するだけです。5 番目のステップで Supabase の接続文字列を聞かれます。

1. https://supabase.com でプロジェクトを作る（リージョンは **Tokyo (ap-northeast-1)** が近い）。
   作成時に決める **Database Password** を控えておく
2. ダッシュボード上部の **Connect** → **Transaction pooler** の接続文字列をコピーする
   （`postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres`）
3. `[YOUR-PASSWORD]` を 1 で決めたパスワードに置き換えて貼り付ける
   （パスワードに `@` `#` `/` などが入っていたら URL エンコードする。例: `@` → `%40`）

### B. Neon で動いているデプロイを Supabase に移す

所要 10〜15 分。**PC のワーカーを止めてから**行います（ジョブの実行中にデータを写すと、写した後の
進捗が Neon 側にだけ書かれて消えるため）。

```bash
# 0. いまのブランチを最新にして依存を入れ直す（@neondatabase/serverless が消え、postgres が入る）
git pull
npm install

# 1. Supabase のプロジェクトを作り、Transaction pooler の接続文字列を得る（上の A-1〜3）
export SUPABASE_URL='postgresql://postgres.<ref>:<password>@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres'

# 2. スキーマを作る（0001 → 0002 → 0003 の順。冪等なので何度流してもよい）
npm run cloud:migrate -- "$SUPABASE_URL"

# 3. PC のワーカーを止める（Reel Studio の窓を閉じる。常駐させているならそれも止める）
#    スマホからもジョブを押さない。

# 4. データを写す。先に --dry-run で件数を見る
export NEON_URL='postgresql://…@….neon.tech/neondb?sslmode=require'
npm run cloud:copy-db -- --from "$NEON_URL" --to "$SUPABASE_URL" --dry-run
npm run cloud:copy-db -- --from "$NEON_URL" --to "$SUPABASE_URL"

# 5. Vercel の DATABASE_URL を差し替える（production / preview / development の 3 つ）
npx vercel env rm DATABASE_URL production -y
printf '%s' "$SUPABASE_URL" | npx vercel env add DATABASE_URL production
#   preview / development も同じように

# 6. 新しいコードを本番に出す（ここで初めて Supabase に繋ぐ）
npm run cloud:deploy

# 7. 確かめる（下の「確認」）。問題なければ PC のワーカーを起動し直す
```

`psql` が入っている PC なら、4 は次でも同じです（こちらは表の作成ごと持っていくので 2 は不要。
ただし 0003 は別途 `npm run cloud:migrate` で当てる）:

```bash
pg_dump "$NEON_URL" --data-only --no-owner --no-privileges \
  -t projects -t docs -t jobs -t job_logs -t assets -t personas -t kv -t push_subs \
  | psql "$SUPABASE_URL"
```

### 確認

- `npm run cloud:copy-db -- … --dry-run` をもう一度流し、Neon 側の件数が写し先と合うこと
  （写し先の件数は Supabase ダッシュボードの Table Editor でも見える）
- スマホで画面を開き、ログインできて案件の一覧が出ること（= `projects` / `docs` が読めている）
- Settings で「PC 接続中」になること（= ワーカーが `/api/worker/*` で `kv` を書けている）
- 軽いジョブ（例: タグ付け）を 1 つ流し、ログが出て完了すること（= `jobs` / `job_logs` の読み書き）
- Supabase ダッシュボードの **Advisors → Security** に「RLS disabled in public」が出ていないこと

### 戻すとき（ロールバック）

Neon 側は消していないので、Vercel の `DATABASE_URL` を Neon の文字列に戻して
`npm run cloud:deploy` すれば元に戻ります。新しいコード（postgres.js）は Neon にもそのまま繋がります
（`sslmode=require` が付いていれば TLS、`channel_binding` は落とします）。
移行後に Supabase 側で進んだデータは Neon には無いので、戻すのは「切り替えてすぐ」に限ってください。

### Neon を閉じる

1〜2 週間ふつうに使えたら、Neon のプロジェクトを削除します（請求を止めるため）。
削除する前に `pg_dump "$NEON_URL" > neon-final.sql` を 1 本残しておくと安心です。

## コードの変更点（この移行で触ったところ）

| ファイル | 変更 |
|---|---|
| `cloud/db/client.ts` | postgres.js ＋ `drizzle-orm/postgres-js`。接続文字列の正規化（`pgbouncer=true` など Postgres が受け取れないパラメータを落とす）、`prepare: false`、`max: 1`、`rowsOf()` |
| `cloud/store.ts` | 生 SQL の結果を `rowsOf()` で受ける（2 か所）。`failStaleJobs` の生 SQL に Date を直接渡していた箇所を ISO 文字列＋`::timestamptz` に（postgres.js ドライバでは列を通らない Date は送れない）。SQL の意味は変えていない |
| `cloud/db/migrations/0003_supabase_rls.sql` | 全表で RLS 有効化、anon / authenticated の権限を外す |
| `scripts/cloud-migrate.mjs` | migration を当てる（`npm run cloud:migrate`）。setup も内部でこれを呼ぶ |
| `scripts/cloud-copy-db.mjs` | 別の Postgres から全表を UPSERT で写す（`npm run cloud:copy-db`） |
| `scripts/cloud-setup.mjs` | ステップ 5 の案内を Supabase に。接続文字列の `[YOUR-PASSWORD]` 残りやポートを確かめる |
| `package.json` | `@neondatabase/serverless` を外し `postgres` を追加 |
| `docs/cloud.md` / `README.md` | Neon の記述を Supabase に |

## 触っていないもの・あとで考えるもの

- **Vercel Blob はそのまま**。Supabase Storage に移すことはできるが、`cloud/blob.ts` と
  ワーカーのアップロード経路（`worker/sync.ts`）の書き直しになる。費用や保存量で困ってから検討する
- **認証はそのまま**（自分用のパスワード 1 つ＋Cookie）。Supabase Auth には乗せていない
- **Realtime は使わない**。SSE は今までどおり `docs.updated_at` のポーリング
- Supabase 無料枠は **1 週間使われないとプロジェクトが一時停止**する（ダッシュボードから再開できる）。
  使う頻度が低いなら Pro（$25/月）か、止まったら起こす運用にする
