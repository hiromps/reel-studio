// 編集画面（Timeline タブ）：素材ビン｜プレビュー｜インスペクタ の 3 列と、下の 4 段タイムライン。
// cuts.json と narration.json をここ 1 か所で編集する（以前は Materials と Timeline と Render に分かれていた）。
import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import {Preview, type PreviewHandle} from '../components/Preview';
import {EmptyState} from '../components/EmptyState';
import {AiJobStatus} from '../components/AiJobStatus';
import {Storyboard} from '../components/Storyboard';
import {useBinDrag} from '../components/useBinDrag';
import {useDebounced} from '../components/useDebounced';
import {PX_PER_SEC_DEFAULT, PX_PER_SEC_MAX, PX_PER_SEC_MIN, clampZoom} from '../components/track';
import {usePref} from '../hooks/usePref';
import {useHotkeys} from '../hooks/useHotkeys';
import type {SfxLibrary} from '@shared/sfx';
import {calcTotalFrames} from '@shared/timeline';
import {Bin} from './Bin';
import {Transport} from './Transport';
import {Timeline, type TimelineHandle, type TrackVisibility} from './Timeline';
import {CutInspector, NarrationInspector, ReelInspector, SfxInspector, TelopInspector} from './Inspector';
import {ValidationPanel} from './ValidationPanel';
import {AiMenu} from './AiMenu';
import {useEditorModel} from './useEditorModel';
import {GROUP_COLORS} from './labels';

type Prefs = {zoom: number; snap: boolean; tracks: TrackVisibility; storyboard: boolean; groupMove: boolean};
const DEFAULT_PREFS: Prefs = {zoom: PX_PER_SEC_DEFAULT, snap: true, tracks: {telop: true, narr: true, sfx: true}, storyboard: false, groupMove: true};

const emptyLib: SfxLibrary = {version: 1, sounds: []};

export const EditorPage: React.FC<{onTab: (t: 'projects' | 'brief' | 'materials' | 'render') => void}> = ({onTab}) => {
  const s = useStudio();
  const [lib, setLib] = useState<SfxLibrary | null>(null);
  const m = useEditorModel(lib);
  const {cuts, narration, catalog, brief, selection, setSelection, frame, setFrame} = m;
  const [prefs, setPrefs] = usePref<Prefs>('reel-studio.editor', DEFAULT_PREFS);
  const prefsSafe: Prefs = {...DEFAULT_PREFS, ...prefs, tracks: {...DEFAULT_PREFS.tracks, ...(prefs.tracks ?? {})}, zoom: clampZoom(prefs.zoom ?? PX_PER_SEC_DEFAULT)};
  const [loop, setLoop] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [focusTelop, setFocusTelop] = useState(false);
  const preview = useRef<PreviewHandle>(null);
  const timeline = useRef<TimelineHandle>(null);
  const centerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [previewW, setPreviewW] = useState(300);
  const [rootTop, setRootTop] = useState(0);
  const debouncedCuts = useDebounced(cuts, 150);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);

  // 効果音ライブラリ（S 段の幅と、インスペクタの音源一覧に使う）
  useEffect(() => {
    void api
      .get<SfxLibrary>('/api/sfx')
      .then((r) => setLib(r.data ?? emptyLib))
      .catch(() => setLib(emptyLib));
  }, [s.jobs.filter((j) => j.type.startsWith('sfx-') && j.status === 'done').length]);

  // 画面の高さいっぱいに使う（上の topbar・次にやることバーの分は測って引く）
  useLayoutEffect(() => {
    const measure = () => {
      const top = rootRef.current?.getBoundingClientRect().top ?? 0;
      setRootTop(Math.max(0, Math.round(top + (window.scrollY || 0))));
    };
    measure();
    window.addEventListener('resize', measure);
    const t = setTimeout(measure, 50);
    return () => {
      window.removeEventListener('resize', measure);
      clearTimeout(t);
    };
  }, [s.active]);
  // プレビューは中央列の高さと幅に収める（9:16）
  useLayoutEffect(() => {
    const el = centerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight - 40; // transport の分
      const w = el.clientWidth - 8;
      setPreviewW(Math.max(120, Math.floor(Math.min(w, (h * 9) / 16))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [s.active, cuts === null]);

  // ---- 再生まわり ----
  const totalFrames = cuts ? calcTotalFrames(cuts) : 0;
  const seek = useCallback(
    (f: number) => {
      const clamped = Math.max(0, Math.min(Math.max(0, totalFrames - 1), Math.round(f)));
      setFrame(clamped);
      preview.current?.pause();
      preview.current?.seekTo(clamped);
    },
    [totalFrames, setFrame],
  );
  const seekCut = useCallback(
    (i: number) => {
      const r = m.ranges[i];
      if (!r || !cuts) return;
      seek(Math.min(r.from + Math.round(0.3 * cuts.fps), r.from + r.dur - 1));
      setSelection({kind: 'cut', index: i});
      timeline.current?.scrollToCut(i);
    },
    [m.ranges, cuts, seek, setSelection],
  );
  const seekSec = useCallback((sec: number) => cuts && seek(Math.round(sec * cuts.fps)), [cuts, seek]);
  const toggle = useCallback(() => preview.current?.toggle(), []);
  const step = useCallback((n: number) => seek((preview.current?.getCurrentFrame() ?? frame) + n), [seek, frame]);

  // レンダー中はプレビューを止める（メモリを取り合うため）
  useEffect(() => {
    if (s.jobs.some((j) => j.status === 'running' && (j.type === 'render' || j.type === 'draft' || j.type === 'build'))) preview.current?.pause();
  }, [s.jobs]);

  // ---- 保存 ----
  const dirtyCuts = s.files.cuts.dirty;
  const dirtyNarr = s.files.narration.dirty;
  const saveAll = useCallback(async () => {
    if (s.files.cuts.dirty) await s.saveFile('cuts');
    if (s.files.narration.dirty) await s.saveFile('narration');
  }, [s]);

  // ---- ショートカット ----
  const removeSelected = () => {
    if (!selection) return;
    if (selection.kind === 'cut' && !m.removeCut(selection.index)) s.toast('最後の 1 カットは消せません', 'error');
    else if (selection.kind === 'narr') m.removeSeg(selection.index);
    else if (selection.kind === 'sfx') m.removeSfx(selection.index);
    else if (selection.kind === 'telop') m.setGroupText(selection.group, '');
  };
  useHotkeys([
    {key: 's', ctrl: true, inInputs: true, handler: () => void saveAll()},
    {key: 'z', ctrl: true, handler: () => m.undo()},
    {key: 'z', ctrl: true, shift: true, handler: () => m.redo()},
    {key: 'y', ctrl: true, handler: () => m.redo()},
    {key: 'd', ctrl: true, handler: () => selection?.kind === 'cut' && m.duplicateCut(selection.index)},
    {key: 'Space', handler: toggle},
    {key: 'ArrowLeft', handler: () => step(-1)},
    {key: 'ArrowRight', handler: () => step(1)},
    {key: 'ArrowLeft', shift: true, handler: () => step(-10)},
    {key: 'ArrowRight', shift: true, handler: () => step(10)},
    {key: 'Home', handler: () => seek(0)},
    {key: 'End', handler: () => seek(totalFrames - 1)},
    {key: 'Delete', handler: removeSelected},
    {key: 'Backspace', handler: removeSelected},
    {
      key: 's',
      handler: () => {
        const i = selection?.kind === 'cut' ? selection.index : m.currentCut;
        if (i < 0) return;
        const err = m.splitCut(i);
        if (err) s.toast(err, 'error');
      },
    },
    {key: 'Escape', handler: () => setSelection(null)},
  ]);

  // ---- 素材ビンからのドラッグ ----
  const binDrag = useBinDrag<string>({
    onDrop: (clipId, x, y) => {
      const idx = timeline.current?.insertIndexAtPoint(x, y);
      if (idx === null || idx === undefined) return;
      const err = m.addClip(clipId, idx);
      if (err) s.toast(err, 'error');
    },
  });
  const addClip = (id: string) => {
    const err = m.addClip(id);
    if (err) s.toast(err, 'error');
    else if (!cuts) s.toast('cuts.json を新しく作りました（保存するまでファイルには書かれません）', 'ok');
  };

  // ---- ナレーションの試聴・生成 ----
  const stopAudio = () => {
    audio.current?.pause();
    audio.current = null;
    setPreviewingId(null);
  };
  const playNarr = async (id: string, text: string, needsTts: boolean) => {
    stopAudio();
    if (!needsTts && s.mediaBase) {
      const a = new Audio(`${s.mediaBase}/narration/${encodeURIComponent(id)}.wav?t=${Date.now()}`);
      audio.current = a;
      setPreviewingId(id);
      a.onended = () => setPreviewingId(null);
      void a.play().catch(() => {
        s.toast('音声が見つかりません（まだ生成していないかもしれません）', 'error');
        setPreviewingId(null);
      });
      return;
    }
    if (!narration) return;
    setPreviewingId(id);
    try {
      const res = await fetch('/api/tts/preview', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({text, voice: narration.voice, speed: narration.speed ?? m.persona?.narration.speed ?? 1.6, latency: narration.latency}),
      });
      if (!res.ok) throw new Error(((await res.json()) as {error?: string}).error ?? `HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = new Audio(url);
      audio.current = a;
      a.onended = () => {
        URL.revokeObjectURL(url);
        setPreviewingId(null);
      };
      await a.play();
    } catch (e) {
      s.toast(`試聴できませんでした: ${(e as Error).message}`, 'error');
      setPreviewingId(null);
    }
  };
  const playSfx = (file: string, trimSec?: number) => {
    stopAudio();
    const a = new Audio(`/api/sfx/file/${file.split('/').map(encodeURIComponent).join('/')}`);
    audio.current = a;
    void a.play().catch(() => s.toast('試聴できませんでした', 'error'));
    if (trimSec && trimSec > 0) setTimeout(() => a.pause(), trimSec * 1000);
  };
  const ttsBusy = s.jobs.some((j) => (j.status === 'running' || j.status === 'queued') && j.type === 'tts');
  const ttsBlockedBy = !s.supportsJob('tts') ? 'サーバーが古いプロセスです。再起動してください' : s.config?.tts === false ? 'FISH_API_KEY が見つかりません' : dirtyNarr ? 'narration.json に未保存の変更があります。保存してから生成してください' : ttsBusy ? '生成中です' : null;
  const needsTts = (narration?.segments ?? []).filter((seg) => (seg as {needsTts?: boolean}).needsTts || !seg.durSec).length;

  // ---- 「この並びを brief の固定順にする」 ----
  const applyOrderToBrief = () => {
    if (!brief || !cuts) return;
    const ids = cuts.cuts.map((c) => m.clipOf(c.src)?.id).filter((x): x is string => !!x);
    if (ids.length !== cuts.cuts.length) return s.toast('catalog に無い素材が含まれているため固定順にできません', 'error');
    const first = cuts.cuts[0];
    s.setFile('brief', {...brief, order: {...brief.order, mode: 'fixed', fixed: ids}, hook: {...(brief.hook ?? {}), clipId: ids[0], inSec: first.inSec, outSec: first.outSec}});
    s.toast('brief に固定順とフックを入れました。Brief で「cuts.json に書き込む」と型どおりの役割・テロップ枠が付きます（尺は型に合わせて組み直されます）', 'ok');
  };

  const aiJob = s.jobs.find((j) => (j.type.startsWith('ai-') || j.type === 'tts' || j.type === 'build') && j.slug === s.active && (j.status === 'running' || j.status === 'queued'));
  const placeholders = m.validation?.summary.placeholders ?? 0;
  const dragClip = binDrag.drag ? catalog?.clips.find((c) => c.id === binDrag.drag!.payload) : undefined;
  const extIndex = binDrag.drag ? (timeline.current?.insertIndexAtPoint(binDrag.drag.x, binDrag.drag.y) ?? null) : null;

  // タイムラインで何かをクリックしたら、選ぶと同時にそこへシークする（NLE の慣習）。ドラッグ中は Timeline 側が選択だけ更新する
  const selectFromTimeline = (sel: typeof selection, opt: {seek?: boolean} = {}) => {
    setSelection(sel);
    setFocusTelop(false);
    if (opt.seek === false || !sel || !cuts) return;
    if (sel.kind === 'cut') seekCut(sel.index);
    else if (sel.kind === 'telop') {
      const g = m.groups[sel.group];
      if (g) seekCut(g.cutIndices[0]);
    } else if (sel.kind === 'narr') {
      const seg = narration?.segments[sel.index];
      if (seg) seekSec(seg.at);
    } else if (sel.kind === 'sfx') {
      const x = narration?.sfx?.[sel.index];
      if (x) seekSec(x.at);
    }
  };
  const blockOf = useCallback(
    (i: number): [number, number] => {
      if (!prefsSafe.groupMove) return [i, i];
      const gi = m.groupOfCut.get(i);
      if (gi === undefined) return [i, i];
      const idx = m.groups[gi].cutIndices;
      return [idx[0], idx[idx.length - 1]];
    },
    [prefsSafe.groupMove, m.groupOfCut, m.groups],
  );

  if (!s.active)
    return (
      <div className="page">
        <EmptyState title="案件が開かれていません" steps={['Projects で案件を開く']} action={{label: 'Projects へ', onClick: () => onTab('projects')}} />
      </div>
    );

  const height = `calc(100vh - ${rootTop + 8}px)`;
  const sel = selection;
  const selectedCutIndex = sel?.kind === 'cut' ? sel.index : null;

  return (
    <div className="editor" ref={rootRef} style={{height}}>
      <div className="ed-toolbar" data-tour="ed-toolbar">
        <button className="primary" onClick={() => void saveAll()} disabled={!dirtyCuts && !dirtyNarr} title="cuts.json と narration.json を保存（Ctrl+S）" data-tour="save">
          保存{dirtyCuts || dirtyNarr ? ' *' : ''}
        </button>
        <span className="btns">
          <button onClick={m.undo} disabled={!m.history.canUndo} title="取り消し（Ctrl+Z）">
            ↶
          </button>
          <button onClick={m.redo} disabled={!m.history.canRedo} title="やり直し（Ctrl+Y）">
            ↷
          </button>
        </span>
        <button
          onClick={() => {
            void s.loadFile('cuts');
            void s.loadFile('narration');
          }}
          title="ディスクから読み直す（未保存の変更は捨てます）"
        >
          読み直す
        </button>
        {(s.files.cuts.external || s.files.narration.external) && (
          <button
            className="warn"
            onClick={() => {
              if (s.files.cuts.external) void s.saveFile('cuts', true);
              if (s.files.narration.external) void s.saveFile('narration', true);
            }}
          >
            外部変更を上書き
          </button>
        )}
        <span className="sep" />
        <AiMenu placeholders={placeholders} cutCount={cuts?.cuts.length ?? 0} hasCuts={!!cuts} hasOrderCheck={!!m.orderCheck} />
        <button className="small" onClick={() => s.addJob('tts')} disabled={!narration || !!ttsBlockedBy || needsTts === 0} title={ttsBlockedBy ?? (needsTts === 0 ? 'すべてのブロックに音声があります' : `${needsTts} ブロックの音声を Fish Audio で作ります`)}>
          {ttsBusy ? '音声を生成中…' : `音声を生成（${needsTts}）`}
        </button>
        <span className="sep" />
        <label className="sb-inline" title="ナレーション・効果音をドラッグしたときカット境界に吸着する（Alt を押しながらで一時的に無効）">
          <input type="checkbox" checked={prefsSafe.snap} onChange={(e) => setPrefs({...prefsSafe, snap: e.target.checked})} />
          <span>吸着</span>
        </label>
        <label className="sb-inline" title="同じテロップが続くカットを 1 かたまりとして動かす（絵コンテ）">
          <input type="checkbox" checked={prefsSafe.groupMove} onChange={(e) => setPrefs({...prefsSafe, groupMove: e.target.checked})} />
          <span>テロップ単位で動かす</span>
        </label>
        <span className="sb-inline">
          <span className="hint">段</span>
          {(
            [
              ['telop', 'T'],
              ['narr', 'N'],
              ['sfx', 'S'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={`small chip${prefsSafe.tracks[k] ? ' on' : ''}`} onClick={() => setPrefs({...prefsSafe, tracks: {...prefsSafe.tracks, [k]: !prefsSafe.tracks[k]}})} title={k === 'telop' ? 'テロップ段' : k === 'narr' ? 'ナレーション段' : '効果音段'}>
              {l}
            </button>
          ))}
        </span>
        <button className={`small chip${prefsSafe.storyboard ? ' on' : ''}`} onClick={() => setPrefs({...prefsSafe, storyboard: !prefsSafe.storyboard})} title="サムネ一覧（絵コンテ）で並べ替える">
          絵コンテ
        </button>
        <span style={{flex: 1}} />
        {brief && cuts && (
          <button className="small" onClick={applyOrderToBrief} title="この並びを brief.order.fixed とフック（先頭カットの区間）に写す。Brief で plan し直すと型どおりの役割・テロップ枠が付く（尺は型に合わせて組み直される）">
            この並びを brief の固定順にする
          </button>
        )}
        <button className="small" onClick={() => onTab('render')} title="書き出し・納品へ">
          Render →
        </button>
      </div>

      {aiJob && <AiJobStatus job={aiJob} onCancel={(id) => void s.cancelJob(id)} compact />}

      <div className="ed-main">
        <div className="ed-bin">
          <Bin catalog={catalog} mediaBase={s.mediaBase} usage={m.usage} draggingId={binDrag.drag?.payload ?? null} handleProps={binDrag.handleProps} onAdd={addClip} onOpenMaterials={() => onTab('materials')} />
        </div>
        <div className="ed-center" ref={centerRef} data-tour="preview">
          {cuts ? (
            <>
              <Preview ref={preview} cuts={debouncedCuts ?? cuts} mediaBase={s.mediaBase} width={previewW} loop={loop} controls={false} onFrame={setFrame} onPlayState={setPlaying} />
              <Transport
                playing={playing}
                frame={frame}
                fps={cuts.fps}
                totalFrames={totalFrames}
                currentCut={m.currentCut}
                cutCount={cuts.cuts.length}
                loop={loop}
                light={s.light}
                onToggle={toggle}
                onStep={step}
                onHome={() => seek(0)}
                onEnd={() => seek(totalFrames - 1)}
                onLoop={setLoop}
                onLight={s.setLight}
              />
            </>
          ) : (
            <EmptyState
              title="まだカット構成がありません"
              steps={['左の素材をタイムラインへドラッグして自分で並べる', 'または Brief の「プラン生成」／「台本から組み立てる」で自動で作る']}
              action={{label: 'Brief へ', onClick: () => onTab('brief')}}
              hint="この画面で順番・長さ・テロップ・ナレーション・効果音をすべて整えます。"
            />
          )}
        </div>
        <div className="ed-inspector" data-tour="inspector">
          {sel?.kind === 'cut' && <CutInspector m={m} index={sel.index} onSeekCut={seekCut} focusTelop={focusTelop} />}
          {sel?.kind === 'telop' && <TelopInspector m={m} group={sel.group} onSeekCut={seekCut} />}
          {sel?.kind === 'narr' && <NarrationInspector m={m} index={sel.index} onSeekCut={seekCut} onPlay={playNarr} playing={previewingId} onRegenerate={(id) => void s.addJob('tts', {ids: [id], force: true})} ttsBlockedBy={ttsBlockedBy} />}
          {sel?.kind === 'sfx' && <SfxInspector m={m} index={sel.index} onSeekCut={seekCut} lib={lib} onPlay={playSfx} />}
          {!sel && <ReelInspector m={m} />}
          <ValidationPanel m={m} onSeekCut={seekCut} onSeekSec={seekSec} />
        </div>
      </div>

      {prefsSafe.storyboard && cuts && (
        <div className="ed-storyboard">
          <Storyboard
            slug={s.active}
            mediaBase={s.mediaBase}
            cuts={cuts}
            ranges={m.ranges}
            clipOf={m.clipOf}
            slotOf={m.slotOf}
            groupOfCut={m.groupOfCut}
            groups={m.groups}
            groupColors={GROUP_COLORS}
            issueOf={m.issueOf}
            currentCut={m.currentCut}
            selected={selectedCutIndex}
            blockOf={blockOf}
            groupMove={prefsSafe.groupMove}
            onGroupMove={(v) => setPrefs({...prefsSafe, groupMove: v})}
            onSelect={seekCut}
            onReorder={m.applyReorder}
            onUndo={m.undo}
            canUndo={m.history.canUndo}
          />
        </div>
      )}

      <div className="ed-timeline" data-tour="timeline">
        <div className="tl-toolbar">
          <span className="hint">
            {cuts ? `${cuts.cuts.length} カット / ${m.total.toFixed(2)}s` : 'まだカットがありません'}
            {narration ? ` / ナレーション ${narration.segments.length}` : ''}
            {narration?.sfx?.length ? ` / 効果音 ${narration.sfx.length}` : ''}
          </span>
          <span style={{flex: 1}} />
          <label className="sb-inline" title="拡大率（Ctrl+ホイールでも）">
            <span>拡大</span>
            <input type="range" min={PX_PER_SEC_MIN} max={PX_PER_SEC_MAX} step={1} value={prefsSafe.zoom} onChange={(e) => setPrefs({...prefsSafe, zoom: clampZoom(Number(e.target.value))})} style={{width: 110}} />
          </label>
          <button className="small" onClick={() => timeline.current?.fit()} title="全体が収まる拡大率にする">
            全体
          </button>
        </div>
        <Timeline
          ref={timeline}
          slug={s.active}
          mediaBase={s.mediaBase}
          cuts={cuts}
          fps={m.fps}
          narration={narration}
          sfxLib={lib}
          estimateSec={m.estimateSec}
          clipOf={m.clipOf}
          slotRole={(c) => m.slotOf(c)?.role}
          selection={selection}
          onSelect={selectFromTimeline}
          onSelectQuiet={(sel) => selectFromTimeline(sel, {seek: false})}
          currentFrame={frame}
          onSeek={seek}
          pxPerSec={prefsSafe.zoom}
          onPxPerSec={(v) => setPrefs({...prefsSafe, zoom: v})}
          issueOf={m.issueOf}
          groupColors={GROUP_COLORS}
          onStart={m.pushHistory}
          onCutsChange={m.setCuts}
          onNarrationChange={m.setNarr}
          onRemoveCut={(i) => !m.removeCut(i) && s.toast('最後の 1 カットは消せません', 'error')}
          onSplitCut={(i) => {
            const err = m.splitCut(i);
            if (err) s.toast(err, 'error');
          }}
          onAddNarration={(at) => {
            const idx = m.addSeg(at);
            if (idx === null) s.toast('brief が無いのでナレーションの設定が作れません', 'error');
          }}
          onAddSfx={(at) => {
            const err = m.addSfx(at);
            if (err) s.toast(err, 'error');
          }}
          external={binDrag.drag ? {x: binDrag.drag.x, y: binDrag.drag.y} : null}
          snap={prefsSafe.snap}
          tracks={prefsSafe.tracks}
        />
      </div>

      {binDrag.drag && (
        <div className="dnd-ghost" style={{left: binDrag.drag.x, top: binDrag.drag.y}}>
          {dragClip?.thumbs.sheet && s.mediaBase && <img src={`${s.mediaBase}/studio/${dragClip.thumbs.sheet}`} alt="" />}
          <span className="dnd-ghost-label">{extIndex !== null ? `→ ${extIndex + 1} 番目に入れる` : 'タイムラインまで運ぶ'}</span>
        </div>
      )}
    </div>
  );
};

