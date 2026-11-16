import React, {useEffect, useMemo, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import {useStringPref} from '../hooks/usePref';
import {archivedCount as countArchived, MATERIALS_PARENT_PREF, visibleProjects} from '../components/projectList';
import {localDateTime} from '@shared/time';
import {termHint} from '../components/RenderTerms';
import {readPref, writePref} from '../hooks/usePref';
import {parentDirOf, slugBaseFromFolder, slugTaken, suggestSlug, type FolderInspection} from '@shared/project-from-folder';

/** フォルダを選んでから「作成」を押すまでの下書き */
type FolderDraft = {
  info: FolderInspection;
  shop: string;
  /** 手で直した案件名。null の間は自動の候補を使う（人格を変えたら候補も変わる） */
  slug: string | null;
  /** 同じ素材の案件がある場合に、その案件から別バージョンを作るか（空＝新しく読み込む） */
  from: string;
};

// engine 列の「STALE → 同期」にマウスを乗せたときの説明（core/project.ts の engineDiff / syncEngine の動き）
const ENGINE_HINT =
  'STALE は「古くなった」の意味。案件フォルダの中にある描画プログラム（エンジン）が、Reel Studio 本体の最新版と違っています。押すと本体の最新版で上書きします（違っていたファイルは .studio/backups/ に控えを取ります。素材・並び・ナレーションには触れません）。レンダーの前にも自動で同じことが行われるので、押さなくても困りません';

export const ProjectsPage: React.FC<{onTab: (t: 'materials' | 'brief') => void}> = ({onTab}) => {
  const s = useStudio();
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<FolderDraft | null>(null);
  const [slug, setSlug] = useState('');
  const [persona, setPersona] = useState('');
  // 人格の一覧はサーバーから来る。届いたら先頭を既定にする
  useEffect(() => {
    if (!s.personas.some((p) => p.id === persona) && s.personas[0]) setPersona(s.personas[0].id);
  }, [s.personas, persona]);
  const [shop, setShop] = useState('');
  const [busy, setBusy] = useState(false);
  // 「同じ素材で別バージョン」を作るとき、元になる案件（空＝まっさらな新規）
  const [from, setFrom] = useState('');
  // 台本（cuts.json・narration.json）もそのまま引き継ぐか（既定は版ごとに作る）
  const [carryTimeline, setCarryTimeline] = useState(false);
  // 投稿し終えて隠した案件も一覧に出すか（このブラウザの表示設定）
  const [showArchivedPref, setShowArchivedPref] = useStringPref('reel-studio.showArchived', '0');
  const showArchived = showArchivedPref === '1';
  const archivedCount = countArchived(s.projects);
  const rows = useMemo(() => visibleProjects(s.projects, {active: s.active, showArchived}), [s.projects, s.active, showArchived]);

  const create = async () => {
    if (!slug.trim()) return s.toast('slug を入力', 'error');
    setBusy(true);
    try {
      const r = await api.post<{slug: string; jobId?: string; lines?: string[]}>('/api/projects', {
        slug: slug.trim(),
        persona,
        shopName: shop,
        from: from || undefined,
        carryTimeline: from ? carryTimeline : undefined,
      });
      s.toast(`作成: ${r.data.slug}${r.data.jobId ? '（npm install 実行中）' : ''}`, 'ok');
      for (const l of r.data.lines ?? []) s.toast(l, l.startsWith('  !') ? 'error' : 'info');
      await s.refreshProjects();
      await s.setActive(r.data.slug);
      setSlug('');
    } catch (e) {
      s.toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  // ── 素材フォルダから案件を作る ─────────────────────────────
  const existingSlugs = useMemo(() => s.projects.map((p) => p.slug), [s.projects]);
  const autoSlug = draft ? suggestSlug(slugBaseFromFolder(draft.info.folderName), persona, existingSlugs) : '';
  const draftSlug = draft ? (draft.slug ?? autoSlug) : '';
  const draftTaken = !!draft && slugTaken(draftSlug, existingSlugs);
  const draftBlocked = !draft ? '' : !draftSlug.trim() ? '案件名を入力してください' : draftTaken ? '同じ名前の案件が既にあります' : !draft.from && draft.info.videoCount === 0 ? 'このフォルダの直下に動画がありません' : '';

  const pickFolder = async () => {
    setPicking(true);
    try {
      const picked = await api.post<{path: string | null; cancelled: boolean}>('/api/pick-folder', {initial: readPref(MATERIALS_PARENT_PREF, '', (r) => r) || undefined});
      if (!picked.data.path) return;
      const info = (await api.post<FolderInspection>('/api/materials-folders/inspect', {dir: picked.data.path})).data;
      writePref(MATERIALS_PARENT_PREF, parentDirOf(info.dir));
      // 同じ素材の案件があれば、既定は「そこから別バージョン」（素材の二重コピーとタグの付け直しを避ける）
      setDraft({info, shop: info.folderName, slug: null, from: info.sameMaterials[0] ?? ''});
    } catch (e) {
      s.toast(`フォルダを選べませんでした: ${(e as Error).message}`, 'error');
    } finally {
      setPicking(false);
    }
  };

  const createFromFolder = async () => {
    if (!draft || draftBlocked) return;
    setBusy(true);
    try {
      // npm install はここでは積ませない（下で素材の読み込みを先に積んでから積む。同じ案件のジョブは順番に走るので、
      // 先に積まれると数分かかる install が終わるまで読み込みが始まらない）
      const r = await api.post<{slug: string; nodeModules?: boolean; lines?: string[]}>('/api/projects', {slug: draftSlug.trim(), persona, shopName: draft.shop.trim(), from: draft.from || undefined, install: false});
      for (const l of r.data.lines ?? []) s.toast(l, l.startsWith('  !') ? 'error' : 'info');
      await s.refreshProjects();
      await s.setActive(r.data.slug);
      if (draft.from) {
        s.toast(`作成: ${r.data.slug}（${draft.from} の素材とタグを引き継ぎました）`, 'ok');
        onTab('brief');
      } else {
        // 素材の読み込みまで続けて始める。進み具合は Materials と画面上部に出る
        await s.addJob('catalog', {materialsDir: draft.info.dir}, r.data.slug, {quiet: true});
        s.toast(`作成: ${r.data.slug}（素材 ${draft.info.videoCount} 本を読み込み中）`, 'ok');
        onTab('materials');
      }
      if (!r.data.nodeModules) await s.addJob('npm-install', {}, r.data.slug, {quiet: true});
      setDraft(null);
    } catch (e) {
      s.toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <section className="card" data-tour="new-project">
        <h2>新規案件</h2>
        {/* フォルダ選択ダイアログは PC 上でしか開けない */}
        {!s.isCloud && (
          <div className="from-folder">
            <div className="row">
              <button className="primary" onClick={pickFolder} disabled={picking || busy}>
                {picking ? '選択中…' : '📂 素材フォルダから案件を作る'}
              </button>
              <span className="hint">撮った動画が入っているフォルダを選ぶと、店名と案件名を入れて案件を作り、素材の読み込みまで始めます。</span>
            </div>
            {draft && (
              <div className="from-folder-confirm">
                <div className="folder-pick" title={draft.info.dir}>
                  <span className="dim">選んだフォルダ</span>
                  <b className="folder-name">{draft.info.folderName}</b>
                  <span className="folder-parent">（{parentDirOf(draft.info.dir)} の中）</span>
                  <span>動画 {draft.info.videoCount} 本</span>
                </div>
                {draft.info.videoCount === 0 && (
                  <p className="hint" style={{color: 'var(--warn)'}}>
                    このフォルダの直下に動画がありません。
                    {draft.info.subfoldersWithVideos.length > 0 && <>動画は中のフォルダ（{draft.info.subfoldersWithVideos.join(' / ')}）に入っています。そのフォルダを選び直してください。</>}
                  </p>
                )}
                {draft.info.sameMaterials.length > 0 && (
                  <label title="同じ素材を読み込んだ案件が既にあります。そこから作ると素材をリンクで共有し（ディスクは増えません）、タグ付けも引き継ぎます">
                    作り方
                    <select value={draft.from} onChange={(e) => setDraft({...draft, from: e.target.value})}>
                      {draft.info.sameMaterials.map((slug) => (
                        <option key={slug} value={slug}>
                          {slug} と同じ素材で別バージョン（素材・タグを引き継ぐ）
                        </option>
                      ))}
                      <option value="">新しく読み込む（素材をコピーしてタグも付け直す）</option>
                    </select>
                  </label>
                )}
                <div className="row">
                  <label>
                    店名 <input value={draft.shop} onChange={(e) => setDraft({...draft, shop: e.target.value})} />
                  </label>
                  <label>
                    案件名（slug）
                    <input value={draftSlug} onChange={(e) => setDraft({...draft, slug: e.target.value})} spellCheck={false} />
                  </label>
                  <label>
                    persona
                    <select value={persona} onChange={(e) => setPersona(e.target.value)}>
                      {s.personas.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                          {p.narration.voiceId ? '' : '（ボイス未設定）'}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="primary" onClick={createFromFolder} disabled={busy || !!draftBlocked} title={draftBlocked || undefined}>
                    {busy ? '作成中…' : draft.from ? '作成（素材を引き継ぐ）' : '作成して素材を読み込む'}
                  </button>
                  <button onClick={() => setDraft(null)} disabled={busy}>
                    やめる
                  </button>
                </div>
                <p className="hint">
                  {/* 動画が無い場合の案内は上に出している（同じ文を 2 回出さない） */}
                  {draftBlocked && (draft.from || draft.info.videoCount > 0) ? <b style={{color: 'var(--warn)'}}>{draftBlocked}。</b> : null}
                  店名・案件名はフォルダ名から入れています。違っていればここで直してください（案件名は work/{draftSlug.trim() || '…'}-reel/ というフォルダになります）。元のフォルダは変更しません。
                </p>
              </div>
            )}
          </div>
        )}
        <h3>手で入力して作る</h3>
        <div className="row">
          <label>
            slug <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="例: cafe-abc" />
          </label>
          <label>
            persona
            <select value={persona} onChange={(e) => setPersona(e.target.value)}>
              {s.personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {/* ボイスが決まっていない人格は、音声生成の段になって初めて気づくのを防ぐ */}
                  {p.narration.voiceId ? '' : '（ボイス未設定）'}
                </option>
              ))}
            </select>
          </label>
          <label>
            店名 <input value={shop} onChange={(e) => setShop(e.target.value)} />
          </label>
          <label title="同じ撮影素材で別バージョン（人格違い／同じ店の別ブランド）を作るとき、元になる案件を選ぶ">
            同じ素材から作る
            {/* 隠した案件も選べる（投稿し終えた案件の第 2 弾を作る、がよくある） */}
            <select value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">（まっさらな新規）</option>
              {s.projects.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.slug}
                  {p.archivedAt ? '（非表示）' : ''}
                </option>
              ))}
            </select>
          </label>
          {from && (
            <label title="cuts.json（構成・トリミング・テロップ）と narration.json（ナレーション原稿）もそのままコピーする。ボイスやフックの一部だけ変えた版を作りたいときに使う。音声ファイルは無いので全ブロック要再生成になる">
              <input type="checkbox" checked={carryTimeline} onChange={(e) => setCarryTimeline(e.target.checked)} />
              台本（cuts・ナレーション原稿）も引き継ぐ
            </label>
          )}
          <button className="primary" onClick={create} disabled={busy}>
            {from ? '同じ素材で作る（素材はリンク共有）' : '作成（テンプレ複製 + brief 雛形 + npm install）'}
          </button>
        </div>
        <p className="hint">
          slug＝案件のフォルダ名（英数字とハイフン）。persona＝誰の声・文体で作るか。作成後は Materials → Brief → Timeline → Render の順に進みます。
        </p>
        <p className="hint">
          <b>「同じ素材から作る」</b>を選ぶと、素材をハードリンクで共有して（ディスクは増えません）
          <b>catalog.json のタグ付けを引き継いだ</b>案件ができます。同じ撮影で hiro 版 / さゆり版を作る、
          同じ店の別ブランド版（例：焼肉たべる版 / 焼肉伍龍版）を作る、といったときに使います。
          構成（cuts）・ナレーション・キャプションは版ごとに作るので引き継ぎません（Materials のカタログ実行は不要で、Brief から始められます）。
          <b>「台本も引き継ぐ」</b>にチェックすると、cuts.json と narration.json をそのままコピーします。同じ構成・同じ原稿でボイスだけ変えたい版や、
          フックの一部だけ書き換えたい版を作りたいときに使います。音声ファイル（narration/）はコピーしないので、作成後は Render で全ブロックの音声を作り直してください。
        </p>
      </section>
      <section className="card" data-tour="project-list">
        <h2>
          案件一覧（work/*-reel）
          {archivedCount > 0 && (
            <label className="list-toggle" title="投稿済みにして隠した案件を一覧に戻して表示します（隠しただけなので中身は残っています）">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchivedPref(e.target.checked ? '1' : '0')} />
              隠した案件も表示（{archivedCount} 件）
            </label>
          )}
        </h2>
        <p className="hint">
          1 行＝動画 1 本。「開く」を押すと全タブがその案件に切り替わります。catalog / brief / cuts の ✓ が、どこまで進んでいるかの目印です。
          投稿し終えて編集が要らなくなった案件は <b>「投稿済み（隠す）」</b>で一覧から外せます（消えません。上のチェックでいつでも戻せます）。
        </p>
        {/* スマホでは 1 案件＝1 枚のカードに積み直す（CSS。data-label が見出しの代わりになる）。
            表のままだと横スクロールの右端に操作列が隠れて、「開く」も「投稿済み（隠す）」も届かない */}
        <table className="table projects">
          <thead>
            <tr>
              <th>slug</th>
              <th>persona</th>
              <th>format</th>
              <th>catalog</th>
              <th>brief</th>
              <th>cuts</th>
              <th>narration</th>
              <th>engine</th>
              <th>node_modules</th>
              <th>更新</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.slug} className={`${p.slug === s.active ? 'active' : ''}${p.archivedAt ? ' archived' : ''}`.trim()}>
                <td className="p-slug">
                  <b>{p.slug}</b>
                  {p.archivedAt && (
                    <>
                      {' '}
                      <span className="pill" title={`${localDateTime(p.archivedAt)} に一覧から隠しました`}>
                        非表示
                      </span>
                    </>
                  )}
                </td>
                <td className="p-chip" data-label="persona">
                  {p.persona ?? '-'}
                </td>
                <td className="p-chip" data-label="format">
                  {p.format ?? '-'}
                </td>
                <td className="p-chip" data-label="catalog">
                  {p.has.catalog ? '✓' : ''}
                </td>
                <td className="p-chip" data-label="brief">
                  {p.has.brief ? '✓' : ''}
                </td>
                <td className="p-chip" data-label="cuts">
                  {p.has.cuts ? '✓' : ''}
                </td>
                <td className="p-chip" data-label="narration">
                  {p.has.narration ? '✓' : ''}
                </td>
                <td className="p-chip" data-label="engine">
                  {p.engine.stale ? (
                    <button className="small warn" onClick={() => s.addJob('sync-engine', {}, p.slug)} title={`${ENGINE_HINT}\n\n本体と違うファイル:\n${p.engine.files
                      .filter((f) => f.status !== 'ok')
                      .map((f) => `${f.file}: ${f.status === 'missing' ? '無い' : '中身が違う'}`)
                      .join('\n')}`}>
                      STALE → 同期
                    </button>
                  ) : (
                    'ok'
                  )}
                </td>
                <td className="p-chip" data-label="node_modules">
                  {p.nodeModules ? '✓' : <button className="small" onClick={() => s.addJob('npm-install', {}, p.slug)} title={termHint('npm install')}>npm install</button>}
                </td>
                <td className="p-chip" data-label="更新">
                  {localDateTime(p.updatedAt)}
                </td>
                <td className="p-act">
                  <button className="small primary" onClick={() => s.setActive(p.slug)} disabled={p.slug === s.active}>
                    {p.slug === s.active ? '開いている' : '開く'}
                  </button>{' '}
                  {/* 案件はタブごとに独立している。別案件を並行して進めたいときはこちら */}
                  <a className="small btn-like" href={`/?p=${encodeURIComponent(p.slug)}`} target="_blank" rel="noreferrer" title="この案件を新しいタブで開く（いまのタブはそのまま）">
                    別タブで開く
                  </a>{' '}
                  {/* 投稿し終えた案件を一覧から外すだけ。フォルダ・素材・書き出しには触らない */}
                  <button
                    className="small"
                    onClick={() => void s.setArchived(p.slug, !p.archivedAt)}
                    title={p.archivedAt ? 'この案件を一覧に戻します' : '投稿し終えて編集が要らなくなった案件を一覧から隠します（案件フォルダ・素材・書き出しは消えません）'}
                  >
                    {p.archivedAt ? '一覧に戻す' : '投稿済み（隠す）'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {/* 全部隠したときに「案件が消えた」と思わせない */}
        {rows.length === 0 && archivedCount > 0 && (
          <p className="hint">
            表示できる案件がありません（{archivedCount} 件すべて隠しています）。上の「隠した案件も表示」にチェックを入れると戻ります。
          </p>
        )}
      </section>
    </div>
  );
};
