// Materials：素材カタログの閲覧・タグ編集・フック／NG／区間の指定（保存先は catalog.json）。
// 並べる作業（cuts.json）は Timeline 画面の編集エディタで行う。
import React, {useMemo, useRef, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import {EmptyState} from '../components/EmptyState';
import {AiJobStatus} from '../components/AiJobStatus';
import {AiModelSelect, useAiModel} from '../hooks/useAiModel';
import {usageBySrc} from '../components/track';
import {TriageMode} from '../components/TriageMode';
import {MosaicCard, MosaicClipSection, mediaVersion, useMosaicForm} from '../components/MosaicPanel';
import {UploadMaterials} from '../components/UploadMaterials';
import {localDate} from '@shared/time';
import type {Catalog, Clip, ClipKind, ClipTags} from '@shared/schema';
import {KIND_LABEL} from '../editor/labels';

const KINDS: ClipKind[] = ['exterior', 'signage', 'interior', 'menu', 'cooking', 'serving', 'eating', 'sizzle', 'person', 'conversation', 'detail', 'other'];

const defaultTags = (clip: Clip): ClipTags => ({
  kind: 'other',
  signage: false,
  signageSize: 'none',
  angle: 'mid',
  motion: 'handheld',
  sizzleScore: 3,
  quality: 3,
  hasSpeech: false,
  subject: '',
  description: clip.slug,
  source: 'user',
  taggedAt: new Date().toISOString(),
});

type Filter = 'all' | 'untagged' | 'hook' | 'ng' | 'unused' | 'mosaic';

export const MaterialsPage: React.FC<{onTab: (t: 'projects' | 'brief' | 'timeline' | 'settings') => void}> = ({onTab}) => {
  const s = useStudio();
  const catalog = s.files.catalog.data;
  const cuts = s.files.cuts.data;
  const [selected, setSelected] = useState<string | null>(null);
  const [materialsDir, setMaterialsDir] = useState('');
  /** クラウド版で、スマホから上げた動画を置く uploads 配下のフォルダ名 */
  const [uploadFolder, setUploadFolder] = useState('');
  const [picking, setPicking] = useState(false);
  const [slugDraft, setSlugDraft] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [triageIds, setTriageIds] = useState<string[] | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const clip = useMemo(() => catalog?.clips.find((c) => c.id === selected) ?? null, [catalog, selected]);
  const untagged = catalog?.clips.filter((c) => !c.tags && !c.user.ng).length ?? 0;
  const [aiModel, setAiModel] = useAiModel();
  const [mosaicForm, setMosaicForm] = useMosaicForm();
  const aiJob = s.jobs.find((j) => (j.status === 'running' || j.status === 'queued') && j.type === 'ai-tag' && j.slug === s.active);
  const aiBusy = s.jobs.some((j) => (j.status === 'running' || j.status === 'queued') && j.type.startsWith('ai-') && j.slug === s.active);
  const staleTag = !s.supportsJob('ai-tag');
  const RESTART_HINT = 'Reel Studio を再起動してください（画面だけ新しく、サーバーが古いプロセスです）';

  const setCatalog = (next: Catalog) => s.setFile('catalog', next);
  const updateClip = (id: string, patch: (c: Clip) => Clip) => {
    if (!catalog) return;
    setCatalog({...catalog, clips: catalog.clips.map((c) => (c.id === id ? patch(c) : c))});
  };
  const setTags = (id: string, patch: Partial<ClipTags>) =>
    updateClip(id, (c) => ({...c, tags: {...(c.tags ?? defaultTags(c)), ...patch, source: 'user', taggedAt: new Date().toISOString()}}));
  const setUser = (id: string, patch: Partial<Clip['user']>) => updateClip(id, (c) => ({...c, user: {...c.user, ...patch}}));

  // alias コピーは元の src に寄せて数える
  const aliasMap = useMemo(() => new Map((cuts?.meta?.aliases ?? []).map((a) => [a.to, a.from])), [cuts]);
  const usage = useMemo(() => usageBySrc(cuts, (src) => aliasMap.get(src) ?? src), [cuts, aliasMap]);

  // 入力が空なら既存 catalog の素材フォルダを使う
  const effectiveDir = (materialsDir.trim() || catalog?.materialsDir || '').replace(/[\\/]+$/, '');
  const uploadsRoot = (s.config?.uploadsRoot ?? '').replace(/[\\/]+$/, '');
  const sep = (uploadsRoot || effectiveDir).includes('\\') ? '\\' : '/';
  const folderName = effectiveDir ? effectiveDir.split(/[\\/]/).filter(Boolean).pop() ?? '' : '';
  // 末尾の区切り文字は落とす（付けたままだと rtl 表示で先頭に回り込む）
  const parentDir = effectiveDir ? effectiveDir.slice(0, effectiveDir.length - folderName.length).replace(/[\\/]+$/, '') : '';

  const runCatalog = async () => {
    if (!effectiveDir) return s.toast('素材フォルダを指定してください', 'error');
    await s.addJob('catalog', {materialsDir: effectiveDir});
  };

  const browse = async () => {
    setPicking(true);
    try {
      const r = await api.post<{path: string | null; cancelled: boolean}>('/api/pick-folder', {initial: effectiveDir || undefined});
      if (r.data.path) setMaterialsDir(r.data.path);
    } catch (e) {
      s.toast(`フォルダを選べませんでした: ${(e as Error).message}`, 'error');
    } finally {
      setPicking(false);
    }
  };

  const applySlug = async () => {
    if (!clip || !s.active) return;
    if (s.files.catalog.dirty) return s.toast('先に catalog.json を保存してください', 'error');
    try {
      await api.post(`/api/projects/${s.active}/catalog/import`, {clips: [{id: clip.id, slug: slugDraft}], source: 'user'});
      await s.loadFile('catalog');
      s.toast(`slug を変更（ファイルもリネーム）`, 'ok');
    } catch (e) {
      s.toast((e as Error).message, 'error');
    }
  };

  const currentTime = () => Math.round((videoRef.current?.currentTime ?? 0) * 100) / 100;

  const shown = useMemo(() => {
    const all = catalog?.clips ?? [];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((c) => {
      if (filter === 'untagged' && (c.tags || c.user.ng)) return false;
      if (filter === 'hook' && !c.user.hook) return false;
      if (filter === 'ng' && !c.user.ng) return false;
      if (filter === 'unused' && ((usage.get(c.src) ?? 0) > 0 || c.user.ng)) return false;
      if (filter === 'mosaic' && !c.mosaic?.applied) return false;
      if (!words.length) return true;
      const hay = [c.id, c.slug, c.original, c.tags?.description ?? '', c.tags?.subject ?? '', c.tags ? KIND_LABEL[c.tags.kind] : '未タグ'].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [catalog, filter, q, usage]);

  // 選別モード用キュー：開いた時点の順序を固定し、中身（タグ・判定）は catalog の最新値を都度引く
  const triageClips = useMemo(() => {
    if (!triageIds || !catalog) return null;
    const byId = new Map(catalog.clips.map((c) => [c.id, c]));
    return triageIds.map((id) => byId.get(id)).filter((c): c is Clip => !!c);
  }, [triageIds, catalog]);

  // 選択中のクリップの前後へ（キーボードで 1 本ずつ確認する用）
  const moveSel = (d: number) => {
    if (!shown.length) return;
    const i = shown.findIndex((c) => c.id === selected);
    const n = shown[Math.max(0, Math.min(shown.length - 1, (i < 0 ? 0 : i) + d))];
    setSelected(n.id);
  };

  if (!s.active)
    return (
      <div className="page">
        <EmptyState
          title="案件が開かれていません"
          steps={['Projects で既存の案件を「開く」', '無ければ「新規案件」で作る']}
          action={{label: 'Projects へ', onClick: () => onTab('projects')}}
        />
      </div>
    );

  return (
    <div className="page">
      <section className="card" data-tour="materials-folder">
        <h2>素材フォルダ</h2>
        <p className="hint">撮った動画が入っているフォルダを選びます。中の動画をすべて読み込み、長さ・解像度を調べて案件フォルダにコピーします（元のフォルダは変更しません）。</p>
        {/* クラウド版：スマホから動画を上げる（PC のフォルダは直接見えないため） */}
        {s.isCloud && <UploadMaterials folder={uploadFolder} onFolder={setUploadFolder} />}
        <div className="row">
          {/* フォルダ選択ダイアログは PC 上でしか開けない */}
          {!s.isCloud && (
            <button onClick={browse} disabled={picking}>
              {picking ? '選択中…' : '📂 参照…（エクスプローラー）'}
            </button>
          )}
          <label>
            uploads 配下から選ぶ
            <select value={uploadsRoot && effectiveDir.startsWith(uploadsRoot) ? folderName : ''} onChange={(e) => e.target.value && setMaterialsDir(`${uploadsRoot}${sep}${e.target.value}`)}>
              <option value="">（選択）</option>
              {s.config?.uploadsFolders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label className="grow">
            パスを直接入力
            <input value={materialsDir} onChange={(e) => setMaterialsDir(e.target.value)} placeholder={catalog?.materialsDir ?? `${uploadsRoot || 'uploads'}${sep}<店名>`} spellCheck={false} />
          </label>
        </div>
        <div className="folder-pick" title={effectiveDir || undefined}>
          {effectiveDir ? (
            <>
              <span className="dim">選択中</span>
              <b className="folder-name">{folderName}</b>
              <span className="folder-parent">{parentDir ? `（${parentDir} の中）` : ''}</span>
            </>
          ) : (
            <span className="dim">素材フォルダが未選択です。「参照…」で選ぶか、パスを入力してください</span>
          )}
        </div>
        <div className="row" style={{marginTop: 8}}>
          <button className="primary" onClick={runCatalog} disabled={!effectiveDir}>
            カタログ実行（probe・コピー・プロキシ・サムネ）
          </button>
          <button onClick={() => s.addJob('thumbs')} disabled={!catalog}>
            サムネ再生成
          </button>
          <button onClick={() => s.addJob('proxy')} disabled={!catalog}>
            HEVC/4K プロキシ生成
          </button>
          <button onClick={() => s.addJob('preview-proxy')} disabled={!catalog} title="540x960 の軽量版。Timeline の「軽量」で使う">
            軽量プレビュー生成
          </button>
          <span style={{flex: 1}} />
          <button onClick={() => s.loadFile('catalog')}>読み直す</button>
          <button className="primary" onClick={() => s.saveFile('catalog')} disabled={!s.files.catalog.dirty}>
            catalog.json を保存
          </button>
          {s.files.catalog.external && (
            <button className="warn" onClick={() => s.saveFile('catalog', true)}>
              外部変更を上書き
            </button>
          )}
        </div>
        {catalog && (
          <p className="hint">
            {catalog.clips.length} 本 / 主力 {catalog.dominantFps}fps / 素材: {catalog.materialsDir}
            {untagged > 0 && (
              <>
                {' '}
                / <b style={{color: 'var(--warn)'}}>未タグ {untagged} 本</b>
              </>
            )}
          </p>
        )}
        {catalog && (
          <div className="row" style={{marginTop: 4}}>
            <button className="primary" onClick={() => s.addJob('ai-tag', {model: aiModel})} disabled={aiBusy || staleTag || untagged === 0} title={staleTag ? RESTART_HINT : '裏で Claude を起動し、サムネイルを 1 枚ずつ見て kind / 画角 / 被写体などを書き込みます'}>
              {aiBusy ? 'AI が作業中…' : `AI にタグ付けしてもらう（未タグ ${untagged} 本）`}
            </button>
            <button onClick={() => s.addJob('ai-tag', {model: aiModel, force: true})} disabled={aiBusy || staleTag} title={staleTag ? RESTART_HINT : 'タグ済みも含めて全部付け直す（lock・NG のクリップは除く）'}>
              全部付け直す
            </button>
            <AiModelSelect value={aiModel} onChange={setAiModel} />
            <span className="hint">API 課金が発生します。実測で 3 本 / sonnet が約 $0.33 でした。手で付けたい場合は下のフォームからどうぞ</span>
          </div>
        )}
        {aiJob && <AiJobStatus job={aiJob} onCancel={(id) => void s.cancelJob(id)} compact />}
      </section>

      {!catalog && (
        <EmptyState
          title="まだ素材を読み込んでいません"
          steps={['上の「📂 参照…」でフォルダを選ぶ（または uploads 配下から選択）', '「カタログ実行」を押す（動画の本数によっては数分かかります）', '読み込めたら 1 本ずつタグを付ける（Claude に頼めます）']}
          hint="タグ＝「何が映っているか」の記録です。これを元に Brief でカット構成が自動で組まれ、台本からの組み立てや Timeline の素材ビンでも使われます。"
        />
      )}

      {catalog && <MosaicCard clips={catalog.clips} shown={shown} form={mosaicForm} setForm={setMosaicForm} onSettings={() => onTab('settings')} />}

      {catalog && (
        <div className="materials">
          <section className="card">
            <div className="row" style={{alignItems: 'center'}}>
              <h2 style={{margin: 0}}>クリップ（{shown.length === catalog.clips.length ? catalog.clips.length : `${shown.length} / ${catalog.clips.length}`}）</h2>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="検索（id・内容・種別）" spellCheck={false} style={{width: 180}} />
              <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
                <option value="all">すべて</option>
                <option value="untagged">未タグ</option>
                <option value="hook">★フック候補</option>
                <option value="unused">タイムライン未使用</option>
                <option value="ng">NG</option>
                <option value="mosaic">顔モザイク済み</option>
              </select>
              <span style={{flex: 1}} />
              <button className="small" onClick={() => setTriageIds(shown.map((c) => c.id))} disabled={!shown.length} title="今の絞り込み結果を 1 本ずつ大きく見て、必要／不要をすばやく判定します">
                🔍 選別モードで判定 →
              </button>
              <button className="small primary" onClick={() => onTab('timeline')} title="素材を並べて尺・テロップ・ナレーションを整える">
                Timeline で並べる →
              </button>
            </div>
            <p className="hint">クリックすると右側で編集できます（← → で前後のクリップ）。★＝つかみに使いたい画、NG＝使わない画。並べるのは Timeline 画面の素材ビンから。</p>
            <div
              className="clip-grid"
              data-tour="clip-grid"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') (e.preventDefault(), moveSel(-1));
                if (e.key === 'ArrowRight') (e.preventDefault(), moveSel(1));
              }}
            >
              {shown.map((c) => {
                const used = usage.get(c.src) ?? 0;
                return (
                  <div key={c.id} className={`clip-card${c.id === selected ? ' selected' : ''}${c.user.ng ? ' ng' : ''}`} onClick={() => setSelected(c.id)}>
                    {c.thumbs.sheet && s.mediaBase ? <img src={`${s.mediaBase}/studio/${c.thumbs.sheet}${mediaVersion(c)}`} alt={c.slug} loading="lazy" draggable={false} /> : <div style={{height: 90}} />}
                    <div className="meta">
                      <span>
                        <b>{c.id}</b> {c.probe.durationSec.toFixed(1)}s
                      </span>
                      <span>{c.probe.codec === 'hevc' ? 'HEVC' : ''}</span>
                    </div>
                    <div className="desc">{c.tags?.description ?? c.slug}</div>
                    <div className="badges">
                      {c.user.hook && <span className="badge hook">★hook</span>}
                      {c.user.ng && <span className="badge ng">NG</span>}
                      {c.tags?.signage && <span className="badge sign">看板</span>}
                      {c.tags ? (
                        <span className="badge">
                          {KIND_LABEL[c.tags.kind]}/{c.tags.angle}
                        </span>
                      ) : (
                        <span className="badge untagged">未タグ</span>
                      )}
                      {c.user.lock && <span className="badge">lock</span>}
                      {c.mosaic?.applied && <span className="badge mosaic">モザイク</span>}
                      {c.mosaic && !c.mosaic.applied && <span className="badge">顔なし</span>}
                      {used > 0 && <span className="badge used">使用中{used > 1 ? ` ×${used}` : ''}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="card detail">
            {!clip ? (
              <p className="hint">クリップを選択</p>
            ) : (
              <>
                <h2>
                  {clip.id} {clip.original} → {clip.src.replace('uploads/', '')}
                </h2>
                <video ref={videoRef} src={`${s.mediaBase}/${clip.src}${mediaVersion(clip)}`} controls preload="metadata" />
                <div className="strip">
                  {clip.thumbs.strip.map((p, i) => (
                    <img
                      key={p}
                      src={`${s.mediaBase}/studio/${p}${mediaVersion(clip)}`}
                      alt=""
                      title={`${i}s`}
                      onClick={() => {
                        if (videoRef.current) videoRef.current.currentTime = clip.probe.durationSec < 3 ? i * 0.5 : i;
                      }}
                    />
                  ))}
                </div>
                <div className="hint">
                  {clip.probe.codec} {clip.probe.width}x{clip.probe.height}
                  {clip.probe.rotation ? ` rot${clip.probe.rotation}` : ''} {clip.probe.fps}fps {clip.probe.durationSec}s {clip.probe.hasAudio ? '音声あり' : '無音'}
                  {(usage.get(clip.src) ?? 0) > 0 ? ` / タイムラインで ${usage.get(clip.src)} 回使用中` : ''}
                </div>

                <h3>ユーザー判断</h3>
                <div className="row">
                  <label>
                    <span>★ フック候補</span>
                    <input type="checkbox" checked={clip.user.hook} onChange={(e) => setUser(clip.id, {hook: e.target.checked})} />
                  </label>
                  <label>
                    <span>NG（使わない）</span>
                    <input type="checkbox" checked={clip.user.ng} onChange={(e) => setUser(clip.id, {ng: e.target.checked})} />
                  </label>
                  <label>
                    <span>lock（Claude が上書きしない）</span>
                    <input type="checkbox" checked={clip.user.lock} onChange={(e) => setUser(clip.id, {lock: e.target.checked})} />
                  </label>
                  <label>
                    並び順ヒント
                    <input type="number" value={clip.user.orderHint ?? ''} onChange={(e) => setUser(clip.id, {orderHint: e.target.value === '' ? null : Number(e.target.value)})} />
                  </label>
                  <label style={{flex: 1}}>
                    メモ
                    <input value={clip.user.note ?? ''} onChange={(e) => setUser(clip.id, {note: e.target.value})} />
                  </label>
                </div>

                <MosaicClipSection
                  clip={clip}
                  form={mosaicForm}
                  onSeek={(sec) => {
                    if (!videoRef.current) return;
                    videoRef.current.currentTime = sec;
                    void videoRef.current.play().catch(() => {});
                  }}
                />

                <h3>
                  タグ{' '}
                  {clip.tags ? (
                    <span className="hint">
                      （{clip.tags.source} / {localDate(clip.tags.taggedAt)}）
                    </span>
                  ) : (
                    <button className="small" onClick={() => setTags(clip.id, {})}>
                      タグを付ける
                    </button>
                  )}
                </h3>
                {clip.tags && (
                  <div className="form">
                    <label>
                      種別
                      <select value={clip.tags.kind} onChange={(e) => setTags(clip.id, {kind: e.target.value as ClipKind, signage: e.target.value === 'signage' ? true : clip.tags!.signage})}>
                        {KINDS.map((k) => (
                          <option key={k} value={k}>
                            {k}（{KIND_LABEL[k]}）
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      画角
                      <select value={clip.tags.angle} onChange={(e) => setTags(clip.id, {angle: e.target.value as ClipTags['angle']})}>
                        <option value="wide">wide（引き）</option>
                        <option value="mid">mid</option>
                        <option value="close">close（寄り）</option>
                      </select>
                    </label>
                    <label>
                      <span>店名・ロゴ・看板が読める（F7 で終盤に温存）</span>
                      <input type="checkbox" checked={clip.tags.signage} onChange={(e) => setTags(clip.id, {signage: e.target.checked, signageSize: e.target.checked ? (clip.tags!.signageSize === 'none' ? 'small' : clip.tags!.signageSize) : 'none'})} />
                    </label>
                    <label>
                      看板の大きさ
                      <select value={clip.tags.signageSize} onChange={(e) => setTags(clip.id, {signageSize: e.target.value as ClipTags['signageSize']})}>
                        <option value="none">none</option>
                        <option value="small">small</option>
                        <option value="large">large</option>
                      </select>
                    </label>
                    <label>
                      シズル度 1-5
                      <input type="number" min={1} max={5} value={clip.tags.sizzleScore} onChange={(e) => setTags(clip.id, {sizzleScore: Number(e.target.value)})} />
                    </label>
                    <label>
                      画質 1-5
                      <input type="number" min={1} max={5} value={clip.tags.quality} onChange={(e) => setTags(clip.id, {quality: Number(e.target.value)})} />
                    </label>
                    <label>
                      動き
                      <select value={clip.tags.motion} onChange={(e) => setTags(clip.id, {motion: e.target.value as ClipTags['motion']})}>
                        <option value="static">static</option>
                        <option value="pan">pan</option>
                        <option value="handheld">handheld</option>
                        <option value="action">action</option>
                      </select>
                    </label>
                    <label>
                      <span>会話・語りがある（保護クリップ）</span>
                      <input type="checkbox" checked={clip.tags.hasSpeech} onChange={(e) => setTags(clip.id, {hasSpeech: e.target.checked})} />
                    </label>
                    <label>
                      被写体
                      <input value={clip.tags.subject} onChange={(e) => setTags(clip.id, {subject: e.target.value})} />
                    </label>
                    <label className="full">
                      内容（カタログの「内容」列）
                      <input value={clip.tags.description} onChange={(e) => setTags(clip.id, {description: e.target.value})} />
                    </label>
                  </div>
                )}

                <h3>使える区間（usableRanges）</h3>
                <div className="ranges">
                  {clip.usableRanges.map((r, i) => (
                    <div className="range" key={i}>
                      <input type="number" step={0.05} value={r.inSec} onChange={(e) => updateClip(clip.id, (c) => ({...c, usableRanges: c.usableRanges.map((x, k) => (k === i ? {...x, inSec: Number(e.target.value)} : x))}))} />
                      <button className="small" onClick={() => updateClip(clip.id, (c) => ({...c, usableRanges: c.usableRanges.map((x, k) => (k === i ? {...x, inSec: currentTime()} : x))}))}>
                        IN=再生位置
                      </button>
                      <input type="number" step={0.05} value={r.outSec} onChange={(e) => updateClip(clip.id, (c) => ({...c, usableRanges: c.usableRanges.map((x, k) => (k === i ? {...x, outSec: Number(e.target.value)} : x))}))} />
                      <button className="small" onClick={() => updateClip(clip.id, (c) => ({...c, usableRanges: c.usableRanges.map((x, k) => (k === i ? {...x, outSec: currentTime()} : x))}))}>
                        OUT=再生位置
                      </button>
                      <select value={r.label} onChange={(e) => updateClip(clip.id, (c) => ({...c, usableRanges: c.usableRanges.map((x, k) => (k === i ? {...x, label: e.target.value as typeof x.label} : x))}))}>
                        <option value="best">best（見せ場）</option>
                        <option value="ok">ok</option>
                        <option value="motion-full">motion-full（一連動作）</option>
                        <option value="avoid">avoid（使わない）</option>
                      </select>
                      <input placeholder="メモ" value={r.note ?? ''} onChange={(e) => updateClip(clip.id, (c) => ({...c, usableRanges: c.usableRanges.map((x, k) => (k === i ? {...x, note: e.target.value} : x))}))} />
                      <button className="small danger" onClick={() => updateClip(clip.id, (c) => ({...c, usableRanges: c.usableRanges.filter((_, k) => k !== i)}))}>
                        ×
                      </button>
                    </div>
                  ))}
                  <button className="small" onClick={() => updateClip(clip.id, (c) => ({...c, usableRanges: [...c.usableRanges, {inSec: currentTime(), outSec: Math.min(c.probe.durationSec, currentTime() + 1.5), label: 'best'}]}))}>
                    + 区間を追加（再生位置から 1.5 秒）
                  </button>
                  <div className="hint">無指定なら全尺（2.5 秒以上のクリップは頭尾 0.2 秒を避ける）から使う。best を付けておくと Timeline に落としたときその区間が採用される</div>
                </div>

                <h3>ファイル名（slug）</h3>
                <div className="row">
                  <input value={slugDraft || clip.slug} onChange={(e) => setSlugDraft(e.target.value)} placeholder={clip.slug} />
                  <button className="small" onClick={applySlug} disabled={!slugDraft || slugDraft === clip.slug}>
                    リネームして適用
                  </button>
                  <span className="hint">英数字・ハイフン。public/uploads のファイルも一緒にリネームされる（catalog 保存後に実行）</span>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {triageClips && <TriageMode clips={triageClips} mediaBase={s.mediaBase} onDecide={(id, patch) => setUser(id, patch)} onClose={() => setTriageIds(null)} />}
    </div>
  );
};
