// トライアルリール：冒頭のフックだけを差し替えた複数バージョンを作る。
// 差し替えるのは**冒頭 3 カット**（既定）。1 カットだけだと見た印象が変わらず A/B の差が出ない。
import React, {useCallback, useEffect, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import {DEFAULT_HOOK_CUTS, checkHooks, type HookVariant, type Hooks} from '@shared/hooks';

type CutInfo = {cutId: string; telop: string; badge: string; src: string};
type HooksRes = {etag: string | null; data: Hooks | null; hookCuts: number[]; current: CutInfo[]};

const emptyHooks: Hooks = {version: 1, cutCount: DEFAULT_HOOK_CUTS, variants: []};
const NEXT_IDS = ['A', 'B', 'C', 'D', 'E', 'F'];

export const TrialCard: React.FC = () => {
  const s = useStudio();
  const slug = s.active;
  const [hooks, setHooks] = useState<Hooks>(emptyHooks);
  const [saved, setSaved] = useState('');
  const [info, setInfo] = useState<HooksRes | null>(null);
  const dirty = JSON.stringify(hooks) !== saved;
  const busy = s.jobs.some((j) => (j.status === 'running' || j.status === 'queued') && j.type === 'trial');
  const unsupported = !s.supportsJob('trial');
  const issues = checkHooks(hooks);
  const span = info?.hookCuts.length ?? hooks.cutCount;
  const clips = s.files.catalog.data?.clips ?? [];

  const load = useCallback(async () => {
    if (!slug) return;
    try {
      const r = await api.get<HooksRes>(`/api/projects/${encodeURIComponent(slug)}/hooks`);
      const data = r.data.data ?? emptyHooks;
      setHooks(data);
      setSaved(JSON.stringify(data));
      setInfo(r.data);
    } catch {
      setHooks(emptyHooks); // 古いサーバーには /hooks が無い
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!slug) return;
    try {
      const r = await api.put<HooksRes>(`/api/projects/${encodeURIComponent(slug)}/hooks`, hooks);
      setSaved(JSON.stringify(hooks));
      setInfo((v) => ({...(v ?? ({} as HooksRes)), ...r.data}));
      s.toast('hooks.json を保存しました', 'ok');
    } catch (e) {
      s.toast((e as Error).message, 'error');
    }
  };

  const patch = (i: number, p: Partial<HookVariant>) => setHooks({...hooks, variants: hooks.variants.map((v, k) => (k === i ? {...v, ...p} : v))});
  const patchAt = (i: number, key: 'telops' | 'clipIds', at: number, value: string) => {
    const v = hooks.variants[i];
    const arr = [...v[key]];
    while (arr.length <= at) arr.push('');
    arr[at] = value;
    patch(i, {[key]: arr} as Partial<HookVariant>);
  };
  const remove = (i: number) => setHooks({...hooks, variants: hooks.variants.filter((_, k) => k !== i)});
  const add = () => {
    const used = new Set(hooks.variants.map((v) => v.id));
    const id = NEXT_IDS.find((x) => !used.has(x)) ?? `V${hooks.variants.length + 1}`;
    // 1 つ目は今の冒頭をそのまま写す（基準として置き、2 つ目以降で文言を変えて比べる）
    const first = !hooks.variants.length;
    setHooks({
      ...hooks,
      variants: [
        ...hooks.variants,
        {
          id,
          label: first ? '今の形（基準）' : '',
          telops: first ? (info?.current ?? []).map((c) => c.telop) : [],
          clipIds: [],
          badge: first ? (info?.current?.[0]?.badge || null) : undefined,
          narration: '',
        },
      ],
    });
  };

  if (!slug || !s.files.cuts.data) return null;
  const cutRows = Array.from({length: span}, (_, i) => i);

  return (
    <section className="card" style={{marginTop: 8}} data-tour="trial">
      <div className="summary">
        <span>
          <b>トライアル（フック差し替え）</b>
        </span>
        <span>{hooks.variants.length ? `${hooks.variants.length} パターン` : '未設定'}</span>
        <span className="hint">冒頭 {span} カットだけを変えた複数バージョンを作ります。それ以降は 1 フレームも変わりません</span>
      </div>

      <div className="row">
        <button className="primary" onClick={() => s.addJob('trial')} disabled={busy || unsupported || dirty || hooks.variants.length < 2} title={dirty ? 'hooks.json に未保存の変更があります' : hooks.variants.length < 2 ? '2 パターン以上必要です' : `${hooks.variants.length} 本レンダーして納品します`}>
          {busy ? '作成中…' : `${hooks.variants.length || ''} パターンを作る（レンダー→音声→mix→納品）`}
        </button>
        <button onClick={() => s.addJob('trial', {draft: true, deliver: false})} disabled={busy || unsupported || dirty || hooks.variants.length < 2} title="0.25 倍の粗いレンダーで見た目だけ先に確認する（納品しません）">
          ドラフトで試す
        </button>
        <label title="冒頭の何カットを差し替えるか。1 カットだけだと違いが伝わりにくいので既定は 3">
          差し替えるカット数
          <input type="number" min={1} max={6} value={hooks.cutCount} onChange={(e) => setHooks({...hooks, cutCount: Math.max(1, Math.min(6, Number(e.target.value) || 1))})} style={{width: 56}} />
        </label>
        {unsupported && <span className="pill warn">サーバーが古いプロセスです。再起動してください</span>}
      </div>

      {hooks.variants.map((v, i) => (
        <div key={i} className="hook-variant">
          <div className="row">
            <input className="narr-id" style={{width: 44}} value={v.id} onChange={(e) => patch(i, {id: e.target.value})} title="A / B / C。ファイル名に入ります" />
            <input style={{flex: 1, minWidth: 140}} value={v.label} onChange={(e) => patch(i, {label: e.target.value})} placeholder="何を試すパターンか（メモ）" />
            <label title="中央上部のラベル。エリア名は本文ではなくここに出す">
              バッジ
              <input style={{width: 100}} value={v.badge ?? ''} onChange={(e) => patch(i, {badge: e.target.value === '' ? null : e.target.value})} placeholder="エリア名" />
            </label>
            <button className="small danger" onClick={() => remove(i)}>
              削除
            </button>
          </div>
          {cutRows.map((k) => (
            <div key={k} className="narr-row">
              <span className="counter" style={{width: 52}}>
                {k + 1}枚目
              </span>
              <input
                className="narr-text"
                value={v.telops[k] ?? ''}
                onChange={(e) => patchAt(i, 'telops', k, e.target.value)}
                placeholder={info?.current?.[k]?.telop ? `今: ${info.current[k].telop}（空なら今のまま）` : '空なら今のまま'}
              />
              <span className="counter">{[...(v.telops[k] ?? '')].length}字</span>
              <select value={v.clipIds[k] ?? ''} onChange={(e) => patchAt(i, 'clipIds', k, e.target.value)} title="このカットの素材を差し替える（空なら今のまま）" style={{width: 150}}>
                <option value="">素材はそのまま</option>
                {clips.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} {c.slug}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <div className="narr-row">
            <span className="counter" style={{width: 52}}>
              ナレ
            </span>
            <input className="narr-text" value={v.narration} onChange={(e) => patch(i, {narration: e.target.value})} placeholder="1本目のナレーション（空なら今のまま）" />
          </div>
        </div>
      ))}

      <div className="row" style={{marginTop: 6}}>
        <button className="small" onClick={add}>
          + パターンを追加
        </button>
        <span style={{flex: 1}} />
        <button onClick={() => void load()}>読み直す</button>
        <button className="primary" onClick={() => void save()} disabled={!dirty}>
          hooks.json を保存
        </button>
      </div>

      {issues.length > 0 && (
        <div className="issues" style={{marginTop: 6}}>
          {issues.map((x, k) => (
            <div key={k} className={`issue ${x.severity}`}>
              <span className="code">
                {x.severity} {x.code}
              </span>
              <span>{x.message}</span>
            </div>
          ))}
        </div>
      )}

      <details style={{marginTop: 6}}>
        <summary className="hint">何が変わって、何が変わらないのか</summary>
        <p className="hint">
          変わるのは<b>冒頭 {span} カットのテロップ・素材</b>、<b>バッジ</b>、<b>ナレーション1本目</b>だけです。
          <b>エリア名は本文ではなくバッジに入れます</b>（本文はエリア名が無くても通る言い回しに。例：バッジ「生野区」＋本文「地元の9割が知らない」）。
          cuts.json は書き換えず、差し替えた内容を <code>--props</code> でレンダーに渡すので、フック以降は元の動画と 1 フレームも変わりません。
          素材を差し替えても<b>カットの尺は元のまま</b>なので、全体の尺は揃います。
        </p>
        <p className="hint">
          書き出しは <code>out/trial_&lt;id&gt;_narration.mp4</code>、納品名は <code>&lt;店名&gt;_&lt;人格&gt;_ナレーション付き_フック&lt;id&gt;.mp4</code>。
          キャプションは共通なので「納品」ボタン側で 1 つだけ出します。
          パターンの数だけレンダーが走るので、先に「ドラフトで試す」で見た目を確認すると速いです。
        </p>
      </details>
    </section>
  );
};
