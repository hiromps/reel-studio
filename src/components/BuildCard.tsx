// 「仕上げ」カード：案件の状態から、完成動画までに残っている工程（原稿 → 音声 → レンダー → 合成 → 納品）を
// 一覧にして、選んだものを 1 つのジョブとして順に走らせる。段取りの判断は shared/build.ts。
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {api, type Job} from '../api';
import {useStudio} from '../state/store';
import {AiModelSelect, useAiModel} from '../hooks/useAiModel';
import {AiJobStatus} from './AiJobStatus';
import {IssueList} from './IssueList';
import {AliasFixNotice} from './AliasFix';
import {buildSelectionIssues, defaultBuildSelection, orderBuildSteps, type BuildFacts, type BuildStep, type BuildStepId} from '@shared/build';

type PlanRes = {facts: BuildFacts; steps: BuildStep[]};

const STATUS_LABEL: Record<BuildStep['status'], string> = {done: '済', todo: '実行', blocked: '不可'};

export const BuildCard: React.FC<{onTab: (t: 'timeline') => void}> = ({onTab}) => {
  const s = useStudio();
  const [plan, setPlan] = useState<PlanRes | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<BuildStepId[]>([]);
  const [touched, setTouched] = useState(false);
  const [allowErrors, setAllowErrors] = useState(false);
  const [label, setLabel] = useState('');
  const [model, setModel] = useAiModel();
  const unsupported = !s.supportsJob('build');
  const job = s.jobs.find((j) => j.type === 'build' && j.slug === s.active && (j.status === 'running' || j.status === 'queued'));
  const last = s.jobs.find((j) => j.type === 'build' && j.slug === s.active && (j.status === 'done' || j.status === 'failed'));
  const dirty = (['cuts', 'narration', 'brief', 'catalog'] as const).filter((k) => s.files[k].dirty);

  const load = useCallback(async () => {
    if (!s.active) return;
    try {
      const r = await api.get<PlanRes>(`/api/projects/${encodeURIComponent(s.active)}/build`);
      setPlan(r.data);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [s.active]);

  // 案件の状態が変わるたびに段取りを取り直す（ジョブ完了・ファイル保存）
  const doneCount = s.jobs.filter((j) => j.slug === s.active && (j.status === 'done' || j.status === 'failed')).length;
  const etags = `${s.files.cuts.etag}|${s.files.narration.etag}|${s.caption.etag}`;
  useEffect(() => {
    void load();
  }, [load, doneCount, etags]);

  // 段取りが変わったら（ユーザーが触っていなければ）既定の選択に戻す
  useEffect(() => {
    if (!plan) return;
    if (!touched) setSelected(defaultBuildSelection(plan.steps));
    else setSelected((cur) => cur.filter((id) => plan.steps.find((x) => x.id === id)?.status !== 'blocked'));
  }, [plan, touched]);

  const issues = useMemo(() => (plan ? buildSelectionIssues(plan.steps, selected) : []), [plan, selected]);
  const aiSelected = selected.some((id) => plan?.steps.find((x) => x.id === id)?.ai);
  const willRun = orderBuildSteps(selected);
  const blockedBy = unsupported ? 'サーバーが古いプロセスです。Reel Studio を再起動してください' : dirty.length ? `${dirty.join(', ')} に未保存の変更があります。先に保存してください` : job ? '実行中です' : !willRun.length ? '走らせる工程を選んでください' : issues.length ? '選び方に問題があります（下の指摘）' : null;

  const run = async () => {
    if (blockedBy) return s.toast(blockedBy, 'error');
    const j = await s.addJob('build', {steps: willRun, model, allowErrors, label: label.trim() || undefined});
    if (j) setTouched(false);
  };
  const toggle = (id: BuildStepId) => {
    setTouched(true);
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : orderBuildSteps([...cur, id])));
  };

  if (!s.active) return null;
  const result = last?.result as {ran?: string[]; delivered?: string[]; costUsd?: number} | undefined;
  const allDone = plan && plan.steps.every((x) => x.status === 'done' || x.id === 'deliver');

  return (
    <section className="card build-card" data-tour="build">
      <div className="summary">
        <span>
          <b>仕上げ（完成動画まで一気に）</b>
        </span>
        <span className="hint">案件の状態を見て、残っている工程だけを順に走らせます。途中で失敗したらそこで止まり、直してから押し直せます</span>
        <span style={{flex: 1}} />
        <button className="small" onClick={() => void load()} title="状態を取り直す">
          状態を更新
        </button>
      </div>
      {err && <div className="issue E"><span className="code">E</span><span>{err}</span></div>}
      {plan && (
        <div className="build-steps">
          {plan.steps.map((st, i) => {
            const on = selected.includes(st.id);
            return (
              <label key={st.id} className={`build-step ${st.status}${on ? ' on' : ''}`} title={st.detail}>
                <input type="checkbox" checked={on} disabled={st.status === 'blocked' || !!job} onChange={() => toggle(st.id)} />
                <span className="build-no">{i + 1}</span>
                <span className={`build-status ${st.status}`}>{STATUS_LABEL[st.status]}</span>
                <span className="build-label">
                  {st.label}
                  {st.ai ? <span className="pill" style={{marginLeft: 6}}>課金</span> : null}
                </span>
                <span className="hint build-detail">{st.detail}</span>
              </label>
            );
          })}
        </div>
      )}
      {plan && plan.facts.placeholders > 0 && (
        <div className="issue W" style={{marginTop: 4}}>
          <span className="code">W</span>
          <span>
            テロップが {plan.facts.placeholders} 件未記入です。
            <button className="small" style={{marginLeft: 6}} onClick={() => onTab('timeline')}>
              Timeline で埋める
            </button>
          </span>
        </div>
      )}
      <AliasFixNotice />
      <div className="row" style={{marginTop: 8}}>
        <button className="primary" onClick={() => void run()} disabled={!!blockedBy} title={blockedBy ?? `${willRun.length} 工程を順に実行します`}>
          {job ? '実行中…' : allDone && willRun.length <= 1 ? '納品する' : `仕上げを実行（${willRun.length} 工程）`}
        </button>
        {aiSelected && <AiModelSelect value={model} onChange={setModel} />}
        <label className="sb-inline" title="検証の E（画角の連続・フックの型など）を承知でレンダーする。素材が無い等の致命的なものは通りません">
          <input type="checkbox" checked={allowErrors} onChange={(e) => setAllowErrors(e.target.checked)} />
          <span>指摘を承知でレンダー</span>
        </label>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="納品名に足す語（任意）：修正版 など" style={{width: 200}} />
        {job && (
          <button className="danger small" onClick={() => void s.cancelJob(job.id)}>
            中断
          </button>
        )}
      </div>
      {issues.length > 0 && <IssueList rows={issues.map((m) => ({severity: 'W', message: m}))} />}
      {job && <AiJobStatus job={job} onCancel={(id) => void s.cancelJob(id)} compact />}
      {last && !job && (
        <div className="issues" style={{marginTop: 6}}>
          {last.status === 'failed' ? (
            <div className="issue E">
              <span className="code">E</span>
              <span style={{whiteSpace: 'pre-wrap'}}>{last.error}</span>
            </div>
          ) : (
            <div className="issue">
              <span className="code">✓</span>
              <span>
                完了: {(result?.ran ?? []).join(' → ')}
                {result?.delivered?.length ? ` ／ 納品: ${result.delivered.join(', ')}` : ''}
                {result?.costUsd ? ` ／ AI $${result.costUsd.toFixed(2)}` : ''}
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
};

export const jobIsBuild = (j: Job) => j.type === 'build';
