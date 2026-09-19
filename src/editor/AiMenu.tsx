// 「AI ▾」メニュー：裏で claude を走らせる作業（テロップ・並べ替え・自由指示・ナレーション原稿）を 1 か所に。
import React, {useEffect, useRef, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import {AiModelSelect, useAiModel} from '../hooks/useAiModel';
import {IssueList} from '../components/IssueList';

type Props = {
  placeholders: number;
  cutCount: number;
  hasCuts: boolean;
  hasOrderCheck: boolean;
};

const RESTART_HINT = 'Reel Studio を再起動してください（画面だけ新しく、サーバーが古いプロセスです）';

export const AiMenu: React.FC<Props> = ({placeholders, cutCount, hasCuts, hasOrderCheck}) => {
  const s = useStudio();
  const [model, setModel] = useAiModel();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'menu' | 'edit'>('menu');
  const [instruction, setInstruction] = useState('');
  const [orderExport, setOrderExport] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const aiBusy = s.jobs.some((j) => j.type.startsWith('ai-') && (j.status === 'running' || j.status === 'queued'));
  const stale = (t: string) => !s.supportsJob(t);
  /**
   * AI のジョブは**サーバーがディスクの cuts.json を読む**。画面に未保存の変更があると
   * 古い構成のまま走り、「18 カットあるのに 11 しか見てくれない」ような食い違いになる。
   */
  const unsaved = s.files.cuts.dirty || s.files.narration.dirty ? '未保存の変更があります。保存（Ctrl+S）してから実行してください' : null;
  const lastEdit = s.jobs.find((j) => j.type === 'ai-edit' && (j.status === 'done' || j.status === 'failed'));
  const editResult = lastEdit?.result as {summary?: string; applied?: string[]; unapplied?: string[]; needsTts?: string[]} | undefined;

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', h);
    window.addEventListener('keydown', k);
    return () => {
      window.removeEventListener('mousedown', h);
      window.removeEventListener('keydown', k);
    };
  }, [open]);

  const run = async (type: string, params: Record<string, unknown> = {}) => {
    if (unsaved) return s.toast(unsaved, 'error');
    const j = await s.addJob(type, {model, ...params});
    if (j) setOpen(false);
  };
  const sendEdit = async () => {
    const text = instruction.trim();
    if (!text) return;
    if (unsaved) return s.toast(unsaved, 'error');
    const j = await s.addJob('ai-edit', {instruction: text, model});
    if (j) {
      setInstruction('');
      setOpen(false);
    }
  };
  const exportOrderForAi = async () => {
    if (!s.active) return;
    try {
      const r = await api.post<{file: string; payload: {clips: unknown[]}}>(`/api/projects/${s.active}/order/export`, {});
      setOrderExport(r.data.file);
      s.toast(`並べ替え用の素材リストを書き出しました（${r.data.payload.clips.length} 本）`, 'ok');
    } catch (e) {
      s.toast(`書き出しに失敗: ${(e as Error).message}`, 'error');
    }
  };

  const item = (label: string, type: string, params: Record<string, unknown>, opt: {disabled?: boolean; title?: string; primary?: boolean} = {}) => (
    <button className={`ai-item${opt.primary ? ' primary' : ''}`} onClick={() => void run(type, params)} disabled={aiBusy || stale(type) || opt.disabled || !!unsaved} title={stale(type) ? RESTART_HINT : (unsaved ?? opt.title)}>
      {label}
    </button>
  );

  return (
    <div className="ai-menu" ref={rootRef} data-tour="ai-menu">
      <button className={`primary${open ? ' on' : ''}`} onClick={() => setOpen((v) => !v)} disabled={!hasCuts} title="裏で Claude を起動して作業を代行させます（API 課金が発生します）">
        {aiBusy ? 'AI 作業中…' : 'AI ▾'}
      </button>
      {/* 狭い画面では画面中央のダイアログになる。後ろを覆っておくと、
          どこを押せば閉じるかが分かるし、下の画面を誤って触らない */}
      {open && <div className="ai-backdrop" onClick={() => setOpen(false)} aria-hidden />}
      {open && (
        <div className="ai-pop card">
          {mode === 'menu' ? (
            <>
              <div className="summary ai-pop-head">
                <AiModelSelect value={model} onChange={setModel} />
                {unsaved && <span className="pill warn">{unsaved}</span>}
                <span style={{flex: 1}} />
                {/* 狭い画面では画面下のシートになる。外を押して閉じる操作が効かないので出口を置く */}
                <button className="small" onClick={() => setOpen(false)} aria-label="閉じる">
                  閉じる
                </button>
              </div>
              <div className="ai-items">
                {item(`テロップを書いてもらう（未記入 ${placeholders}）`, 'ai-telop', {}, {disabled: placeholders === 0, title: '各テロップのカット頭の画を見て {{gNN:intent}} を埋めます。記入済みには触りません', primary: placeholders > 0})}
                {item(`テロップを全部書き直す（${cutCount} カット）`, 'ai-telop', {force: true}, {title: '記入済みも含めて全部書き直します'})}
                <button className="ai-item" onClick={() => setMode('edit')} disabled={aiBusy || stale('ai-edit') || !!unsaved} title={stale('ai-edit') ? RESTART_HINT : (unsaved ?? '直したいことを文で書いて送ると、テロップ・ナレーション・カットの区間や並びを直します')}>
                  直してもらう（自由指示）…
                </button>
                {item('ナレーション原稿を書いてもらう', 'ai-narration', {}, {title: 'テロップと映像に沿った narration.json を書きます（音声はあとで Render の「音声を生成」）'})}
                {hasOrderCheck && item('並べ替えてもらう（型どおりに再 plan）', 'ai-order', {write: true}, {title: '素材を見て並び順を決め直し、cuts.json まで書きます。記入済みのテロップは作り直しになります'})}
                {hasOrderCheck && (
                  <button className="ai-item" onClick={() => void exportOrderForAi()} title="自分で Claude に頼むための素材リストを書き出すだけ（並べ替えは実行しません）">
                    並べ替え用の素材リストを書き出すだけ
                  </button>
                )}
              </div>
              <div className="hint" style={{marginTop: 6}}>
                API 課金が発生します。AI の文言は下書き扱いなので必ず読み直してください
                {orderExport ? ` ／ 書き出し: ${orderExport}` : ''}
              </div>
              {lastEdit && (
                <details style={{marginTop: 6}}>
                  <summary className="hint">前回の「直してもらう」の結果</summary>
                  <EditResult status={lastEdit.status} error={lastEdit.error} r={editResult} />
                </details>
              )}
            </>
          ) : (
            <>
              <div className="summary ai-pop-head">
                <b>AI に直してもらう</b>
                <span style={{flex: 1}} />
                <button className="small" onClick={() => setMode('menu')}>
                  ← 戻る
                </button>
                <button className="small" onClick={() => setOpen(false)} aria-label="閉じる">
                  閉じる
                </button>
              </div>
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    void sendEdit();
                  }
                }}
                placeholder={'例）\n3カット目のテロップをもっと短く\nナレーション n03 の言い回しを変えて。語尾が前と同じで単調\n最後のカットを0.5秒詰めて\n煙のカットをもっと前に持ってきて'}
                style={{minHeight: 96, width: '100%'}}
                autoFocus
              />
              <div className="row" style={{marginTop: 6}}>
                <button className="primary" onClick={() => void sendEdit()} disabled={aiBusy || !instruction.trim()}>
                  送信（Ctrl+Enter）
                </button>
                <AiModelSelect value={model} onChange={setModel} />
                <span className="hint">変更前は .studio/backups に残ります</span>
              </div>
              {lastEdit && <EditResult status={lastEdit.status} error={lastEdit.error} r={editResult} />}
            </>
          )}
        </div>
      )}
    </div>
  );
};

const EditResult: React.FC<{status: string; error?: string; r?: {summary?: string; applied?: string[]; unapplied?: string[]; needsTts?: string[]}}> = ({status, error, r}) => {
  if (status === 'failed') return <IssueList rows={[{severity: 'E', message: error ?? '失敗'}]} />;
  return (
    <div style={{marginTop: 6}}>
      {r?.summary && <div className="hint">{r.summary}</div>}
      <IssueList
        rows={[
          ...(r?.applied ?? []).map((a) => ({severity: 'info' as const, code: '✓', message: a})),
          ...(r?.unapplied ?? []).map((u) => ({severity: 'W' as const, message: u})),
          ...((r?.needsTts ?? []).length ? [{severity: 'E' as const, code: '要再生成', message: `ナレーション ${(r!.needsTts ?? []).join(', ')} は文言が変わりました。Render の「音声を生成」で作り直してください`}] : []),
        ]}
      />
    </div>
  );
};
