// 裏で走っているジョブ（AI・音声生成・仕上げ）の進捗カード。
// 「動いているのか止まっているのか」が一目で分かるように、経過秒・段階・最後に反応があってからの秒数・直近のログを出す。
import React, {useEffect, useRef, useState} from 'react';
import type {Job} from '../api';
import {useStudio} from '../state/store';

export const AI_JOB_LABEL: Record<string, string> = {
  'ai-telop': 'AI がテロップを作成中',
  'ai-order': 'AI が並べ替え中',
  'ai-edit': 'AI が修正中',
  'ai-tag': 'AI がタグ付け中',
  'ai-narration': 'AI がナレーション原稿を作成中',
  'ai-caption': 'AI がキャプションを作成中',
  'ai-facts': 'AI が店舗情報を裏取り中',
  'ai-script': 'AI が台本から組み立て中',
  'ai-hooks': 'AI がトライアル用のフック案とキャプションを作成中',
  winner: '二次活用版を作成中（レンダー→音声→mix→倍速）',
  build: '仕上げを実行中',
  tts: '音声を生成中',
  mosaic: '顔にモザイクをかけています（deface）',
  'mosaic-revert': 'モザイクを外しています',
  'mosaic-setup': 'deface を導入中',
  fonts: 'フォントを PC に取り込み中',
  sync: 'PC と同期中',
};

/** これ以上反応が無いと「止まっているかも」と出す秒数（heartbeat は 5 秒ごとに来る） */
const STALL_SEC = 90;

const elapsedOf = (job: Job): number => (job.startedAt ? Math.max(0, Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000)) : 0);
const fmt = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)}分${String(sec % 60).padStart(2, '0')}秒` : `${sec}秒`);

export const AiJobStatus: React.FC<{job: Job | undefined; onCancel: (id: string) => void; compact?: boolean; lines?: number}> = ({job, onCancel, compact, lines = 3}) => {
  const s = useStudio();
  // 走っている間だけ 1 秒ごとに描き直して経過秒を進める
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!job) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [job?.id]);

  // サーバーから何か（進捗・ログ）が届くたびに時刻を覚えておき、「最後の反応から何秒か」を出す
  const log = job ? (s.logs[job.id] ?? job.logTail ?? []) : [];
  const signature = job ? `${job.status}|${job.progress?.phase ?? ''}|${job.progress?.done ?? ''}|${log.length}|${log[log.length - 1] ?? ''}` : '';
  const lastSeen = useRef<{sig: string; at: number}>({sig: '', at: Date.now()});
  if (signature !== lastSeen.current.sig) lastSeen.current = {sig: signature, at: Date.now()};
  useEffect(() => {
    lastSeen.current = {sig: signature, at: Date.now()};
    // ジョブが変わったら計り直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  if (!job) return null;
  const el = elapsedOf(job);
  const sinceSec = Math.round((Date.now() - lastSeen.current.at) / 1000);
  const queued = job.status === 'queued';
  const determinate = !!job.progress && job.progress.total > 0;
  const stalled = !queued && sinceSec >= STALL_SEC;
  const pct = determinate ? Math.min(100, (100 * job.progress!.done) / job.progress!.total) : 0;

  return (
    <div className={`card ai-running${compact ? ' compact' : ''}${stalled ? ' stalled' : ''}`}>
      <div className="summary" style={{marginBottom: 4}}>
        <span className={`live-dot${stalled ? ' stalled' : queued ? ' queued' : ''}`} title={stalled ? `${fmt(sinceSec)} 反応がありません` : '動いています'} />
        <span className="pill run">{AI_JOB_LABEL[job.type] ?? job.type}</span>
        <span>
          <b>{queued ? '順番待ち（前のジョブが終わると始まります）' : (job.progress?.phase ?? 'claude を起動しています…')}</b>
        </span>
        <span className="hint">{fmt(el)} 経過</span>
        <span className={`hint${stalled ? ' warn-text' : ''}`} title="サーバーから進捗かログが届いてからの秒数。5 秒ごとに heartbeat が来るので、普段は 10 秒以内です">
          {stalled ? `⚠ ${fmt(sinceSec)} 反応なし（止まっている可能性。中止して再実行を検討）` : `最終反応 ${sinceSec} 秒前`}
        </span>
        <span style={{flex: 1}} />
        <button className="small" onClick={() => onCancel(job.id)}>
          中止
        </button>
      </div>
      <div className={`progress${determinate ? '' : ' indeterminate'}`} title={determinate ? `${job.progress!.done} / ${job.progress!.total}` : '数えられる作業が無いので、動いていることだけ示しています'}>
        <div style={determinate ? {width: `${pct}%`} : undefined} />
      </div>
      <div className="hint" style={{marginTop: 2}}>
        {determinate ? `${job.progress!.done} / ${job.progress!.total}` : '進捗は数えられない工程です（AI が考えている間）。上の段階と経過秒、下のログが更新されていれば動いています'}
      </div>
      {log.length > 0 && (
        <div className="ai-log">
          {log.slice(-lines).map((l, i) => (
            <div key={i} className="mono-ellipsis">
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
