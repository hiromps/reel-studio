# Reel Studio への協力

不具合の報告・要望・プルリクエストを歓迎します。個人開発のため、返信や取り込みに時間がかかることがあります。

## Issue

- 不具合・要望は [Issue](https://github.com/hiromps/reel-studio/issues/new/choose) のテンプレートから
- **API キー・素材動画・店舗の非公開情報は貼らないでください**（Issue は誰でも読めます）
- 脆弱性は Issue ではなく [SECURITY.md](SECURITY.md) の方法で

## 開発の始め方

必要なものは [README の「必要なもの」](README.md#必要なもの) と同じです（Node.js 20 以上・ffmpeg / ffprobe・Claude Code）。

```bash
git clone https://github.com/hiromps/reel-studio.git
cd reel-studio
npm install
npm run server      # API サーバー（:4310）
npm run dev         # 画面（Vite :5173、HMR）
```

設定と人格は `~/.reel-studio/`、案件データはデータフォルダ（既定はリポジトリ内の `data/`、gitignore 済み）に置かれます。
開発用に分けたいときは `REEL_STUDIO_HOME` と `REEL_STUDIO_DATA_ROOT` を別の場所に向けてください。

## ディレクトリ

| 場所 | 中身 |
|---|---|
| `shared/` | 画面・サーバー・クラウドで共有する純粋なロジック（fs に依存しない）とスキーマ（zod） |
| `core/` | ファイル・ffmpeg・Claude Code を扱う処理（ジョブの本体） |
| `cli/` `bin/` | CLI（`bin/reel`） |
| `server/` | ローカルの API サーバー（express） |
| `src/` | 画面（React + Vite） |
| `engine/` | 案件に複製される Remotion プロジェクトの原本（[engine/README.md](engine/README.md)） |
| `cloud/` `api/` `worker/` | クラウドモード（Vercel の API と自宅 PC のワーカー。[docs/cloud.md](docs/cloud.md)） |
| `test/` | vitest |

## プルリクエスト

1. `main` からブランチを切る
2. 変更したら **`npm run ci`**（型検査・テスト・ビルド）を通す。CI（GitHub Actions）も同じものを Linux で走らせます
3. ロジックを変えたら `test/` にテストを足す。判定・検算のような純粋な処理は `shared/` に置いてテストする
4. 利用者に見える変更は `CHANGELOG.md` の「未リリース」に、**使う人の言葉で**追記する
5. 画面の文言は日本語。コードのコメントも日本語で、周りの書き方に合わせる

### 気をつけること

- **素材・音源をコミットしない** — `work/` `uploads/` `outputs/` `sfx/` は gitignore 済み。効果音ラボなどの音源は再配布禁止です
- **フォントを足すときはライセンスを確認** — 同梱してよいのは再配布が許されたもの（例: SIL OFL）だけ。ライセンス文も一緒に置く
- **AI に課金が発生するテスト** — テストから実際に `claude` や Fish Audio を呼ばない（呼び出しは差し替えて検証する）
- **Remotion のライセンス** — 協力する人自身が Remotion を使う場合も [remotion.dev/license](https://www.remotion.dev/license) に従ってください

提出されたコードは、このリポジトリと同じ [MIT ライセンス](LICENSE)で公開されます。
