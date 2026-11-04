import React, {useEffect, useRef, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import {useHotkeys} from '../hooks/useHotkeys';
import {defaultEmotionTags, emotionId, EmotionTagsSchema, type EmotionTags} from '@shared/emotion-tags';
import type {ReelData, Narration} from '@shared/schema';
import type {EmotionSample} from '../../core/emotion-audition';

import {EmotionChips} from '../components/EmotionChips';
export {EmotionChips} from '../components/EmotionChips';

export const EmotionCutsDialog: React.FC<{cuts: ReelData; narration: Narration | null; initialSelection: string[]; voice: string;
  onChange: (ids: string[], emotion: string | null) => void; onClose: () => void}> = ({cuts, narration, initialSelection, voice, onChange, onClose}) => {
  const s = useStudio();
  const dialog = useRef<HTMLDialogElement>(null);
  const [config, setConfig] = useState(defaultEmotionTags);
  const [configReady, setConfigReady] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>(initialSelection);
  const [focused, setFocused] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const job = s.jobs.find(j => j.id === jobId);
  const busy = submitting || !!job && ['queued', 'running'].includes(job.status);
  const editingBusy = s.jobs.some(j => j.slug === s.active && ['queued', 'running'].includes(j.status) && j.id !== jobId);
  const canonical = cuts.cuts.every(c => c.id && c.emotion_tag !== undefined);
  const targets = (selected.length ? selected : focused ? [focused] : []).filter(id => cuts.cuts.some(c => c.id === id));
  const chosen = cuts.cuts.filter(c => targets.includes(c.id ?? ''));
  const same = chosen.length && chosen.every(c => emotionId(c.emotion_tag, config) === emotionId(chosen[0].emotion_tag, config));
  const value = same ? chosen[0].emotion_tag : '__mixed__';
  const change = (id: string | null) => {if (targets.length && configReady && canonical && !editingBusy) onChange(targets, id);};
  useHotkeys([
    ...config.tags.filter(t => t.id !== 'none').slice(0, 7).map((tag, i) => ({key: String(i + 1), handler: () => change(same && emotionId(value, config) === tag.id ? null : tag.id)})),
    {key: '0', handler: () => change(null)},
  ]);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal?.();
    let active = true;
    void api.get<EmotionTags>('/api/emotion-tags').then(r => {
      if (active) {setConfig(EmotionTagsSchema.parse(r.data)); setConfigReady(true);}
    }).catch(e => {if (active) setError(`タグ定義を読み込めません: ${e.message}`);});
    return () => {active = false; if (el?.open) el.close?.();};
  }, []);
  const audition = async () => {
    if (!voice || busy || submittingRef.current || !configReady) return;
    submittingRef.current = true; setSubmitting(true); setError('');
    try {
      const created = await s.addJob('emotion-test', {voice, text: config.audition.text, speed: config.audition.speed});
      if (!created) throw new Error('聞き比べ音声の生成を開始できませんでした');
      setJobId(created.id);
    } catch (e) {setError((e as Error).message);}
    finally {submittingRef.current = false; setSubmitting(false);}
  };
  const samples = (job?.status === 'done' ? job.result?.samples : []) as EmotionSample[] | undefined;
  return <dialog ref={dialog} className="card emotion-dialog" aria-labelledby="emotion-title" onCancel={e => {e.preventDefault(); onClose();}}>
    <div className="row"><h2 id="emotion-title">カットごとの感情タグ</h2><button onClick={onClose} autoFocus>閉じる</button></div>
    <p className="hint">1タップで選択。同じタグをもう一度押すと「なし」。変更後は編集画面の「保存」で確定します。</p>
    {!canonical && <p role="status">この機能は共通カット形式（reel-cuts.json）の案件で使えます。既存の音声ブロックを保つため、自動変換は行いません。</p>}
    <div className="emotion-bulk">
      <div className="row">
        <button onClick={() => setSelected(cuts.cuts.flatMap(c => c.id ? [c.id] : []))}>すべて選択</button>
        <button onClick={() => {setSelected([]); setFocused(null);}}>選択を解除</button>
        <b role="status">{targets.length} カットに一括適用</b>
      </div>
      <p className="hint">選択したカットへ数字キー1〜7でタグを適用、0で「なし」。入力欄・日本語変換中は切り替わりません。</p>
      <EmotionChips config={config} value={value} label="選択したカットに感情を一括適用" disabled={!targets.length || !canonical || !configReady || editingBusy} onChange={change} />
    </div>
    <ol className="emotion-cut-list" aria-label="カット別の感情">
      {cuts.cuts.map((c, i) => {
        const id = c.id ?? `missing-${i}`;
        const line = narration?.segments.find(seg => seg.id === `oc_${id}`)?.text;
        return <li key={id} onFocus={() => setFocused(id)}>
          <label className="emotion-cut-label"><input type="checkbox" aria-label={`カット${i + 1}を選択`} checked={selected.includes(id)}
            onChange={e => setSelected(e.target.checked ? [...selected, id] : selected.filter(x => x !== id))} />
            <b>カット {i + 1}</b><span>{line || c.main?.text || 'ナレーションなし'}</span></label>
          <EmotionChips config={config} value={c.emotion_tag} label={`カット${i + 1}の感情`} disabled={!canonical || !configReady || editingBusy}
            onChange={emotion => onChange([id], emotion)} />
          {c.emotion_tag && !config.tags.some(t => t.id === emotionId(c.emotion_tag, config)) && <p className="hint">既存タグ: {String(c.emotion_tag)}（固定タグを選ぶと置き換わります）</p>}
        </li>;
      })}
    </ol>
    <details className="emotion-audition"><summary>同じ1文で全タグを聞き比べる</summary>
      <p>{config.audition.text}</p><p className="hint">全{config.tags.length}種類を同じ声・話速で生成します。Fish Audioを使用し、音声はPCの案件フォルダに保存・再利用します。</p>
      <button disabled={!voice || !configReady || busy || editingBusy || s.config?.tts === false || !s.supportsJob('emotion-test')} onClick={() => void audition()}>
        {busy ? '聞き比べ音声を生成中…' : '全タグの試聴音声を生成（ローカル保存）'}</button>
      {!voice && <p className="hint">Renderでボイスを選ぶか、人格にボイスを設定してください。</p>}
      {job && <p role="status">{job.progress?.phase || job.status}{job.status === 'failed' ? `: ${job.error}` : ''}</p>}
      {samples?.map(sample => <div className="emotion-sample" key={sample.id}><b>{sample.label}</b><audio controls preload="none" src={`${s.mediaBase}/${sample.file}`} aria-label={`${sample.label}の試聴`} />{sample.cached && <span className="hint">保存済みを再利用</span>}</div>)}
    </details>
    {error && <p role="alert" className="error">{error}</p>}
  </dialog>;
};
