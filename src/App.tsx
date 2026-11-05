import React, {useEffect, useMemo, useRef, useState} from 'react';
import {useStudio} from './state/store';
import {ProjectsPage} from './pages/Projects';
import {MaterialsPage} from './pages/Materials';
import {BriefPage} from './pages/Brief';
import {EditorPage} from './editor/EditorPage';
import {LockedScriptContinuation} from './components/LockedScriptContinuation';
import {RenderPage} from './pages/Render';
import {SettingsPage} from './pages/Settings';
import {Tour, type TourTab} from './components/Tour';
import {HelpPanel} from './components/HelpPanel';
import {UpdatePrompt} from './components/UpdatePrompt';
import {InstallHint} from './components/InstallHint';
import {nextStepOf} from './components/nextStep';
import {visibleProjects} from './components/projectList';
import {useStringPref, writePref} from './hooks/usePref';
import {AI_JOB_LABEL} from './components/AiJobStatus';
import {readTheme, saveTheme, type Theme} from './theme';
import {AGENT_PROVIDER_LABEL, type AgentStatus} from '@shared/schema/settings';
import {version} from '../package.json';
import {PwaUpdateNotice} from './components/PwaUpdateNotice';

const TABS: {id: TourTab; label: string; sub: string}[] = [
  {id: 'projects', label: '案件', sub: '一覧'},
  {id: 'materials', label: '素材', sub: '取り込み・選別'},
  {id: 'brief', label: 'AIで台本', sub: '企画・作成'},
  {id: 'timeline', label: '編集', sub: '仕上げ'},
  {id: 'render', label: '書き出し', sub: '動画を保存'},
  {id: 'settings', label: '設定', sub: 'AI・スキル'},
];

/** スマホの下部ナビに出す記号（画像を増やさずに済ませる） */
const TAB_ICON: Record<TourTab, React.ReactNode> = {
  projects: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></>,
  materials: <><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m8 14 3-3 5 6M14 7h.01"/></>,
  brief: <><path d="M14 3H5v18h14V8Z M14 3v5h5M8 12h8M8 16h6"/></>,
  timeline: <><path d="M3 6h18M3 12h18M3 18h18M7 3v6M15 9v6M10 15v6"/></>,
  render: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
  settings: <><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/></>,
};
type Tab = TourTab;
const isTab = (v: string): v is Tab => TABS.some((t) => t.id === v);

/**
 * いま AI がどこに繋がっているか（Claude / DeepSeek とモデル）。どの画面でも上部に出し、押すと Settings へ。
 * 使えない状態（claude が無い・DeepSeek の鍵が無い）は赤で出す
 */
const AgentBadge: React.FC<{agent: AgentStatus; onClick: () => void}> = ({agent, onClick}) => {
  const name = AGENT_PROVIDER_LABEL[agent.provider] ?? agent.provider;
  return (
    <button
      className={`pill agent-badge ${agent.ready ? `agent-${agent.provider}` : 'err'}`}
      onClick={onClick}
      title={`AI の接続先: ${name}（モデル ${agent.model}）${agent.problem ? `\n${agent.problem}` : ''}\n押すと Settings の「AI」で切り替えられます`}
      aria-label={`AI の接続先 ${name}`}
    >
      <span className="agent-badge-dot" aria-hidden="true" />
      AI: {name}
      {agent.ready ? <span className="agent-badge-model">{agent.model || 'CLI の既定'}</span> : <span>{agent.issue === 'no-key' ? '・鍵が未設定' : agent.issue === 'no-codex' ? '・codex なし' : agent.issue === 'no-codex-login' ? '・未ログイン' : '・claude なし'}</span>}
    </button>
  );
};

export const App: React.FC = () => {
  const s = useStudio();
  const [tabPref, setTabPref] = useStringPref('reel-studio.tab', 'projects');
  const tab: Tab = isTab(tabPref) ? tabPref : 'projects';
  const [help, setHelp] = useState(false);
  const [tour, setTour] = useState(false);
  const [tourDone, setTourDone] = useStringPref('reel-studio.tourDone', '');
  const [nextBarPref, setNextBarPref] = useStringPref('reel-studio.nextbar', '1');
  const nextBarHidden = nextBarPref === '0';
  const [theme, setTheme] = useState<Theme>(readTheme);
  const toggleTheme = () => {
    const t: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(t);
    saveTheme(t);
  };

  const go = (t: Tab) => setTabPref(t);

  // 上部バーの高さを CSS から参照できるようにする（--topbar-h）。
  // 追従（sticky）させる要素は、これを避けた位置で止めないとバーの裏に隠れる。
  // 高さはタブの折り返しや警告のピルで変わるので、実測して変化を追う
  const topbarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = topbarRef.current;
    if (!el) return;
    const apply = () => document.documentElement.style.setProperty('--topbar-h', `${Math.round(el.getBoundingClientRect().height)}px`);
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 初回起動時だけガイドツアーを自動で出す
  useEffect(() => {
    if (tourDone !== '1') setTour(true);
    // 初回だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const closeTour = () => {
    setTour(false);
    setTourDone('1');
  };

  // ? でヘルプ（入力中は邪魔しない）／数字キーでタブ移動（Ctrl+1〜6）
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const editing = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !editing) {
        e.preventDefault();
        setHelp((v) => !v);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && /^[1-6]$/.test(e.key)) {
        e.preventDefault();
        go(TABS[Number(e.key) - 1].id);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const next = useMemo(
    () =>
      nextStepOf({
        active: s.active,
        catalog: s.files.catalog.data,
        brief: s.files.brief.data,
        cuts: s.files.cuts.data,
        narration: s.files.narration.data,
        caption: s.caption.text,
        dirty: {catalog: s.files.catalog.dirty, brief: s.files.brief.dirty, cuts: s.files.cuts.dirty},
      }),
    [s.active, s.files, s.caption.text],
  );

  // タブを複数開いたときに見分けが付くよう、タイトルに案件名を出す
  useEffect(() => {
    document.title = s.active ? `${s.active} — Reel Studio` : 'Reel Studio';
  }, [s.active]);

  const running = s.jobs.find((j) => j.status === 'running' && j.slug === s.active) ?? s.jobs.find((j) => j.status === 'running');
  const dirty = (Object.keys(s.files) as (keyof typeof s.files)[]).filter((k) => s.files[k].dirty);

  return (
    <div className="app">
      <header className="topbar" ref={topbarRef}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <img src="/icons/reel-studio.svg" alt="" width="26" height="26" />
          </span>
          <span className="brand-name">Reel Studio <span className="app-version">v{version}</span></span>
        </div>
        <nav className="tabs" data-tour="tabs" aria-label="メインメニュー">
          {TABS.map(({id, label, sub}, n) => (
            <button key={id} className={tab === id ? 'tab active' : 'tab'} onClick={() => go(id)} aria-current={tab === id ? 'page' : undefined} title={`${sub}（Ctrl+${n + 1}）`}>
              <span className="tab-no">{n + 1}</span>
              {label}
              <span className="tab-sub">{sub}</span>
            </button>
          ))}
        </nav>
        <button className="icon-btn help-btn" data-tour="help" onClick={() => setHelp(true)} title="使い方・ショートカット（? キー）" aria-label="使い方">
          ?
        </button>
        <button className="icon-btn theme-btn" onClick={toggleTheme} title={theme === 'dark' ? '明るい配色にする' : '暗い配色にする'} aria-label="配色を切り替える">
          {theme === 'dark' ? '☀' : '☾'}
        </button>
        <div className="status">
          <select data-tour="project-select" value={s.active ?? ''} onChange={(e) => e.target.value && s.setActive(e.target.value)} title="編集中の案件" aria-label="編集中の案件">
            <option value="">（案件を選択）</option>
            {/* 投稿済みにして隠した案件は出さない。ただし開いている案件だけは必ず残す（選択が空欄になるのを防ぐ） */}
            {visibleProjects(s.projects, {active: s.active, showArchived: false}).map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.slug}
                {p.archivedAt ? '（非表示）' : ''}
              </option>
            ))}
          </select>
          {/* PC で直したものを取り込む。クラウド版では PC に「いま送って」と頼んでから読み直す
              （棚卸しは 5 分ごとなので、押さないと出てこないことがある） */}
          <button
            className="small pull-btn"
            onClick={() => void s.pullLatest()}
            disabled={s.pulling}
            title={
              s.isCloud
                ? 'PC に最新を送らせて取り込みます（キャプション・構成・書き出し・サムネイル）。未保存の編集は上書きしません'
                : '案件のファイルを読み直します（未保存の編集は上書きしません）'
            }
          >
            {s.pulling ? '取り込み中…' : '⟳ 最新に'}
          </button>
          {s.config?.agent && <AgentBadge agent={s.config.agent} onClick={() => go('settings')} />}
          {s.config?.stale && (
            <span className="pill err" title="起動したあとにツールのコードが更新されています。画面だけ新しく、サーバーは古い規則のまま動いています">
              ⚠ サーバーが古い：Reel Studio を再起動してください
            </span>
          )}
          {dirty.length > 0 && <span className="pill warn">未保存: {dirty.join(', ')}</span>}
          {running && (
            <span className="pill run" title={`${running.slug} / ${running.type}`}>
              {AI_JOB_LABEL[running.type] ?? running.type} {running.progress && running.progress.total > 0 ? `${running.progress.done}/${running.progress.total}` : '…'}
            </span>
          )}
        </div>
      </header>

      {/* PCの接続状態と、独立したModal処理の利用可否を混同しない。 */}
      {s.isCloud && s.config?.worker && !s.config.worker.online && (
        <div className="offlinebar">
          <span className="pill warn">PC未接続</span>
          <span>
            Modalの素材転送・軽量プレビュー・クラウド書き出しはPC接続不要です。AI台本・音声生成・PCでの書き出しなど、PCに依頼した処理は、PCでReel Studioを起動すると実行されます。
            {s.config.worker.lastSeen && <> PCの最終応答: {new Date(s.config.worker.lastSeen).toLocaleString('ja-JP')}</>}
          </span>
        </div>
      )}
      <InstallHint />

      {!nextBarHidden && (
        <div className={`nextbar${next.ready ? ' ready' : ''}`} data-tour="next">
          <span className="nextbar-tag">次にやること</span>
          <span className="nextbar-text">{next.text}</span>
          <button className="small" onClick={() => go(next.tab)} disabled={tab === next.tab}>
            {tab === next.tab ? 'この画面です' : next.cta}
          </button>
          <button className="small nextbar-x" title="非表示にする（右上の「?」から戻せます）" onClick={() => setNextBarPref('0')}>
            ×
          </button>
        </div>
      )}

      <LockedScriptContinuation />
      <main className={`main${tab === 'timeline' ? ' main-editor' : ''}`}>
        {/* key に案件を入れて、案件を切り替えたら各画面の状態（選択カット・Undo 履歴・遅延中のプレビュー等）を捨てる。
            残していると、前の案件のカットを新しい案件の URL で読みにいってしまう */}
        {tab === 'projects' && <ProjectsPage />}
        {tab === 'materials' && <MaterialsPage key={s.active ?? ''} onTab={go} />}
        {tab === 'brief' && <BriefPage key={s.active ?? ''} onGoTimeline={() => go('timeline')} onTab={go} />}
        {tab === 'timeline' && <EditorPage key={s.active ?? ''} onTab={go} />}
        {tab === 'render' && <RenderPage key={s.active ?? ''} onTab={go} />}
        {/* Settings は案件に依存しないので key を付けない（案件を切り替えても入力中の値を捨てない） */}
        {tab === 'settings' && <SettingsPage onCreate={() => {if (s.active) writePref(`reel-studio.brief.route.${s.active}`, 'script'); go(s.active ? 'brief' : 'projects');}} />}
      </main>

      {/* スマホ用の下部ナビ。desktop では CSS で隠れる（上のタブがそのまま使われる） */}
      <nav className="bottomnav" aria-label="モバイルメニュー">
        {TABS.map(({id, label, sub}) => (
          <button key={id} className={tab === id ? 'bn active' : 'bn'} onClick={() => go(id)} aria-current={tab === id ? 'page' : undefined} aria-label={`${label}（${sub}）`}>
            <span className="bn-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{TAB_ICON[id]}</svg>
            </span>
            <span className="bn-label">{label}</span>
          </button>
        ))}
      </nav>

      <div className="toasts">
        {s.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>

      <HelpPanel
        open={help}
        onClose={() => setHelp(false)}
        onTab={go}
        onStartTour={() => {
          setHelp(false);
          setTour(true);
        }}
        nextBarHidden={nextBarHidden}
        onNextBar={(show) => setNextBarPref(show ? '1' : '0')}
      />
      <Tour open={tour} tab={tab} onTab={go} onClose={closeTour} />
      {/* 新しい版のお知らせ（PC で動かしているときだけ。クラウド版では何も出さない） */}
      <UpdatePrompt held={tour || help} />
      <PwaUpdateNotice hasUnsavedChanges={dirty.length > 0} />
    </div>
  );
};
