// Timeline：cuts.json をカット単位で編集し、Remotion Player でテロップ付きプレビュー。validate は常時（クライアント側）。
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useStudio} from '../state/store';
import {Preview, type PreviewHandle} from '../components/Preview';
import type {Cut, ReelData, Slot, SubDef} from '@shared/schema';
import {cutRanges, cutDurationSec, telopGroupsOf, totalSec} from '@shared/timeline';
import {validateCuts, type Issue} from '@shared/validate';
import {checkOrder, orderFromCuts} from '@shared/order';
import {FORMAT_SPECS} from '@shared/format-specs';
import {PERSONAS} from '@shared/personas';
import {api} from '../api';
import {countChars, isPlaceholder} from '@shared/telop-text';
import {Storyboard} from '../components/Storyboard';
import {CutThumb} from '../components/CutThumb';
import {EmptyState} from '../components/EmptyState';
import {useDragReorder} from '../components/useDragReorder';
import {destIndexOf, reorderBlock} from '../components/reorder';
import {TrimBar} from '../components/TrimBar';
import {fallbackDuration} from '../components/trim';
import {useDebounced} from '../components/useDebounced';

const GROUP_COLORS = ['#6bb0ff', '#ffd966', '#4cc38a', '#f0a941', '#c77dff', '#ff6b6b', '#5ad1d1', '#a3e635'];

/** バッジ下地の濃さの既定値。エンジン（telops.tsx の LAYOUT.badgeBgAlpha）と揃える */
const BADGE_OPACITY_DEFAULT = 0.6;

const AI_JOB_LABEL: Record<string, string> = {
  'ai-telop': 'AI がテロップを作成中',
  'ai-order': 'AI が並べ替え中',
  'ai-edit': 'AI が修正中',
  'ai-tag': 'AI がタグ付け中',
};

/** 並べ替え・追加・削除の 1 手前（Ctrl+Z 用）。slots も一緒に戻す */
type OrderSnapshot = {cuts: Cut[]; slots: Slot[] | undefined};

const readGroupMove = (): boolean => {
  try {
    return localStorage.getItem('reel-studio.groupMove') !== '0';
  } catch {
    return true;
  }
};

export const TimelinePage: React.FC<{onTab: (t: 'projects' | 'brief') => void}> = ({onTab}) => {
  const s = useStudio();
  const cuts = s.files.cuts.data;
  const catalog = s.files.catalog.data;
  const brief = s.files.brief.data;
  const preview = useRef<PreviewHandle>(null);
  const [frame, setFrame] = useState(0);
  const [loop, setLoop] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [groupMove, setGroupMove] = useState(readGroupMove);
  const [canUndo, setCanUndo] = useState(false);
  const [orderExport, setOrderExport] = useState<{file: string; clips: number} | null>(null);
  // 裏で走らせる Claude のモデル（Materials と同じ設定を共有する）
  const [aiModel, setAiModel] = useState(() => {
    try {
      return localStorage.getItem('reel-studio.aiModel') ?? 'opus';
    } catch {
      return 'opus';
    }
  });
  const changeAiModel = (v: string) => {
    setAiModel(v);
    try {
      localStorage.setItem('reel-studio.aiModel', v);
    } catch {
      /* 記憶できなくても動作には影響しない */
    }
  };
  const aiJob = s.jobs.find((j) => j.type.startsWith('ai-') && (j.status === 'running' || j.status === 'queued'));
  const aiBusy = !!aiJob;
  // 走っている間だけ 1 秒ごとに描き直して経過秒を進める
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!aiJob) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [aiJob?.id]);
  const aiElapsed = aiJob?.startedAt ? Math.max(0, Math.round((Date.now() - new Date(aiJob.startedAt).getTime()) / 1000)) : 0;
  void tick;
  /** 起動中のサーバーにその機能が無い（＝古いプロセスのまま）*/
  const stale = (t: string) => !s.supportsJob(t);
  const RESTART_HINT = 'Reel Studio を再起動してください（画面だけ新しく、サーバーが古いプロセスです）';
  // 自由指示（AI に直してもらう）
  const [instruction, setInstruction] = useState('');
  /**
   * AI のジョブは**サーバーがディスクの cuts.json を読む**。画面に未保存の変更があると
   * 古い構成のまま走り、「18 カットあるのに 11 しか見てくれない」ような食い違いになる。
   * 実際に踏んだので、未保存のうちは押させない。
   */
  const unsavedCuts = s.files.cuts.dirty ? 'cuts.json に未保存の変更があります。保存（Ctrl+S）してから実行してください' : null;
  const lastEdit = s.jobs.find((j) => j.type === 'ai-edit' && (j.status === 'done' || j.status === 'failed'));
  const editResult = lastEdit?.result as {summary?: string; applied?: string[]; unapplied?: string[]; needsTts?: string[]} | undefined;
  const sendEdit = async () => {
    const text = instruction.trim();
    if (!text) return;
    // AI はディスクの cuts.json を読む。未保存だと古い構成に対して修正が当たる
    if (unsavedCuts) return s.toast(unsavedCuts, 'error');
    const j = await s.addJob('ai-edit', {instruction: text, model: aiModel});
    if (j) setInstruction('');
  };
  const history = useRef<OrderSnapshot[]>([]);

  const persona = brief ? PERSONAS[brief.persona] : undefined;
  const spec = brief ? FORMAT_SPECS[brief.format ?? persona!.defaultFormat] : undefined;
  const debounced = useDebounced(cuts, 150);
  const validation = useMemo(() => (debounced ? validateCuts(debounced, {catalog: catalog ?? undefined, brief: brief ?? undefined, spec, persona}) : null), [debounced, catalog, brief, spec, persona]);
  // 並び順そのものの構成チェック（catalog に対応付かない src が混ざっていたら出さない：カット数の判定が狂うため）
  const orderCheck = useMemo(() => {
    if (!debounced || !catalog || !brief || !spec) return null;
    const ids = orderFromCuts(debounced, catalog);
    if (!ids.length || ids.length !== debounced.cuts.length) return null;
    return {ids, ...checkOrder(ids, {catalog, brief, spec, persona})};
  }, [debounced, catalog, brief, spec, persona]);
  const ranges = useMemo(() => (cuts ? cutRanges(cuts) : []), [cuts]);
  const groups = useMemo(() => (cuts ? telopGroupsOf(cuts) : []), [cuts]);
  const groupOfCut = useMemo(() => {
    const m = new Map<number, number>();
    groups.forEach((g, gi) => g.cutIndices.forEach((ci) => m.set(ci, gi)));
    return m;
  }, [groups]);
  const currentCut = ranges.findIndex((r) => frame >= r.from && frame < r.from + r.dur);
  const clipBySrc = useMemo(() => new Map((catalog?.clips ?? []).map((c) => [c.src, c])), [catalog]);
  const aliasMap = useMemo(() => new Map((cuts?.meta?.aliases ?? []).map((a) => [a.to, a.from])), [cuts]);
  const clipOf = (src: string) => clipBySrc.get(aliasMap.get(src) ?? src);
  const slotOf = (c: Cut): Slot | undefined => cuts?.meta?.slots?.find((x) => x.cutId === c.id);

  const update = useCallback(
    (next: ReelData) => s.setFile('cuts', next),
    [s],
  );
  const patchCut = (i: number, patch: Partial<Cut> | ((c: Cut) => Cut)) => {
    if (!cuts) return;
    const nextCuts = cuts.cuts.map((c, k) => (k === i ? (typeof patch === 'function' ? patch(c) : {...c, ...patch}) : c));
    update({...cuts, cuts: nextCuts});
  };
  const patchSlot = (c: Cut, patch: Partial<Slot>) => {
    if (!cuts || !c.id) return;
    const slots = (cuts.meta?.slots ?? []).map((x) => (x.cutId === c.id ? {...x, ...patch} : x));
    update({...cuts, meta: {...(cuts.meta ?? {}), slots}});
  };
  // ---- カット順の編集（ドラッグ / ▲▼ / Alt+矢印）と、その取り消し ----
  const pushHistory = () => {
    if (!cuts) return;
    history.current = [...history.current.slice(-29), {cuts: cuts.cuts, slots: cuts.meta?.slots}];
    setCanUndo(true);
  };
  const undoOrder = () => {
    const snap = history.current.pop();
    setCanUndo(history.current.length > 0);
    if (!snap || !cuts) return;
    update({...cuts, cuts: snap.cuts, meta: {...(cuts.meta ?? {}), slots: snap.slots}});
    setSelected(null);
  };
  const undoRef = useRef(undoOrder);
  undoRef.current = undoOrder;
  // 案件を切り替えたら履歴は捨てる（別案件のカット配列を復元してしまわないように）
  useEffect(() => {
    history.current = [];
    setCanUndo(false);
  }, [s.active]);

  /** groupMove が ON なら、同じテロップ文言で連続するカットをまとめて動かす */
  const blockOf = useCallback(
    (i: number): [number, number] => {
      if (!groupMove) return [i, i];
      const gi = groupOfCut.get(i);
      if (gi === undefined) return [i, i];
      const idx = groups[gi].cutIndices;
      return [idx[0], idx[idx.length - 1]];
    },
    [groupMove, groupOfCut, groups],
  );
  const applyReorder = (block: [number, number], to: number) => {
    if (!cuts) return;
    pushHistory();
    update({...cuts, cuts: reorderBlock(cuts.cuts, block, to)});
    setSelected(destIndexOf(block, to));
  };
  const move = (i: number, d: number) => {
    if (!cuts) return;
    const j = i + d;
    if (j < 0 || j >= cuts.cuts.length) return;
    pushHistory();
    const arr = [...cuts.cuts];
    [arr[i], arr[j]] = [arr[j], arr[i]];
    update({...cuts, cuts: arr});
    setSelected(j);
  };
  const changeGroupMove = (v: boolean) => {
    setGroupMove(v);
    try {
      localStorage.setItem('reel-studio.groupMove', v ? '1' : '0');
    } catch {
      /* localStorage が使えなくても動作には影響しない */
    }
  };
  const newId = () => {
    const used = new Set((cuts?.cuts ?? []).map((c) => c.id));
    for (let n = 1; ; n++) {
      const id = `c${String(n).padStart(2, '0')}`;
      if (!used.has(id)) return id;
    }
  };
  const duplicate = (i: number) => {
    if (!cuts) return;
    pushHistory();
    const src = cuts.cuts[i];
    const id = newId();
    const copy: Cut = {...JSON.parse(JSON.stringify(src)), id};
    const arr = [...cuts.cuts];
    arr.splice(i + 1, 0, copy);
    const slot = slotOf(src);
    const slots = slot ? [...(cuts.meta?.slots ?? []), {...slot, cutId: id, locked: false}] : cuts.meta?.slots;
    update({...cuts, cuts: arr, meta: {...(cuts.meta ?? {}), slots}});
  };
  const remove = (i: number) => {
    if (!cuts || cuts.cuts.length <= 1) return;
    pushHistory();
    const c = cuts.cuts[i];
    const arr = cuts.cuts.filter((_, k) => k !== i);
    const slots = (cuts.meta?.slots ?? []).filter((x) => x.cutId !== c.id);
    update({...cuts, cuts: arr, meta: {...(cuts.meta ?? {}), slots}});
    setSelected(null);
  };
  const seekToCut = (i: number) => {
    const r = ranges[i];
    if (!r || !cuts) return;
    preview.current?.pause();
    preview.current?.seekTo(Math.min(r.from + Math.round(0.3 * cuts.fps), r.from + r.dur - 1));
    setSelected(i);
  };
  /** 絵コンテから選んだとき：プレビューを合わせ、下の詳細行もそこまでスクロールする */
  const selectFromStoryboard = (i: number) => {
    seekToCut(i);
    requestAnimationFrame(() => document.querySelector(`[data-cut-row="${i}"]`)?.scrollIntoView({block: 'nearest', behavior: 'smooth'}));
  };
  /** カット index → そのカットに出ている一番重い指摘（絵コンテのバッジ用） */
  const issueOf = useMemo(() => {
    const m = new Map<number, 'E' | 'W'>();
    for (const w of validation?.warnings ?? []) if (w.cutIndex !== undefined && !m.has(w.cutIndex)) m.set(w.cutIndex, 'W');
    for (const e of validation?.errors ?? []) if (e.cutIndex !== undefined) m.set(e.cutIndex, 'E');
    return m;
  }, [validation]);
  const rowDnd = useDragReorder({axis: 'y', gap: 4, blockOf, onDrop: applyReorder});
  /** Claude に並べ替えを頼むための素材リスト（サムネの場所・タグ・型の要求・今の並び）を書き出す */
  const exportOrderForAi = async () => {
    if (!s.active) return;
    try {
      const r = await api.post<{file: string; payload: {clips: unknown[]}}>(`/api/projects/${s.active}/order/export`, {});
      setOrderExport({file: r.data.file, clips: r.data.payload.clips.length});
      s.toast('並べ替え用の素材リストを書き出しました', 'ok');
    } catch (e) {
      s.toast(`書き出しに失敗: ${(e as Error).message}`, 'error');
    }
  };
  const applyFix = (iss: Issue) => {
    if (!cuts || iss.cutIndex === undefined || !iss.fix) return;
    const f = iss.fix;
    patchCut(iss.cutIndex, (c) => {
      const n = {...c};
      if (f.type === 'trimTo') n.outSec = f.payload.outSec;
      if (f.type === 'setRate') {
        if (f.payload.playbackRate === null) delete n.playbackRate;
        else n.playbackRate = f.payload.playbackRate;
      }
      if (f.type === 'orientation' && n.main) n.main = {...n.main, orientation: f.payload.orientation};
      if (f.type === 'removeKey') delete (n as Record<string, unknown>)[f.payload.key];
      return n;
    });
    if (f.type === 'removeKey' && f.payload.key === 'tate') update({...cuts, tate: undefined});
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void s.saveFile('cuts');
      }
      // Ctrl+Z：カットの並び・追加・削除を 1 手戻す。入力欄の中では通常の取り消しを邪魔しない
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        const t = e.target as HTMLElement | null;
        if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
        e.preventDefault();
        undoRef.current();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [s]);

  useEffect(() => {
    const running = s.jobs.some((j) => j.status === 'running' && (j.type === 'render' || j.type === 'draft'));
    if (running) preview.current?.pause();
  }, [s.jobs]);

  if (!s.active)
    return (
      <div className="page">
        <EmptyState title="案件が開かれていません" steps={['Projects で案件を開く']} action={{label: 'Projects へ', onClick: () => onTab('projects')}} />
      </div>
    );
  if (!cuts)
    return (
      <div className="page">
        <EmptyState
          title="まだカット構成がありません"
          steps={['Brief で意図を入力する', '「プランを生成（プレビュー）」で並びを確認する', '「cuts.json に書き込む」で確定する']}
          action={{label: 'Brief へ', onClick: () => onTab('brief')}}
          hint="この画面は、できたカット構成の順番・長さ・テロップを整えるところです。"
        />
      </div>
    );

  const fpsStep = 1 / cuts.fps;
  const total = totalSec(cuts);

  return (
    <div className="timeline">
      <Storyboard
        slug={s.active}
        mediaBase={s.mediaBase}
        cuts={cuts}
        ranges={ranges}
        clipOf={clipOf}
        slotOf={slotOf}
        groupOfCut={groupOfCut}
        groups={groups}
        groupColors={GROUP_COLORS}
        issueOf={issueOf}
        currentCut={currentCut}
        selected={selected}
        blockOf={blockOf}
        groupMove={groupMove}
        onGroupMove={changeGroupMove}
        onSelect={selectFromStoryboard}
        onReorder={applyReorder}
        onUndo={undoOrder}
        canUndo={canUndo}
      />
      <div className="preview-col">
        <Preview ref={preview} cuts={debounced ?? cuts} mediaBase={s.mediaBase} loop={loop} onFrame={setFrame} />
        <div className="row" style={{marginTop: 6}}>
          <span className="hint">
            {(frame / cuts.fps).toFixed(2)}s / {total.toFixed(2)}s（f{frame}） {currentCut >= 0 ? `カット ${currentCut + 1}` : ''}
          </span>
          <label>
            <span>loop</span>
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
          </label>
          <label title="Materials の「軽量プレビュー生成」で作った 540x960 を使う（レンダーには影響しない）">
            <span>軽量プレビュー</span>
            <input
              type="checkbox"
              checked={s.light}
              onChange={(e) => s.setLight(e.target.checked)}
            />
          </label>
        </div>
        <div className="row" style={{marginTop: 6}}>
          <button className="primary" data-tour="save" onClick={() => s.saveFile('cuts')} disabled={!s.files.cuts.dirty}>
            保存（Ctrl+S）
          </button>
          <button onClick={() => s.loadFile('cuts')}>読み直す</button>
          {s.files.cuts.external && (
            <button className="warn" onClick={() => s.saveFile('cuts', true)}>
              外部変更を上書き
            </button>
          )}
          <label>
            theme
            <select value={cuts.theme ?? 'pop'} onChange={(e) => update({...cuts, theme: e.target.value as ReelData['theme']})}>
              {(['pop', 'bold', 'human', 'stylish'] as const).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label title="バッジ（エリア名・順位）の下地の濃さ。0 で下地なし、1 でベタ塗り。文字の濃さは変わりません">
            バッジの濃さ
            <span className="btns">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={cuts.badgeOpacity ?? BADGE_OPACITY_DEFAULT}
                onChange={(e) => update({...cuts, badgeOpacity: Number(e.target.value)})}
                style={{width: 110}}
              />
              <span className="counter">{Math.round((cuts.badgeOpacity ?? BADGE_OPACITY_DEFAULT) * 100)}%</span>
            </span>
          </label>
        </div>
        <div className="row" style={{marginTop: 6}}>
          <button
            className="primary"
            onClick={() => s.addJob('ai-telop', {model: aiModel})}
            disabled={aiBusy || stale('ai-telop') || !!unsavedCuts || (validation?.summary.placeholders ?? 0) === 0}
            title={stale('ai-telop') ? RESTART_HINT : (unsavedCuts ?? '裏で Claude を起動し、各テロップのカット頭の画を見て文言を書きます')}
          >
            {aiBusy ? 'AI が作業中…' : `AI にテロップを書いてもらう（未記入 ${validation?.summary.placeholders ?? 0}）`}
          </button>
          <button
            onClick={() => s.addJob('ai-telop', {model: aiModel, force: true})}
            disabled={aiBusy || stale('ai-telop') || !!unsavedCuts}
            title={stale('ai-telop') ? RESTART_HINT : (unsavedCuts ?? `記入済みも含めて全部書き直す（いま ${cuts.cuts.length} カット）`)}
          >
            全部書き直す
          </button>
          {unsavedCuts && <span className="pill warn">{unsavedCuts}</span>}
          <label>
            モデル
            <select value={aiModel} onChange={(e) => changeAiModel(e.target.value)}>
              <option value="opus">opus（精度重視）</option>
              <option value="sonnet">sonnet（速い・安い）</option>
              <option value="haiku">haiku（最安）</option>
            </select>
          </label>
        </div>
        <span className="hint">API 課金が発生します。書いたあとは必ず自分で読み直してください（AI の文言は下書き扱いです）</span>

        {aiJob && (
          <div className="card ai-running" style={{marginTop: 8}}>
            <div className="summary" style={{marginBottom: 4}}>
              <span className="pill run">{AI_JOB_LABEL[aiJob.type] ?? aiJob.type}</span>
              <span>
                <b>{aiJob.status === 'queued' ? '順番待ち' : (aiJob.progress?.phase ?? '起動中…')}</b>
              </span>
              <span className="hint">
                {Math.floor(aiElapsed / 60)}分{String(aiElapsed % 60).padStart(2, '0')}秒 経過
              </span>
              <span style={{flex: 1}} />
              <button className="small" onClick={() => void s.cancelJob(aiJob.id)}>
                中止
              </button>
            </div>
            <div className={`progress${aiJob.progress && aiJob.progress.total > 0 ? '' : ' indeterminate'}`}>
              <div style={aiJob.progress && aiJob.progress.total > 0 ? {width: `${Math.min(100, (100 * aiJob.progress.done) / aiJob.progress.total)}%`} : undefined} />
            </div>
            {aiJob.progress && aiJob.progress.total > 0 && (
              <div className="hint" style={{marginTop: 2}}>
                {aiJob.progress.done} / {aiJob.progress.total}
              </div>
            )}
            {(aiJob.logTail ?? []).slice(-1).map((l, i) => (
              <div key={i} className="hint" style={{fontFamily: 'Consolas, monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>
                {l}
              </div>
            ))}
          </div>
        )}

        <div className="card" style={{marginTop: 8}} data-tour="ai-edit">
          <div className="summary">
            <span>
              <b>AI に直してもらう</b>
            </span>
            <span className="hint">直したいところを書いて送ると、テロップ・ナレーション・カットの区間や並びを直します</span>
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
            style={{minHeight: 76, width: '100%'}}
            disabled={aiBusy}
          />
          <div className="row" style={{marginTop: 6}}>
            <button className="primary" onClick={() => void sendEdit()} disabled={aiBusy || stale('ai-edit') || !instruction.trim()} title={stale('ai-edit') ? RESTART_HINT : undefined}>
              {aiBusy ? 'AI が作業中…' : '送信（Ctrl+Enter）'}
            </button>
            <label>
              モデル
              <select value={aiModel} onChange={(e) => changeAiModel(e.target.value)}>
                <option value="opus">opus（精度重視）</option>
                <option value="sonnet">sonnet（速い・安い）</option>
                <option value="haiku">haiku（最安）</option>
              </select>
            </label>
            <span className="hint">変更前は .studio/backups に残ります</span>
          </div>
          {lastEdit && (
            <div className="issues" style={{marginTop: 6}}>
              {lastEdit.status === 'failed' ? (
                <div className="issue E">
                  <span className="code">E</span>
                  <span>{lastEdit.error}</span>
                </div>
              ) : (
                <>
                  {editResult?.summary && <div className="hint">{editResult.summary}</div>}
                  {(editResult?.applied ?? []).map((a, i) => (
                    <div key={`a${i}`} className="issue">
                      <span className="code">✓</span>
                      <span>{a}</span>
                    </div>
                  ))}
                  {(editResult?.unapplied ?? []).map((u, i) => (
                    <div key={`u${i}`} className="issue W">
                      <span className="code">W</span>
                      <span>{u}</span>
                    </div>
                  ))}
                  {(editResult?.needsTts ?? []).length > 0 && (
                    <div className="issue E">
                      <span className="code">要再生成</span>
                      <span>ナレーション {(editResult!.needsTts ?? []).join(', ')} は文言が変わりました。音声を作り直さないと古い wav のまま混ざります（Claude に「narration.json の needsTts を作り直して」と頼んでください）</span>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        {validation && (
          <div className="card" style={{marginTop: 8}} data-tour="validation">
            <div className="summary">
              <span>
                <b>{validation.ok ? 'OK' : 'NG'}</b>
              </span>
              <span>
                <b>{validation.summary.cutCount}</b> カット
              </span>
              <span>
                <b>{validation.summary.totalSec}</b>s
              </span>
              <span>
                平均 <b>{validation.summary.avgCutSec}</b>s
              </span>
              <span>
                テロップ <b>{validation.summary.groupCount}</b> G
              </span>
              {validation.summary.revealPct !== undefined && (
                <span>
                  リビール <b>{Math.round(validation.summary.revealPct * 100)}%</b>
                </span>
              )}
              {validation.summary.placeholders > 0 && (
                <span style={{color: 'var(--warn)'}}>
                  未記入 <b>{validation.summary.placeholders}</b>
                </span>
              )}
            </div>
            <div className="issues">
              {[...validation.errors, ...validation.warnings].map((iss, i) => (
                <div key={i} className={`issue ${iss.severity}`} onClick={() => iss.cutIndex !== undefined && seekToCut(iss.cutIndex)}>
                  <span className="code">
                    {iss.severity} {iss.code}
                  </span>
                  <span>
                    {iss.cutId ? `[${iss.cutId}] ` : ''}
                    {iss.message}
                  </span>
                  {iss.fix && (
                    <button
                      className="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        applyFix(iss);
                      }}
                    >
                      適用
                    </button>
                  )}
                </div>
              ))}
              {validation.skipped.length > 0 && <div className="hint">skip: {validation.skipped.join(', ')}</div>}
            </div>
          </div>
        )}
        {orderCheck && (
          <div className="card" style={{marginTop: 8}} data-tour="order">
            <div className="summary">
              <span>
                <b>構成</b>（並び順）
              </span>
              <span>
                <b>{orderCheck.summary.count}</b> カット（型の推奨 {orderCheck.summary.recommendedCount[0]}〜{orderCheck.summary.recommendedCount[1]}）
              </span>
              {orderCheck.summary.signageAt.length > 0 && <span>看板 {orderCheck.summary.signageAt.map((i) => i + 1).join(',')} 番目</span>}
              {orderCheck.summary.unusedGood.length > 0 && (
                <span style={{color: 'var(--warn)'}}>
                  未使用の見せ場 <b>{orderCheck.summary.unusedGood.length}</b>
                </span>
              )}
            </div>
            <div className="issues">
              {orderCheck.findings.map((f, i) => (
                <div key={i} className={`issue ${f.severity}`} onClick={() => f.index !== undefined && seekToCut(f.index)}>
                  <span className="code">
                    {f.severity} {f.code}
                  </span>
                  <span>
                    {f.index !== undefined ? `[${f.index + 1}番目] ` : ''}
                    {f.message}
                  </span>
                </div>
              ))}
              {orderCheck.findings.length === 0 && <div className="hint">型どおりの並びです</div>}
            </div>
            <div className="row" style={{marginTop: 6}}>
              <button
                className="primary"
                onClick={() => s.addJob('ai-order', {model: aiModel, write: true})}
                disabled={aiBusy || stale('ai-order') || !!unsavedCuts}
                title={stale('ai-order') ? RESTART_HINT : (unsavedCuts ?? '裏で Claude を起動し、素材を見て並び順を決めさせます。cuts.json まで書き込みます')}
              >
                {aiBusy ? 'AI が並べ替え中…' : 'AI に並べ替えてもらう'}
              </button>
              <label>
                モデル
                <select value={aiModel} onChange={(e) => changeAiModel(e.target.value)}>
                  <option value="opus">opus（精度重視）</option>
                  <option value="sonnet">sonnet（速い・安い）</option>
                  <option value="haiku">haiku（最安）</option>
                </select>
              </label>
              <button onClick={exportOrderForAi} title="自分で Claude に頼むための素材リストを書き出すだけ（並べ替えは実行しません）">
                書き出すだけ
              </button>
            </div>
            <span className="hint">
              API 課金が発生します。記入済みのテロップは作り直しになるので、テロップを書いたあとは絵コンテのドラッグで直してください
              {orderExport ? ` ／ 書き出し: ${orderExport.file}` : ''}
            </span>
          </div>
        )}
      </div>

      <div className="cut-rows" data-tour="cut-rows" {...rowDnd.containerProps}>
        {cuts.cuts.map((c, i) => {
          const clip = clipOf(c.src);
          const slot = slotOf(c);
          const gi = groupOfCut.get(i);
          const text = c.main?.text ?? '';
          const n = countChars(text);
          return (
            <div
              key={c.id ?? i}
              className={`cut-row${i === currentCut ? ' current' : ''}${i === selected ? ' selected' : ''}${rowDnd.isDragging(i) ? ' dragging' : ''}`}
              style={{borderLeftColor: gi !== undefined ? GROUP_COLORS[gi % GROUP_COLORS.length] : 'var(--line)'}}
              data-cut-row={i}
              {...rowDnd.itemProps(i)}
            >
              <div className="handle" {...rowDnd.handleProps(i)} title="ドラッグして順番を変える（絵コンテでも並べ替えられます）">
                ⠿
              </div>
              <div className="no" onClick={() => seekToCut(i)} title="カット頭へ">
                {i + 1}
                <div className="hint" style={{fontSize: 10}}>
                  {slot?.role ?? ''}
                </div>
              </div>
              <div className="thumb" onClick={() => seekToCut(i)} title="カット頭へ">
                <CutThumb slug={s.active} src={c.src} inSec={c.inSec} width={160} fallback={clip?.thumbs.sheet && s.mediaBase ? `${s.mediaBase}/studio/${clip.thumbs.sheet}` : null} />
              </div>
              <div className="fields">
                <label>
                  素材
                  <select
                    value={clip?.src ?? c.src}
                    onChange={(e) => {
                      const nc = clipBySrc.get(e.target.value);
                      if (!nc) return patchCut(i, {src: e.target.value});
                      const dur = Math.min(cutDurationSec(c), nc.probe.durationSec);
                      patchCut(i, {src: nc.src, inSec: 0, outSec: Math.round(dur * 1000) / 1000});
                    }}
                  >
                    {!clip && <option value={c.src}>{c.src}</option>}
                    {(catalog?.clips ?? []).map((k) => (
                      <option key={k.id} value={k.src}>
                        {k.id} {k.tags?.description ?? k.slug}（{k.probe.durationSec.toFixed(1)}s）
                      </option>
                    ))}
                  </select>
                </label>
                <div style={{width: '100%'}}>
                  <TrimBar
                    inSec={c.inSec}
                    outSec={c.outSec}
                    durationSec={clip?.probe.durationSec ?? fallbackDuration(c)}
                    fps={cuts.fps}
                    strip={clip?.thumbs.strip}
                    mediaBase={s.mediaBase}
                    usableRanges={clip?.usableRanges}
                    onStart={pushHistory}
                    onChange={(r) => patchCut(i, r)}
                  />
                </div>
                <label>
                  IN
                  <span className="btns">
                    <input type="number" step={0.01} value={c.inSec} onChange={(e) => patchCut(i, {inSec: Number(e.target.value)})} />
                    <button className="small" onClick={() => patchCut(i, {inSec: Math.max(0, Math.round((c.inSec - fpsStep) * 1000) / 1000)})}>
                      -1f
                    </button>
                    <button className="small" onClick={() => patchCut(i, {inSec: Math.round((c.inSec + fpsStep) * 1000) / 1000})}>
                      +1f
                    </button>
                  </span>
                </label>
                <label>
                  OUT
                  <span className="btns">
                    <input type="number" step={0.01} value={c.outSec} onChange={(e) => patchCut(i, {outSec: Number(e.target.value)})} />
                    <button className="small" onClick={() => patchCut(i, {outSec: Math.round((c.outSec - 0.1) * 1000) / 1000})}>
                      -0.1
                    </button>
                    <button className="small" onClick={() => patchCut(i, {outSec: Math.round((c.outSec + 0.1) * 1000) / 1000})}>
                      +0.1
                    </button>
                  </span>
                </label>
                <span className="hint">
                  尺 {cutDurationSec(c).toFixed(2)}s{clip ? ` / 素材 ${clip.probe.durationSec.toFixed(2)}s` : ''}
                </span>
                <label>
                  rate
                  <input type="number" step={0.25} min={0.5} max={2} value={c.playbackRate ?? ''} placeholder="1" onChange={(e) => patchCut(i, (x) => {
                    const nx = {...x};
                    if (e.target.value === '' || Number(e.target.value) === 1) delete nx.playbackRate;
                    else nx.playbackRate = Number(e.target.value);
                    return nx;
                  })} />
                </label>
                {!c.subs?.length && (
                  <label>
                    テロップ {gi !== undefined ? <span className="hint">g{String(gi + 1).padStart(2, '0')}</span> : null}
                    <input className={`telop${isPlaceholder(text) ? ' placeholder' : ''}`} value={text} placeholder="（無し）" onChange={(e) => patchCut(i, (x) => (e.target.value === '' ? {...x, main: undefined} : {...x, main: {...(x.main ?? {}), text: e.target.value}}))} />
                    <span className={`counter${n > 13 ? ' over' : ''}`}>{n}/13</span>
                  </label>
                )}
                {c.main && (
                  <label>
                    向き
                    <select value={c.main.orientation ?? 'vertical'} onChange={(e) => patchCut(i, {main: {...c.main!, orientation: e.target.value === 'vertical' ? undefined : 'horizontal'}})}>
                      <option value="vertical">縦書き（中央）</option>
                      <option value="horizontal">横書き（上部）</option>
                    </select>
                  </label>
                )}
                <label>
                  badge
                  <input style={{width: 80}} value={c.badge ?? ''} onChange={(e) => patchCut(i, (x) => {
                    const nx = {...x};
                    if (e.target.value) nx.badge = e.target.value;
                    else delete nx.badge;
                    return nx;
                  })} />
                </label>
                <span className="btns">
                  <button className="small" onClick={() => move(i, -1)} disabled={i === 0}>
                    ▲
                  </button>
                  <button className="small" onClick={() => move(i, 1)} disabled={i === cuts.cuts.length - 1}>
                    ▼
                  </button>
                  <button className="small" onClick={() => duplicate(i)}>
                    複製
                  </button>
                  <button className="small danger" onClick={() => remove(i)}>
                    削除
                  </button>
                  {slot && (
                    <button className={`small${slot.locked ? ' warn' : ''}`} onClick={() => patchSlot(c, {locked: !slot.locked})} title="再 plan でこのカットを固定">
                      {slot.locked ? '🔒' : '🔓'}
                    </button>
                  )}
                  {!c.subs?.length && clip?.tags?.hasSpeech && (
                    <button className="small" onClick={() => patchCut(i, (x) => ({...x, main: undefined, subs: [{text: '', orientation: 'horizontal', startSec: x.inSec, endSec: x.outSec}]}))}>
                      subs に
                    </button>
                  )}
                </span>
                {c.subs && c.subs.length > 0 && (
                  <div className="subs-editor full" style={{width: '100%'}}>
                    {c.subs.map((sub, k) => (
                      <div className="sub" key={k}>
                        <input type="number" step={0.05} value={sub.startSec} onChange={(e) => patchCut(i, {subs: c.subs!.map((x, j) => (j === k ? {...x, startSec: Number(e.target.value)} : x))})} />
                        <input type="number" step={0.05} value={sub.endSec} onChange={(e) => patchCut(i, {subs: c.subs!.map((x, j) => (j === k ? {...x, endSec: Number(e.target.value)} : x))})} />
                        <input className={`telop${isPlaceholder(sub.text) ? ' placeholder' : ''}`} value={sub.text} onChange={(e) => patchCut(i, {subs: c.subs!.map((x, j) => (j === k ? {...x, text: e.target.value} : x))})} />
                        <span className="counter">{countChars(sub.text)}/20</span>
                        <button className="small danger" onClick={() => patchCut(i, (x) => ({...x, subs: x.subs!.filter((_, j) => j !== k)}))}>
                          ×
                        </button>
                      </div>
                    ))}
                    <button className="small" onClick={() => patchCut(i, {subs: [...c.subs!, {text: '', orientation: 'horizontal', startSec: c.subs![c.subs!.length - 1].endSec, endSec: c.outSec} as SubDef]})}>
                      + 字幕
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div className="row">
          <button
            onClick={() => {
              const last = cuts.cuts[cuts.cuts.length - 1];
              const id = newId();
              pushHistory();
              update({...cuts, cuts: [...cuts.cuts, {id, src: last.src, inSec: last.outSec, outSec: Math.round((last.outSec + 1.5) * 1000) / 1000, main: {text: ''}}]});
            }}
          >
            + カットを追加
          </button>
        </div>
        {rowDnd.drag?.caret && <div className="dnd-caret" style={rowDnd.drag.caret} />}
      </div>

      {rowDnd.drag && (
        <div className="dnd-ghost text-only" style={{left: rowDnd.drag.x, top: rowDnd.drag.y}}>
          <span className="dnd-ghost-label">
            カット {rowDnd.drag.block[0] + 1}
            {rowDnd.drag.block[1] > rowDnd.drag.block[0] ? `〜${rowDnd.drag.block[1] + 1}` : ''}
            {rowDnd.drag.to !== null ? ` → ${destIndexOf(rowDnd.drag.block, rowDnd.drag.to) + 1} 番目` : ' 位置はそのまま'}
          </span>
        </div>
      )}
    </div>
  );
};
