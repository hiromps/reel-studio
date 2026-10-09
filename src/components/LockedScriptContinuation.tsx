import React, {useEffect, useRef, useState} from 'react';
import {useStudio} from '../state/store';
import {api, type Job} from '../api';
import {useStringPref} from '../hooks/usePref';
import {scriptTextConfirmation, type ScriptTextConfirmation} from '@shared/script-text';

/** 旧版でロックエラーになった台本も、再作成せずこの確認から再開できる。 */
export const LockedScriptContinuation: React.FC = () => {
  const s = useStudio();
  return s.active ? <LockedProjectContinuation key={s.active} /> : null;
};

const LockedProjectContinuation: React.FC = () => {
  const s = useStudio();
  const [dismissed, setDismissed] = useStringPref('reel-studio.locked-text-dismissed.' + (s.active ?? ''), '');
  const source = s.jobs.find(j => j.slug === s.active && ['ai-mimic', 'ai-script-draft', 'ai-script'].includes(j.type));
  const pending = source && ((source.status === 'done' && !!source.result?.textConfirmation) || (source.status === 'failed' && source.error?.includes('並び順がロック')));
  const continued = source && s.jobs.some(j => j.slug === s.active && j.type === 'ai-script-text' && j.params.fromJob === source.id && ['queued', 'running', 'done'].includes(j.status));
  if (!s.active || !s.files.cuts.data?.meta?.orderLocked || !source || !pending || continued) return null;
  if (dismissed === source.id) return <div className="locked-text-reminder card"><span>台本は保存済みです。今の並びでテロップとナレーション原稿を生成できます。</span><button onClick={() => setDismissed('')}>生成するか確認</button></div>;
  return <LockedTextDialog key={s.active + source.id} source={source} onDismiss={() => setDismissed(source.id)} />;
};

const LockedTextDialog: React.FC<{source: Job; onDismiss: () => void}> = ({source, onDismiss}) => {
  const s = useStudio();
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirmation, setConfirmation] = useState<ScriptTextConfirmation | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const cuts = s.files.cuts.data;
  const narration = s.files.narration.data;
  const dirty = ['cuts', 'narration', 'brief', 'catalog'].some(name => s.files[name as keyof typeof s.files].dirty);
  const busy = s.jobs.some(j => j.slug === s.active && ['running', 'queued'].includes(j.status));
  const unsupported = !s.supportsJob('ai-script-text');
  const previous = s.jobs.find(j => j.slug === s.active && j.type === 'ai-script-text' && j.params.fromJob === source.id && j.status === 'failed');
  useEffect(() => {
    const el = dialog.current;
    el?.showModal?.();
    return () => {if (el?.open) el.close?.();};
  }, []);
  useEffect(() => {
    let alive = true;
    setConfirmation(null);
    setError('');
    if (cuts) void api.get<{data: string | null}>(`/api/projects/${encodeURIComponent(source.slug)}/script`).then(r => {
      if (!alive) return;
      if (!r.data.data?.trim()) {setError('保存済みの台本がありません');return;}
      setConfirmation(scriptTextConfirmation(r.data.data, cuts, narration));
    }).catch(e => alive && setError('台本を確認できません: ' + (e as Error).message));
    return () => {alive = false;};
  }, [source.slug, cuts, narration, refresh]);
  const generate = async () => {
    if (!confirmation || dirty || busy || unsupported || submitting) return;
    setSubmitting(true);
    try {
      await s.addJob('ai-script-text', {confirmed: true, fingerprint: confirmation.fingerprint, fromJob: source.id, ...(typeof source.params.model === 'string' ? {model: source.params.model} : {})});
    } finally {setSubmitting(false);}
  };
  const reload = async () => {
    if (dirty) return;
    await Promise.all([s.loadFile('cuts'), s.loadFile('narration')]);
    setRefresh(v => v + 1);
  };
  return <dialog ref={dialog} className="locked-text-dialog card" aria-labelledby="locked-text-title" onCancel={(e) => {e.preventDefault();onDismiss();}}>
    <h2 id="locked-text-title">今の並びでテロップとナレーション原稿を生成しますか？</h2>
    <p>台本は保存済みです。並び順がロックされているため、現在の映像に合わせて文言を生成します。</p>
    {confirmation && <p><b>{confirmation.cuts} カット・{confirmation.totalSec.toFixed(1)} 秒</b>の並び順・素材・尺・倍速を保持します。現在のテロップとナレーション原稿を更新します。音声は生成後に作り直してください。</p>}
    {!confirmation && !error && <p className="hint">保存済みの台本を確認中…</p>}
    {error && <p role="alert" className="hint">{error}</p>}
    {previous?.error && <p role="alert" className="hint">前回の生成: {previous.error}</p>}
    {dirty && <p role="alert" className="hint">未保存の編集があります。「今回は生成しない」で閉じ、編集を保存してから続行してください。</p>}
    {unsupported && <p className="hint">Reel Studio と PC ワーカーを再起動すると続行できます。</p>}
    <div className="row">
      <button className="primary" onClick={() => void generate()} disabled={!confirmation || dirty || busy || unsupported || submitting}>今の並びでテロップ・原稿を生成</button>
      <button onClick={onDismiss} autoFocus>今回は生成しない</button>
      <button className="small" onClick={() => void reload().catch(e => setError((e as Error).message))} disabled={dirty || busy || submitting}>最新の内容を読み込む</button>
    </div>
  </dialog>;
};
