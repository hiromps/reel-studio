// 裏で走っている AI ジョブの進捗（経過秒・段階・進捗バー・中止）。編集画面と Render で共用。
import React, {useEffect, useState} from 'react';
import type {Job} from '../api';

export const AI_JOB_LABEL: Record<string, string> = {
  'ai-telop': 'AI がテロップを作成中',
  'ai-order': 'AI が並べ替え中',
  'ai-edit': 'AI が修正中',
  'ai-tag': 'AI がタグ付け中',
  'ai-narration': 'AI がナレーション原稿を作成中',
  'ai-caption': 'AI がキャプションを作成中',
  'ai-facts': 'AI が店舗情報を裏取り中',
  'ai-script': 'AI が台本から組み立て中',
  build: '仕上げを実行中',
  tts: '音声を生成中',
};

const elapsedOf = (job: Job): number => (job.startedAt ? Math.max(0, Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000)) : 0);

export const AiJobStatus: React.FC<{job: Job | undefined; onCancel: (id: string) => void; compact?: boolean}> = ({job, onCancel, compact}) => {
  // 走っている間だけ 1 秒ごとに描き直して経過秒を進める
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!job) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [job?.id]);
  if (!job) return null;
  const el = elapsedOf(job);
  const determinate = !!job.progress && job.progress.total > 0;
  return (
    <div className={`card ai-running${compact ? ' compact' : ''}`}>
      <div className="summary" style={{marginBottom: 4}}>
        <span className="pill run">{AI_JOB_LABEL[job.type] ?? job.type}</span>
        <span>
          <b>{job.status === 'queued' ? '順番待ち' : (job.progress?.phase ?? '起動中…')}</b>
        </span>
        <span className="hint">
          {Math.floor(el / 60)}分{String(el % 60).padStart(2, '0')}秒 経過
        </span>
        <span style={{flex: 1}} />
        <button className="small" onClick={() => onCancel(job.id)}>
          中止
        </button>
      </div>
      <div className={`progress${determinate ? '' : ' indeterminate'}`}>
        <div style={determinate ? {width: `${Math.min(100, (100 * job.progress!.done) / job.progress!.total)}%`} : undefined} />
      </div>
      {determinate && (
        <div className="hint" style={{marginTop: 2}}>
          {job.progress!.done} / {job.progress!.total}
        </div>
      )}
      {(job.logTail ?? []).slice(-1).map((l, i) => (
        <div key={i} className="hint mono-ellipsis">
          {l}
        </div>
      ))}
    </div>
  );
};
