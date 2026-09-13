// Materials：素材カタログの閲覧・タグ編集・フック／NG／区間の指定（保存先は catalog.json）と、
// 素材を直接タイムラインに並べて尺を決める編集（保存先は cuts.json。Timeline 画面と同じファイルを同じ store で触る）。
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import {EmptyState} from '../components/EmptyState';
import {Preview, type PreviewHandle} from '../components/Preview';
import {ClipTimeline, type ClipTimelineHandle} from '../components/ClipTimeline';
import {useBinDrag} from '../components/useBinDrag';
import {useDebounced} from '../components/useDebounced';
import {PX_PER_SEC_DEFAULT, PX_PER_SEC_MAX, PX_PER_SEC_MIN, clampZoom, createReel, defaultRangeFor, insertCutAt, makeCut, newCutId, removeCutAt, sourceSecAt, splitCutAt, usageBySrc} from '../components/track';
import {cutRanges, snapSec, totalSec} from '@shared/timeline';
import {validateCuts} from '@shared/validate';
import {FORMAT_SPECS} from '@shared/format-specs';
import {PERSONAS} from '@shared/personas';
import {localDate} from '@shared/time';
import type {Catalog, Clip, ClipKind, ClipTags, ReelData} from '@shared/schema';

const KINDS: ClipKind[] = ['exterior', 'signage', 'interior', 'menu', 'cooking', 'serving', 'eating', 'sizzle', 'person', 'conversation', 'detail', 'other'];
const KIND_LABEL: Record<ClipKind, string> = {
  exterior: '外観',
  signage: '看板・店名',
  interior: '店内',
  menu: 'メニュー',
  cooking: '調理',
  serving: '提供・登場',
  eating: '実食',
  sizzle: 'シズル',
  person: '人物',
  conversation: '会話',
  detail: '小物',
  other: 'その他',
};

const defaultTags = (clip: Clip): ClipTags => ({
  kind: 'other',
  signage: false,
  signageSize: 'none',
  angle: 'mid',
  motion: 'handheld',
  sizzleScore: 3,
  quality: 3,
  hasSpeech: false,
  subject: '',
  description: clip.slug,
  source: 'user',
  taggedAt: new Date().toISOString(),
});

/** 落としたときの長さの上限（型の maxCutSec が分からないとき） */
const DEFAULT_MAX_CUT_SEC = 3;

type CtlPrefs = {open: boolean; preview: boolean; zoom: number};
const CTL_PREF_KEY = 'reel-studio.materials.timeline';
const loadCtlPrefs = (): CtlPrefs => {
  try {
    const raw = localStorage.getItem(CTL_PREF_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<CtlPrefs>;
      return {open: p.open ?? true, preview: p.preview ?? true, zoom: clampZoom(p.zoom ?? PX_PER_SEC_DEFAULT)};
    }
  } catch {
    /* localStorage が使えない環境では既定値 */
  }
  return {open: true, preview: true, zoom: PX_PER_SEC_DEFAULT};
};

export const MaterialsPage: React.FC<{onTab: (t: 'projects' | 'brief' | 'timeline') => void}> = ({onTab}) => {
  const s = useStudio();
  const catalog = s.files.catalog.data;
  const cuts = s.files.cuts.data;
  const brief = s.files.brief.data;
  const [selected, setSelected] = useState<string | null>(null);
  const [materialsDir, setMaterialsDir] = useState('');
  const [picking, setPicking] = useState(false);
  const [slugDraft, setSlugDraft] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const clip = useMemo(() => catalog?.clips.find((c) => c.id === selected) ?? null, [catalog, selected]);
  const untagged = catalog?.clips.filter((c) => !c.tags && !c.user.ng).length ?? 0;
  // 裏で走らせる Claude のモデル（ブラウザに記憶する）
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
  const aiBusy = s.jobs.some((j) => (j.status === 'running' || j.status === 'queued') && j.type.startsWith('ai-'));
  const staleTag = !s.supportsJob('ai-tag');
  const RESTART_HINT = 'Reel Studio を再起動してください（画面だけ新しく、サーバーが古いプロセスです）';

  const setCatalog = (next: Catalog) => s.setFile('catalog', next);
  const updateClip = (id: string, patch: (c: Clip) => Clip) => {
    if (!catalog) return;
    setCatalog({...catalog, clips: catalog.clips.map((c) => (c.id === id ? patch(c) : c))});
  };
  const setTags = (id: string, patch: Partial<ClipTags>) =>
    updateClip(id, (c) => ({...c, tags: {...(c.tags ?? defaultTags(c)), ...patch, source: 'user', taggedAt: new Date().toISOString()}}));
  const setUser = (id: string, patch: Partial<Clip['user']>) => updateClip(id, (c) => ({...c, user: {...c.user, ...patch}}));

  // 入力が空なら既存 catalog の素材フォルダを使う
  const effectiveDir = (materialsDir.trim() || catalog?.materialsDir || '').replace(/[\\/]+$/, '');
  const uploadsRoot = (s.config?.uploadsRoot ?? '').replace(/[\\/]+$/, '');
  const sep = (uploadsRoot || effectiveDir).includes('\\') ? '\\' : '/';
  const folderName = effectiveDir ? effectiveDir.split(/[\\/]/).filter(Boolean).pop() ?? '' : '';
  // 末尾の区切り文字は落とす（付けたままだと rtl 表示で先頭に回り込む）
  const parentDir = effectiveDir ? effectiveDir.slice(0, effectiveDir.length - folderName.length).replace(/[\\/]+$/, '') : '';

  const runCatalog = async () => {
    if (!effectiveDir) return s.toast('素材フォルダを指定してください', 'error');
    await s.addJob('catalog', {materialsDir: effectiveDir});
  };

  const browse = async () => {
    setPicking(true);
    try {
      const r = await api.post<{path: string | null; cancelled: boolean}>('/api/pick-folder', {initial: effectiveDir || undefined});
      if (r.data.path) setMaterialsDir(r.data.path);
    } catch (e) {
      s.toast(`フォルダを選べませんでした: ${(e as Error).message}`, 'error');
    } finally {
      setPicking(false);
    }
  };

  const applySlug = async () => {
    if (!clip || !s.active) return;
    if (s.files.catalog.dirty) return s.toast('先に catalog.json を保存してください', 'error');
    try {
      await api.post(`/api/projects/${s.active}/catalog/import`, {clips: [{id: clip.id, slug: slugDraft}], source: 'user'});
      await s.loadFile('catalog');
      s.toast(`slug を変更（ファイルもリネーム）`, 'ok');
    } catch (e) {
      s.toast((e as Error).message, 'error');
    }
  };

  const currentTime = () => Math.round((videoRef.current?.currentTime ?? 0) * 100) / 100;

  // ───────────────────────── タイムライン（cuts.json） ─────────────────────────
  const [ctlPrefs, setCtlPrefs] = useState<CtlPrefs>(loadCtlPrefs);
  const savePrefs = (p: Partial<CtlPrefs>) => {
    const next = {...ctlPrefs, ...p};
    setCtlPrefs(next);
    try {
      localStorage.setItem(CTL_PREF_KEY, JSON.stringify(next));
    } catch {
      /* 記憶できなくても動作には影響しない */
    }
  };
  const [selCut, setSelCut] = useState<number | null>(null);
  const [frame, setFrame] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const previewRef = useRef<PreviewHandle>(null);
  const timelineRef = useRef<ClipTimelineHandle>(null);
  const history = useRef<ReelData[]>([]);
  const debouncedCuts = useDebounced(cuts, 150);

  const clipBySrc = useMemo(() => new Map((catalog?.clips ?? []).map((c) => [c.src, c])), [catalog]);
  const aliasMap = useMemo(() => new Map((cuts?.meta?.aliases ?? []).map((a) => [a.to, a.from])), [cuts]);
  const resolveSrc = useCallback((src: string) => aliasMap.get(src) ?? src, [aliasMap]);
  const clipOf = useCallback((src: string) => clipBySrc.get(resolveSrc(src)), [clipBySrc, resolveSrc]);
  const usage = useMemo(() => usageBySrc(cuts, resolveSrc), [cuts, resolveSrc]);
  const persona = brief ? PERSONAS[brief.persona] : undefined;
  const spec = brief ? FORMAT_SPECS[brief.format ?? persona!.defaultFormat] : undefined;
  const maxCutSec = spec?.tempo.maxCutSec ?? DEFAULT_MAX_CUT_SEC;
  const fps = cuts?.fps ?? catalog?.dominantFps ?? 30;
  const ranges = useMemo(() => (cuts ? cutRanges(cuts) : []), [cuts]);
  const total = cuts ? totalSec(cuts) : 0;
  const validation = useMemo(
    () => (debouncedCuts ? validateCuts(debouncedCuts, {catalog: catalog ?? undefined, brief: brief ?? undefined, spec, persona}) : null),
    [debouncedCuts, catalog, brief, spec, persona],
  );
  const issueOf = useMemo(() => {
    const m = new Map<number, 'E' | 'W'>();
    for (const w of validation?.warnings ?? []) if (w.cutIndex !== undefined && !m.has(w.cutIndex)) m.set(w.cutIndex, 'W');
    for (const e of validation?.errors ?? []) if (e.cutIndex !== undefined) m.set(e.cutIndex, 'E');
    return m;
  }, [validation]);

  const applyCuts = useCallback((next: ReelData) => s.setFile('cuts', next), [s]);
  /** 変更の直前に呼ぶ（Ctrl+Z 用）。cuts.json がまだ無いとき（最初の 1 本）は戻せる状態が無いので積まない */
  const pushHistory = useCallback(() => {
    if (!cuts) return;
    history.current = [...history.current.slice(-29), cuts];
    setCanUndo(true);
  }, [cuts]);
  const undo = useCallback(() => {
    const snap = history.current.pop();
    setCanUndo(history.current.length > 0);
    if (!snap) return;
    applyCuts(snap);
    setSelCut(null);
  }, [applyCuts]);
  const undoRef = useRef(undo);
  undoRef.current = undo;

  const seek = useCallback((f: number) => {
    setFrame(f);
    previewRef.current?.pause();
    previewRef.current?.seekTo(f);
  }, []);
  const selectCut = useCallback(
    (i: number) => {
      if (!cuts || !cuts.cuts[i]) return;
      setSelCut(i);
      const c = clipOf(cuts.cuts[i].src);
      if (c) setSelected(c.id);
      const r = ranges[i];
      if (r) seek(Math.min(r.from + Math.round(0.3 * cuts.fps), r.from + r.dur - 1));
    },
    [cuts, clipOf, ranges, seek],
  );

  /** 素材をタイムラインに入れる。index 省略なら末尾。cuts.json が無ければここで作る */
  const addClip = useCallback(
    (clipId: string, index?: number) => {
      const c = catalog?.clips.find((x) => x.id === clipId);
      if (!c || !catalog) return;
      if (c.user.ng) return s.toast(`${c.id} は NG 指定です（使うなら NG を外してください）`, 'error');
      const range = defaultRangeFor(c, fps, maxCutSec);
      if (!cuts) {
        const first = makeCut(c, range, 'c01');
        applyCuts(createReel(catalog.dominantFps, brief?.theme ?? spec?.theme, first));
        setSelCut(0);
        setSelected(c.id);
        s.toast('cuts.json を新しく作りました（保存するまでファイルには書かれません）', 'ok');
        return;
      }
      pushHistory();
      const at = index ?? cuts.cuts.length;
      applyCuts(insertCutAt(cuts, makeCut(c, range, newCutId(cuts.cuts)), at));
      setSelCut(Math.min(at, cuts.cuts.length));
      setSelected(c.id);
    },
    [catalog, cuts, fps, maxCutSec, brief, spec, applyCuts, pushHistory, s],
  );
  const removeCut = useCallback(
    (i: number) => {
      if (!cuts) return;
      const next = removeCutAt(cuts, i);
      if (!next) return s.toast('最後の 1 カットは消せません（別の素材を入れてから消してください）', 'error');
      pushHistory();
      applyCuts(next);
      setSelCut(null);
    },
    [cuts, applyCuts, pushHistory, s],
  );
  const splitCut = useCallback(
    (i: number) => {
      if (!cuts) return;
      const r = ranges[i];
      const c = cuts.cuts[i];
      if (!r || !c) return;
      const offset = frame / cuts.fps - r.startSec;
      if (offset < 0 || offset > r.durSec) return s.toast('再生ヘッド（赤い線）をこのカットの中に置いてから分割してください', 'error');
      const next = splitCutAt(cuts, i, sourceSecAt(c, offset), cuts.fps);
      if (!next) return s.toast('端に寄りすぎています（両側に 0.2 秒以上残る位置で分割してください）', 'error');
      pushHistory();
      applyCuts(next);
      setSelCut(i);
    },
    [cuts, ranges, frame, applyCuts, pushHistory, s],
  );
  /** IN/OUT のドラッグ中、右の video をその秒に合わせる（選択中の素材と同じときだけ） */
  const scrubVideo = useCallback(
    (src: string, sec: number) => {
      const v = videoRef.current;
      if (!v || clipOf(src)?.id !== selected) return;
      v.currentTime = sec;
    },
    [clipOf, selected],
  );
  /** 今の並びを brief の固定順＋フックにして、Brief の plan で役割・テロップ枠を付けられるようにする */
  const applyOrderToBrief = () => {
    if (!brief || !cuts) return;
    const ids = cuts.cuts.map((c) => clipOf(c.src)?.id).filter((x): x is string => !!x);
    if (ids.length !== cuts.cuts.length) return s.toast('catalog に無い素材が含まれているため固定順にできません', 'error');
    const first = cuts.cuts[0];
    s.setFile('brief', {...brief, order: {...brief.order, mode: 'fixed', fixed: ids}, hook: {...(brief.hook ?? {}), clipId: ids[0], inSec: first.inSec, outSec: first.outSec}});
    s.toast('brief に固定順とフックを入れました。Brief で「cuts.json に書き込む」と型どおりの役割・テロップ枠が付きます（尺は型に合わせて組み直されます）', 'ok');
  };

  // 素材カード → タイムラインへのドラッグ
  const binDrag = useBinDrag<string>({
    onDrop: (clipId, x, y) => {
      const idx = timelineRef.current?.insertIndexAtPoint(x, y);
      if (idx === null || idx === undefined) return;
      addClip(clipId, idx);
    },
  });
  const extIndex = binDrag.drag ? (timelineRef.current?.insertIndexAtPoint(binDrag.drag.x, binDrag.drag.y) ?? null) : null;
  const dragClip = binDrag.drag ? catalog?.clips.find((c) => c.id === binDrag.drag!.payload) : undefined;

  // Ctrl+S：未保存のものを保存／Ctrl+Z：タイムラインの編集を 1 手戻す（入力欄の中では効かない）
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (s.files.cuts.dirty) void s.saveFile('cuts');
        if (s.files.catalog.dirty) void s.saveFile('catalog');
      }
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

  // 案件を切り替えたら履歴は捨てる
  useEffect(() => {
    history.current = [];
    setCanUndo(false);
    setSelCut(null);
  }, [s.active]);

  // レンダー中はプレビューを止める（Timeline と同じ）
  useEffect(() => {
    const running = s.jobs.some((j) => j.status === 'running' && (j.type === 'render' || j.type === 'draft'));
    if (running) previewRef.current?.pause();
  }, [s.jobs]);

  if (!s.active)
    return (
      <div className="page">
        <EmptyState
          title="案件が開かれていません"
          steps={['Projects で既存の案件を「開く」', '無ければ「新規案件」で作る']}
          action={{label: 'Projects へ', onClick: () => onTab('projects')}}
        />
      </div>
    );

  const currentCut = ranges.findIndex((r) => frame >= r.from && frame < r.from + r.dur);

  return (
    <div className="page">
      <section className="card" data-tour="materials-folder">
        <h2>素材フォルダ</h2>
        <p className="hint">撮った動画が入っているフォルダを選びます。中の動画をすべて読み込み、長さ・解像度を調べて案件フォルダにコピーします（元のフォルダは変更しません）。</p>
        <div className="row">
          <button onClick={browse} disabled={picking}>
            {picking ? '選択中…' : '📂 参照…（エクスプローラー）'}
          </button>
          <label>
            uploads 配下から選ぶ
            <select
              value={uploadsRoot && effectiveDir.startsWith(uploadsRoot) ? folderName : ''}
              onChange={(e) => e.target.value && setMaterialsDir(`${uploadsRoot}${sep}${e.target.value}`)}
            >
              <option value="">（選択）</option>
              {s.config?.uploadsFolders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label className="grow">
            パスを直接入力
            <input value={materialsDir} onChange={(e) => setMaterialsDir(e.target.value)} placeholder={catalog?.materialsDir ?? `${uploadsRoot || 'uploads'}${sep}<店名>`} spellCheck={false} />
          </label>
        </div>
        <div className="folder-pick" title={effectiveDir || undefined}>
          {effectiveDir ? (
            <>
              <span className="dim">選択中</span>
              <b className="folder-name">{folderName}</b>
              <span className="folder-parent">{parentDir ? `（${parentDir} の中）` : ''}</span>
            </>
          ) : (
            <span className="dim">素材フォルダが未選択です。「参照…」で選ぶか、パスを入力してください</span>
          )}
        </div>
        <div className="row" style={{marginTop: 8}}>
          <button className="primary" onClick={runCatalog} disabled={!effectiveDir}>
            カタログ実行（probe・コピー・プロキシ・サムネ）
          </button>
          <button onClick={() => s.addJob('thumbs')} disabled={!catalog}>
            サムネ再生成
          </button>
          <button onClick={() => s.addJob('proxy')} disabled={!catalog}>
            HEVC/4K プロキシ生成
          </button>
          <button onClick={() => s.addJob('preview-proxy')} disabled={!catalog} title="540x960 の軽量版。Timeline の「軽量プレビュー」で使う">
            軽量プレビュー生成
          </button>
          <span style={{flex: 1}} />
          <button onClick={() => s.loadFile('catalog')}>読み直す</button>
          <button className="primary" onClick={() => s.saveFile('catalog')} disabled={!s.files.catalog.dirty}>
            catalog.json を保存
          </button>
          {s.files.catalog.external && (
            <button className="warn" onClick={() => s.saveFile('catalog', true)}>
              外部変更を上書き
            </button>
          )}
        </div>
        {catalog && (
          <p className="hint">
            {catalog.clips.length} 本 / 主力 {catalog.dominantFps}fps / 素材: {catalog.materialsDir}
            {untagged > 0 && (
              <>
                {' '}
                / <b style={{color: 'var(--warn)'}}>未タグ {untagged} 本</b>
              </>
            )}
          </p>
        )}
        {catalog && (
          <div className="row" style={{marginTop: 4}}>
            <button className="primary" onClick={() => s.addJob('ai-tag', {model: aiModel})} disabled={aiBusy || staleTag || untagged === 0} title={staleTag ? RESTART_HINT : '裏で Claude を起動し、サムネイルを 1 枚ずつ見て kind / 画角 / 被写体などを書き込みます'}>
              {aiBusy ? 'AI がタグ付け中…' : `AI にタグ付けしてもらう（未タグ ${untagged} 本）`}
            </button>
            <button onClick={() => s.addJob('ai-tag', {model: aiModel, force: true})} disabled={aiBusy || staleTag} title={staleTag ? RESTART_HINT : 'タグ済みも含めて全部付け直す（lock したクリップは除く）'}>
              全部付け直す
            </button>
            <label>
              モデル
              <select value={aiModel} onChange={(e) => changeAiModel(e.target.value)}>
                <option value="opus">opus（精度重視）</option>
                <option value="sonnet">sonnet（速い・安い）</option>
                <option value="haiku">haiku（最安）</option>
              </select>
            </label>
            <span className="hint">API 課金が発生します。実測で 3 本 / sonnet が約 $0.33 でした。手で付けたい場合は下のフォームからどうぞ</span>
          </div>
        )}
      </section>

      {!catalog && (
        <EmptyState
          title="まだ素材を読み込んでいません"
          steps={[
            '上の「📂 参照…」でフォルダを選ぶ（または uploads 配下から選択）',
            '「カタログ実行」を押す（動画の本数によっては数分かかります）',
            '読み込めたら 1 本ずつタグを付ける（Claude に頼めます）',
          ]}
          hint="タグ＝「何が映っているか」の記録です。これを元に Brief でカット構成が自動で組まれます。"
        />
      )}

      {catalog && (
        <section className={`card ctl-card${ctlPrefs.open ? '' : ' closed'}`} data-tour="materials-timeline">
          <div className="sb-bar">
            <button className="sb-toggle" onClick={() => savePrefs({open: !ctlPrefs.open})} title={ctlPrefs.open ? '折りたたむ' : '開く'}>
              {ctlPrefs.open ? '▾' : '▸'}
            </button>
            <span className="sb-title">タイムライン</span>
            <span className="hint">
              {cuts ? `${cuts.cuts.length} カット / ${total.toFixed(2)}s` : 'まだカットがありません'}
              {cuts && currentCut >= 0 ? `（${(frame / cuts.fps).toFixed(2)}s・カット ${currentCut + 1}）` : ''}
            </span>
            <span className="hint sb-howto">素材カードをここへドラッグで追加 ／ ブロックの両端で尺 ／ ブロックをドラッグで並べ替え ／ Alt+ドラッグで中身をずらす</span>
            <span style={{flex: 1}} />
            <label className="sb-inline" title="Remotion のプレビュー（テロップ付き）。重いときは切る">
              <input type="checkbox" checked={ctlPrefs.preview} onChange={(e) => savePrefs({preview: e.target.checked})} />
              <span>プレビュー</span>
            </label>
            <label className="sb-inline" title="拡大率（Ctrl+ホイールでも）">
              <span>拡大</span>
              <input type="range" min={PX_PER_SEC_MIN} max={PX_PER_SEC_MAX} step={1} value={ctlPrefs.zoom} onChange={(e) => savePrefs({zoom: clampZoom(Number(e.target.value))})} style={{width: 110}} />
            </label>
            <button className="small" onClick={() => timelineRef.current?.fit()} title="全体が収まる拡大率にする">
              全体
            </button>
            <button onClick={undo} disabled={!canUndo} title="タイムラインの編集（追加・削除・並び・尺）を 1 つ戻す（Ctrl+Z）">
              ↶ 元に戻す
            </button>
            <button onClick={() => s.loadFile('cuts')} disabled={!cuts && !s.files.cuts.dirty}>
              読み直す
            </button>
            <button className="primary" onClick={() => s.saveFile('cuts')} disabled={!s.files.cuts.dirty}>
              cuts.json を保存（Ctrl+S）
            </button>
            {s.files.cuts.external && (
              <button className="warn" onClick={() => s.saveFile('cuts', true)}>
                外部変更を上書き
              </button>
            )}
          </div>
          {ctlPrefs.open && (
            <div className="ctl-body">
              {ctlPrefs.preview && cuts && cuts.cuts.length > 0 && (
                <div className="ctl-preview">
                  <Preview ref={previewRef} cuts={debouncedCuts ?? cuts} mediaBase={s.mediaBase} width={170} onFrame={setFrame} />
                </div>
              )}
              <div className="ctl-main">
                <ClipTimeline
                  ref={timelineRef}
                  slug={s.active}
                  mediaBase={s.mediaBase}
                  cuts={cuts}
                  fps={fps}
                  clipOf={clipOf}
                  selected={selCut}
                  onSelect={selectCut}
                  currentFrame={frame}
                  onSeek={seek}
                  pxPerSec={ctlPrefs.zoom}
                  onPxPerSec={(v) => savePrefs({zoom: v})}
                  issueOf={issueOf}
                  onStart={pushHistory}
                  onChange={applyCuts}
                  onRemove={removeCut}
                  onSplit={splitCut}
                  onScrub={scrubVideo}
                  external={binDrag.drag ? {x: binDrag.drag.x, y: binDrag.drag.y} : null}
                />
                <div className="row ctl-foot">
                  <span className="hint">
                    追加時の長さ：使える区間（best）があればそれ、無ければ頭から最大 {maxCutSec} 秒（会話クリップは全尺）。右端を引いて伸ばせます。テロップは Timeline で付けます
                  </span>
                  <span style={{flex: 1}} />
                  {validation && (validation.errors.length > 0 || validation.warnings.length > 0) && (
                    <span className="hint">
                      検証 <b style={{color: validation.errors.length ? 'var(--err)' : 'var(--warn)'}}>E {validation.errors.length} / W {validation.warnings.length}</b>
                    </span>
                  )}
                  {cuts && (
                    <button className="small" onClick={() => onTab('timeline')} title="テロップ・検証・AI の直しは Timeline 画面で">
                      Timeline で仕上げる →
                    </button>
                  )}
                  {cuts && brief && (
                    <button
                      className="small"
                      onClick={applyOrderToBrief}
                      title="この並びを brief.order.fixed とフック（先頭カットの区間）に写す。Brief で plan し直すと型どおりの役割・テロップ枠が付く（尺は型に合わせて組み直される）"
                    >
                      この並びを brief の固定順にする
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {catalog && (
        <div className="materials">
          <section className="card">
            <h2>クリップ（{catalog.clips.length}）</h2>
            <p className="hint">クリックすると右側で編集できます。カードを上のタイムラインへドラッグ（または「＋」）で並べます。★＝つかみに使いたい画、NG＝使わない画。</p>
            <div className="clip-grid" data-tour="clip-grid">
              {catalog.clips.map((c) => {
                const used = usage.get(c.src) ?? 0;
                return (
                  <div
                    key={c.id}
                    className={`clip-card${c.id === selected ? ' selected' : ''}${c.user.ng ? ' ng' : ''}${binDrag.drag?.payload === c.id ? ' dragging' : ''}`}
                    onClick={() => setSelected(c.id)}
                    {...binDrag.handleProps(c.id)}
                  >
                    {c.thumbs.sheet && s.mediaBase ? <img src={`${s.mediaBase}/studio/${c.thumbs.sheet}`} alt={c.slug} loading="lazy" draggable={false} /> : <div style={{height: 90}} />}
                    <div className="meta">
                      <span>
                        <b>{c.id}</b> {c.probe.durationSec.toFixed(1)}s
                      </span>
                      <span>{c.probe.codec === 'hevc' ? 'HEVC' : ''}</span>
                    </div>
                    <div className="desc">{c.tags?.description ?? c.slug}</div>
                    <div className="badges">
                      {c.user.hook && <span className="badge hook">★hook</span>}
                      {c.user.ng && <span className="badge ng">NG</span>}
                      {c.tags?.signage && <span className="badge sign">看板</span>}
                      {c.tags ? <span className="badge">{KIND_LABEL[c.tags.kind]}/{c.tags.angle}</span> : <span className="badge untagged">未タグ</span>}
                      {c.user.lock && <span className="badge">lock</span>}
                      {used > 0 && <span className="badge used">使用中{used > 1 ? ` ×${used}` : ''}</span>}
                      <span style={{flex: 1}} />
                      <button
                        className="small clip-add"
                        title="タイムラインの末尾に追加"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          addClip(c.id);
                        }}
                        disabled={c.user.ng}
                      >
                        ＋
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="card detail">
            {!clip ? (
              <p className="hint">クリップを選択</p>
            ) : (
              <>
                <h2>
                  {clip.id} {clip.original} → {clip.src.replace('uploads/', '')}
                </h2>
                <video ref={videoRef} src={`${s.mediaBase}/${clip.src}`} controls preload="metadata" />
                <div className="strip">
                  {clip.thumbs.strip.map((p, i) => (
                    <img
                      key={p}
                      src={`${s.mediaBase}/studio/${p}`}
                      alt=""
                      title={`${i}s`}
                      onClick={() => {
                        if (videoRef.current) videoRef.current.currentTime = clip.probe.durationSec < 3 ? i * 0.5 : i;
                      }}
                    />
                  ))}
                </div>
                <div className="hint">
                  {clip.probe.codec} {clip.probe.width}x{clip.probe.height}
                  {clip.probe.rotation ? ` rot${clip.probe.rotation}` : ''} {clip.probe.fps}fps {clip.probe.durationSec}s {clip.probe.hasAudio ? '音声あり' : '無音'}
                </div>
                <div className="row" style={{marginTop: 4}}>
                  <button className="small" onClick={() => addClip(clip.id)} disabled={clip.user.ng} title="使える区間（best）か既定の長さでタイムラインの末尾に追加">
                    ＋ タイムラインに追加
                  </button>
                  <button
                    className="small"
                    disabled={clip.user.ng}
                    title="いまの再生位置を IN にして追加（長さは既定の上限まで）"
                    onClick={() => {
                      const t = snapSec(currentTime(), fps);
                      const range = {inSec: t, outSec: snapSec(Math.min(clip.probe.durationSec, t + maxCutSec), fps)};
                      if (range.outSec - range.inSec < 0.2) return s.toast('再生位置が末尾に近すぎます', 'error');
                      if (!cuts) {
                        applyCuts(createReel(catalog.dominantFps, brief?.theme ?? spec?.theme, makeCut(clip, range, 'c01')));
                        setSelCut(0);
                      } else {
                        pushHistory();
                        applyCuts(insertCutAt(cuts, makeCut(clip, range, newCutId(cuts.cuts)), cuts.cuts.length));
                        setSelCut(cuts.cuts.length);
                      }
                    }}
                  >
                    ＋ 再生位置から追加
                  </button>
                  {(usage.get(clip.src) ?? 0) > 0 && <span className="hint">タイムラインで {usage.get(clip.src)} 回使用中</span>}
                </div>

                <h3>ユーザー判断</h3>
                <div className="row">
                  <label>
                    <span>★ フック候補</span>
                    <input type="checkbox" checked={clip.user.hook} onChange={(e) => setUser(clip.id, {hook: e.target.checked})} />
                  </label>
                  <label>
                    <span>NG（使わない）</span>
                    <input type="checkbox" checked={clip.user.ng} onChange={(e) => setUser(clip.id, {ng: e.target.checked})} />
                  </label>
                  <label>
                    <span>lock（Claude が上書きしない）</span>
                    <input type="checkbox" checked={clip.user.lock} onChange={(e) => setUser(clip.id, {lock: e.target.checked})} />
                  </label>
                  <label>
                    並び順ヒント
                    <input type="number" value={clip.user.orderHint ?? ''} onChange={(e) => setUser(clip.id, {orderHint: e.target.value === '' ? null : Number(e.target.value)})} />
                  </label>
                  <label style={{flex: 1}}>
                    メモ
                    <input value={clip.user.note ?? ''} onChange={(e) => setUser(clip.id, {note: e.target.value})} />
                  </label>
                </div>

                <h3>タグ {clip.tags ? <span className="hint">（{clip.tags.source} / {localDate(clip.tags.taggedAt)}）</span> : <button className="small" onClick={() => setTags(clip.id, {})}>タグを付ける</button>}</h3>
                {clip.tags && (
                  <div className="form">
                    <label>
                      種別
                      <select value={clip.tags.kind} onChange={(e) => setTags(clip.id, {kind: e.target.value as ClipKind, signage: e.target.value === 'signage' ? true : clip.tags!.signage})}>
                        {KINDS.map((k) => (
                          <option key={k} value={k}>
                            {k}（{KIND_LABEL[k]}）
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      画角
                      <select value={clip.tags.angle} onChange={(e) => setTags(clip.id, {angle: e.target.value as ClipTags['angle']})}>
                        <option value="wide">wide（引き）</option>
                        <option value="mid">mid</option>
                        <option value="close">close（寄り）</option>
                      </select>
                    </label>
                    <label>
                      <span>店名・ロゴ・看板が読める（F7 で終盤に温存）</span>
                      <input type="checkbox" checked={clip.tags.signage} onChange={(e) => setTags(clip.id, {signage: e.target.checked, signageSize: e.target.checked ? (clip.tags!.signageSize === 'none' ? 'small' : clip.tags!.signageSize) : 'none'})} />
                    </label>
                    <label>
                      看板の大きさ
                      <select value={clip.tags.signageSize} onChange={(e) => setTags(clip.id, {signageSize: e.target.value as ClipTags['signageSize']})}>
                        <option value="none">none</option>
                        <option value="small">small</option>
                        <option value="large">large</option>
                      </select>
                    </label>
                    <label>
                      シズル度 1-5
                      <input type="number" min={1} max={5} value={clip.tags.sizzleScore} onChange={(e) => setTags(clip.id, {sizzleScore: Number(e.target.value)})} />
                    </label>
                    <label>
                      画質 1-5
                      <input type="number" min={1} max={5} value={clip.tags.quality} onChange={(e) => setTags(clip.id, {quality: Number(e.target.value)})} />
                    </label>
                    <label>
                      動き
                      <select value={clip.tags.motion} onChange={(e) => setTags(clip.id, {motion: e.target.value as ClipTags['motion']})}>
                        <option value="static">static</option>
                        <option value="pan">pan</option>
                        <option value="handheld">handheld</option>
                        <option value="action">action</option>
                      </select>
                    </label>
                    <label>
                      <span>会話・語りがある（保護クリップ）</span>
                      <input type="checkbox" checked={clip.tags.hasSpeech} onChange={(e) => setTags(clip.id, {hasSpeech: e.target.checked})} />
                    </label>
                    <label>
                      被写体
                      <input value={clip.tags.subject} onChange={(e) => setTags(clip.id, {subject: e.target.value})} />
                    </label>
                    <label className="full">
                      内容（カタログの「内容」列）
                      <input value={clip.tags.description} onChange={(e) => setTags(clip.id, {description: e.target.value})} />
                    </label>
                  </div>
                )}

                <h3>使える区間（usableRanges）</h3>
                <div className="ranges">
                  {clip.usableRanges.map((r, i) => (
                    <div className="range" key={i}>
                      <input type="number" step={0.05} value={r.inSec} onChange={(e) => updateClip(clip.id, (c) => ({...c, usableRanges: c.usableRanges.map((x, k) => (k === i ? {...x, inSec: Number(e.target.value)} : x))}))} />
                      <button className="small" onClick={() => updateClip(clip.id, (c) => ({...c, usableRanges: c.usableRanges.map((x, k) => (k === i ? {...x, inSec: currentTime()} : x))}))}>
                        IN=再生位置
                      </button>
                      <input type="number" step={0.05} value={r.outSec} onChange={(e) => updateClip(clip.id, (c) => ({...c, usableRanges: c.usableRanges.map((x, k) => (k === i ? {...x, outSec: Number(e.target.value)} : x))}))} />
                      <button className="small" onClick={() => updateClip(clip.id, (c) => ({...c, usableRanges: c.usableRanges.map((x, k) => (k === i ? {...x, outSec: currentTime()} : x))}))}>
                        OUT=再生位置
                      </button>
                      <select value={r.label} onChange={(e) => updateClip(clip.id, (c) => ({...c, usableRanges: c.usableRanges.map((x, k) => (k === i ? {...x, label: e.target.value as typeof x.label} : x))}))}>
                        <option value="best">best（見せ場）</option>
                        <option value="ok">ok</option>
                        <option value="motion-full">motion-full（一連動作）</option>
                        <option value="avoid">avoid（使わない）</option>
                      </select>
                      <input placeholder="メモ" value={r.note ?? ''} onChange={(e) => updateClip(clip.id, (c) => ({...c, usableRanges: c.usableRanges.map((x, k) => (k === i ? {...x, note: e.target.value} : x))}))} />
                      <button className="small danger" onClick={() => updateClip(clip.id, (c) => ({...c, usableRanges: c.usableRanges.filter((_, k) => k !== i)}))}>
                        ×
                      </button>
                    </div>
                  ))}
                  <button className="small" onClick={() => updateClip(clip.id, (c) => ({...c, usableRanges: [...c.usableRanges, {inSec: currentTime(), outSec: Math.min(c.probe.durationSec, currentTime() + 1.5), label: 'best'}]}))}>
                    + 区間を追加（再生位置から 1.5 秒）
                  </button>
                  <div className="hint">無指定なら全尺（2.5 秒以上のクリップは頭尾 0.2 秒を避ける）から使う</div>
                </div>

                <h3>ファイル名（slug）</h3>
                <div className="row">
                  <input value={slugDraft || clip.slug} onChange={(e) => setSlugDraft(e.target.value)} placeholder={clip.slug} />
                  <button className="small" onClick={applySlug} disabled={!slugDraft || slugDraft === clip.slug}>
                    リネームして適用
                  </button>
                  <span className="hint">英数字・ハイフン。public/uploads のファイルも一緒にリネームされる（catalog 保存後に実行）</span>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {binDrag.drag && (
        <div className="dnd-ghost" style={{left: binDrag.drag.x, top: binDrag.drag.y}}>
          {dragClip?.thumbs.sheet && s.mediaBase && <img src={`${s.mediaBase}/studio/${dragClip.thumbs.sheet}`} alt="" />}
          <span className="dnd-ghost-label">{extIndex !== null ? `→ ${extIndex + 1} 番目に入れる` : 'タイムラインまで運ぶ'}</span>
        </div>
      )}
    </div>
  );
};
