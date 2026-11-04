import React, {useCallback, useEffect, useRef, useState} from 'react';
import {modalApi} from '../modal-api';
import {useStudio} from '../state/store';
import {MODAL_GPU, MODAL_SECRET_KEYS, MODAL_STATUS_LABEL, MODAL_TASK_LABEL, type ModalDashboard, type ModalJob, type ModalJobInput, type ModalSettingsView, type ModalTask} from '@shared/modal';
import '../modal.css';

const usd = (v: number) => `$${v.toFixed(2)}`;
const errorText = (e: unknown) => e instanceof Error ? e.message : 'Modalの処理に失敗しました';
const active = (j: ModalJob) => !['completed', 'failed', 'cancelled'].includes(j.status);

const useModal = () => {
  const [settings, setSettings] = useState<ModalSettingsView | null>(null);
  const [dashboard, setDashboard] = useState<ModalDashboard | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const config = await modalApi.get<ModalSettingsView>('/settings');
      if (!mounted.current) return;
      setSettings(previous => JSON.stringify(previous) === JSON.stringify(config) ? previous : config);
      if (config.configured) {
        const d = await modalApi.get<ModalDashboard>('/health');
        if (mounted.current) setDashboard(d);
      } else setDashboard(null);
      if (mounted.current) setError('');
    } catch (e) {if (mounted.current) {setError(errorText(e)); setDashboard(null);}}
    finally {if (mounted.current) setLoading(false);}
  }, []);
  useEffect(() => {void refresh();}, [refresh]);
  // No idle polling: merely leaving Settings open must not keep CPU/GPU warm.
  useEffect(() => {
    if (!dashboard?.usage.activeJobId) return;
    const timer = window.setTimeout(() => void refresh(), 10000);
    return () => window.clearTimeout(timer);
  }, [dashboard, refresh]);
  return {settings, dashboard, error, setError, loading, refresh};
};

const Overview: React.FC<{dashboard: ModalDashboard | null; settings: ModalSettingsView | null}> = ({dashboard: d, settings}) => (
  <>
    <dl className="modal-metrics">
      <div><dt>接続状態</dt><dd>{d?.ok ? '接続済み' : settings?.configured ? '接続確認が必要' : '未設定'}</dd></div>
      <div><dt>GPUモデル</dt><dd>{d?.gpuInfo?.name ?? MODAL_GPU}</dd></div>
      <div><dt>現在のジョブ</dt><dd>{d?.jobs.find(active) ? MODAL_STATUS_LABEL[d.jobs.find(active)!.status] : '停止中・実行待ちなし'}</dd></div>
      <div><dt>月間推定利用額・予約額</dt><dd>{d ? usd(d.usage.committedUsd) : '未取得'}</dd></div>
      <div><dt>ストレージ・API用の余裕</dt><dd>{d ? usd(d.usage.overheadReserveUsd) : '未取得'}</dd></div>
      <div><dt>予算残額の目安</dt><dd>{d ? `${usd(d.usage.remainingUsd)} / ${usd(d.usage.budgetUsd)}` : usd(settings?.monthlyBudgetUsd ?? 25)}</dd></div>
    </dl>
    {d?.gpuInfo && <p className="hint">実機確認: CUDA {d.gpuInfo.cudaVersion} ／ VRAM {(d.gpuInfo.memoryTotalMiB / 1024).toFixed(1)} GiB（確認時使用 {(d.gpuInfo.memoryUsedMiB / 1024).toFixed(1)} GiB）／ 確認日時 {new Date(d.gpuInfo.checkedAt).toLocaleString()}。GPU情報は前回テストの記録です。</p>}
    <p className="hint">表示額はReel Studioが受け付けたジョブの保守的な概算です。実際のModal請求額・他アプリの利用量・クレジット残高とは異なります。Starterの月$30クレジットは無制限無料ではありません。</p>
  </>
);

const Jobs: React.FC<{jobs: ModalJob[]; onCancel: (id: string) => void; onPreview?: (j: ModalJob) => void; onImport?: (j: ModalJob) => void; busy: boolean}> = ({jobs, onCancel, onPreview, onImport, busy}) => (
  <div className="modal-job-list" aria-live="polite" aria-relevant="additions text">
    {jobs.slice(0, 8).map(j => <article className="modal-job" key={j.id}>
      <div><strong>{MODAL_TASK_LABEL[j.kind]}</strong><span>{MODAL_STATUS_LABEL[j.status]} · {new Date(j.createdAt).toLocaleString()} · 予約 {usd(j.estimatedCostUsd)}</span></div>
      {active(j) && <progress value={j.progress} max={100} aria-label={`${MODAL_TASK_LABEL[j.kind]}の進行状況`} />}
      {j.error && <p className="warn-text">{j.error === 'JOB_TIMEOUT' ? '実行時間の上限で停止しました。小さいサイズや少ないステップでお試しください。' : j.error === 'STORAGE_LIMIT' ? 'モデル保存領域が80GiBの保護上限に達しました。不要なモデルキャッシュを整理してください。' : 'GPU処理が完了しませんでした。Modalの実行ログを確認してください。'}</p>}
      <div className="modal-actions">
        {active(j) && <button disabled={busy || j.status === 'cancelling'} onClick={() => onCancel(j.id)}>ジョブを中止</button>}
        {j.status === 'completed' && j.resultType && onPreview && <button disabled={busy} onClick={() => onPreview(j)}>結果を見る・保存</button>}
        {j.status === 'completed' && j.resultType && onImport && <button disabled={busy} onClick={() => onImport(j)}>この案件の素材に追加</button>}
      </div>
    </article>)}
  </div>
);

export const ModalCloudSettings: React.FC = () => <ModalSettingsLocal />;

const ModalSettingsLocal: React.FC = () => {
  const {settings, dashboard, error, setError, loading, refresh} = useModal();
  const [form, setForm] = useState({endpointUrl: '', monthlyBudgetUsd: 25, maxJobSeconds: 300});
  const [secrets, setSecrets] = useState(Object.fromEntries(MODAL_SECRET_KEYS.map(k => [k, ''])) as Record<typeof MODAL_SECRET_KEYS[number], string>);
  const [busy, setBusy] = useState(false);
  const [allowGpu, setAllowGpu] = useState(false);
  const [message, setMessage] = useState('');
  const [estimate, setEstimate] = useState<number | null>(null);
  const probePending = useRef<ModalJobInput | null>(null);
  useEffect(() => {if (settings) setForm({endpointUrl: settings.endpointUrl, monthlyBudgetUsd: settings.monthlyBudgetUsd, maxJobSeconds: settings.maxJobSeconds});}, [settings]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setMessage('');
    try {await action();} catch (e) {setError(errorText(e));} finally {setBusy(false);}
  };
  const probeInput = (): ModalJobInput => ({kind: 'gpu-test', prompt: '', negativePrompt: '', width: 512, height: 512, steps: 1, frames: 5, seed: 42, strength: 0.7, maxSeconds: 30, allowGpu: true, requestId: crypto.randomUUID()});
  const secretLabels = {tokenId: 'Modal API Token ID', tokenSecret: 'Modal API Token Secret', proxyTokenId: 'HTTP Proxy Token ID', proxyTokenSecret: 'HTTP Proxy Token Secret'};
  return <section className="card modal-cloud" data-tour="settings-modal">
    <h2>Modal Cloud GPU</h2>
    <p>ローカルPCのGPUを使わずに、クラウドで画像・動画を生成します。接続確認と画面の表示ではGPUを起動しません。</p>
    <Overview dashboard={dashboard} settings={settings} />
    <form onSubmit={e => {e.preventDefault(); void run(async () => {
      await modalApi.put('/settings', {...form, gpu: MODAL_GPU, ...Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.trim()))});
      setSecrets(Object.fromEntries(MODAL_SECRET_KEYS.map(k => [k, ''])) as typeof secrets);
      await refresh(); setMessage('Modal設定を保存しました');
    });}}>
      <div className="modal-fields">
        <label className="modal-wide">Modal Web Endpoint URL<input type="url" required value={form.endpointUrl} placeholder="https://workspace--reel-studio-gpu-api.modal.run" onChange={e => setForm({...form, endpointUrl: e.target.value})} /></label>
        {MODAL_SECRET_KEYS.map(k => <label key={k}>{secretLabels[k]}<input type="password" autoComplete="new-password" spellCheck={false} value={secrets[k]} placeholder={settings?.secrets[k] ? '保存済み（変更する場合のみ入力）' : '未設定'} onChange={e => setSecrets({...secrets, [k]: e.target.value})} /></label>)}
        <label>使用GPU<select value={MODAL_GPU} disabled><option value={MODAL_GPU}>NVIDIA RTX PRO 6000 Blackwell（96GB）</option></select></label>
        <label>月間利用予算（USD、最大$25）<input type="number" min={0} max={25} step={0.5} required value={form.monthlyBudgetUsd} onChange={e => setForm({...form, monthlyBudgetUsd: e.target.valueAsNumber})} /></label>
        <label>1ジョブの最大実行時間（秒）<input type="number" min={30} max={600} step={1} required value={form.maxJobSeconds} onChange={e => setForm({...form, maxJobSeconds: e.target.valueAsNumber})} /></label>
      </div>
      <p className="hint">API Tokenは公式SDK用、HTTP Proxy TokenはWeb API用です。認証情報は{settings?.encryption ?? 'OSの暗号化機能'}でサーバー側に保存します。保存済みの値を画面やログに返しません。</p>
      <div className="modal-actions"><button type="submit" disabled={busy || loading}>Modal設定を保存</button>
        <button type="button" disabled={busy || !settings?.configured} onClick={() => void run(async () => {const result = await modalApi.post<{ok: boolean; message: string}>('/test-sdk'); await refresh(); setMessage(result.message);})}>認証・接続テスト（GPU起動なし）</button>
      </div>
    </form>
    <details><summary>GPU接続テスト・課金の保護</summary>
      <p className="hint">GPUテストはCUDAで実際に計算します。実行上限30秒に加え、コールドスタート等も予約額に含めます。生成ボタンは素材画面にあります。</p>
      <div className="modal-actions"><button disabled={busy || !settings?.configured} onClick={() => void run(async () => {const r = await modalApi.post<{estimatedCostUsd: number}>('/estimate', probeInput()); setEstimate(r.estimatedCostUsd);})}>テストの概算を確認（GPU起動なし）</button>{estimate !== null && <span>予約額の目安: {usd(estimate)}</span>}</div>
      <label className="modal-consent"><input type="checkbox" checked={allowGpu} onChange={e => setAllowGpu(e.target.checked)} />このGPUテストの起動・利用料金を許可する</label>
      <button disabled={busy || !settings?.configured || !allowGpu || !!dashboard?.usage.activeJobId} onClick={() => void run(async () => {
        probePending.current ??= probeInput();
        try {await modalApi.post('/jobs', probePending.current); probePending.current = null; setAllowGpu(false);}
        catch (e) {if ((e as {status?: number}).status && (e as {status: number}).status < 500) probePending.current = null; throw e;}
        await refresh();
      })}>GPU接続テストを実行</button>
      <p className="hint">最小コンテナ0・同時GPUジョブ1・自動終了。アプリ内予算は実際の請求に対する強制上限ではありません。ModalのUsage &amp; BillingでもWorkspace budgetとspend limitを設定してください。他アプリの使用量や請求サイクルとの差を含め、Modal側の明細を確認する必要があります。</p>
      <a href="https://modal.com/docs/guide/budgets" target="_blank" rel="noreferrer">Modal公式の予算・支出上限の設定方法</a>
    </details>
    <div role="status">{busy && <p>処理中…</p>}{message && <p>{message}</p>}</div>
    {error && <p role="alert" className="warn-text">{error}</p>}
    <Jobs jobs={dashboard?.jobs ?? []} busy={busy} onCancel={id => void run(async () => {await modalApi.post(`/jobs/${id}/cancel`); await refresh();})} />
    <button disabled={busy || loading} onClick={() => void refresh()}>接続状態・履歴を更新</button>
  </section>;
};

export const ModalGenerateCard: React.FC = () => {
  const s = useStudio();
  const [provider, setProvider] = useState('existing');
  return <section className="card modal-cloud">
    <h2>AIプロバイダー・素材生成</h2>
    <label>使うAI<select value={provider} onChange={e => setProvider(e.target.value)}>
      <option value="existing">既存AI（台本・素材のタグ付け）</option>
      <option value="modal">Modal Cloud GPU（画像・動画の生成）</option>
    </select></label>
    {provider === 'existing' ? <p className="hint">既存AIのタグ付けは、この画面の「AIでタグ付け」から利用できます。台本は「AIで台本」から作成できます。</p> : <ModalGenerateLocal key={s.active} />}
  </section>;
};

const ModalGenerateLocal: React.FC = () => {
  const s = useStudio();
  const {settings, dashboard, error, setError, loading, refresh} = useModal();
  const [kind, setKind] = useState<ModalTask>('text-to-image');
  const [prompt, setPrompt] = useState('');
  const [image, setImage] = useState<string>();
  const [steps, setSteps] = useState(20);
  const [size, setSize] = useState('512x512');
  const [frames, setFrames] = useState(17);
  const [allow, setAllow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [preview, setPreview] = useState<{url: string; job: ModalJob} | null>(null);
  const previewRef = useRef('');
  const [pending, setPending] = useState<ModalJobInput | null>(null);
  const frozen = !!pending;
  useEffect(() => {if (pending && dashboard?.jobs.some(j => j.id === pending.requestId)) {setPending(null); setAllow(false);}}, [dashboard, pending]);
  useEffect(() => () => {if (previewRef.current) URL.revokeObjectURL(previewRef.current);}, []);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try {await fn();} catch (e) {setError(errorText(e));} finally {setBusy(false);}
  };
  const input = (): ModalJobInput => {
    const [width, height] = size.split('x').map(Number);
    return {kind, prompt, negativePrompt: '', width, height, steps, frames, seed: 42, strength: 0.7, ...(kind.startsWith('image-to-') ? {imageBase64: image} : {}), allowGpu: true, requestId: crypto.randomUUID()};
  };
  return <div>
    <Overview dashboard={dashboard} settings={settings} />
    {!settings?.configured && <p className="warn-text">設定画面の「Modal Cloud GPU」で接続を設定してください。</p>}
    <div className="modal-fields">
      <label>生成方法<select disabled={busy || frozen} value={kind} onChange={e => {setKind(e.target.value as ModalTask); setEstimate(null);}}>{(['text-to-image', 'image-to-image', 'image-to-video', 'text-to-video'] as const).map(k => <option key={k} value={k}>{MODAL_TASK_LABEL[k]}</option>)}</select></label>
      <label>出力サイズ<select disabled={busy || frozen} value={size} onChange={e => {setSize(e.target.value); setEstimate(null);}}><option>512x512</option><option>320x576</option><option>576x320</option></select></label>
      <label className="modal-wide">プロンプト<textarea disabled={busy || frozen} rows={3} maxLength={2000} value={prompt} onChange={e => {setPrompt(e.target.value); setEstimate(null);}} placeholder="例: Cinematic close-up of steaming ramen, soft warm lighting" /></label>
      {kind.startsWith('image-to-') && <label className="modal-wide">入力画像（PNG・JPEG・WebP、最大{s.isCloud ? 2 : 6}MB）<input disabled={busy || frozen} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => {
        setImage(undefined);
        const file = e.target.files?.[0]; if (!file) return;
        const maxMb = s.isCloud ? 2 : 6;
        if (file.size > maxMb * 1024 ** 2) {setError(`画像は${maxMb}MB以下にしてください`); return;}
        const reader = new FileReader(); reader.onload = () => setImage(String(reader.result).split(',')[1]); reader.onerror = () => setError('画像を読み込めません'); reader.readAsDataURL(file);
      }} /></label>}
      <label>推論ステップ<input disabled={busy || frozen} type="number" min={1} max={40} value={steps} onChange={e => setSteps(e.target.valueAsNumber)} /></label>
      {kind.endsWith('video') && <label>フレーム数（16fps）<select disabled={busy || frozen} value={frames} onChange={e => setFrames(Number(e.target.value))}><option value={17}>17（約1秒・軽量テスト）</option><option value={33}>33（約2秒）</option><option value={49}>49（約3秒）</option></select></label>}
    </div>
    <p className="hint">画像: SSD-1B ／ Text to Video: Wan 2.1 1.3B ／ Image to Video: Wan 2.2 5B。各モデルはApache-2.0として公開されています。初回はモデルのダウンロード・読込にも時間と料金がかかります。画像はPNG、動画はMP4で保存できます。画像を案件に追加すると3秒のMP4素材になります。</p>
    {s.isCloud && <p className="hint">生成・結果の確認はPCの起動なしで利用できます。「この案件の素材に追加」はPC版Reel Studioが起動すると実行されます。素材の保存先はPCのままです。</p>}
    <div className="modal-actions"><button disabled={busy || !settings?.configured || !prompt.trim()} onClick={() => void run(async () => {const payload = input(); const r = await modalApi.post<{estimatedCostUsd: number}>('/estimate', payload); setEstimate(r.estimatedCostUsd);})}>概算を確認（GPU起動なし）</button>{estimate !== null && <span>上限予約額: {usd(estimate)}</span>}</div>
    <label className="modal-consent"><input type="checkbox" checked={allow} onChange={e => setAllow(e.target.checked)} />このジョブのGPU起動・利用料金を許可する</label>
    <div className="modal-actions"><button className="primary" disabled={busy || !settings?.configured || !allow || !prompt.trim() || kind.startsWith('image-to-') && !image || !!dashboard?.usage.activeJobId} onClick={() => void run(async () => {
      // Keep request ID across a network failure; retry is idempotent.
      const payload = pending ?? input();
      setPending(payload);
      try {await modalApi.post('/jobs', payload); setPending(null); setAllow(false);}
      catch (e) {if ((e as {status?: number}).status && (e as {status: number}).status < 500) setPending(null); throw e;}
      await refresh();
    })}>Modalで生成する</button><button disabled={busy || loading} onClick={() => void refresh()}>履歴を更新</button></div>
    {frozen && <p className="hint">送信結果を確認中です。再送しても同じジョブIDを使用します。内容を変更する前に履歴で受付状況を確認してください。</p>}
    {busy && <p role="status">処理中…</p>}{error && <p role="alert" className="warn-text">{error}</p>}
    <Jobs jobs={dashboard?.jobs ?? []} busy={busy} onCancel={id => void run(async () => {await modalApi.post(`/jobs/${id}/cancel`); await refresh();})}
      onPreview={j => void run(async () => {const blob = await modalApi.blob(`/jobs/${j.id}/result`); if (previewRef.current) URL.revokeObjectURL(previewRef.current); previewRef.current = URL.createObjectURL(blob); setPreview({url: previewRef.current, job: j});})}
      onImport={j => void run(async () => {if (s.files.catalog.dirty) throw new Error('素材の未保存の変更を保存してから追加してください'); if (!s.active) return; const r = await modalApi.post<{catalogJob: {id: string}}>(`/jobs/${j.id}/import`, {slug: s.active}); s.toast(`素材取り込みを開始しました（${r.catalogJob.id}）`, 'ok'); await s.reloadActive();})} />
    {preview && <div className="modal-preview">{preview.job.resultType === 'video/mp4' ? <video src={preview.url} controls playsInline /> : <img src={preview.url} alt="Modalで生成した画像" />}<a className="button" href={preview.url} download={`${preview.job.id}.${preview.job.resultType === 'video/mp4' ? 'mp4' : 'png'}`}>生成結果を保存</a></div>}
  </div>;
};
