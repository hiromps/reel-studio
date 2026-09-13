// Reel Studio の唯一の設定箇所。パスはすべてここから導出する。
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const studioConfig = {
  /** リポジトリのルート（Gourmet-short-video） */
  repoRoot: path.resolve(here, '..', '..'),
  /** 案件フォルダの親（work/<slug>-reel/） */
  workDir: path.resolve(here, '..', '..', 'work'),
  /** 生素材の置き場（uploads/<店名>/） */
  uploadsRoot: path.resolve(here, '..', '..', 'uploads'),
  /** Remotion マスターテンプレート（hiro-daihon が正） */
  templateDir: path.resolve(here, '..', '..', '.claude', 'skills', 'hiro-daihon', 'assets', 'remotion-template'),
  /**
   * 人格の既定ボイス（shared/personas.ts）以外に、選べるようにしておきたいボイス。
   * **他人の公開モデルは Fish Audio の `GET /model?self=true` に出てこない**ので、
   * ここに書かないと GUI のボイス一覧に現れない。title はここに書いた名前が優先される
   * （Fish Audio 側の題名より、こちらで付けた呼び名の方が分かりやすいため）。
   */
  voices: [
    {id: '86ed1bd268b34740b4bdce6120745e06', title: '大阪グルメボイス'},
  ] as {id: string; title: string; note?: string}[],
  /** 効果音ライブラリ（効果音ラボ等）。素材の再配布は禁止なので .gitignore 済み */
  sfxDir: path.resolve(here, '..', '..', 'sfx'),
  /** 納品先 */
  outputsDir: path.resolve(here, '..', '..', 'outputs'),
  /** サーバーのポート */
  port: 4310,
  /** 案件フォルダの命名（<slug>-reel） */
  projectSuffix: '-reel',
  /** 案件内の派生物ディレクトリ */
  studioDirName: '.studio',
  /** ジョブキュー。案件をまたいだ並行作業のため、条件つきで同時実行する（server/jobs.ts の canStart） */
  jobs: {
    /** 同時に走らせる上限。重いジョブ（ffmpeg / Remotion）はこの値に関わらず全体で 1 本 */
    maxConcurrent: Number(process.env.REEL_STUDIO_JOB_CONCURRENCY ?? 2),
  },
  /** 裏で走らせる Claude Code CLI（タグ付け・並べ替えの代行） */
  agent: {
    /** --model に渡す値。エイリアス（opus / sonnet / haiku）でも完全な id でもよい */
    model: process.env.REEL_STUDIO_AGENT_MODEL ?? 'opus',
    /** タグ付け 1 回で見せるクリップ数。多いと 1 回が長くなり、失敗時に巻き戻る範囲も広がる */
    tagBatchSize: Number(process.env.REEL_STUDIO_TAG_BATCH ?? 8),
    /** タグ付けを何本並列で走らせるか。1 バッチ 2〜6 分かかるので効き方が大きい（claude 1 本あたり数百 MB） */
    tagConcurrency: Number(process.env.REEL_STUDIO_TAG_CONCURRENCY ?? 3),
    /** 1 回あたりの上限時間 */
    timeoutMs: 20 * 60_000,
  },
} as const;

export type StudioConfig = typeof studioConfig;
