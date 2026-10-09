import React, {useEffect, useRef, useState} from 'react';
import type {Narration, NarrationSegment} from '@shared/schema';
import type {NarrationLibraryEntry} from '@shared/narration-library';
import {api} from '../api';

type Props = {
  project: string;
  narration: Narration | null;
  selected: NarrationSegment | null;
  onUse: (entry: NarrationLibraryEntry) => Promise<void>;
  onClose: () => void;
};

export const NarrationLibrary: React.FC<Props> = ({project, narration, selected, onUse, onClose}) => {
  const [entries, setEntries] = useState<NarrationLibraryEntry[]>([]);
  const [title, setTitle] = useState(selected?.label?.trim() || selected?.text.slice(0, 40) || '');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    void api.get<{entries: NarrationLibraryEntry[]}>('/api/narration-library').then((r) => setEntries(r.data.entries)).catch((e: Error) => setError(e.message));
    return () => { audio.current?.pause(); };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try { await task(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const save = () => void run(async () => {
    if (!selected || !narration) return;
    const r = await api.post<{entry: NarrationLibraryEntry}>('/api/narration-library', {project, segment: selected, narration: {voice: narration.voice, voiceTitle: narration.voiceTitle, speed: narration.speed, latency: narration.latency}, title});
    setEntries((prev) => [r.data.entry, ...prev]);
    setTitle('');
  });
  const play = (entry: NarrationLibraryEntry) => {
    audio.current?.pause();
    const next = new Audio(`/api/narration-library/${encodeURIComponent(entry.id)}/audio`);
    audio.current = next;
    if (entry.trimSec && entry.trimSec > 0) next.ontimeupdate = () => {
      if (next.currentTime >= entry.trimSec!) next.pause();
    };
    void next.play().catch(() => setError('保存した音声を再生できませんでした'));
  };
  const remove = (entry: NarrationLibraryEntry) => void run(async () => {
    if (!window.confirm(`「${entry.title}」をライブラリから削除しますか？`)) return;
    await api.del(`/api/narration-library/${encodeURIComponent(entry.id)}`);
    setEntries((prev) => prev.filter((x) => x.id !== entry.id));
  });
  const visible = entries.filter((entry) => `${entry.title} ${entry.text}`.toLowerCase().includes(query.toLowerCase()));
  const canSave = !!selected?.durSec && !(selected as {needsTts?: boolean} | null)?.needsTts && !!selected.text.trim();

  return (
    <div className="modal-root" onClick={onClose}>
      <div className="modal narration-library" role="dialog" aria-modal="true" aria-label="ナレーション音声ライブラリ" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><b>ナレーション音声ライブラリ</b><span style={{flex: 1}} /><button className="small" onClick={onClose}>閉じる（Esc）</button></div>
        <div className="modal-body">
          {selected && narration && <div className="narration-library-save">
            <div><strong>選択中の音声を保存</strong><p className="hint">{selected.text}</p></div>
            <label>保存名<input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="例: 冒頭の決まり文句" /></label>
            <button className="primary" disabled={busy || !canSave || !title.trim()} onClick={save}>音声を保存</button>
            {!canSave && <span className="hint">先に音声を生成してください</span>}
          </div>}
          <label>保存した音声を探す<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="名前・文言で検索" /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="narration-library-list">
            {visible.length === 0 && <p className="hint">保存した音声はありません</p>}
            {visible.map((entry) => <div className="narration-library-item" key={entry.id}>
              <div><strong>{entry.title}</strong><p>{entry.text}</p><small className="hint">{entry.voiceTitle ?? entry.voice} · {entry.durSec.toFixed(1)} 秒</small></div>
              <div className="btns">
                <button className="small" onClick={() => play(entry)}>▶ 聴く</button>
                <button className="small primary" disabled={busy} onClick={() => void run(async () => { await onUse(entry); onClose(); })}>再生位置に追加</button>
                <button className="small danger" disabled={busy} onClick={() => remove(entry)} aria-label={`${entry.title} を削除`}>削除</button>
              </div>
            </div>)}
          </div>
        </div>
      </div>
    </div>
  );
};
