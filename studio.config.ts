// Reel Studio の設定の入口。固定値はここ、可変値（フォルダ・鍵・claude）は core/settings.ts
// （REEL_STUDIO_HOME ?? ~/.reel-studio/settings.json）。getter なので呼ぶたびに設定を引き、
// 保存後は resetSettings() だけで全 call site に効く。優先順位は 環境変数 > settings.json > 既定。
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadSettings, resolvedPaths} from './core/settings';

const here = path.dirname(fileURLToPath(import.meta.url));

export const studioConfig = {
  /** アプリ（このリポジトリ）のルート */
  appRoot: here,
  /** 同梱の Remotion エンジン。案件はここから複製・同期される */
  templateDir: path.join(here, 'engine'),
  /** ナレーション合成スクリプト（CommonJS。パッケージが ESM なので .cjs） */
  mixScript: path.join(here, 'scripts', 'mix-narration.cjs'),
  /** 案件・素材・納品・効果音の親（既定 <appRoot>/data） */
  get dataRoot(): string {
    return resolvedPaths().dataRoot;
  },
  /** 案件フォルダの親（work/<slug>-reel/） */
  get workDir(): string {
    return resolvedPaths().workDir;
  },
  /** 生素材の置き場（uploads/<店名>/） */
  get uploadsRoot(): string {
    return resolvedPaths().uploadsRoot;
  },
  /** 納品先 */
  get outputsDir(): string {
    return resolvedPaths().outputsDir;
  },
  /** 効果音ライブラリ（効果音ラボ等）。素材の再配布は禁止なのでリポジトリには入れない */
  get sfxDir(): string {
    return resolvedPaths().sfxDir;
  },
  /**
   * 人格の既定ボイス以外に、選べるようにしておきたいボイス（Settings「音声生成」の追加ボイス）。
   * **他人の公開モデルは Fish Audio の `GET /model?self=true` に出てこない**ので、
   * ここに無いと GUI のボイス一覧に現れない。title はここで付けた名前が優先される
   */
  get voices(): {id: string; title: string; note?: string}[] {
    return loadSettings().tts.voices;
  },
  /** サーバーのポート */
  port: 4310,
  /** 案件フォルダの命名（<slug>-reel） */
  projectSuffix: '-reel',
  /** 案件内の派生物ディレクトリ */
  studioDirName: '.studio',
  /** ジョブキュー。案件をまたいだ並行作業のため、条件つきで同時実行する（server/jobs.ts の canStart） */
  jobs: {
    /** 同時に走らせる上限。重いジョブ（ffmpeg / Remotion）はこの値に関わらず全体で 1 本 */
    get maxConcurrent(): number {
      return Number(process.env.REEL_STUDIO_JOB_CONCURRENCY ?? 2);
    },
  },
  /** 裏で走らせる Claude Code CLI（タグ付け・並べ替えの代行） */
  agent: {
    /** --model に渡す値。エイリアス（opus / sonnet / haiku）でも完全な id でもよい */
    get model(): string {
      return process.env.REEL_STUDIO_AGENT_MODEL ?? loadSettings().agent.model;
    },
    /** タグ付け 1 回で見せるクリップ数。多いと 1 回が長くなり、失敗時に巻き戻る範囲も広がる */
    get tagBatchSize(): number {
      return Number(process.env.REEL_STUDIO_TAG_BATCH ?? loadSettings().agent.tagBatchSize);
    },
    /** タグ付けを何本並列で走らせるか。1 バッチ 2〜6 分かかるので効き方が大きい（claude 1 本あたり数百 MB） */
    get tagConcurrency(): number {
      return Number(process.env.REEL_STUDIO_TAG_CONCURRENCY ?? loadSettings().agent.tagConcurrency);
    },
    /** 1 回あたりの上限時間 */
    get timeoutMs(): number {
      return loadSettings().agent.timeoutMin * 60_000;
    },
  },
};

export type StudioConfig = typeof studioConfig;
