// 自然言語の台本から構成を組み立てる。型（F0/F7…）に流し込む「プラン生成」の代わりに使う。
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import type {ScriptIssue, ScriptSection} from '@shared/script';
import {localDate} from '@shared/time';
import {AiModelSelect} from '../hooks/useAiModel';

type ScriptRes = {etag: string | null; data: string | null; sections: ScriptSection[]; totalSec: number | null};

/** GET /script/plan（core/script.ts の ScriptProposalView） */
type Proposal = {
  canApply: boolean;
  blockers: string[];
  issues: ScriptIssue[];
  lines: string[];
  totalSec: number;
  cutCount: number;
  narrationCount: number;
  createdAt: string;
  model: string;
  costUsd: number;
  appliedAt?: string;
  unmatched: string[];
  notes: string;
  /** AI の返答から自動で直したこと（ナレーションが動画尺の後ろ・素材の長さ超え等）。空なら何も直していない */
  autoFixes?: string[];
  current: {cuts: number | null; narration: number | null; sfx: number};
};

/** 承認の確認文。何を置き換えるかを具体的に出す */
const approvalText = (p: Proposal): string => {
  const w = p.issues.filter((i) => i.severity === 'W').length;
  const items = [
    `・cuts.json: ${p.cutCount} カット / ${p.totalSec.toFixed(1)} 秒${p.current.cuts !== null ? `（いまの ${p.current.cuts} カットを置き換え）` : '（新規）'}`,
    p.narrationCount
      ? `・narration.json: ${p.narrationCount} ブロック${p.current.narration !== null ? `（いまの ${p.current.narration} ブロック${p.current.sfx ? `・効果音 ${p.current.sfx} 個` : ''}・声と音量の設定を置き換え）` : '（新規）'}`
      : '・narration.json: 台本にナレーションが無いので書きません',
    w ? `・W（注意）が ${w} 件あります` : null,
    p.unmatched.length ? `・素材が無かった区間が ${p.unmatched.length} 件あります（撮り足しが要ります）` : null,
  ].filter((l): l is string => !!l);
  return ['この割り当てで書き込みますか？（AI はもう走らせません）', '', ...items, '', '旧版は .studio/backups/ に残ります。音声は作り直しになります。'].join('\n');
};

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
  // 「バズ動画の型を写す」（ai-mimic）も script.md を書いて組み立てるので、同じく待つ
  const busy = s.jobs.some((j) => (j.status === 'running' || j.status === 'queued') && (j.type === 'ai-script' || j.type === 'ai-mimic'));
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

  // 「割り当てを見るだけ」の結果（保存してある案）
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [applying, setApplying] = useState(false);
  const loadProposal = useCallback(async () => {
    if (!slug) return;
    try {
      const r = await api.get<{data: Proposal | null}>(`/api/projects/${encodeURIComponent(slug)}/script/plan`);
      setProposal(r.data.data);
    } catch {
      setProposal(null); // 古いサーバーには /script/plan が無い
    }
  }, [slug]);
  useEffect(() => {
    void loadProposal();
  }, [loadProposal]);

  // 組み立てが終わったら（E で書けなかったときも）結果を取り直す。
  // 台本は編集中なら読み直さない（走っている間に書いた変更を消さないように）
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const finished = s.jobs.find((j) => (j.type === 'ai-script' || j.type === 'ai-mimic') && j.slug === slug && (j.status === 'done' || j.status === 'failed'));
  useEffect(() => {
    if (!finished) return;
    // 型を写す工程は script.md を書き換えるので、編集中でも読み直す（AI が書いた新しい台本の方が正）
    if (!dirtyRef.current || finished.type === 'ai-mimic') void load();
    void loadProposal();
  }, [finished?.id, finished?.status, finished?.type, load, loadProposal]);

  const approve = async () => {
    if (!slug || !proposal) return;
    if (s.files.cuts.dirty || s.files.narration.dirty) return s.toast('Timeline に未保存の変更があります。保存するか読み直してから書き込んでください', 'error');
    if (dirty) return s.toast('script.md に未保存の変更があります。この案は保存済みの台本から作ったものです', 'error');
    if (!window.confirm(approvalText(proposal))) return;
    setApplying(true);
    try {
      const r = await api.post<{cuts: number; narration: number; totalSec: number; view: Proposal | null}>(`/api/projects/${encodeURIComponent(slug)}/script/plan/apply`);
      setProposal(r.data.view);
      await Promise.all([s.loadFile('cuts'), s.loadFile('narration')]);
      s.toast(`書き込みました: ${r.data.cuts} カット / ${r.data.totalSec.toFixed(1)} 秒・ナレーション ${r.data.narration} ブロック`, 'ok');
    } catch (e) {
      const view = ((e as {body?: {view?: Proposal | null}}).body?.view) ?? undefined;
      if (view !== undefined) setProposal(view);
      s.toast((e as Error).message, 'error');
    } finally {
      setApplying(false);
    }
  };

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
        <button
          onClick={() => s.addJob('ai-script', {model: aiModel, write: false})}
          disabled={busy || unsupported || dirty || !text.trim() || !catalog}
          title="書き込まずに割り当てだけ作ります。結果を見て「この割り当てで書き込む」で承認すると、そのまま cuts.json と narration.json に入ります（AI をもう一度走らせません）"
        >
          割り当てを見るだけ
        </button>
        <AiModelSelect value={aiModel} onChange={onModel} />
        {untagged > 0 && <span className="pill warn">タグの無い素材が {untagged} 本（先にタグ付けすると当たりが良くなります）</span>}
        {unsupported && <span className="pill warn">サーバーが古いプロセスです。再起動してください</span>}
      </div>

      {proposal && (
        <div className="script-proposal">
          <div className="summary">
            <span>
              <b>割り当ての結果</b>
            </span>
            <span>
              {proposal.cutCount} カット / {proposal.totalSec.toFixed(1)} 秒・ナレーション {proposal.narrationCount} ブロック
            </span>
            {proposal.appliedAt ? (
              <span className="pill">書き込み済み（{localDate(proposal.appliedAt)}）</span>
            ) : proposal.canApply ? (
              <span className="pill warn">未反映（承認待ち）</span>
            ) : (
              <span className="pill err">書き込めません</span>
            )}
            <span className="hint">
              {localDate(proposal.createdAt)} 作成{proposal.model ? ` / ${proposal.model}` : ''}
              {proposal.costUsd ? ` / $${proposal.costUsd.toFixed(2)}` : ''}
            </span>
          </div>

          {proposal.blockers.length > 0 && (
            <div className="issues">
              {proposal.blockers.map((b, i) => (
                <div key={i} className="issue E">
                  <span className="code">書き込めない理由</span>
                  <span>{b}</span>
                </div>
              ))}
            </div>
          )}

          {proposal.lines.length > 0 && (
            <pre className="script-proposal-lines">{proposal.lines.join('\n')}</pre>
          )}

          {(proposal.issues.length > 0 || proposal.unmatched.length > 0 || (proposal.autoFixes?.length ?? 0) > 0) && (
            <div className="issues">
              {(proposal.autoFixes ?? []).map((f, i) => (
                <div key={`f${i}`} className="issue F" title="AI の返答のうち機械的に直せる E は、AI を走らせ直さずにここで直しています">
                  <span className="code">自動修正</span>
                  <span>{f}</span>
                </div>
              ))}
              {proposal.issues.map((x, i) => (
                <div key={`i${i}`} className={`issue ${x.severity}`}>
                  <span className="code">
                    {x.severity} {x.code}
                  </span>
                  <span>{x.message}</span>
                </div>
              ))}
              {proposal.unmatched.map((u, i) => (
                <div key={`u${i}`} className="issue W">
                  <span className="code">素材が無い</span>
                  <span>{u}</span>
                </div>
              ))}
            </div>
          )}
          {proposal.notes && <p className="hint">意図: {proposal.notes}</p>}

          <div className="row">
            <button
              className="primary"
              onClick={() => void approve()}
              disabled={!proposal.canApply || applying || busy || dirty}
              title={
                !proposal.canApply
                  ? proposal.blockers.join(' / ')
                  : dirty
                    ? 'script.md に未保存の変更があります'
                    : '確認のうえ、この割り当てを cuts.json と narration.json に書き込みます（AI は走らせません）'
              }
            >
              {applying ? '書き込み中…' : proposal.appliedAt ? 'この割り当てでもう一度書き込む' : 'この割り当てで書き込む'}
            </button>
            <span className="hint">
              {proposal.appliedAt
                ? '書き込んだあとに Timeline で直した内容は、もう一度書き込むと失われます'
                : '押すと、置き換える内容を確認してから書き込みます。直したい点があれば台本を直して「割り当てを見るだけ」をやり直してください'}
            </span>
          </div>
        </div>
      )}

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
          そのあとは Timeline で微調整 → Render の「仕上げ」（音声 → レンダー → 合成 → 納品）で完成です。
        </p>
        <p className="hint">
          「プラン生成」（型に流し込む方式）とは<b>どちらか一方</b>を使います。台本があるならこちら、
          素材だけあって構成から決めたいなら「プラン生成」です。
        </p>
      </details>
    </section>
  );
};
