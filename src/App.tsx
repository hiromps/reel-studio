import React, {useEffect, useMemo, useState} from 'react';
import {useStudio} from './state/store';
import {ProjectsPage} from './pages/Projects';
import {MaterialsPage} from './pages/Materials';
import {BriefPage} from './pages/Brief';
import {TimelinePage} from './pages/Timeline';
import {RenderPage} from './pages/Render';
import {Tour, type TourTab} from './components/Tour';
import {HelpPanel} from './components/HelpPanel';
import {nextStepOf} from './components/nextStep';

const TABS = [
  ['projects', 'Projects'],
  ['materials', 'Materials'],
  ['brief', 'Brief'],
  ['timeline', 'Timeline'],
  ['render', 'Render'],
] as const;
type Tab = TourTab;

const pref = (key: string, fallback: string): string => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const setPref = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* localStorage が使えなくても動作には影響しない */
  }
};

export const App: React.FC = () => {
  const s = useStudio();
  const [tab, setTab] = useState<Tab>(() => (pref('reel-studio.tab', 'projects') as Tab) || 'projects');
  const [help, setHelp] = useState(false);
  const [tour, setTour] = useState(false);
  const [nextBarHidden, setNextBarHidden] = useState(() => pref('reel-studio.nextbar', '1') === '0');

  const go = (t: Tab) => {
    setTab(t);
    setPref('reel-studio.tab', t);
  };

  // 初回起動時だけガイドツアーを自動で出す
  useEffect(() => {
    if (pref('reel-studio.tourDone', '') !== '1') setTour(true);
  }, []);
  const closeTour = () => {
    setTour(false);
    setPref('reel-studio.tourDone', '1');
  };

  // ? でヘルプ（入力中は邪魔しない）
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      e.preventDefault();
      setHelp((v) => !v);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
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
    [s.active, s.files],
  );

  // タブを複数開いたときに見分けが付くよう、タイトルに案件名を出す
  useEffect(() => {
    document.title = s.active ? `${s.active} — Reel Studio` : 'Reel Studio';
  }, [s.active]);

  const running = s.jobs.find((j) => j.status === 'running');
  const dirty = (Object.keys(s.files) as (keyof typeof s.files)[]).filter((k) => s.files[k].dirty);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Reel Studio</div>
        <nav className="tabs" data-tour="tabs">
          {TABS.map(([id, label], n) => (
            <button key={id} className={tab === id ? 'tab active' : 'tab'} onClick={() => go(id)}>
              <span className="tab-no">{n + 1}</span>
              {label}
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
            <span className="pill run">
              {running.type} {running.progress ? `${running.progress.done}/${running.progress.total}` : '…'}
            </span>
          )}
        </div>
      </header>

      {!nextBarHidden && (
        <div className={`nextbar${next.ready ? ' ready' : ''}`} data-tour="next">
          <span className="nextbar-tag">次にやること</span>
          <span className="nextbar-text">{next.text}</span>
          <button className="small" onClick={() => go(next.tab)} disabled={tab === next.tab}>
            {tab === next.tab ? 'この画面です' : next.cta}
          </button>
          <button
            className="small nextbar-x"
            title="非表示にする（「? 使い方」から戻せます）"
            onClick={() => {
              setNextBarHidden(true);
              setPref('reel-studio.nextbar', '0');
            }}
          >
            ×
          </button>
        </div>
      )}

      <main className="main">
        {/* key に案件を入れて、案件を切り替えたら各画面の状態（選択カット・Undo 履歴・遅延中のプレビュー等）を捨てる。
            残していると、前の案件のカットを新しい案件の URL で読みにいってしまう */}
        {tab === 'projects' && <ProjectsPage />}
        {tab === 'materials' && <MaterialsPage key={s.active ?? ''} onTab={go} />}
        {tab === 'brief' && <BriefPage key={s.active ?? ''} onGoTimeline={() => go('timeline')} onTab={go} />}
        {tab === 'timeline' && <TimelinePage key={s.active ?? ''} onTab={go} />}
        {tab === 'render' && <RenderPage key={s.active ?? ''} onTab={go} />}
      </main>

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
        onNextBar={(show) => {
          setNextBarHidden(!show);
          setPref('reel-studio.nextbar', show ? '1' : '0');
        }}
      />
      <Tour open={tour} tab={tab} onTab={go} onClose={closeTour} />
    </div>
  );
};
