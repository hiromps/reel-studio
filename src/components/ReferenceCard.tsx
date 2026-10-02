// バズ動画の型を写す：他の人の伸びたリールを取り込んで型を分析し、その型で自分の素材の台本を作る。
//
// 流れ: 動画を選ぶ → 「型を分析する」（ai-reference）→ 分析結果（区間・テロップの型・テンポ）を見る
//       → 「この型で台本を作って組み立てる」（ai-mimic）→ script.md と cuts / narration ができる
// 写すのは構成・テンポ・テロップの型だけ。参考動画の映像・音声・文言そのものは使わない。
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {put} from '@vercel/blob/client';
import {api} from '../api';
import {useStudio} from '../state/store';
import {AiModelSelect} from '../hooks/useAiModel';
import {AiJobStatus} from './AiJobStatus';
import {fmtSec, isReferenceAnalyzed, libraryEntryLabel, referenceStats, type LibraryIndexEntry, type Reference, type ReferenceCut} from '@shared/reference';
import {localDateTime} from '@shared/time';
import {parseInstagramPostUrl} from '@shared/instagram-mcp';

type Res = {etag: string | null; data: Reference | null};

const ROLE_LABEL: Record<string, string> = {
  hook: 'フック',
  proof: '証明',
  tease: '焦らし',
  reveal: 'リビール',
  sizzle: 'シズル',
  info: '情報',
  conversation: '会話',
  badgeHead: '見出し',
  cta: '締め',
  filler: 'つなぎ',
};

const ORIENT: Record<ReferenceCut['orientation'], string> = {vertical: '縦', horizontal: '横', none: ''};

/** カット頭のコマ。取れていない・まだ PC から上がっていないときは枠だけ */
const Frame: React.FC<{src: string | null; alt: string}> = ({src, alt}) => {
  const [ok, setOk] = useState(true);
  useEffect(() => setOk(true), [src]);
  if (!src || !ok) return <div className="thumb-none">no frame</div>;
  return <img src={src} alt={alt} loading="lazy" draggable={false} onError={() => setOk(false)} />;
};

export type ReferenceCardState = {
  /** 参考動画を取り込んであるか */
  present: boolean;
  /** 分析まで済んでいるか */
  analyzed: boolean;
};

export const ReferenceCard: React.FC<{
  aiModel: string;
  onModel: (v: string) => void;
  /** 参考動画の有無を親（Brief の「作り方の流れ」）に知らせる */
  onState?: (st: ReferenceCardState) => void;
  /** Brief で「いまの作り方」に選ばれている（見出しに印を出す） */
  primary?: boolean;
}> = ({aiModel, onModel, onState, primary}) => {
  const s = useStudio();
  const slug = s.active;
  const [ref, setRef] = useState<Reference | null>(null);
  useEffect(() => {
    onState?.({present: !!ref?.source, analyzed: isReferenceAnalyzed(ref)});
  }, [ref, onState]);
  const [uploading, setUploading] = useState<{name: string; pct: number | null} | null>(null);
  const [localPath, setLocalPath] = useState('');
  const [igUrl, setIgUrl] = useState('');
  const [from, setFrom] = useState('');
  // ライブラリ（同じ動画の分析を案件をまたいで使い回す置き場）。名前で選んで写す・この案件の分析に名前を付ける
  const [library, setLibrary] = useState<LibraryIndexEntry[]>([]);
  const [libKey, setLibKey] = useState('');
  const [title, setTitle] = useState('');
  const [showCuts, setShowCuts] = useState(false);
  const [showRules, setShowRules] = useState(true);
  const input = useRef<HTMLInputElement>(null);

  const base = `/api/projects/${encodeURIComponent(slug ?? '')}/reference`;
  const jobOf = (type: string) => s.jobs.find((j) => (j.status === 'running' || j.status === 'queued') && j.type === type && j.slug === slug);
  const analyzing = jobOf('ai-reference');
  const mimicking = jobOf('ai-mimic');
  const naming = s.jobs.some((j) => (j.status === 'running' || j.status === 'queued') && j.type === 'reference-library');
  const scripting = jobOf('ai-script');
  const busy = !!(analyzing || mimicking || scripting);
  const unsupported = !s.supportsJob('ai-reference') || !s.supportsJob('ai-mimic');
  const catalog = s.files.catalog.data;
  const brief = s.files.brief.data;
  const claude = s.config?.claude !== false;

  const load = useCallback(async () => {
    if (!slug) return;
    try {
      const r = await api.get<Res>(base);
      setRef(r.data.data);
    } catch {
      setRef(null); // 古いサーバーには /reference が無い
    }
  }, [slug, base]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadLibrary = useCallback(async () => {
    try {
      const r = await api.get<{entries: LibraryIndexEntry[]}>('/api/reference-library');
      setLibrary(r.data.entries ?? []);
    } catch {
      setLibrary([]); // 古いサーバーには無い
    }
  }, []);
  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);
  // 名前の入力欄は、いま写してある分析の名前から始める
  useEffect(() => setTitle(ref?.title ?? ''), [ref?.title, ref?.source?.key]);

  // 分析・複製・ライブラリのジョブが終わったら（失敗でも）結果と一覧を取り直す
  const finished = s.jobs.find((j) => ((j.type === 'ai-reference' && j.slug === slug) || j.type === 'reference-library') && (j.status === 'done' || j.status === 'failed'));
  useEffect(() => {
    if (!finished) return;
    void load();
    void loadLibrary();
  }, [finished?.id, finished?.status, load, loadLibrary]);

  /** 分析を積む。force は「分析をやり直す」（ライブラリの再利用や済んでいる分析を無視して走らせる） */
  const analyze = (force = false) => void s.addJob('ai-reference', {model: aiModel, ...(force ? {force: true} : {})});
  /** 取り込みの結果が分析済み（ライブラリから写した）なら、分析は積まずに知らせる */
  const afterImport = (data: Reference | null, name: string) => {
    setRef(data);
    if (isReferenceAnalyzed(data)) s.toast(`同じ動画の分析がライブラリにあったので再利用しました: ${name}`, 'ok');
    else {
      s.toast(`参考動画を取り込みました: ${name}`, 'ok');
      analyze();
    }
  };

  /** 動画を取り込んで、そのまま分析まで積む */
  const pick = async (file: File) => {
    if (!slug) return;
    setUploading({name: file.name, pct: s.isCloud ? 0 : null});
    try {
      if (s.isCloud) {
        // Vercel の Function は本文 4.5MB までなので、素材と同じくブラウザから Blob へ直接上げる
        const t = await api.post<{token: string; pathname: string}>('/api/uploads/token', {slug, filename: file.name, folder: '_reference'});
        const r = await put(t.data.pathname, file, {
          access: 'public',
          token: t.data.token,
          contentType: file.type || 'application/octet-stream',
          multipart: file.size > 8 * 1024 * 1024,
          onUploadProgress: (p) => setUploading({name: file.name, pct: p.total ? Math.round((p.loaded / p.total) * 100) : 0}),
        });
        const job = await s.addJob('ai-reference', {url: r.url, name: file.name, model: aiModel});
        if (job) s.toast('PC が動画を取り込んで分析します（PC オフラインなら起動後に始まります）', 'ok');
      } else {
        const r = await api.upload<Res>(`${base}/upload?filename=${encodeURIComponent(file.name)}`, file);
        afterImport(r.data.data, file.name);
      }
    } catch (e) {
      s.toast(`取り込みに失敗: ${(e as Error).message}`, 'error');
    } finally {
      setUploading(null);
      if (input.current) input.current.value = '';
    }
  };

  /** Instagram のリール URL から取り込んで分析（ダウンロードは PC が Smartgram MCP で行う。HikerAPI 1 トークン） */
  const importInstagram = async () => {
    const post = parseInstagramPostUrl(igUrl);
    if (!slug || !post) return;
    const job = await s.addJob('ai-reference', {igUrl: post.url, model: aiModel});
    if (job) {
      setIgUrl('');
      s.toast(s.isCloud ? 'PC が Instagram から動画を落として分析します（PC オフラインなら起動後に始まります）' : 'Instagram から動画を落として分析します', 'ok');
    }
  };

  const importPath = async () => {
    if (!slug || !localPath.trim()) return;
    try {
      const r = await api.post<Res>(`${base}/import`, {path: localPath.trim()});
      setLocalPath('');
      afterImport(r.data.data, localPath.trim().split(/[\\/]/).pop() ?? '');
    } catch (e) {
      s.toast((e as Error).message, 'error');
    }
  };

  const copyFrom = async () => {
    if (!slug || !from) return;
    try {
      const r = await api.post<Res & {job?: {id: string}}>(`${base}/copy-from`, {from});
      if (r.data.job) s.toast(`${from} の分析を PC で複製しています（ジョブ ${r.data.job.id}）`, 'ok');
      else {
        setRef(r.data.data);
        s.toast(`${from} の分析を写しました`, 'ok');
      }
    } catch (e) {
      s.toast((e as Error).message, 'error');
    }
  };

  /** ライブラリの 1 本を名前で選んで写す（ローカルはその場で、クラウドは PC のジョブ） */
  const useLibrary = async () => {
    if (!slug || !libKey) return;
    try {
      const r = await api.post<Res & {job?: {id: string}}>(`${base}/use-library`, {key: libKey});
      if (r.data.job) s.toast('PC がライブラリの分析を写しています（PC オフラインなら起動後に始まります）', 'ok');
      else {
        setRef(r.data.data);
        s.toast('ライブラリの分析を写しました（分析は走らせていません）', 'ok');
      }
      setLibKey('');
    } catch (e) {
      s.toast((e as Error).message, 'error');
    }
  };

  /** ライブラリの 1 本を消す（動画・コマ・分析。戻せない）。案件に写した分析は残る */
  const removeFromLibrary = async () => {
    const e = library.find((x) => x.key === libKey);
    if (!e) return;
    const name = libraryEntryLabel(e);
    const used = e.usedBy.length ? `使っている案件 ${e.usedBy.length} 件（${e.usedBy.slice(0, 5).join('、')}${e.usedBy.length > 5 ? '…' : ''}）の分析はそのまま残ります。` : '使っている案件はありません。';
    if (!window.confirm(`「${name}」をライブラリから消しますか？\n\n動画・コマ・分析が消え、戻せません。${used}\nライブラリから写した案件では「分析をやり直す」ができなくなります。`)) return;
    try {
      const r = await api.del<{removed?: {title: string}; job?: {id: string}}>(`/api/reference-library/${encodeURIComponent(libKey)}`);
      if (r.data.job) s.toast('PC がライブラリから消しています', 'ok');
      else {
        s.toast(`ライブラリから消しました: ${name}`, 'ok');
        await loadLibrary();
      }
      setLibKey('');
    } catch (e2) {
      s.toast((e2 as Error).message, 'error');
    }
  };

  /** ライブラリの名前を付ける。同じ動画を使う全案件の表示名も揃う */
  const saveTitle = async () => {
    const key = ref?.source?.key;
    if (!key) return;
    try {
      const r = await api.put<{entry?: LibraryIndexEntry; job?: {id: string}}>(`/api/reference-library/${encodeURIComponent(key)}`, {title});
      if (r.data.job) s.toast('PC がライブラリの名前を更新しています', 'ok');
      else {
        s.toast(`名前を保存しました: ${r.data.entry?.title || '（なし）'}`, 'ok');
        await Promise.all([load(), loadLibrary()]);
      }
    } catch (e) {
      s.toast((e as Error).message, 'error');
    }
  };

  /** 鍵の無い古い取り込みをライブラリに登録して名前を付ける（同じ動画が既にあればそれに結び付く） */
  const register = async () => {
    if (!slug) return;
    try {
      const r = await api.post<{entry?: LibraryIndexEntry; data?: Reference | null; job?: {id: string}}>(`${base}/register`, {title});
      if (r.data.job) s.toast('PC がライブラリに登録しています', 'ok');
      else {
        if (r.data.data) setRef(r.data.data);
        s.toast(`ライブラリに登録しました${r.data.entry?.title ? `: ${r.data.entry.title}` : ''}（${r.data.entry?.key ?? ''}）`, 'ok');
        await loadLibrary();
      }
    } catch (e) {
      s.toast((e as Error).message, 'error');
    }
  };

  const remove = async () => {
    if (!slug || !window.confirm('参考動画の取り込みと分析を取り消しますか？（作った台本・構成はそのまま残ります）')) return;
    try {
      await api.del(base);
      setRef(null);
      s.toast('参考動画を取り消しました', 'ok');
    } catch (e) {
      s.toast((e as Error).message, 'error');
    }
  };

  const mimic = (write: boolean) => {
    if (s.files.cuts.dirty || s.files.narration.dirty) return s.toast('Timeline に未保存の変更があります。保存するか読み直してから実行してください', 'error');
    void s.addJob('ai-mimic', {model: aiModel, write});
  };

  if (!slug) return null;
  const others = s.projects.filter((p) => p.slug !== slug && p.has.reference);
  const stats = ref ? referenceStats(ref) : null;
  const analyzed = isReferenceAnalyzed(ref);
  const p = ref?.pattern;
  const frameUrl = (c: ReferenceCut): string | null => (c.frame && s.mediaBase ? `${s.mediaBase}/studio/${c.frame}` : null);
  const running = analyzing ?? mimicking;
  const igParsed = parseInstagramPostUrl(igUrl);
  const igReady = !!s.config?.instagramMcp;
  const mimicDisabled = busy || unsupported || !analyzed || !catalog || !brief || !claude;
  const mimicTitle = !analyzed
    ? '先に参考動画を分析してください'
    : !catalog
      ? '先に Materials で素材のカタログ化が要ります'
      : !brief
        ? '先に Brief（店名・人格）を保存してください'
        : !claude
          ? 'claude が見つかりません（Settings の「AI」）'
          : '参考動画と同じ区間・秒数・カット数・テロップの型で台本を書き、続けて素材を割り当てて cuts.json と narration.json を作ります';

  return (
    <section className="card reference-card" style={{marginTop: 8}} data-tour="reference">
      <div className="summary">
        <span>
          <b>バズ動画の型を写す</b>
        </span>
        {primary && <span className="flow-primary-tag">いまの作り方</span>}
        {!ref ? (
          <span className="pill">参考動画なし</span>
        ) : analyzed ? (
          <span className="pill ok">分析済み</span>
        ) : (
          <span className="pill warn">取り込み済み（未分析）</span>
        )}
        <span className="hint">他の人の伸びたリールを渡すと、構成・テンポ・テロップの型を言語化し、その型で自分の素材の台本を作ります</span>
      </div>

      {running && <AiJobStatus job={running} onCancel={(id) => void s.cancelJob(id)} compact lines={4} />}

      {/* ── 取り込み ── */}
      <div className="row">
        <button className="primary" onClick={() => input.current?.click()} disabled={!!uploading || busy || unsupported} title="動画ファイルを選ぶと取り込んで、そのまま分析を始めます">
          {uploading ? `アップロード中…${uploading.pct !== null ? ` ${uploading.pct}%` : ''}` : ref ? '📱 別の動画に替える' : '📱 バズ動画を選ぶ'}
        </button>
        <input
          ref={input}
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pick(f);
          }}
        />
        <AiModelSelect value={aiModel} onChange={onModel} />
        {others.length > 0 && (
          <label>
            別の案件の分析を使う
            <select value={from} onChange={(e) => setFrom(e.target.value)} disabled={busy}>
              <option value="">（選択）</option>
              {others.map((o) => (
                <option key={o.slug} value={o.slug}>
                  {o.slug}
                </option>
              ))}
            </select>
          </label>
        )}
        {others.length > 0 && (
          <button onClick={() => void copyFrom()} disabled={!from || busy || unsupported}>
            この分析を写す
          </button>
        )}
        {unsupported && <span className="pill warn">サーバーが古いプロセスです。再起動してください</span>}
      </div>
      <div className="row">
        <label className="grow">
          Instagram のリール URL から取り込む（共有 →「リンクをコピー」の URL）
          <input value={igUrl} onChange={(e) => setIgUrl(e.target.value)} placeholder="https://www.instagram.com/reel/XXXXXXXXX/" spellCheck={false} inputMode="url" disabled={busy || !!uploading} />
        </label>
        <button
          onClick={() => void importInstagram()}
          disabled={!igParsed || busy || !!uploading || unsupported || !igReady}
          title={!igReady ? 'Settings の「Instagram の情報取得」に Smartgram の MCP 用 API キーを入れると使えます' : 'Smartgram MCP で動画を落として取り込み、そのまま分析します（HikerAPI 1 トークン + 分析の API 課金）'}
        >
          URL から取り込んで分析
        </button>
        {igUrl.trim() && !igParsed && <span className="pill warn">Instagram の投稿・リールの URL ではありません</span>}
        {!igReady && <span className="hint">Settings の「Instagram の情報取得」に Smartgram の鍵が要ります</span>}
      </div>
      {library.length > 0 && (
        <div className="row">
          <label className="grow" title="同じ動画の分析は案件をまたいで 1 本に貯めてあります（設定の置き場の reference-library/）。名前で選んで写せば、ダウンロードも分析も要りません">
            ライブラリから使う（分析済みの動画に付けた名前で選ぶ）
            <select value={libKey} onChange={(e) => setLibKey(e.target.value)} disabled={busy || !!uploading}>
              <option value="">（選択）</option>
              {library.map((e) => (
                <option key={e.key} value={e.key}>
                  {libraryEntryLabel(e)}
                  {e.title ? `（${e.originalName || e.key}）` : ''} — {fmtSec(e.durationSec)} 秒・{e.segments} 区間
                  {e.usedBy.length ? `・使用 ${e.usedBy.length} 案件` : ''}
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => void useLibrary()} disabled={!libKey || busy || !!uploading || unsupported} title="選んだ分析（コマ・シート・型）をこの案件に写します。分析は走らせません">
            この分析を使う
          </button>
          <button
            className="small danger"
            onClick={() => void removeFromLibrary()}
            disabled={!libKey || busy || naming || unsupported}
            title="選んだ型をライブラリから消します（動画・コマ・分析。戻せません）。案件に写した分析は残ります"
          >
            この型をライブラリから消す
          </button>
          {library.some((e) => !e.title.trim()) && (
            <button
              className="small"
              onClick={() => void s.addJob('reference-library', {op: 'name', model: aiModel}, '_studio')}
              disabled={busy || unsupported || naming || !claude}
              title="名前の無いものに、分析の内容（フック・見せ方・締め）から Claude が名前を付けます（1 回で全部・API 課金）"
            >
              {naming ? '名前を付けています…' : `名前の無い ${library.filter((e) => !e.title.trim()).length} 本に自動で名前を付ける`}
            </button>
          )}
        </div>
      )}
      {!s.isCloud && !ref && (
        <div className="row">
          <label className="grow">
            PC 上のファイルを指定する（ダウンロード済みの mp4 など）
            <input value={localPath} onChange={(e) => setLocalPath(e.target.value)} placeholder="C:\Users\...\Downloads\reel.mp4" spellCheck={false} disabled={busy} />
          </label>
          <button onClick={() => void importPath()} disabled={!localPath.trim() || busy || unsupported}>
            取り込んで分析
          </button>
        </div>
      )}
      {uploading && uploading.pct !== null && (
        <div className="progress">
          <div style={{width: `${uploading.pct}%`}} />
        </div>
      )}

      {/* ── 取り込み済み・分析前 ── */}
      {ref?.source && stats && !analyzed && (
        <div className="row">
          <span>
            <b>{ref.source.originalName || ref.source.file}</b>（{fmtSec(stats.durationSec)} 秒・{ref.source.width}x{ref.source.height}・音声{ref.source.hasAudio ? 'あり' : 'なし'}）
          </span>
          <button className="primary" onClick={() => analyze()} disabled={busy || unsupported || !claude} title="シーン検出とコンタクトシートを作り、Claude に型を言語化させます（数分・API 課金）">
            型を分析する
          </button>
          <button className="small danger" onClick={() => void remove()} disabled={busy}>
            取り消す
          </button>
        </div>
      )}

      {/* ── 分析結果 ── */}
      {ref && analyzed && stats && p && (
        <div className="reference-result">
          <div className="summary">
            <span>
              <b>{ref.source!.originalName || ref.source!.file}</b>
              {ref.source!.sourceUrl && (
                <a href={ref.source!.sourceUrl} target="_blank" rel="noreferrer" style={{marginLeft: 6}}>
                  元の投稿
                </a>
              )}
            </span>
            <span>
              {fmtSec(stats.durationSec)} 秒・{stats.count} カット・平均 {fmtSec(stats.avgSec)} 秒/カット・{stats.segments} 区間・声 {Math.round(stats.speechRatio * 100)}%
            </span>
            <span className="hint">
              {localDateTime(ref.analyzedAt)} 分析{ref.model ? ` / ${ref.model}` : ''}
              {ref.costUsd ? ` / $${ref.costUsd.toFixed(2)}` : ''}
            </span>
            {ref.reusedAt && <span className="pill" title="同じ動画を別の案件（または人格づくり）で分析したものを写しました。分析し直すと全体に新しい方が使われます">ライブラリの分析を再利用</span>}
          </div>
          <div className="row">
            <label className="grow" title="ライブラリでの呼び名。同じ動画を使っている全案件に同じ名前が出ます（例: 大阪・炉端焼きの発見型）">
              ライブラリでの名前{ref.source!.key ? `（${ref.source!.key}）` : '（未登録。鍵の無い古い取り込み）'}
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例: 大阪・炉端焼きの発見型" disabled={busy} />
            </label>
            {ref.source!.key && library.some((e) => e.key === ref.source!.key) ? (
              <button className="small" onClick={() => void saveTitle()} disabled={busy || unsupported || title.trim() === (ref.title ?? '').trim()}>
                名前を保存
              </button>
            ) : (
              <button
                className="small"
                onClick={() => void register()}
                disabled={busy || unsupported}
                title="この分析をライブラリに入れます。同じ動画（ファイル名の投稿コードか内容）が既にあれば、新しく作らずそれに結び付けます"
              >
                ライブラリに登録して名前を付ける
              </button>
            )}
          </div>
          {ref.summary && <p className="reference-summary">{ref.summary}</p>}

          <div className="reference-pattern">
            <div>
              <span className="k">フック</span>
              <span>
                {p.hookType || '-'}
                {p.hookText ? `「${p.hookText}」` : ''}
              </span>
            </div>
            <div>
              <span className="k">リビール</span>
              <span>
                {p.revealSec === null ? '無し' : `${fmtSec(p.revealSec)} 秒`}
                {p.revealStyle ? `（${p.revealStyle}）` : ''}
              </span>
            </div>
            <div>
              <span className="k">締め</span>
              <span>
                {p.ctaText ? `「${p.ctaText}」` : '-'}
                {p.ctaStyle ? `（${p.ctaStyle}）` : ''}
              </span>
            </div>
            {p.telopStyle && (
              <div>
                <span className="k">テロップ</span>
                <span>{p.telopStyle}</span>
              </div>
            )}
            {p.tempoStyle && (
              <div>
                <span className="k">テンポ</span>
                <span>{p.tempoStyle}</span>
              </div>
            )}
            {p.saveReasons.length > 0 && (
              <div>
                <span className="k">保存理由</span>
                <span>{p.saveReasons.join('・')}</span>
              </div>
            )}
            {p.narrationStyle && (
              <div>
                <span className="k">声</span>
                <span>{p.narrationStyle}</span>
              </div>
            )}
          </div>

          <div className="table-wrap">
            <table className="table reference-segments">
              <thead>
                <tr>
                  <th>区間</th>
                  <th>役割</th>
                  <th>カット</th>
                  <th>テロップの型</th>
                  <th>目的</th>
                  <th>声</th>
                </tr>
              </thead>
              <tbody>
                {ref.segments.map((seg) => (
                  <tr key={seg.id}>
                    <td>
                      <b>{seg.label}</b>
                      <div className="hint">
                        {fmtSec(seg.fromSec)}〜{fmtSec(seg.toSec)} 秒
                      </div>
                    </td>
                    <td>{ROLE_LABEL[seg.role] ?? seg.role}</td>
                    <td>{seg.cutCount}</td>
                    <td>{seg.telopPattern || '-'}</td>
                    <td>{seg.purpose || '-'}</td>
                    <td>{seg.narration ? 'あり' : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="row">
            <button className="small" onClick={() => setShowCuts((v) => !v)}>
              {showCuts ? 'カットの一覧を隠す' : `カットの一覧を見る（${ref.cuts.length}）`}
            </button>
            <button className="small" onClick={() => setShowRules((v) => !v)}>
              {showRules ? '写すときの規則を隠す' : `写すときの規則（${ref.mimicRules.length}）`}
            </button>
          </div>
          {showCuts && (
            <div className="reference-strip">
              {ref.cuts.map((c) => (
                <div key={c.index} className="reference-cut" title={c.shot.description}>
                  <div className="reference-thumb">
                    <Frame src={frameUrl(c)} alt={`カット ${c.index}`} />
                    <span className="sb-no">{c.index}</span>
                    <span className="sb-dur">{fmtSec(c.endSec - c.startSec)}s</span>
                  </div>
                  <div className="reference-cut-foot">
                    <span>{ROLE_LABEL[c.role] ?? c.role}</span>
                    <span>
                      {c.shot.subject || c.shot.kind}・{c.shot.angle}
                      {ORIENT[c.orientation] ? `・${ORIENT[c.orientation]}書き` : ''}
                    </span>
                  </div>
                  <div className={`sb-telop${c.telop ? '' : ' empty'}`}>{c.telop || (c.badge ? `［${c.badge}］` : 'テロップなし')}</div>
                </div>
              ))}
            </div>
          )}
          {showRules && ref.mimicRules.length > 0 && (
            <ul className="tour-list reference-rules">
              {ref.mimicRules.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}

          <div className="row">
            <button className="primary" onClick={() => mimic(true)} disabled={mimicDisabled} title={mimicTitle}>
              {mimicking ? '台本を作って組み立て中…' : 'この型で台本を作って組み立てる（script.md → cuts + ナレーション）'}
            </button>
            <button onClick={() => mimic(false)} disabled={mimicDisabled} title="台本は script.md に書き、素材の割り当ては書き込まずに結果だけ残します（下の「割り当ての結果」で承認）">
              台本を作って割り当てを見るだけ
            </button>
            <button className="small" onClick={() => analyze(true)} disabled={busy || unsupported || !claude} title="同じ動画をもう一度分析します（結果は置き換わり、ライブラリにも新しい方が入ります）">
              分析をやり直す
            </button>
            <button className="small danger" onClick={() => void remove()} disabled={busy}>
              取り消す
            </button>
          </div>
          {catalog && (catalog.clips ?? []).some((c) => !c.tags && !c.user.ng) && (
            <span className="pill warn">タグの無い素材があります。先に Materials で「AI にタグ付けしてもらう」と、参考の画に合う素材を当てやすくなります</span>
          )}
        </div>
      )}

      <p className="hint reference-note">
        参考動画は分析にだけ使います。<b>映像・音声・文言そのものは使わず</b>、構成・テンポ・テロップの型を自分の素材と店の事実で再現します
        （店名・料理名・数字が参考のまま残っていたら検算で指摘します）。動画は案件フォルダの <code>.studio/reference/</code> に置かれ、クラウドにはコマだけ上がります。
        <b>同じ動画の分析は案件をまたいで使い回します</b>（設定の置き場の <code>reference-library/</code>。Instagram の投稿コードか、ファイルの内容で同じと判定）。別の案件や「AI で人格を作る」で分析済みなら、取り込むだけで分析が付きます。
      </p>
    </section>
  );
};
