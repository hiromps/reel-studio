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
  'trial',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

/**
 * ffmpeg / Remotion を回すジョブ。CPU とメモリを食い合うので**全体で 1 本だけ**にする
 * （このPCは空きメモリが少なく、レンダーを 2 本並べると落ちた実績がある）。
 * ここに無いもの（AI・音声生成）は待ち時間のほとんどが外部処理なので、案件をまたいで同時に動かしてよい。
 */
export const HEAVY_JOBS: ReadonlySet<JobType> = new Set<JobType>(['catalog', 'thumbs', 'proxy', 'preview-proxy', 'render', 'draft', 'still', 'qc-tile', 'mix', 'trial']);

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
