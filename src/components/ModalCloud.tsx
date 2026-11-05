import React, {useCallback, useEffect, useRef, useState} from 'react';
import {modalApi} from '../modal-api';
import {MODAL_GPU, MODAL_SECRET_KEYS, MODAL_STATUS_LABEL, MODAL_TASK_LABEL, type ModalDashboard, type ModalJob, type ModalJobInput, type ModalSettingsView} from '@shared/modal';
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
    <p>Reel Studioで編集した映像・字幕・生成済み音声をクラウドで合成し、完成MP4を書き出します。編集を軽くするプレビュー作成にも使います。</p>
    <p className="hint">案件を開き、「書き出し」→「書き出す場所」→「Modalクラウド」から実行できます。画像・動画をAIで新しく生成する機能は提供しません。接続確認や画面を開くだけではGPUを起動しません。</p>
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
      <p className="hint">GPUテストは接続の診断用です。実際の動画の書き出しは案件の「書き出し」画面から行います。診断の実行上限30秒に加え、コールドスタート等も予約額に含めます。</p>
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
    <Jobs jobs={(dashboard?.jobs ?? []).filter(j => active(j) || ['remotion-render', 'prepare-media', 'gpu-test'].includes(j.kind))} busy={busy} onCancel={id => void run(async () => {await modalApi.post(`/jobs/${id}/cancel`); await refresh();})} />
    <button disabled={busy || loading} onClick={() => void refresh()}>接続状態・履歴を更新</button>
  </section>;
};
