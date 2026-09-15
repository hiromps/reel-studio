// 編集画面の状態と操作をまとめたフック。cuts.json / narration.json は store が持ち、ここは
// 「選択」「取り消し履歴」「よく使う書き換え」を提供する。DOM には触らない。
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useStudio} from '../state/store';
import type {Clip, Cut, Narration, NarrationSegment, ReelData, Slot, SubDef} from '@shared/schema';
import {cutRanges, round3, snapSec, telopGroupsOf, totalSec} from '@shared/timeline';
import {validateCuts, type Issue} from '@shared/validate';
import {checkOrder, orderFromCuts} from '@shared/order';
import {FORMAT_SPECS} from '@shared/format-specs';
import {findPersona} from '@shared/personas';
import {checkNarration, fixNarrationOverlaps} from '@shared/narration';
import {SFX_DEFAULTS, checkSfx, type SfxLibrary} from '@shared/sfx';
import {useUndo} from '../hooks/useUndo';
import {useDebounced} from '../components/useDebounced';
import {defaultRangeFor, insertCutAt, makeCut, newCutId, removeCutAt, splitCutAt, sourceSecAt, usageBySrc, createReel} from '../components/track';
import {reorderBlock, destIndexOf} from '../components/reorder';
import {selectionAfterRemove, type Selection} from './selection';

/** 落としたときの長さの上限（型の maxCutSec が分からないとき） */
const DEFAULT_MAX_CUT_SEC = 3;

type Snapshot = {cuts: ReelData | null; narration: Narration | null};

export const useEditorModel = (sfxLib: SfxLibrary | null) => {
  const s = useStudio();
  const cuts = s.files.cuts.data;
  const narration = s.files.narration.data;
  const catalog = s.files.catalog.data;
  const brief = s.files.brief.data;

  const [selection, setSelection] = useState<Selection>(null);
  const [frame, setFrame] = useState(0);
  const history = useUndo<Snapshot>({resetKey: s.active});

  const persona = brief ? findPersona(brief.persona) : undefined;
  const spec = brief ? FORMAT_SPECS[brief.format ?? persona?.defaultFormat ?? 'F0'] : undefined;
  const fps = cuts?.fps ?? catalog?.dominantFps ?? 30;
  const maxCutSec = spec?.tempo.maxCutSec ?? DEFAULT_MAX_CUT_SEC;
  const cps = persona?.narration.charsPerSec ?? 11;
  const estimateSec = useCallback((seg: NarrationSegment) => (seg.durSec && seg.durSec > 0 ? seg.durSec : [...seg.text].length / cps), [cps]);

  // ---- 参照の解決 ----
  const clipBySrc = useMemo(() => new Map((catalog?.clips ?? []).map((c) => [c.src, c])), [catalog]);
  const aliasMap = useMemo(() => new Map((cuts?.meta?.aliases ?? []).map((a) => [a.to, a.from])), [cuts]);
  const resolveSrc = useCallback((src: string) => aliasMap.get(src) ?? src, [aliasMap]);
  const clipOf = useCallback((src: string): Clip | undefined => clipBySrc.get(resolveSrc(src)), [clipBySrc, resolveSrc]);
  const slotOf = useCallback((c: Cut): Slot | undefined => cuts?.meta?.slots?.find((x) => x.cutId === c.id), [cuts]);
  const usage = useMemo(() => usageBySrc(cuts, resolveSrc), [cuts, resolveSrc]);
  const ranges = useMemo(() => (cuts ? cutRanges(cuts) : []), [cuts]);
  const groups = useMemo(() => (cuts ? telopGroupsOf(cuts) : []), [cuts]);
  const groupOfCut = useMemo(() => {
    const m = new Map<number, number>();
    groups.forEach((g, gi) => g.cutIndices.forEach((ci) => m.set(ci, gi)));
    return m;
  }, [groups]);
  const total = cuts ? totalSec(cuts) : 0;
  const currentCut = ranges.findIndex((r) => frame >= r.from && frame < r.from + r.dur);

  // ---- 検証（入力中は少し待つ） ----
  const debounced = useDebounced(cuts, 150);
  const validation = useMemo(() => (debounced ? validateCuts(debounced, {catalog: catalog ?? undefined, brief: brief ?? undefined, spec, persona}) : null), [debounced, catalog, brief, spec, persona]);
  const orderCheck = useMemo(() => {
    if (!debounced || !catalog || !brief || !spec) return null;
    const ids = orderFromCuts(debounced, catalog);
    if (!ids.length || ids.length !== debounced.cuts.length) return null;
    return {ids, ...checkOrder(ids, {catalog, brief, spec, persona})};
  }, [debounced, catalog, brief, spec, persona]);
  const issueOf = useMemo(() => {
    const m = new Map<number, 'E' | 'W'>();
    for (const w of validation?.warnings ?? []) if (w.cutIndex !== undefined && !m.has(w.cutIndex)) m.set(w.cutIndex, 'W');
    for (const e of validation?.errors ?? []) if (e.cutIndex !== undefined) m.set(e.cutIndex, 'E');
    return m;
  }, [validation]);
  const narrIssues = useMemo(() => (narration ? checkNarration(narration, {estimate: estimateSec, videoSec: total || undefined, emptyText: true}) : []), [narration, estimateSec, total]);
  const sfxIssues = useMemo(() => (narration ? checkSfx(narration.sfx ?? [], {videoSec: total || undefined, lib: sfxLib ?? undefined, narration: narration.segments}) : []), [narration, total, sfxLib]);

  // ---- 書き換えの基本形（履歴を積む → store に入れる） ----
  const snapshot = useCallback((): Snapshot => ({cuts: s.files.cuts.data, narration: s.files.narration.data}), [s.files.cuts.data, s.files.narration.data]);
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;
  /** 変更の直前に呼ぶ（ドラッグの開始など、何回も書き換わる操作は最初の 1 回だけ） */
  const pushHistory = useCallback(() => history.push(snapRef.current()), [history]);
  const setCuts = useCallback((next: ReelData) => s.setFile('cuts', next), [s]);
  const setNarr = useCallback((next: Narration) => s.setFile('narration', next), [s]);
  /** 1 回の操作＝履歴 1 手 */
  const commitCuts = useCallback(
    (next: ReelData) => {
      pushHistory();
      setCuts(next);
    },
    [pushHistory, setCuts],
  );
  const commitNarr = useCallback(
    (next: Narration) => {
      pushHistory();
      setNarr(next);
    },
    [pushHistory, setNarr],
  );
  // 保存済み（読み込み直後・保存直後）の状態。取り消しでここまで戻ったら「未保存」の印を消す
  const baseline = useRef<Snapshot>({cuts: null, narration: null});
  useEffect(() => {
    if (!s.files.cuts.dirty) baseline.current = {...baseline.current, cuts: s.files.cuts.data};
  }, [s.files.cuts.etag, s.files.cuts.dirty, s.files.cuts.data]);
  useEffect(() => {
    if (!s.files.narration.dirty) baseline.current = {...baseline.current, narration: s.files.narration.data};
  }, [s.files.narration.etag, s.files.narration.dirty, s.files.narration.data]);
  const restore = useCallback(
    (snap: Snapshot | null) => {
      if (!snap) return;
      const cur = snapRef.current();
      if (snap.cuts && snap.cuts !== cur.cuts) s.setFile('cuts', snap.cuts, {dirty: snap.cuts !== baseline.current.cuts});
      if (snap.narration && snap.narration !== cur.narration) s.setFile('narration', snap.narration, {dirty: snap.narration !== baseline.current.narration});
    },
    [s],
  );
  const undo = useCallback(() => restore(history.undo(snapRef.current())), [history, restore]);
  const redo = useCallback(() => restore(history.redo(snapRef.current())), [history, restore]);

  // ---- カットの操作 ----
  const patchCut = useCallback(
    (i: number, patch: Partial<Cut> | ((c: Cut) => Cut), opt: {history?: boolean} = {}) => {
      if (!cuts) return;
      const next = {...cuts, cuts: cuts.cuts.map((c, k) => (k === i ? (typeof patch === 'function' ? patch(c) : {...c, ...patch}) : c))};
      if (opt.history === false) setCuts(next);
      else commitCuts(next);
    },
    [cuts, setCuts, commitCuts],
  );
  const patchSlot = useCallback(
    (c: Cut, patch: Partial<Slot>) => {
      if (!cuts || !c.id) return;
      commitCuts({...cuts, meta: {...(cuts.meta ?? {}), slots: (cuts.meta?.slots ?? []).map((x) => (x.cutId === c.id ? {...x, ...patch} : x))}});
    },
    [cuts, commitCuts],
  );
  const patchReel = useCallback((patch: Partial<ReelData>) => cuts && commitCuts({...cuts, ...patch}), [cuts, commitCuts]);
  const applyReorder = useCallback(
    (block: [number, number], to: number) => {
      if (!cuts) return;
      commitCuts({...cuts, cuts: reorderBlock(cuts.cuts, block, to)});
      setSelection({kind: 'cut', index: destIndexOf(block, to)});
    },
    [cuts, commitCuts],
  );
  const moveCut = useCallback(
    (i: number, d: number) => {
      if (!cuts) return;
      const j = i + d;
      if (j < 0 || j >= cuts.cuts.length) return;
      const arr = [...cuts.cuts];
      [arr[i], arr[j]] = [arr[j], arr[i]];
      commitCuts({...cuts, cuts: arr});
      setSelection({kind: 'cut', index: j});
    },
    [cuts, commitCuts],
  );
  const duplicateCut = useCallback(
    (i: number) => {
      if (!cuts) return;
      const src = cuts.cuts[i];
      const id = newCutId(cuts.cuts);
      const copy: Cut = {...JSON.parse(JSON.stringify(src)), id};
      const arr = [...cuts.cuts];
      arr.splice(i + 1, 0, copy);
      const slot = slotOf(src);
      const slots = slot ? [...(cuts.meta?.slots ?? []), {...slot, cutId: id, locked: false}] : cuts.meta?.slots;
      commitCuts({...cuts, cuts: arr, meta: {...(cuts.meta ?? {}), slots}});
      setSelection({kind: 'cut', index: i + 1});
    },
    [cuts, slotOf, commitCuts],
  );
  const removeCut = useCallback(
    (i: number): boolean => {
      if (!cuts) return false;
      const next = removeCutAt(cuts, i);
      if (!next) return false;
      commitCuts(next);
      setSelection((sel) => selectionAfterRemove(sel, 'cut', i));
      return true;
    },
    [cuts, commitCuts],
  );
  /** 再生ヘッドの位置で 2 つに割る。割れなければ理由 */
  const splitCut = useCallback(
    (i: number): string | null => {
      if (!cuts) return '構成がありません';
      const r = ranges[i];
      const c = cuts.cuts[i];
      if (!r || !c) return 'カットが見つかりません';
      const offset = frame / cuts.fps - r.startSec;
      if (offset < 0 || offset > r.durSec) return '再生ヘッド（赤い線）をこのカットの中に置いてから分割してください';
      const next = splitCutAt(cuts, i, sourceSecAt(c, offset), cuts.fps);
      if (!next) return '端に寄りすぎています（両側に 0.2 秒以上残る位置で分割してください）';
      commitCuts(next);
      setSelection({kind: 'cut', index: i});
      return null;
    },
    [cuts, ranges, frame, commitCuts],
  );
  /** 素材をタイムラインに入れる。index 省略なら末尾。cuts.json が無ければここで作る */
  const addClip = useCallback(
    (clipId: string, index?: number): string | null => {
      const c = catalog?.clips.find((x) => x.id === clipId);
      if (!c || !catalog) return '素材が見つかりません';
      if (c.user.ng) return `${c.id} は NG 指定です（使うなら Materials で NG を外してください）`;
      const range = defaultRangeFor(c, fps, maxCutSec);
      if (!cuts) {
        const first = makeCut(c, range, 'c01');
        setCuts(createReel(catalog.dominantFps, brief?.theme ?? spec?.theme, first));
        setSelection({kind: 'cut', index: 0});
        return null;
      }
      const at = index ?? cuts.cuts.length;
      commitCuts(insertCutAt(cuts, makeCut(c, range, newCutId(cuts.cuts)), at));
      setSelection({kind: 'cut', index: Math.min(at, cuts.cuts.length)});
      return null;
    },
    [catalog, cuts, fps, maxCutSec, brief, spec, setCuts, commitCuts],
  );

  // ---- テロップグループの操作（グループ内の全カットに同じ文言） ----
  const setGroupText = useCallback(
    (gi: number, text: string) => {
      if (!cuts) return;
      const g = groups[gi];
      if (!g) return;
      const idx = new Set(g.cutIndices);
      commitCuts({...cuts, cuts: cuts.cuts.map((c, k) => (idx.has(k) ? (text === '' ? {...c, main: undefined} : {...c, main: {...(c.main ?? {}), text}}) : c))});
    },
    [cuts, groups, commitCuts],
  );
  const setGroupOrientation = useCallback(
    (gi: number, orientation: 'vertical' | 'horizontal') => {
      if (!cuts) return;
      const g = groups[gi];
      if (!g) return;
      const idx = new Set(g.cutIndices);
      commitCuts({...cuts, cuts: cuts.cuts.map((c, k) => (idx.has(k) && c.main ? {...c, main: {...c.main, orientation: orientation === 'vertical' ? undefined : 'horizontal'}} : c))});
    },
    [cuts, groups, commitCuts],
  );

  // ---- ナレーションの操作 ----
  const patchSeg = useCallback(
    (i: number, patch: Partial<NarrationSegment>, retts = false) => {
      if (!narration) return;
      commitNarr({
        ...narration,
        segments: narration.segments.map((sg, k) => {
          if (k !== i) return sg;
          const n: NarrationSegment = {...sg, ...patch};
          // 文言を変えたら既存の wav は使えない。実測尺も無効にする
          if (retts) {
            (n as {needsTts?: boolean}).needsTts = true;
            delete (n as {durSec?: number}).durSec;
          }
          return n;
        }),
      });
    },
    [narration, commitNarr],
  );
  const removeSeg = useCallback(
    (i: number) => {
      if (!narration) return;
      commitNarr({...narration, segments: narration.segments.filter((_, k) => k !== i)});
      setSelection((sel) => selectionAfterRemove(sel, 'narr', i));
    },
    [narration, commitNarr],
  );
  /** narration.json が無ければ人格の既定で作る */
  const ensureNarration = useCallback((): Narration | null => {
    if (narration) return narration;
    if (!persona) return null;
    return {voice: persona.narration.voiceId, voiceTitle: persona.narration.voiceTitle, latency: 'normal', speed: persona.narration.speed, videoSec: round3(total), segments: []};
  }, [narration, persona, total]);
  const addSeg = useCallback(
    (atSec: number): number | null => {
      const n = ensureNarration();
      if (!n) return null;
      const used = new Set(n.segments.map((x) => x.id));
      let k = n.segments.length + 1;
      while (used.has(`${String(k).padStart(2, '0')}_new`)) k++;
      const seg: NarrationSegment = {id: `${String(k).padStart(2, '0')}_new`, at: round3(Math.max(0, atSec)), text: '', needsTts: true} as NarrationSegment;
      commitNarr({...n, segments: [...n.segments, seg]});
      const index = n.segments.length;
      setSelection({kind: 'narr', index});
      return index;
    },
    [ensureNarration, commitNarr],
  );
  const sortSegs = useCallback(() => narration && commitNarr({...narration, segments: [...narration.segments].sort((a, b) => a.at - b.at)}), [narration, commitNarr]);
  const fixOverlaps = useCallback((): string[] => {
    if (!narration) return [];
    const r = fixNarrationOverlaps(narration, {estimate: estimateSec, videoSec: total || undefined});
    if (r.moved.length) commitNarr({...narration, segments: r.segments});
    return r.notes;
  }, [narration, estimateSec, total, commitNarr]);
  const invalidateAll = useCallback(
    (patch: Partial<Narration>) => {
      if (!narration) return;
      commitNarr({
        ...narration,
        ...patch,
        segments: narration.segments.map((sg) => {
          const n: NarrationSegment = {...sg, needsTts: true} as NarrationSegment;
          delete (n as {durSec?: number}).durSec;
          return n;
        }),
      });
    },
    [narration, commitNarr],
  );

  // ---- 効果音の操作 ----
  const patchSfx = useCallback(
    (i: number, patch: Record<string, unknown>) => {
      if (!narration) return;
      commitNarr({...narration, sfx: (narration.sfx ?? []).map((x, k) => (k === i ? {...x, ...patch} : x))});
    },
    [narration, commitNarr],
  );
  const removeSfx = useCallback(
    (i: number) => {
      if (!narration) return;
      commitNarr({...narration, sfx: (narration.sfx ?? []).filter((_, k) => k !== i)});
      setSelection((sel) => selectionAfterRemove(sel, 'sfx', i));
    },
    [narration, commitNarr],
  );
  const addSfx = useCallback(
    (atSec: number, file?: string): string | null => {
      const n = ensureNarration();
      if (!n) return 'ナレーションの設定が作れません（brief が無い）';
      const sound = file ? sfxLib?.sounds.find((x) => x.file === file) : sfxLib?.sounds[0];
      if (!sound) return '効果音がライブラリにありません（sfx/ に音源を置いて Render の「ライブラリを読み直す」）';
      const list = n.sfx ?? [];
      const used = new Set(list.map((x) => x.id));
      let k = list.length + 1;
      while (used.has(`sfx${k}`)) k++;
      commitNarr({
        ...n,
        sfx: [
          ...list,
          {
            id: `sfx${k}`,
            at: round3(Math.max(0, atSec)),
            file: sound.file,
            trimSec: sound.defaultTrimSec ?? Math.min(sound.durSec ?? SFX_DEFAULTS.trimSec, SFX_DEFAULTS.trimSec),
            fadeOutSec: sound.defaultFadeOutSec ?? SFX_DEFAULTS.fadeOutSec,
            gainDb: sound.defaultGainDb ?? SFX_DEFAULTS.gainDb,
            label: sound.label,
          },
        ],
      });
      setSelection({kind: 'sfx', index: list.length});
      return null;
    },
    [ensureNarration, sfxLib, commitNarr],
  );

  // ---- 検証の自動修正 ----
  const applyFix = useCallback(
    (iss: Issue) => {
      if (!cuts || iss.cutIndex === undefined || !iss.fix) return;
      const f = iss.fix;
      let next: ReelData = {
        ...cuts,
        cuts: cuts.cuts.map((c, k) => {
          if (k !== iss.cutIndex) return c;
          const n = {...c};
          if (f.type === 'trimTo') n.outSec = f.payload.outSec;
          if (f.type === 'setRate') {
            if (f.payload.playbackRate === null) delete n.playbackRate;
            else n.playbackRate = f.payload.playbackRate;
          }
          if (f.type === 'orientation' && n.main) n.main = {...n.main, orientation: f.payload.orientation};
          if (f.type === 'removeKey') delete (n as Record<string, unknown>)[f.payload.key];
          return n;
        }),
      };
      if (f.type === 'removeKey' && f.payload.key === 'tate') next = {...next, tate: undefined};
      commitCuts(next);
    },
    [cuts, commitCuts],
  );

  // 選択がはみ出したら外す（削除や読み直しのあと）
  useEffect(() => {
    setSelection((sel) => {
      if (!sel) return sel;
      if (sel.kind === 'cut' && (!cuts || sel.index >= cuts.cuts.length)) return null;
      if (sel.kind === 'telop' && sel.group >= groups.length) return null;
      if (sel.kind === 'narr' && (!narration || sel.index >= narration.segments.length)) return null;
      if (sel.kind === 'sfx' && (!narration || sel.index >= (narration.sfx ?? []).length)) return null;
      return sel;
    });
  }, [cuts, groups.length, narration]);

  const subsFrom = useCallback((c: Cut): SubDef => ({text: '', orientation: 'horizontal', startSec: c.inSec, endSec: c.outSec}), []);

  return {
    s,
    cuts,
    narration,
    catalog,
    brief,
    persona,
    spec,
    fps,
    total,
    estimateSec,
    selection,
    setSelection,
    frame,
    setFrame,
    currentCut,
    ranges,
    groups,
    groupOfCut,
    clipOf,
    slotOf,
    usage,
    validation,
    orderCheck,
    issueOf,
    narrIssues,
    sfxIssues,
    history,
    pushHistory,
    undo,
    redo,
    setCuts,
    setNarr,
    commitCuts,
    commitNarr,
    patchCut,
    patchSlot,
    patchReel,
    applyReorder,
    moveCut,
    duplicateCut,
    removeCut,
    splitCut,
    addClip,
    setGroupText,
    setGroupOrientation,
    patchSeg,
    removeSeg,
    addSeg,
    sortSegs,
    fixOverlaps,
    invalidateAll,
    patchSfx,
    removeSfx,
    addSfx,
    applyFix,
    subsFrom,
    snapSec: (sec: number) => snapSec(sec, fps),
  };
};

export type EditorModel = ReturnType<typeof useEditorModel>;
