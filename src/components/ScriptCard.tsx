// 自然言語の台本から構成を組み立てる。型（F0/F7…）に流し込む「プラン生成」の代わりに使う。
import React, {useCallback, useEffect, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import type {ScriptSection} from '@shared/script';

type ScriptRes = {etag: string | null; data: string | null; sections: ScriptSection[]; totalSec: number | null};

const PLACEHOLDER = `【0〜3秒】フック
映像： 盛り合わせの全体を一気に見せる。肉のアップ
テロップ： 価格論争が起きた焼肉盛り
ナレーション： これ、いくらに見えますか？

【4〜10秒】店舗紹介
映像： 外観、看板
ナレーション： 深夜3時まで営業しているお店です`;

export const ScriptCard: React.FC<{aiModel: string; onModel: (v: string) => void}> = ({aiModel, onModel}) => {
  const s = useStudio();
  const slug = s.active;
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [info, setInfo] = useState<ScriptRes | null>(null);
  const [open, setOpen] = useState(false);
  const dirty = text !== saved;
  const busy = s.jobs.some((j) => (j.status === 'running' || j.status === 'queued') && j.type === 'ai-script');
  const unsupported = !s.supportsJob('ai-script');
  const catalog = s.files.catalog.data;
  const untagged = (catalog?.clips ?? []).filter((c) => !c.tags && !c.user.ng).length;

  const load = useCallback(async () => {
    if (!slug) return;
    try {
      const r = await api.get<ScriptRes>(`/api/projects/${encodeURIComponent(slug)}/script`);
      setText(r.data.data ?? '');
      setSaved(r.data.data ?? '');
      setInfo(r.data);
    } catch {
      setText(''); // 古いサーバーには /script が無い
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  // 組み立てが終わったら cuts / narration が変わっているので読み直す
  const done = s.jobs.find((j) => j.type === 'ai-script' && j.status === 'done')?.id;
  useEffect(() => {
    if (done) void load();
  }, [done, load]);

  const save = async () => {
    if (!slug) return;
    try {
      const r = await api.put<ScriptRes>(`/api/projects/${encodeURIComponent(slug)}/script`, {text});
      setSaved(text);
      setInfo((v) => ({...(v ?? ({} as ScriptRes)), ...r.data}));
      s.toast('script.md を保存しました', 'ok');
    } catch (e) {
      s.toast((e as Error).message, 'error');
    }
  };

  if (!slug) return null;
  const sections = info?.sections ?? [];

  return (
    <section className="card" style={{marginTop: 8}} data-tour="script">
      <div className="summary">
        <span>
          <b>台本から組み立てる</b>
        </span>
        <span>{sections.length ? `${sections.length} 区間 / ${info?.totalSec ?? '?'} 秒` : text ? '区間が読み取れていません' : '未入力'}</span>
        <span className="hint">書いた台本に合わせて素材を並べます。型（F0 等）に収まらない長尺もこちらで作れます</span>
      </div>

      <div className="row">
        <button
          className="primary"
          onClick={() => s.addJob('ai-script', {model: aiModel})}
          disabled={busy || unsupported || dirty || !text.trim() || !catalog}
          title={dirty ? 'script.md に未保存の変更があります' : !catalog ? '先に素材のカタログ化が要ります' : '素材のタグ（映像の説明）と突き合わせて cuts.json と narration.json を作ります'}
        >
          {busy ? '組み立て中…' : '台本から組み立てる（cuts + ナレーション）'}
        </button>
        <button onClick={() => s.addJob('ai-script', {model: aiModel, write: false})} disabled={busy || unsupported || dirty || !text.trim() || !catalog} title="書き込まずに割り当てだけ見る">
          割り当てを見るだけ
        </button>
        <label title="裏で走らせる Claude のモデル">
          モデル
          <select value={aiModel} onChange={(e) => onModel(e.target.value)}>
            <option value="opus">opus（精度重視）</option>
            <option value="sonnet">sonnet（速い・安い）</option>
            <option value="haiku">haiku（最安）</option>
          </select>
        </label>
        {untagged > 0 && <span className="pill warn">タグの無い素材が {untagged} 本（先にタグ付けすると当たりが良くなります）</span>}
        {unsupported && <span className="pill warn">サーバーが古いプロセスです。再起動してください</span>}
      </div>

      <textarea
        className="caption-box"
        style={{minHeight: 200, fontFamily: 'Consolas, "Yu Gothic UI", monospace'}}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={PLACEHOLDER}
        spellCheck={false}
      />

      <div className="row" style={{marginTop: 6}}>
        <button onClick={() => void load()}>読み直す</button>
        <span style={{flex: 1}} />
        <button className="primary" onClick={() => void save()} disabled={!dirty}>
          script.md を保存
        </button>
      </div>

      {sections.length > 0 && (
        <div className="narr-rows">
          {sections.map((x, i) => (
            <div key={i} className="narr-row">
              <span className="counter" style={{width: 128}}>
                {x.fromSec}〜{x.toSec}秒（{x.toSec - x.fromSec}s）
              </span>
              <span>{x.label || '（見出しなし）'}</span>
            </div>
          ))}
        </div>
      )}
      {text.trim() && !sections.length && (
        <div className="issues" style={{marginTop: 6}}>
          <div className="issue W">
            <span className="code">W 区間なし</span>
            <span>【0〜3秒】のような時間の見出しが読み取れませんでした。尺の検算ができないので、区間の見出しを入れると精度が上がります</span>
          </div>
        </div>
      )}

      <details style={{marginTop: 6}} open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary className="hint">何をどう組み立てるのか</summary>
        <p className="hint">
          台本の「映像：」の指示と、<b>素材のタグ（AI が映像を見て書いた説明）</b>を突き合わせて素材を選び、
          <b>区間の尺に合わせて</b> IN/OUT を決めます。「テロップ：」はそのカットに、「ナレーション：」は
          <b>台本の文のまま</b> narration.json に入ります（勝手に書き換えません）。
          エリア名はバッジに出し、本文はエリア名が無くても通る言い回しにします。
        </p>
        <p className="hint">
          合う素材が無い区間は<b>無理に埋めず「素材が無い」として報告</b>します（撮り足しの指示になります）。
          書き出す前に、区間ごとの尺・素材の重複・テロップの文字数を検算し、<b>E が出たら何も書きません</b>。
          そのあとは Timeline で微調整 →「音声を生成」→「ナレーション合成（mix）」で仕上げます。
        </p>
        <p className="hint">
          「プラン生成」（型に流し込む方式）とは<b>どちらか一方</b>を使います。台本があるならこちら、
          素材だけあって構成から決めたいなら「プラン生成」です。
        </p>
      </details>
    </section>
  );
};
