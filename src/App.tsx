import React, {useEffect, useMemo, useRef, useState} from 'react';
import {useStudio} from './state/store';
import {ProjectsPage} from './pages/Projects';
import {MaterialsPage} from './pages/Materials';
import {BriefPage} from './pages/Brief';
import {EditorPage} from './editor/EditorPage';
import {RenderPage} from './pages/Render';
import {SettingsPage} from './pages/Settings';
import {Tour, type TourTab} from './components/Tour';
import {HelpPanel} from './components/HelpPanel';
import {InstallHint} from './components/InstallHint';
import {nextStepOf} from './components/nextStep';
import {useStringPref} from './hooks/usePref';
import {AI_JOB_LABEL} from './components/AiJobStatus';

const TABS: {id: TourTab; label: string; sub: string}[] = [
  {id: 'projects', label: 'Projects', sub: '案件'},
  {id: 'materials', label: 'Materials', sub: '素材'},
  {id: 'brief', label: 'Brief', sub: '企画'},
  {id: 'timeline', label: 'Timeline', sub: '編集'},
  {id: 'render', label: 'Render', sub: '書き出し'},
  {id: 'settings', label: 'Settings', sub: '設定'},
];

/** スマホの下部ナビに出す記号（画像を増やさずに済ませる） */
const TAB_ICON: Record<TourTab, string> = {projects: '◰', materials: '▤', brief: '✎', timeline: '⟷', render: '▶', settings: '⚙'};
type Tab = TourTab;
const isTab = (v: string): v is Tab => TABS.some((t) => t.id === v);

export const App: React.FC = () => {
  const s = useStudio();
  const [tabPref, setTabPref] = useStringPref('reel-studio.tab', 'projects');
  const tab: Tab = isTab(tabPref) ? tabPref : 'projects';
  const [help, setHelp] = useState(false);
  const [tour, setTour] = useState(false);
  const [tourDone, setTourDone] = useStringPref('reel-studio.tourDone', '');
  const [nextBarPref, setNextBarPref] = useStringPref('reel-studio.nextbar', '1');
  const nextBarHidden = nextBarPref === '0';

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
        <div className="brand">Reel Studio</div>
        <nav className="tabs" data-tour="tabs">
          {TABS.map(({id, label, sub}, n) => (
            <button key={id} className={tab === id ? 'tab active' : 'tab'} onClick={() => go(id)} title={`${sub}（Ctrl+${n + 1}）`}>
              <span className="tab-no">{n + 1}</span>
              {label}
              <span className="tab-sub">{sub}</span>
            </button>
          ))}
        </nav>
        <button className="tab help-btn" data-tour="help" onClick={() => setHelp(true)} title="使い方・ショートカット（? キー）">
          ? 使い方
        </button>
        <div className="status">
          <select data-tour="project-select" value={s.active ?? ''} onChange={(e) => e.target.value && s.setActive(e.target.value)} title="編集中の案件">
            <option value="">（案件を選択）</option>
            {s.projects.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.slug}
              </option>
            ))}
          </select>
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

      {/* クラウド版で PC が落ちているとき。ジョブは消えず、PC が起きたら順に実行される */}
      {s.isCloud && s.config?.worker && !s.config.worker.online && (
        <div className="offlinebar">
          <span className="pill err">PC オフライン</span>
          <span>
            重い処理（素材のカタログ化・AI・レンダー）は自宅の PC が行います。いま PC が繋がっていないので、押したジョブは待機のまま残り、PC で Reel Studio を起動すると順に実行されます。
            {s.config.worker.lastSeen && <> 最後の応答: {new Date(s.config.worker.lastSeen).toLocaleString('ja-JP')}</>}
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
          <button className="small nextbar-x" title="非表示にする（「? 使い方」から戻せます）" onClick={() => setNextBarPref('0')}>
            ×
          </button>
        </div>
      )}

      <main className={`main${tab === 'timeline' ? ' main-editor' : ''}`}>
        {/* key に案件を入れて、案件を切り替えたら各画面の状態（選択カット・Undo 履歴・遅延中のプレビュー等）を捨てる。
            残していると、前の案件のカットを新しい案件の URL で読みにいってしまう */}
        {tab === 'projects' && <ProjectsPage />}
        {tab === 'materials' && <MaterialsPage key={s.active ?? ''} onTab={go} />}
        {tab === 'brief' && <BriefPage key={s.active ?? ''} onGoTimeline={() => go('timeline')} onTab={go} />}
        {tab === 'timeline' && <EditorPage key={s.active ?? ''} onTab={go} />}
        {tab === 'render' && <RenderPage key={s.active ?? ''} onTab={go} />}
        {/* Settings は案件に依存しないので key を付けない（案件を切り替えても入力中の値を捨てない） */}
        {tab === 'settings' && <SettingsPage />}
      </main>

      {/* スマホ用の下部ナビ。desktop では CSS で隠れる（上のタブがそのまま使われる） */}
      <nav className="bottomnav">
        {TABS.map(({id, label, sub}) => (
          <button key={id} className={tab === id ? 'bn active' : 'bn'} onClick={() => go(id)} aria-label={`${label}（${sub}）`}>
            <span className="bn-icon" aria-hidden="true">
              {TAB_ICON[id]}
            </span>
            <span className="bn-label">{sub}</span>
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
    </div>
  );
};
