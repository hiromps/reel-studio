// 素材ビン：カタログのクリップを小さいカードで並べ、タイムラインへドラッグ（または ＋）で入れる。
// タグ付け・使える区間・NG などの編集は Materials 画面（こちらは並べるための一覧に絞る）。
import React, {useMemo, useState} from 'react';
import type {Catalog, Clip} from '@shared/schema';
import {KIND_LABEL} from './labels';

export type BinFilter = 'all' | 'unused' | 'hook' | 'untagged';

type Props = {
  catalog: Catalog | null;
  mediaBase: string | null;
  /** src → タイムラインでの使用回数 */
  usage: Map<string, number>;
  /** ドラッグ中のクリップ id（薄く出す） */
  draggingId: string | null;
  handleProps: (id: string) => {onPointerDown: (e: React.PointerEvent) => void};
  onAdd: (id: string) => void;
  onOpenMaterials: () => void;
};

const matches = (c: Clip, q: string): boolean => {
  if (!q) return true;
  const hay = [c.id, c.slug, c.original, c.tags?.description ?? '', c.tags?.subject ?? '', c.tags ? KIND_LABEL[c.tags.kind] : '', c.tags?.kind ?? ''].join(' ').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
};

export const Bin: React.FC<Props> = ({catalog, mediaBase, usage, draggingId, handleProps, onAdd, onOpenMaterials}) => {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<BinFilter>('all');
  const clips = useMemo(() => {
    const all = catalog?.clips ?? [];
    return all.filter((c) => {
      if (!matches(c, q)) return false;
      if (filter === 'unused') return !(usage.get(c.src) ?? 0) && !c.user.ng;
      if (filter === 'hook') return c.user.hook;
      if (filter === 'untagged') return !c.tags;
      return true;
    });
  }, [catalog, q, filter, usage]);
  const total = catalog?.clips.length ?? 0;
  const unused = (catalog?.clips ?? []).filter((c) => !(usage.get(c.src) ?? 0) && !c.user.ng).length;

  return (
    <div className="bin" data-tour="bin">
      <div className="bin-head">
        <b>素材</b>
        <span className="hint">
          {total} 本{unused ? ` / 未使用 ${unused}` : ''}
        </span>
        <span style={{flex: 1}} />
        <button className="small" onClick={onOpenMaterials} title="タグ・使える区間・NG の編集は Materials 画面で">
          Materials
        </button>
      </div>
      <div className="bin-tools">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="検索（id・内容・種別）" spellCheck={false} />
        <select value={filter} onChange={(e) => setFilter(e.target.value as BinFilter)} title="絞り込み">
          <option value="all">すべて</option>
          <option value="unused">未使用だけ</option>
          <option value="hook">★フック候補</option>
          <option value="untagged">未タグ</option>
        </select>
      </div>
      {!catalog && <div className="hint" style={{padding: 8}}>素材がまだ読み込まれていません。Materials で「カタログ実行」をしてください</div>}
      <div className="bin-grid">
        {clips.map((c) => {
          const used = usage.get(c.src) ?? 0;
          return (
            <div
              key={c.id}
              className={`bin-card${c.user.ng ? ' ng' : ''}${draggingId === c.id ? ' dragging' : ''}`}
              title={`${c.id} ${c.tags?.description ?? c.slug}（${c.probe.durationSec.toFixed(1)}s）\nドラッグでタイムラインへ／ダブルクリックで末尾に追加`}
              onDoubleClick={() => !c.user.ng && onAdd(c.id)}
              {...handleProps(c.id)}
            >
              <div className="bin-thumb">
                {c.thumbs.sheet && mediaBase ? <img src={`${mediaBase}/studio/${c.thumbs.sheet}`} alt="" loading="lazy" draggable={false} /> : <div className="thumb-none">no thumb</div>}
                <span className="bin-id">{c.id}</span>
                <span className="bin-dur">{c.probe.durationSec.toFixed(1)}s</span>
                {used > 0 && <span className="bin-used">×{used}</span>}
                {c.user.hook && <span className="bin-hook">★</span>}
              </div>
              <div className="bin-desc">{c.tags?.description ?? c.slug}</div>
              <div className="bin-foot">
                <span className="hint">{c.user.ng ? 'NG' : c.tags ? KIND_LABEL[c.tags.kind] : '未タグ'}</span>
                <button
                  className="small clip-add"
                  title="タイムラインの末尾に追加"
                  disabled={c.user.ng}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAdd(c.id);
                  }}
                >
                  ＋
                </button>
              </div>
            </div>
          );
        })}
        {catalog && !clips.length && <div className="hint" style={{padding: 8}}>該当する素材がありません</div>}
      </div>
    </div>
  );
};
