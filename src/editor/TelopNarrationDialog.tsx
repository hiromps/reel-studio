import React, {useEffect, useRef, useState} from 'react';
import {useStudio} from '../state/store';
import {telopNarrationConfirmation, type TelopVoice} from '@shared/telop-narration';
import type {Job} from '../api';
import type {Narration} from '@shared/schema';

type Props = {defaults: TelopVoice; capture: (emptyNarration?: Narration) => (jobId: string) => void; onClose: () => void};

export const TelopNarrationDialog: React.FC<Props> = ({defaults, capture, onClose}) => {
  const s = useStudio();
  const dialog = useRef<HTMLDialogElement>(null);
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const cuts = s.files.cuts.data;
  const narration = s.files.narration.data;
  const plan = cuts ? telopNarrationConfirmation(cuts, narration, defaults) : null;
  const busy = s.jobs.some(j => j.slug === s.active && ['queued', 'running'].includes(j.status));
  const dirty = ['cuts', 'narration', 'brief'].some(name => s.files[name as 'cuts' | 'narration' | 'brief'].dirty);
  const blocked = !s.supportsJob('telop-tts') ? 'Reel Studio と PC ワーカーを再起動してください。'
    : s.config?.tts === false ? 'Settings の「音声生成」で Fish Audio の API キーを設定してください。'
    : !plan?.entries.length ? '音声化できるテロップがありません。空欄・未記入の文言は読み上げません。'
    : !plan.voice.voice ? 'Brief で人格を選ぶか、Render でボイスを選んでください。'
    : busy ? 'この案件の処理が終わってから実行してください。' : null;

  useEffect(() => {
    const el = dialog.current;
    el?.showModal?.();
    return () => {if (el?.open) el.close?.();};
  }, []);

  const generate = async () => {
    if (!plan || blocked || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError('');
    try {
      // store の保存は成功/失敗を返す。競合・保存失敗なら音声化ジョブを投入しない。
      for (const name of ['cuts', 'narration', 'brief'] as const) {
        if (s.files[name].dirty && !(await s.saveFile(name))) throw new Error('編集を保存できなかったため、音声化を開始していません。');
      }
      const record = capture(narration ? undefined : {...plan.voice, latency: 'normal', segments: []});
      const job: Job | null = await s.addJob('telop-tts', {fingerprint: plan.fingerprint});
      if (!job) throw new Error('音声化を開始できませんでした。接続状態を確認して再実行してください。');
      record(job.id);
      onClose();
    } catch (e) {setError((e as Error).message);}
    finally {submittingRef.current = false; setSubmitting(false);}
  };

  const chars = plan?.entries.reduce((n, entry) => n + [...entry.text].length, 0) ?? 0;
  return <dialog ref={dialog} className="locked-text-dialog card telop-narration-dialog" aria-labelledby="telop-narration-title"
    onCancel={e => {e.preventDefault(); if (!submitting) onClose();}}>
    <h2 id="telop-narration-title">テロップをそのまま音声化</h2>
    <p>テロップ段の文言を表示順に読み上げ、各テロップの開始位置に音声を配置します。同じ文言が続く部分は一度だけ読み上げます。</p>
    {plan && <>
      <p><b>{plan.entries.length} ブロック・{chars} 文字</b> ／ 声: {plan.voice.voiceTitle || plan.voice.voice || '未設定'} ／ 話速: {plan.voice.speed}</p>
      {!!narration?.segments.length && <p className="hint">既存のナレーション {narration.segments.length} 本を、この文言と配置に置き換えます。声・話速・音量・効果音は引き継ぎます。生成完了後に Ctrl+Z で元に戻せます。</p>}
      {!!plan.skipped && <p className="hint">空欄・未記入のテロップ {plan.skipped} 件は除外します。</p>}
      <ol className="telop-narration-list" aria-label="読み上げるテロップ">
        {plan.entries.map((entry, i) => <li key={i}><span className="hint mono">{entry.at.toFixed(2)}s</span><span>{entry.text}</span></li>)}
      </ol>
    </>}
    <p className="hint">音声は Fish Audio で生成します。読み上げが表示尺を超える場合は、生成後に Timeline で尺を調整してください。</p>
    {dirty && <p className="hint">未保存の編集も保存してから音声化します。</p>}
    {blocked && <p role="status" className="hint">{blocked}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="row">
      <button className="primary" disabled={!!blocked || submitting} onClick={() => void generate()}>{submitting ? '準備中…' : dirty ? '保存して音声を生成' : 'この文言で音声を生成'}</button>
      <button onClick={onClose} disabled={submitting} autoFocus>キャンセル</button>
    </div>
  </dialog>;
};
