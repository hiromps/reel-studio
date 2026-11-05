import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ModalRenderInputSchema, ModalRenderNarrationSchema, type ModalRenderDashboard, type ModalRenderEstimate, type ModalRenderInput} from '@shared/modal-render';
import {MODAL_STATUS_LABEL, type ModalJob} from '@shared/modal';
import {useStudio} from '../state/store';
import {modalApi} from '../modal-api';
import {planCloudUpload, uploadCloudFiles, type CloudUpload} from '../cloud-upload';
import type {Job} from '../api';
import {api} from '../api';
import '../modal.css';

const active = (j: ModalJob) => !['completed', 'failed', 'cancelled'].includes(j.status);
const money = (n: number) => `$${n.toFixed(3)}`;
const message = (e: unknown) => e instanceof Error ? e.message : '処理を完了できませんでした';

function useCloudProject(slug: string) {
  const [data, setData] = useState<ModalRenderDashboard | null>(null);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const next = await modalApi.get<ModalRenderDashboard>(`/render/projects/${encodeURIComponent(slug)}`);
      if (mounted.current) {setData(next); setError('');}
      return next;
    } catch (e) {if (mounted.current) setError(message(e)); return null;}
  }, [slug]);
  useEffect(() => {mounted.current = true; void refresh(); return () => {mounted.current = false;};}, [refresh]);
  const running = data?.jobs.some(active) ?? false;
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {void refresh();}, 10000);
    return () => clearInterval(id);
  }, [running, refresh]);
  return {data, error, refresh, setError};
}

export const CloudRenderCard: React.FC<{materials?: boolean}> = ({materials = false}) => {
  const s = useStudio();
  return s.active ? <CloudProject key={s.active + String(materials)} slug={s.active} materials={materials} /> : null;
};

function CloudProject({slug, materials}: {slug: string; materials: boolean}) {
  const s = useStudio();
  const {data, error, refresh, setError} = useCloudProject(slug);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [uploadConsent, setUploadConsent] = useState(false);
  const [gpuConsent, setGpuConsent] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const uploadPlan = useRef<CloudUpload | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<{done: number; total: number} | null>(null);
  const [localJob, setLocalJob] = useState<Job | null>(null);
  const localUploadId = useRef<string | null>(null);
  const [draft, setDraft] = useState(true);
  const [estimate, setEstimate] = useState<{value: ModalRenderEstimate; input: ModalRenderInput; key: string} | null>(null);
  // Retain the request ID until an acknowledged response; retries cannot start two GPU jobs.
  const request = useRef<ModalRenderInput | null>(null);
  const [deleteConsent, setDeleteConsent] = useState(false);
  const [notice, setNotice] = useState('');
  const route = `/render/projects/${encodeURIComponent(slug)}`;
  const session = data?.expired ? null : data?.session;
  const ready = !!session?.files.every(f => f.complete);
  const dirty = s.files.cuts.dirty || s.files.narration.dirty || s.files.catalog.dirty;
  const running = data?.jobs.some(active) ?? false;
  const uploadRunning = localJob && ['queued', 'running'].includes(localJob.status);
  const disabled = busy || running || !!uploadRunning;
  const prepare = materials;
  const cuts = s.files.cuts.data;
  const narration = s.files.narration.data;
  // Project schema fields used only for voice selection are omitted from the render contract.
  const audio = narration && (narration.segments.length || narration.sfx?.length) ? ModalRenderNarrationSchema.safeParse(narration) : null;
  const inputKey = JSON.stringify({sessionId: session?.id, cuts: prepare ? null : cuts, narration: prepare ? null : audio?.success ? audio.data : narration, draft, prepare});
  const estimateCurrent = estimate?.key === inputKey;
  const usableEstimate = estimateCurrent ? estimate : null;
  const terminalPreview = data?.jobs.find(j => j.kind === 'prepare-media' && j.status === 'completed' && j.sessionId === session?.id);
  const lastRender = data?.jobs.find(j => j.kind === 'remotion-render' && j.status === 'completed');

  useEffect(() => {setGpuConsent(false); request.current = null;}, [inputKey]);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (!localJob || !['queued', 'running'].includes(localJob.status)) return;
    let stopped = false;
    const poll = async () => {
      try {
        const {data: next} = await api.get<Job>(`/api/jobs/${localJob.id}`);
        if (stopped) return;
        setLocalJob(next);
        if (next.status === 'done') {localUploadId.current = null; setNotice(next.result?.cloudPublished ? '素材を転送し、Web/PWAへ同期しました' : '素材を転送しました。Web/PWAで使う場合は「スマホへ同期」を押してください'); await refresh();}
        if (next.status === 'failed' || next.status === 'cancelled') {localUploadId.current = null; setError(next.error ?? '素材転送を中止しました');}
      } catch (e) {if (!stopped) setError(message(e));}
    };
    const id = window.setInterval(() => {void poll();}, 2000);
    return () => {stopped = true; clearInterval(id);};
  }, [localJob?.id, localJob?.status, refresh, setError]);

  const run = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {await fn();} catch (e) {setError(message(e));} finally {lock.current = false; setBusy(false);}
  };
  const upload = () => run(async () => {
    if (!uploadConsent || dirty) throw new Error('編集内容を保存し、素材の転送を許可してください');
    if (!s.isCloud && !materials) {
      localUploadId.current ??= crypto.randomUUID();
      const job = await modalApi.post<Job>(`${route}/upload-local`, {sessionId: localUploadId.current, allowUpload: true});
      setLocalJob(job); return;
    }
    uploadPlan.current ??= planCloudUpload(files, session ?? null);
    const controller = new AbortController(); abort.current = controller;
    await uploadCloudFiles(slug, uploadPlan.current, controller.signal, (done, total) => setProgress({done, total}));
    uploadPlan.current = null; setFiles([]); setProgress(null); setUploadConsent(false);
    setEstimate(null); await refresh(); setNotice('素材を転送しました。次に軽量プレビューを作成してください');
  });
  const quote = () => run(async () => {
    if (!ready || dirty) throw new Error('先に素材を転送し、編集内容を保存してください');
    if (!prepare && audio && !audio.success) throw new Error('未生成のナレーションがあります。音声を生成してから素材を転送してください');
    const parsed = ModalRenderInputSchema.safeParse({kind: prepare ? 'prepare-media' : 'remotion-render', sessionId: session!.id, requestId: crypto.randomUUID(), allowGpu: true, draft, ...(prepare ? {} : {cuts, narration: audio?.success ? audio.data : null})});
    if (!parsed.success) throw new Error('編集データを確認してください。180秒・120カット・60fps以内の保存済み動画を書き出せます');
    const input = parsed.data;
    const value = await modalApi.post<ModalRenderEstimate>(`${route}/estimate`, input);
    setEstimate({value, input, key: inputKey}); setGpuConsent(false); request.current = input;
  });
  const submit = () => run(async () => {
    if (!usableEstimate || !gpuConsent || dirty || !request.current) throw new Error('概算を確認し、この処理のGPU利用を許可してください');
    const job = await modalApi.post<ModalJob>(`${route}/jobs`, request.current);
    setGpuConsent(false); setEstimate(null); request.current = null;
    await refresh(); setNotice(`${prepare ? '軽量プレビュー作成' : 'クラウド書き出し'}を受け付けました（${MODAL_STATUS_LABEL[job.status]}）`);
  });
  const activate = () => run(async () => {
    if (dirty) throw new Error('先に編集内容を保存してください');
    await modalApi.post(`${route}/activate`, {catalogEtag: s.files.catalog.etag, cutsEtag: s.files.cuts.etag});
    s.setLight(true); await s.reloadActive(); await s.refreshProjects();
    setNotice('軽量プレビューを使って編集できます。「編集」からカット・字幕を調整してください');
  });
  const cancelUpload = () => {
    abort.current?.abort();
    if (uploadRunning) void s.cancelJob(localJob!.id).then(() => setLocalJob(null));
  };
  const uploadProgress = progress ?? localJob?.progress;
  const hasBudget = !!usableEstimate && usableEstimate.value.estimatedCostUsd <= (data?.usage.remainingUsd ?? 0);
  const resultUrl = lastRender ? `/p/${encodeURIComponent(slug)}/full/out/modal-${lastRender.id}.mp4` : null;

  return <section className="card modal-cloud cloud-render" aria-label={prepare ? 'クラウド素材' : 'Modalクラウド書き出し'}>
    <h2>{prepare ? 'スマホから素材を追加' : 'Modalで書き出し'}</h2>
    <p className="hint">{prepare ? '選んだ動画をクラウドへ転送し、軽いプレビューで編集します。PCを起動せずに使えます。' : '映像・字幕・生成済み音声をクラウドで合成します。端末のGPUは不要です。'}</p>
    <p className="hint">素材は7日間保存。1本512MiB・案件合計1GiBまで。書き出しは180秒・120カット以内です。</p>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="modal-actions"><button onClick={() => void run(async () => {await refresh();})} disabled={busy}>状態を更新</button></div>
    {data && <>
      <p className="hint">今月の利用可能な予約額：{money(data.usage.remainingUsd)} ／ 上限 {money(data.usage.budgetUsd)}。概算・予約額と実請求は異なります。</p>
      {data.expired && <p role="status">素材の保存期限が切れました。再度アップロードしてください。</p>}
      {session && <p>{session.files.length}ファイル・{(session.totalBytes / 1024 ** 2).toFixed(1)}MiB ／ {ready ? '転送済み' : '転送未完了'} ／ 期限 {new Date(session.expiresAt).toLocaleDateString('ja-JP')}</p>}
      {(prepare || !s.isCloud) && <div className="cloud-upload">
        {(prepare || s.isCloud) && <label>動画を選ぶ<input type="file" multiple accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm" disabled={disabled || !!uploadPlan.current} onChange={e => {setFiles(Array.from(e.target.files ?? [])); uploadPlan.current = null; setProgress(null); setEstimate(null);}} /></label>}
        {!!files.length && <p className="hint">{files.length}本・{(files.reduce((n, f) => n + f.size, 0) / 1024 ** 2).toFixed(1)}MiBを転送します</p>}
        <label className="modal-consent"><input type="checkbox" checked={uploadConsent} disabled={disabled} onChange={e => setUploadConsent(e.target.checked)} />{prepare ? '選んだ動画をModalへ転送する' : 'この案件で使う動画・フォント・生成済み音声をModalへ転送する'}</label>
        <div className="modal-actions">
          <button onClick={() => void upload()} disabled={disabled || dirty || !uploadConsent || (prepare && !files.length)}>{uploadPlan.current ? '転送を再開' : '素材をアップロード'}</button>
          {!prepare && !s.isCloud && ready && <button disabled={disabled} onClick={() => void run(async () => {await modalApi.post(`${route}/publish`); setNotice('この案件のクラウド素材をWeb/PWAへ同期しました');})}>スマホへ同期</button>}
          {(busy && progress || uploadRunning) && <button onClick={cancelUpload}>転送を中止</button>}
          {uploadPlan.current && !busy && <button onClick={() => {uploadPlan.current = null; setProgress(null); setFiles([]); setUploadConsent(false);}}>選び直す</button>}
        </div>
        {uploadProgress && <div role="status"><progress aria-label="素材の転送" max={uploadProgress.total || 1} value={uploadProgress.done} /><p className="hint">{Math.round(uploadProgress.done / (uploadProgress.total || 1) * 100)}% 転送済み。転送中は画面を開いたままにしてください。</p></div>}
        {!prepare && s.isCloud && <p className="hint">PCの既存案件はPC版の「Modalで書き出し」から素材をアップロードしてください。</p>}
      </div>}
      {!prepare && s.isCloud && !ready && <p>素材画面で動画を追加するか、PC版からこの案件の素材をアップロードしてください。</p>}
      {dirty && <p className="hint" role="status">未保存の変更があります。保存してから続けてください。</p>}
      {!prepare && <label>書き出し品質<select value={draft ? 'draft' : 'final'} disabled={disabled} onChange={e => setDraft(e.target.value === 'draft')}><option value="draft">確認用（540×960）</option><option value="final">完成動画（1080×1920）</option></select></label>}
      <div className="modal-actions"><button onClick={() => void quote()} disabled={disabled || !ready || dirty}>概算を確認</button></div>
      {usableEstimate && <div>
        <p>今回の予約額：<b>{money(usableEstimate.value.estimatedCostUsd)}</b>（上限 {usableEstimate.input.maxSeconds ?? data.maxJobSeconds}秒）</p>
        {!hasBudget && <p role="alert">今月の予約上限を超えます。設定・利用状況を確認してください。</p>}
        <label className="modal-consent"><input type="checkbox" checked={gpuConsent} onChange={e => setGpuConsent(e.target.checked)} disabled={disabled || !hasBudget} />この処理のGPU利用と料金予約を許可する</label>
        <button className="primary" onClick={() => void submit()} disabled={disabled || dirty || !gpuConsent || !hasBudget}>{prepare ? '軽量プレビューを作成' : 'クラウドで書き出す'}</button>
      </div>}
      {prepare && (session?.prepared || terminalPreview) && <div className="modal-actions"><button className="primary" onClick={() => void activate()} disabled={disabled || dirty}>編集に取り込む</button></div>}
      {data.jobs.map(j => <div className="modal-job" key={j.id}>
        <b>{j.kind === 'prepare-media' ? '軽量プレビュー' : '書き出し'}：{MODAL_STATUS_LABEL[j.status]}</b>
        <span>{j.status === 'completed' ? '完了' : j.phase} ／ 予約 {money(j.estimatedCostUsd)}</span>
        {active(j) && <><progress aria-label="クラウド処理の進捗" value={j.progress} max={100} /><div className="modal-actions"><button disabled={busy || j.status === 'cancelling'} onClick={() => void run(async () => {await modalApi.post(`/jobs/${j.id}/cancel`); await refresh();})}>処理を中止</button></div></>}
        {j.error && <p role="alert">{j.error}</p>}
        {j.renderInfo && <><span>{j.renderInfo.width}×{j.renderInfo.height} ／ {j.renderInfo.fps}fps ／ {j.renderInfo.durationSec.toFixed(1)}秒 ／ {j.renderInfo.encoder}</span>{j.renderInfo.warnings.map(w => <p className="hint" key={w}>{w}</p>)}</>}
      </div>)}
      {!prepare && resultUrl && <div className="modal-preview"><video src={resultUrl} controls playsInline preload="metadata" /><a className="button" href={`${resultUrl}?download=1`} download>MP4を保存</a></div>}
      <details><summary>クラウドの素材を削除</summary><p className="hint">クラウド上の素材とプレビューを削除します。端末の元動画は保持します。</p><label className="modal-consent"><input type="checkbox" checked={deleteConsent} onChange={e => setDeleteConsent(e.target.checked)} />この案件のクラウド素材を削除する</label><button disabled={disabled || !data.project || !deleteConsent} onClick={() => void run(async () => {await modalApi.del(route); setEstimate(null); setDeleteConsent(false); await refresh();})}>削除する</button></details>
    </>}
  </section>;
}
