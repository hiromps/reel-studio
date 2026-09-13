// 絵コンテ：全カットをサムネの並びとして一覧し、ドラッグ&ドロップで順番を決める。
// サムネはコンタクトシートではなく「そのカットの IN 付近のストリップ画像」を出すので、実際に映る画で並べられる。
import React, {useEffect, useMemo, useRef, useState} from 'react';
import type {Clip, Cut, ReelData, Slot, SlotRole} from '@shared/schema';
import {cutDurationSec, type CutRange, type TelopGroup} from '@shared/timeline';
import {useDragReorder} from './useDragReorder';
import {destIndexOf} from './reorder';
import {CutThumb, cutFrameUrl} from './CutThumb';

const ROLE_LABEL: Record<SlotRole, string> = {
  hook: 'フック',
  proof: '証拠',
  tease: '焦らし',
  reveal: 'リビール',
  sizzle: 'シズル',
  info: '情報',
  conversation: '会話',
  badgeHead: '見出し',
  cta: 'CTA',
  filler: 'つなぎ',
};

const SIZES = [
  ['s', '小'],
  ['m', '中'],
  ['l', '大'],
] as const;
type Size = (typeof SIZES)[number][0];

type Prefs = {size: Size; open: boolean};
const PREF_KEY = 'reel-studio.storyboard';
const loadPrefs = (): Prefs => {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Prefs>;
      return {size: p.size ?? 'm', open: p.open ?? true};
    }
  } catch {
    /* localStorage が使えない環境では既定値 */
  }
  return {size: 'm', open: true};
};

/** フレームが取れないときの保険（catalog にクリップがある場合だけ使える） */
const sheetUrl = (base: string | null, clip: Clip | undefined): string | null => (base && clip?.thumbs.sheet ? `${base}/studio/${clip.thumbs.sheet}` : null);

type Props = {
  slug: string | null;
  /** 素材 URL の先頭（`/p/<slug>/<mode>`）。タブごとに違う案件を開けるようにするため URL に案件が入る */
  mediaBase: string | null;
  cuts: ReelData;
  ranges: CutRange[];
  clipOf: (src: string) => Clip | undefined;
  slotOf: (c: Cut) => Slot | undefined;
  groupOfCut: Map<number, number>;
  groups: TelopGroup[];
  groupColors: string[];
  /** カット index → 最も重い issue の severity */
  issueOf: Map<number, 'E' | 'W'>;
  currentCut: number;
  selected: number | null;
  blockOf: (i: number) => [number, number];
  groupMove: boolean;
  onGroupMove: (v: boolean) => void;
  onSelect: (i: number) => void;
  onReorder: (block: [number, number], to: number) => void;
  onUndo: () => void;
  canUndo: boolean;
};

export const Storyboard: React.FC<Props> = ({
  slug,
  mediaBase,
  cuts,
  ranges,
  clipOf,
  slotOf,
  groupOfCut,
  groups,
  groupColors,
  issueOf,
  currentCut,
  selected,
  blockOf,
  groupMove,
  onGroupMove,
  onSelect,
  onReorder,
  onUndo,
  canUndo,
}) => {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [hover, setHover] = useState<number | null>(null);
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const savePrefs = (p: Partial<Prefs>) => {
    const next = {...prefs, ...p};
    setPrefs(next);
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(next));
    } catch {
      /* 保存できなくても動作には影響しない */
    }
  };

  const dnd = useDragReorder({axis: 'grid', gap: 8, blockOf, onDrop: onReorder});
  const total = ranges.length ? ranges[ranges.length - 1].endSec : 0;
  const hoverBlock = useMemo(() => (hover === null ? null : blockOf(hover)), [hover, blockOf]);

  // Alt+←→ で動かしたあと、移動先のカードにフォーカスを戻す
  useEffect(() => {
    if (focusIdx === null) return;
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-dnd-index="${focusIdx}"]`);
    el?.focus();
    setFocusIdx(null);
  }, [focusIdx]);

  // 下のカット行や ▲▼ で選び直したときも、絵コンテ側のカードを見える位置に出す
  const dragging = dnd.drag !== null;
  useEffect(() => {
    if (selected === null || dragging) return;
    bodyRef.current?.querySelector(`[data-dnd-index="${selected}"]`)?.scrollIntoView({block: 'nearest', inline: 'nearest'});
  }, [selected, dragging]);

  const nudge = (i: number, dir: -1 | 1) => {
    const block = blockOf(i);
    const to = dir < 0 ? block[0] - 1 : block[1] + 2;
    if (to < 0 || to > cuts.cuts.length) return;
    onReorder(block, to);
    setFocusIdx(destIndexOf(block, to) + (i - block[0]));
  };

  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      e.preventDefault();
      if (e.altKey) nudge(i, dir);
      else {
        const n = Math.max(0, Math.min(cuts.cuts.length - 1, i + dir));
        onSelect(n);
        setFocusIdx(n);
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(i);
    }
  };

  const ghostCut = dnd.drag ? cuts.cuts[dnd.drag.block[0]] : null;
  const ghostSrc = ghostCut && slug ? cutFrameUrl(slug, ghostCut.src, ghostCut.inSec, 240) : null;
  const ghostCount = dnd.drag ? dnd.drag.block[1] - dnd.drag.block[0] + 1 : 0;

  return (
    <section className="storyboard" data-tour="storyboard">
      <div className="sb-bar">
        <button className="sb-toggle" onClick={() => savePrefs({open: !prefs.open})} title={prefs.open ? '折りたたむ' : '開く'}>
          {prefs.open ? '▾' : '▸'}
        </button>
        <span className="sb-title">カットの順番</span>
        <span className="hint">
          {cuts.cuts.length} カット / {total.toFixed(2)}s
        </span>
        <span className="hint sb-howto">サムネをドラッグして並べ替え（クリックでその位置へシーク・Alt+←→ でも移動・Esc で取り消し）</span>
        <span style={{flex: 1}} />
        <label className="sb-inline" title="同じテロップ文言が続くカットは 1 つのまとまりとして動かす（ばらけてテロップが分断されるのを防ぐ）">
          <input type="checkbox" checked={groupMove} onChange={(e) => onGroupMove(e.target.checked)} />
          <span>テロップ単位で動かす</span>
        </label>
        <label className="sb-inline">
          <span>大きさ</span>
          <select value={prefs.size} onChange={(e) => savePrefs({size: e.target.value as Size})}>
            {SIZES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <button onClick={onUndo} disabled={!canUndo} title="カットの並び・追加・複製・削除を 1 つ戻す（Ctrl+Z）">
          ↶ 元に戻す
        </button>
      </div>

      {prefs.open && (
        <div
          className={`sb-body size-${prefs.size}`}
          {...dnd.containerProps}
          ref={(el) => {
            bodyRef.current = el;
            dnd.containerProps.ref(el);
          }}
        >
          {cuts.cuts.map((c, i) => {
            const clip = clipOf(c.src);
            const slot = slotOf(c);
            const gi = groupOfCut.get(i);
            const color = gi !== undefined ? groupColors[gi % groupColors.length] : undefined;
            const groupHead = gi !== undefined && groups[gi].cutIndices[0] === i;
            const sev = issueOf.get(i);
            const inHoverBlock = hoverBlock !== null && hoverBlock[1] > hoverBlock[0] && i >= hoverBlock[0] && i <= hoverBlock[1];
            const text = c.main?.text ?? (c.subs?.length ? c.subs.map((x) => x.text).join(' / ') : '');
            return (
              <div
                key={c.id ?? i}
                className={[
                  'sb-card',
                  i === currentCut ? 'current' : '',
                  i === selected ? 'selected' : '',
                  dnd.isDragging(i) ? 'dragging' : '',
                  inHoverBlock ? 'in-block' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                title={`${i + 1}. ${clip?.tags?.description ?? clip?.slug ?? c.src}\n${c.inSec.toFixed(2)}〜${c.outSec.toFixed(2)}s${text ? `\nテロップ: ${text}` : ''}`}
                data-tour={i === 0 ? 'sb-card-0' : undefined}
                tabIndex={0}
                {...dnd.itemProps(i)}
                {...dnd.handleProps(i)}
                onClick={() => onSelect(i)}
                onKeyDown={(e) => onKeyDown(e, i)}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              >
                <div className="sb-gbar" style={{background: color ?? 'transparent'}} />
                <div className="sb-thumb">
                  <CutThumb slug={slug} src={c.src} inSec={c.inSec} width={prefs.size === 'l' ? 320 : 240} fallback={sheetUrl(mediaBase, clip)} />
                  <span className="sb-no">{i + 1}</span>
                  <span className="sb-dur">{cutDurationSec(c).toFixed(1)}s</span>
                  <span className="sb-flags">
                    {slot?.locked && <span className="sb-flag" title="固定（再 plan で動かさない）">🔒</span>}
                    {c.playbackRate && c.playbackRate !== 1 && <span className="sb-flag rate">{c.playbackRate}x</span>}
                    {sev && (
                      <span className={`sb-flag ${sev === 'E' ? 'err' : 'warn'}`} title={sev === 'E' ? 'エラーあり' : '警告あり'}>
                        {sev === 'E' ? '!' : '?'}
                      </span>
                    )}
                  </span>
                </div>
                <div className="sb-foot">
                  <span className="sb-role">{slot ? ROLE_LABEL[slot.role] : ''}</span>
                  {groupHead && color && (
                    <span className="sb-gid" style={{color}}>
                      g{String(gi! + 1).padStart(2, '0')}
                    </span>
                  )}
                </div>
                <div className={`sb-telop${text ? '' : ' empty'}`}>{text || '（テロップ無し）'}</div>
              </div>
            );
          })}
          {dnd.drag?.caret && <div className="dnd-caret" style={dnd.drag.caret} />}
        </div>
      )}

      {dnd.drag && (
        <div className="dnd-ghost" style={{left: dnd.drag.x, top: dnd.drag.y}}>
          {ghostSrc && <img src={ghostSrc} alt="" />}
          <span className="dnd-ghost-label">
            {dnd.drag.block[0] + 1}
            {ghostCount > 1 ? `〜${dnd.drag.block[1] + 1}（${ghostCount}カット）` : ''}
            {dnd.drag.to !== null ? ` → ${destIndexOf(dnd.drag.block, dnd.drag.to) + 1} 番目` : ' 位置はそのまま'}
          </span>
        </div>
      )}
    </section>
  );
};
