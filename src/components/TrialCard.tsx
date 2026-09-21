// トライアルリール：冒頭のフックだけを差し替えた複数バージョンを作る。
// 差し替えるのは**冒頭 3 カット**（既定）。1 カットだけだと見た印象が変わらず A/B の差が出ない。
// キャプションは**パターンごとに文面を変える**（同じ文面で複数投稿すると使い回しとして扱われる）。
// 伸びた 1 本が決まったら「勝ちパターンの二次活用」（締めだけ変えて 1.1 倍速・新しいキャプション）。
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import {DEFAULT_HOOK_CUTS, TRIAL_POSTING_RULES, checkHooks, trialCaptionOf, type HookVariant, type Hooks} from '@shared/hooks';
import {DEFAULT_WINNER_SPEED, WINNER_SPEED_RANGE} from '@shared/winner';

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
  const [aiInstruction, setAiInstruction] = useState('');
  const [winnerId, setWinnerId] = useState('');
  const [tailTelop, setTailTelop] = useState('');
  const [tailNarration, setTailNarration] = useState('');
  const [speed, setSpeed] = useState(DEFAULT_WINNER_SPEED);
  // 検証の E（F7 の看板温存・画角の連続など「構成の意見」）を承知でレンダーする。通常レンダー・仕上げと同じ逃げ道
  const [allowErrors, setAllowErrors] = useState(false);
  const handled = useRef(new Set<string>());
  const dirty = JSON.stringify(hooks) !== saved;
  const running = (t: string) => s.jobs.some((j) => (j.status === 'running' || j.status === 'queued') && j.type === t && j.slug === slug);
  const busy = running('trial');
  const aiBusy = running('ai-hooks');
  const winnerBusy = running('winner');
  // 直近の trial / winner が検証で止まっていたら、その E を見せて「承知で」を案内する
  const lastPreflightFail = s.jobs.find((j) => (j.type === 'trial' || j.type === 'winner') && j.slug === slug && j.status === 'failed' && /preflight に失敗/.test(j.error ?? ''));
  const preflightErrors = (lastPreflightFail?.error ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .filter((l) => l && !/preflight に失敗/.test(l));
  const unsupported = !s.supportsJob('trial');
  // トライアル・二次活用版が自分で作る音声はフック（と締め）だけ。残りのブロックの wav は
  // 「音声を生成」で先に作っておかないと、レンダーが終わったあと mix で落ちる
  const narration = s.files.narration.data;
  const needsTts = (narration?.segments ?? []).filter((seg) => (seg as {needsTts?: boolean}).needsTts || !seg.durSec).length;
  const audioBlockedBy = narration && needsTts > 0 ? `ナレーション ${needsTts} ブロックの音声がまだありません。上の「音声を生成」を先に実行してください` : null;
  const commonCaption = s.caption.text ?? '';
  const issues = checkHooks(hooks, {caption: commonCaption});
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

  // AI がフック案を書き終えたら hooks.json を読み直す（このタブの案件のものだけ）
  useEffect(() => {
    for (const j of s.jobs) {
      if (j.type !== 'ai-hooks' || j.slug !== slug || j.status !== 'done' || handled.current.has(j.id)) continue;
      handled.current.add(j.id);
      void load();
    }
  }, [s.jobs, slug, load]);

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
          angle: '',
          telops: first ? (info?.current ?? []).map((c) => c.telop) : [],
          clipIds: [],
          badge: first ? (info?.current?.[0]?.badge || null) : undefined,
          narration: '',
          caption: '',
        },
      ],
    });
  };

  const askAi = () => {
    if (hooks.variants.length && !window.confirm(`いまの ${hooks.variants.length} パターンを AI の案で置き換えます（旧版は .studio/backups/ に残ります）。よろしいですか？`)) return;
    void s.addJob('ai-hooks', {count: 3, cutCount: hooks.cutCount, force: hooks.variants.length > 0, instruction: aiInstruction.trim() || undefined});
  };

  const makeTrial = (draft: boolean) => {
    void s.addJob('trial', draft ? {draft: true, deliver: false, allowErrors} : {allowErrors});
  };

  const makeWinner = (draft: boolean) => {
    void s.addJob('winner', {
      id: winnerId || undefined,
      tailTelop: tailTelop.trim() || undefined,
      tailNarration: tailNarration.trim() || undefined,
      speed,
      draft,
      deliver: !draft,
      allowErrors,
    });
  };

  if (!slug || !s.files.cuts.data) return null;
  const cutRows = Array.from({length: span}, (_, i) => i);
  const captionSummary = (v: HookVariant) => {
    const cap = trialCaptionOf(v, commonCaption);
    if (!cap) return '（キャプション無し。共通の caption.txt も無い）';
    return v.caption.trim() ? `専用 ${[...cap].length} 文字` : `共通の caption.txt（${[...cap].length} 文字）`;
  };

  return (
    <section className="card" style={{marginTop: 8}} data-tour="trial">
      <div className="summary">
        <span>
          <b>トライアル（フック差し替え）</b>
        </span>
        <span>{hooks.variants.length ? `${hooks.variants.length} パターン` : '未設定'}</span>
        <span className="hint">冒頭 {span} カットだけを変えた複数バージョンを作ります。それ以降は 1 フレームも変わりません。キャプションはパターンごとに変えます</span>
      </div>

      <div className="row">
        <button className="primary" onClick={askAi} disabled={aiBusy || busy || !s.supportsJob('ai-hooks')} title="今のフックを A（基準）として残し、B / C を別の切り口（疑問形・結果先出し・煽り形 など）で書かせます。キャプションもパターンごとに書き換えます">
          {aiBusy ? 'AI が書いています…' : 'AI に 3 パターン書いてもらう'}
        </button>
        <input value={aiInstruction} onChange={(e) => setAiInstruction(e.target.value)} placeholder="AI への追加の指示（任意）：B は疑問形で など" style={{flex: 1, minWidth: 200}} />
        <label title="冒頭の何カットを差し替えるか。1 カットだけだと違いが伝わりにくいので既定は 3。AI に書かせるときはテロップの切れ目まで自動で伸びます">
          差し替えるカット数
          <input type="number" min={1} max={6} value={hooks.cutCount} onChange={(e) => setHooks({...hooks, cutCount: Math.max(1, Math.min(6, Number(e.target.value) || 1))})} style={{width: 56}} />
        </label>
      </div>
      <div className="row">
        <button
          className="primary"
          onClick={() => makeTrial(false)}
          disabled={busy || unsupported || dirty || hooks.variants.length < 2 || !!audioBlockedBy}
          title={audioBlockedBy ?? (dirty ? 'hooks.json に未保存の変更があります' : hooks.variants.length < 2 ? '2 パターン以上必要です' : `${hooks.variants.length} 本レンダーして、キャプションと一緒に納品します`)}
        >
          {busy ? '作成中…' : `${hooks.variants.length || ''} パターンを作る（レンダー→音声→mix→納品）`}
        </button>
        <button onClick={() => makeTrial(true)} disabled={busy || unsupported || dirty || hooks.variants.length < 2 || !!audioBlockedBy} title={audioBlockedBy ?? '0.25 倍の粗いレンダーで見た目だけ先に確認する（納品しません）'}>
          ドラフトで試す
        </button>
        <label className="sb-inline" title="検証の E（F7 の看板温存・画角の連続・フックの型など）を承知でレンダーする。二次活用版にも効きます。素材が無い等の致命的なものは通りません">
          <input type="checkbox" checked={allowErrors} onChange={(e) => setAllowErrors(e.target.checked)} />
          <span>指摘を承知でレンダー</span>
        </label>
        {unsupported && <span className="pill warn">サーバーが古いプロセスです。再起動してください</span>}
      </div>
      {audioBlockedBy && <div className="hint" style={{color: 'var(--warn)'}}>{audioBlockedBy}（トライアルが自分で作るのはフック区間のナレーションだけです）</div>}
      {preflightErrors.length > 0 && !allowErrors && (
        <div className="issues" style={{marginTop: 6}}>
          <div className="hint" style={{color: 'var(--warn)'}}>
            前回の{lastPreflightFail?.type === 'winner' ? '二次活用版' : 'トライアル'}が検証で止まりました。並びを自分で決めていて、この指摘を承知のうえで進めたい場合は「指摘を承知でレンダー」にチェックを入れて押し直してください
          </div>
          {preflightErrors.map((e, i) => (
            <div key={i} className="issue E">
              <span className="code">E</span>
              <span>{e}</span>
            </div>
          ))}
        </div>
      )}

      {hooks.variants.map((v, i) => (
        <div key={i} className="hook-variant">
          <div className="row">
            <input className="narr-id" style={{width: 44}} value={v.id} onChange={(e) => patch(i, {id: e.target.value})} title="A / B / C。ファイル名に入ります" />
            <input style={{width: 120}} value={v.angle} onChange={(e) => patch(i, {angle: e.target.value})} placeholder="切り口（疑問形 など）" title="どの切り口を試すパターンか。A/B/C で重ねない" />
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
            <input className="narr-text" value={v.narration} onChange={(e) => patch(i, {narration: e.target.value})} placeholder="フック区間のナレーション 1 文（空なら今のまま。区間に入るブロックをまとめて差し替えます）" />
            <span className="counter">{[...v.narration].length}字</span>
          </div>
          <details style={{marginTop: 4}}>
            <summary className="hint">キャプション: {captionSummary(v)}</summary>
            <textarea
              className="caption-box"
              value={v.caption}
              onChange={(e) => patch(i, {caption: e.target.value})}
              placeholder={commonCaption ? '空なら共通の caption.txt をそのまま使います。他のパターンと同じ文面にしない' : 'このパターン専用のキャプション'}
              spellCheck={false}
              style={{minHeight: 120}}
            />
          </details>
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

      <details style={{marginTop: 8}} open>
        <summary className="hint">
          <b>投稿の運用ルール</b>（Instagram 側の操作。ツールは代行しません）
        </summary>
        <ol className="hint" style={{margin: '4px 0 0', paddingLeft: 20}}>
          {TRIAL_POSTING_RULES.map((r, k) => (
            <li key={k}>{r}</li>
          ))}
        </ol>
      </details>

      <details style={{marginTop: 8}}>
        <summary className="hint">
          <b>勝ちパターンの二次活用</b>（締めの一言だけ変えて {DEFAULT_WINNER_SPEED} 倍速・新しいキャプションで再投稿）
        </summary>
        <p className="hint">伸びた 1 本が決まってから使います。映像は締め以外変えません。文言を空にすると AI が書きます（締めのテロップ・ナレーション・キャプション）。</p>
        <div className="row">
          <label>
            伸びたパターン
            <select value={winnerId} onChange={(e) => setWinnerId(e.target.value)} style={{width: 150}}>
              <option value="">元の動画（トライアル前）</option>
              {hooks.variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.id}
                  {v.angle ? `［${v.angle}］` : ''}
                </option>
              ))}
            </select>
          </label>
          <label title={`${WINNER_SPEED_RANGE[0]}〜${WINNER_SPEED_RANGE[1]}`}>
            倍速
            <input type="number" min={WINNER_SPEED_RANGE[0]} max={WINNER_SPEED_RANGE[1]} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value) || DEFAULT_WINNER_SPEED)} style={{width: 64}} />
          </label>
        </div>
        <div className="narr-row">
          <span className="counter" style={{width: 52}}>
            締め
          </span>
          <input className="narr-text" value={tailTelop} onChange={(e) => setTailTelop(e.target.value)} placeholder="新しい締めのテロップ（空なら AI が書く）" />
          <span className="counter">{[...tailTelop].length}字</span>
        </div>
        <div className="narr-row">
          <span className="counter" style={{width: 52}}>
            ナレ
          </span>
          <input className="narr-text" value={tailNarration} onChange={(e) => setTailNarration(e.target.value)} placeholder="新しい締めのナレーション（空なら AI が書く）" />
          <span className="counter">{[...tailNarration].length}字</span>
        </div>
        <div className="row">
          <button
            className="primary"
            onClick={() => makeWinner(false)}
            disabled={winnerBusy || busy || dirty || !s.supportsJob('winner') || !!audioBlockedBy}
            title={audioBlockedBy ?? (dirty ? 'hooks.json に未保存の変更があります' : 'レンダー→締めの音声→mix→倍速→outputs/ へ（mp4 と新しいキャプション）')}
          >
            {winnerBusy ? '作成中…' : '二次活用版を作る（レンダー→音声→mix→倍速→納品）'}
          </button>
          <button onClick={() => makeWinner(true)} disabled={winnerBusy || busy || dirty || !s.supportsJob('winner') || !!audioBlockedBy} title={audioBlockedBy ?? '0.25 倍の粗いレンダーで確認（納品しません）'}>
            ドラフトで試す
          </button>
        </div>
      </details>

      <details style={{marginTop: 6}}>
        <summary className="hint">何が変わって、何が変わらないのか</summary>
        <p className="hint">
          変わるのは<b>冒頭 {span} カットのテロップ・素材</b>、<b>バッジ</b>、<b>フック区間のナレーション</b>、<b>キャプション</b>だけです。
          <b>エリア名は本文ではなくバッジに入れます</b>（本文はエリア名が無くても通る言い回しに。例：バッジ「生野区」＋本文「地元の9割が知らない」）。
          cuts.json は書き換えず、差し替えた内容を <code>--props</code> でレンダーに渡すので、フック以降は元の動画と 1 フレームも変わりません。
          素材を差し替えても<b>カットの尺は元のまま</b>なので、全体の尺は揃います。
        </p>
        <p className="hint">
          書き出しは <code>out/trial_&lt;id&gt;_narration.mp4</code>、納品名は <code>&lt;店名&gt;_&lt;人格&gt;_ナレーション付き_フック&lt;id&gt;.mp4</code> と
          <code>&lt;店名&gt;_&lt;人格&gt;_caption_フック&lt;id&gt;.txt</code>（専用が無ければ共通の caption.txt）。
          パターンの数だけレンダーが走るので、先に「ドラフトで試す」で見た目を確認すると速いです。
        </p>
      </details>
    </section>
  );
};
