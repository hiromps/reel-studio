import React, {useCallback, useEffect, useRef, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import {AiModelSelect} from '../hooks/useAiModel';
import {useStringPref} from '../hooks/usePref';
import {localDateTime} from '@shared/time';
import {
  STYLE_FIELDS, STYLE_LABELS, VideoStyleDraftSchema, VideoStyleSnapshotSchema,
  renderVideoStyleSkill, type VideoStyleDraft, type VideoStyleEntry, type VideoStyleSnapshot,
} from '@shared/video-style';

export const VideoStyleCard: React.FC<{aiModel: string; onModel: (v: string) => void; onScript: () => void}> = ({aiModel, onModel, onScript}) => {
  const s = useStudio();
  const brief = s.files.brief.data;
  const [entries, setEntries] = useState<VideoStyleEntry[]>([]);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(brief?.videoStyle?.id ?? '');
  const [revision, setRevision] = useState(brief?.videoStyle?.revision ?? 0);
  const [sourceSlug, setSourceSlug] = useState(s.active ?? '');
  const [instruction, setInstruction] = useState('');
  const [learnFromProject, setLearnFromProject] = useState(false);
  const [draft, setDraft] = useState<VideoStyleDraft | null>(null);
  const [base, setBase] = useState<{id: string; revision: number} | null>(null);
  const [pending, setPending] = useStringPref('reel-studio.video-style-job.' + (s.active ?? ''), '');
  const [submitting, setSubmitting] = useState(false);
  const [request, setRequest] = useState('');
  const handled = useRef(new Set<string>());
  const entry = entries.find((e) => e.id === selectedId);
  const selected = entry?.revisions.find((r) => r.revision === revision) ?? entry?.revisions.at(-1) ??
    (brief?.videoStyle?.id === selectedId ? brief.videoStyle : null);
  const latest = entry?.revisions.at(-1);
  const job = s.jobs.find((j) => j.id === pending);
  const busy = submitting || !!pending && (!job || job.status === 'queued' || job.status === 'running');
  const activeDirty = ['brief', 'cuts', 'narration'].some((key) => s.files[key as 'brief' | 'cuts' | 'narration'].dirty);
  const unsupported = !s.supportsJob('ai-video-style') || !s.supportsJob('video-style-save');
  const applied = brief?.videoStyle;
  const display = draft ?? selected;
  const usableSources = s.projects.filter((p) => p.has.cuts);
  const load = useCallback(async () => {
    try { const r = await api.get<{entries: VideoStyleEntry[]}>('/api/video-styles'); setEntries(r.data.entries); setError(''); }
    catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!job || !['done', 'failed', 'cancelled'].includes(job.status) || handled.current.has(job.id)) return;
    handled.current.add(job.id);
    setPending('');
    if (job.status !== 'done') { setError(job.error ?? '処理を取り消しました'); return; }
    if (job.type === 'ai-video-style') {
      const parsed = VideoStyleDraftSchema.safeParse(job.result?.draft);
      if (!parsed.success) { setError('型の案が読めませんでした'); return; }
      setDraft(parsed.data);
      setBase(typeof job.result?.baseId === 'string' && typeof job.result?.baseRevision === 'number' ? {id: job.result.baseId, revision: job.result.baseRevision} : null);
      setError('');
    } else if (job.type === 'video-style-save') {
      const parsed = VideoStyleSnapshotSchema.safeParse(job.result?.snapshot);
      if (!parsed.success) { setError('保存結果が読めませんでした'); return; }
      const snapshot = parsed.data;
      setEntries((current) => [{id: snapshot.id, revisions: [...(current.find((e) => e.id === snapshot.id)?.revisions ?? []).filter((r) => r.revision !== snapshot.revision), snapshot]}, ...current.filter((e) => e.id !== snapshot.id)]);
      setSelectedId(snapshot.id); setRevision(snapshot.revision); setDraft(null); setBase(null); setError('');
      s.toast('型「' + snapshot.label + '」v' + snapshot.revision + ' を保存しました', 'ok');
    }
  }, [job?.id, job?.status, job?.result, job?.error, s.toast]);

  const queue = async (type: string, params: Record<string, unknown>, slug?: string) => {
    setSubmitting(true); setError('');
    try { const j = await s.addJob(type, params, slug); if (j) setPending(j.id); }
    finally { setSubmitting(false); }
  };
  const extract = () => queue('ai-video-style', {model: aiModel}, sourceSlug);
  const refine = () => selected && queue('ai-video-style', {model: aiModel, base: selected, instruction, learnFromProject}, s.active ?? undefined);
  const save = (asNew = false) => {
    if (!draft) return;
    const parsed = VideoStyleDraftSchema.safeParse(draft);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? '内容を確認してください'); return; }
    return queue('video-style-save', {draft: parsed.data, id: !asNew ? base?.id : undefined, expectedRevision: !asNew ? base?.revision : undefined});
  };
  const apply = () => {
    if (!brief || !selected) return;
    s.setFile('brief', {...brief, videoStyle: selected});
    s.toast('型を案件に設定しました。Brief を保存すると台本作成に反映されます', 'info');
  };
  const generate = async () => {
    const j = await s.addJob('ai-script-draft', {model: aiModel, request: request.trim() || '保存済みの動画の型を、この案件の事実と素材に合わせて適用する。フック・言葉選び・カットの尺・順番に統一感のある台本を作って。'});
    if (j) onScript();
  };
  const download = () => {
    if (!selected) return;
    const url = URL.createObjectURL(new Blob([renderVideoStyleSkill(selected)], {type: 'text/markdown;charset=utf-8'}));
    const a = document.createElement('a'); a.href = url; a.download = 'reel-' + selected.id + '-v' + selected.revision + '-SKILL.md'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (!brief || !s.active) return null;
  const generating = s.jobs.some((j) => j.slug === s.active && (j.status === 'queued' || j.status === 'running'));
  return (
    <section className="card video-style-card" data-tour="video-style">
      <h2>過去案件の型を記憶する</h2>
      <p className="hint">過去案件からフック・言葉選び・カットの尺と並びを型にして保存。別の店の素材で使い、修正を次の版へ育てられます。</p>
      {applied && <p className="video-style-applied">この案件の型：<b>{applied.label} v{applied.revision}</b>{s.files.brief.dirty && '（Brief 未保存）'}</p>}
      {error && <p className="hint err" role="alert">{error}</p>}
      {unsupported && <p className="hint warn">この機能を使うには Reel Studio を再起動してください。</p>}
      <div className="row">
        <label>保存した型
          <select value={selectedId} disabled={busy || !!draft} onChange={(e) => {setSelectedId(e.target.value); setRevision(0); setInstruction('');}}>
            <option value="">（型を選ぶ）</option>
            {entries.map((e) => <option key={e.id} value={e.id}>{e.revisions.at(-1)!.label}（v{e.revisions.at(-1)!.revision}）</option>)}
            {applied && !entries.some((e) => e.id === applied.id) && <option value={applied.id}>{applied.label}（案件に保存した版）</option>}
          </select>
        </label>
        {entry && <label>版
          <select value={selected?.revision ?? 0} disabled={busy || !!draft} onChange={(e) => setRevision(Number(e.target.value))}>
            {[...entry.revisions].reverse().map((r) => <option key={r.revision} value={r.revision}>v{r.revision} · {localDateTime(r.savedAt)}</option>)}
          </select>
        </label>}
        <button onClick={() => void load()} disabled={busy || !!draft}>一覧を読み直す</button>
        <button onClick={apply} disabled={!selected || !!draft || busy}>この版を案件に設定</button>
        <button onClick={download} disabled={!selected || !!draft || busy}>スキルをダウンロード</button>
        {applied && <button disabled={busy} onClick={() => s.setFile('brief', {...brief, videoStyle: undefined})}>案件の型を解除</button>}
      </div>

      {display && <div className="video-style-detail">
        {draft ? <>
          <label>型の名前<input value={draft.label} maxLength={60} disabled={busy} onChange={(e) => setDraft({...draft, label: e.target.value})} /></label>
          <label>型の要約<textarea rows={2} value={draft.summary} maxLength={400} disabled={busy} onChange={(e) => setDraft({...draft, summary: e.target.value})} /></label>
        </> : <p><b>{display.label}</b> — {display.summary}</p>}
        <p className="hint">元案件：{display.source.slug} · {display.referenceCuts.length} カット · {display.referenceCuts.reduce((n, c) => n + c.durationSec, 0).toFixed(1)} 秒</p>
        <div className="video-style-rules">
          {STYLE_FIELDS.map((key) => draft ? <label key={key}>{STYLE_LABELS[key]}<textarea rows={3} value={draft.rules[key]} maxLength={2000} disabled={busy} onChange={(e) => setDraft({...draft, rules: {...draft.rules, [key]: e.target.value}})} /></label>
            : <div key={key}><b>{STYLE_LABELS[key]}</b><p>{display.rules[key]}</p></div>)}
        </div>
        {draft && <div className="row">
          <button className="primary" disabled={busy || unsupported} onClick={() => void save()}>{base ? '改善版として保存（v' + (base.revision + 1) + '）' : '新しい型として保存'}</button>
          {base && <button disabled={busy || unsupported} onClick={() => void save(true)}>別の型として保存</button>}
          <button disabled={busy} onClick={() => {setDraft(null); setBase(null);}}>案を閉じる</button>
          <span className="hint">保存すると他案件でも使えます。適用済み案件の版はそのままです。</span>
        </div>}
      </div>}

      {!draft && <details className="video-style-create">
        <summary>過去案件から新しい型を作る{selected ? ' / この型をブラッシュアップする' : ''}</summary>
        <div className="row">
          <label>型の元になる案件<select value={sourceSlug} disabled={busy} onChange={(e) => setSourceSlug(e.target.value)}>
            <option value="">（完成したカットのある案件を選ぶ）</option>
            {usableSources.map((p) => <option key={p.slug} value={p.slug}>{p.slug}{p.archivedAt ? '（投稿済み）' : ''}</option>)}
          </select></label>
          <fieldset disabled={busy} style={{border: 0, padding: 0, margin: 0}}><AiModelSelect value={aiModel} onChange={onModel} /></fieldset>
          <button disabled={busy || unsupported || !usableSources.some((p) => p.slug === sourceSlug) || sourceSlug === s.active && activeDirty} onClick={() => void extract()}>この案件から型の案を作る</button>
        </div>
        <p className="hint">保存済みの編集データを分析します。動きのピークや音楽の拍など、データから分からない点は未確認として残します。</p>
        {selected && <>
          <label>次の案件にも覚えておきたい改善<textarea rows={3} value={instruction} maxLength={3000} disabled={busy} onChange={(e) => setInstruction(e.target.value)} placeholder="例：フックは商品の紹介より体験の驚きから。提供→寄り→実食の順を残し、情報カットは後半へ" /></label>
          <div className="row">
            <label><input type="checkbox" checked={learnFromProject} disabled={busy} onChange={(e) => setLearnFromProject(e.target.checked)} />いまの案件の保存済み編集も手本にする</label>
            <button disabled={busy || unsupported || !instruction.trim() || !!latest && selected.revision !== latest.revision || learnFromProject && (activeDirty || !s.files.cuts.data)} onClick={() => void refine()}>改善案を作る</button>
          </div>
          {latest && selected.revision !== latest.revision && <p className="hint">改善は最新版から行います。過去の版は別案件に設定・ダウンロードできます。</p>}
        </>}
        {activeDirty && <p className="hint warn">いまの案件を手本にする場合は、Brief と Timeline の変更を先に保存してください。</p>}
      </details>}

      {applied && <div className="video-style-generate">
        <label>コピー先の案件で伝えたいこと<textarea rows={2} value={request} disabled={busy || generating} onChange={(e) => setRequest(e.target.value)} placeholder="例：焼肉の型をカフェへ。看板スイーツの提供と断面を中心に、20秒で" /></label>
        <div className="row"><button className="primary" disabled={busy || generating || s.files.brief.dirty || !s.files.catalog.data || !s.supportsJob('ai-script-draft')} onClick={() => void generate()}>この案件の型で台本を作る</button>
        <span className="hint">Brief を保存して実行。台本は下の「台本から組み立てる」で確認し、素材の割り当てへ進めます。</span></div>
      </div>}
      {busy && <p role="status">{job?.progress?.phase ?? (job?.status === 'queued' ? '処理待ち…' : '処理中…')}</p>}
    </section>
  );
};
