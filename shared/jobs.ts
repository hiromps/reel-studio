// ジョブ種別と、同時に走らせてよいかの判定。純粋なので画面からもサーバーからも使う。
// 実行そのものは server/jobs.ts。

/** ジョブ種別の唯一の定義。サーバーの受け口も GUI のボタンもこれを見る（二重管理にしない） */
export const JOB_TYPES = [
  'catalog',
  'thumbs',
  'proxy',
  'preview-proxy',
  'render',
  'draft',
  'still',
  'qc-tile',
  'sync-engine',
  'npm-install',
  'aliases',
  'mix',
  'ai-tag',
  'ai-order',
  'ai-telop',
  'ai-edit',
  'ai-narration',
  'ai-caption',
  'ai-facts',
  'ai-script',
  'tts',
  'sfx-scan',
  'sfx-auto',
  'deliver',
  'ai-hooks',
  /** 参考動画（他の人のバズったリール）を取り込んで型を分析する → reference.json */
  'ai-reference',
  /** 分析した型を写した台本（script.md）を書き、そのまま「台本から組み立てる」まで行う */
  'ai-mimic',
  'trial',
  'winner',
  'build',
  'mosaic',
  'mosaic-revert',
  'mosaic-setup',
  // ── クラウド（PWA）から使うときだけ出るもの。ローカル単体では投げられない ──
  /** 案件フォルダを PC に作る（複製も含む）。画面の「案件を作る」がこれを積む */
  'create-project',
  /** スマホから上げた素材を PC の uploads/ に取り込む */
  'ingest',
  /** タグ・slug の取り込み（slug 変更は実ファイルのリネームを伴うので PC でしかできない） */
  'catalog-import',
  /** スマホから上げたテロップ用フォントを PC の置き場に入れる／置き場から消す */
  'fonts',
  /**
   * 「最新に」ボタン。PC の案件フォルダとクラウドをその場で突き合わせる。
   * 棚卸し（5 分ごと）を待たずに、PC で直したキャプション・構成・書き出しをスマホへ出すためのもの。
   * 中身は空で、ワーカーがジョブの前後で必ず行う同期（syncDocs / pushAfterJob）が本体。
   */
  'sync',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

/**
 * ffmpeg / Remotion を回すジョブ。CPU とメモリを食い合うので**全体で 1 本だけ**にする
 * （このPCは空きメモリが少なく、レンダーを 2 本並べると落ちた実績がある）。
 * ここに無いもの（AI・音声生成）は待ち時間のほとんどが外部処理なので、案件をまたいで同時に動かしてよい。
 * build はレンダーと mix を含むので重い扱い。winner（二次活用）もレンダー・mix・ffmpeg の倍速を含む。
 * mosaic は顔検出（GPU/CPU）と ffmpeg の再エンコード、mosaic-revert はサムネの作り直し。
 * mosaic-setup は mosaic が使っている venv を入れ替えるので、同時に走らせない。
 */
export const HEAVY_JOBS: ReadonlySet<JobType> = new Set<JobType>([
  'catalog',
  'thumbs',
  'proxy',
  'preview-proxy',
  'render',
  'draft',
  'still',
  'qc-tile',
  'mix',
  'trial',
  'winner',
  'build',
  'mosaic',
  'mosaic-revert',
  'mosaic-setup',
  // 素材の取り込みは大きなファイルのダウンロードとコピーを伴う
  'ingest',
]);

/** 案件に属さないジョブ（案件を開いていなくても投げられる） */
export const PROJECTLESS_JOBS: ReadonlySet<JobType> = new Set<JobType>(['mosaic-setup', 'fonts']);

export const isHeavyJob = (type: string): boolean => HEAVY_JOBS.has(type as JobType);

/** 判定に必要な最小限（テストしやすいように Job 全体を要求しない） */
export type Schedulable = {slug: string; type: string};

/**
 * 複数案件を並行して進められるように、**案件が違えば同時に走らせる**。ただし
 *   - 同じ案件で 2 本は走らせない（同じ契約ファイルを取り合うため）
 *   - 重いジョブは全体で 1 本だけ
 *   - 全体で maxConcurrent 本まで
 */
export const canStartJob = (job: Schedulable, running: readonly Schedulable[], maxConcurrent: number): boolean => {
  if (running.length >= maxConcurrent) return false;
  if (running.some((r) => r.slug === job.slug)) return false;
  if (isHeavyJob(job.type) && running.some((r) => isHeavyJob(r.type))) return false;
  return true;
};
