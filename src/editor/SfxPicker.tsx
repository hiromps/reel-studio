// 効果音を選ぶ画面：ライブラリ（sfx/）をカテゴリー（フォルダ）ごとに並べ、試聴してからタイムラインの指定位置に追加する。
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {SFX_ROLE_LABEL, sfxCategories, type SfxLibrary, type SfxSound} from '@shared/sfx';

type Props = {
  lib: SfxLibrary | null;
  /** 追加する位置（秒） */
  atSec: number;
  onPick: (file: string) => void;
  onClose: () => void;
};

const ALL = '\u0000all';
const urlOf = (file: string) => `/api/sfx/file/${file.split('/').map(encodeURIComponent).join('/')}`;

export const SfxPicker: React.FC<Props> = ({lib, atSec, onPick, onClose}) => {
  const categories = useMemo(() => sfxCategories(lib), [lib]);
  const [category, setCategory] = useState<string>(ALL);
  const [query, setQuery] = useState('');
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState('');
  const audio = useRef<HTMLAudioElement | null>(null);

  const stop = () => {
    audio.current?.pause();
    audio.current = null;
    setPlaying(null);
  };
  useEffect(() => () => audio.current?.pause(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const play = (sound: SfxSound) => {
    if (playing === sound.file) return stop();
    stop();
    const a = new Audio(urlOf(sound.file));
    audio.current = a;
    setPlaying(sound.file);
    setError('');
    a.onended = () => audio.current === a && setPlaying(null);
    void a.play().catch(() => {
      if (audio.current !== a) return;
      setPlaying(null);
      setError(`「${sound.label}」を試聴できませんでした`);
    });
  };

  const q = query.trim().toLowerCase();
  // 検索中はカテゴリーをまたいで探す（どのフォルダに入れたか覚えていなくても見つかるように）
  const shown = categories
    .filter((c) => q || category === ALL || c.name === category)
    .map((c) => ({...c, sounds: q ? c.sounds.filter((s) => `${s.label} ${s.file}`.toLowerCase().includes(q)) : c.sounds}))
    .filter((c) => c.sounds.length);
  const total = lib?.sounds.length ?? 0;

  return (
    <div className="modal-root" onClick={onClose}>
      <div className="modal sfx-picker" role="dialog" aria-modal="true" aria-label="効果音を追加" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>効果音を追加</b>
          <span className="hint">追加する位置 {atSec.toFixed(2)} 秒</span>
          <span style={{flex: 1}} />
          <button className="small" onClick={onClose}>
            閉じる（Esc）
          </button>
        </div>
        {total === 0 ? (
          <div className="modal-body">
            <p className="hint">効果音ライブラリが空です。sfx フォルダにカテゴリーごとのフォルダを作って音源を置き、Render の「ライブラリを読み直す」を押してください。</p>
          </div>
        ) : (
          <div className="sfx-picker-body">
            <nav className="sfx-picker-cats" aria-label="カテゴリー">
              <button className={`sfx-picker-cat${category === ALL && !q ? ' on' : ''}`} onClick={() => setCategory(ALL)}>
                <span>すべて</span>
                <small>{total}</small>
              </button>
              {categories.map((c) => (
                <button key={c.name} className={`sfx-picker-cat${category === c.name && !q ? ' on' : ''}`} onClick={() => { setCategory(c.name); setQuery(''); }}>
                  <span>📁 {c.name}</span>
                  <small>{c.sounds.length}</small>
                </button>
              ))}
            </nav>
            <div className="sfx-picker-main">
              <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="名前で検索（全カテゴリーから）" aria-label="効果音を名前で検索" />
              {error && <p className="error" role="alert">{error}</p>}
              <div className="sfx-picker-list">
                {shown.length === 0 && <p className="hint">見つかりませんでした</p>}
                {shown.map((c) => (
                  <section key={c.name}>
                    {(q || category === ALL) && <h3>{c.name}</h3>}
                    {c.sounds.map((sound) => (
                      <div className="sfx-picker-item" key={sound.file}>
                        <button className="small" onClick={() => play(sound)} aria-label={`${sound.label} を${playing === sound.file ? '止める' : '試聴'}`} title="試聴">
                          {playing === sound.file ? '■' : '▶'}
                        </button>
                        <div className="sfx-picker-name" title={sound.file}>
                          <strong>{sound.label}</strong>
                          <small className="hint">
                            {sound.durSec ? `${sound.durSec.toFixed(1)} 秒` : ''}
                            {sound.roles.length ? ` · ${sound.roles.map((r) => SFX_ROLE_LABEL[r]).join('・')}` : ''}
                          </small>
                        </div>
                        <button className="small primary" onClick={() => { stop(); onPick(sound.file); }}>
                          追加
                        </button>
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
