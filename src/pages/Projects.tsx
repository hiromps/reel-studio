import React, {useEffect, useMemo, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import {useStringPref} from '../hooks/usePref';
import {archivedCount as countArchived, visibleProjects} from '../components/projectList';
import {localDateTime} from '@shared/time';

export const ProjectsPage: React.FC = () => {
  const s = useStudio();
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

  return (
    <div className="page">
      <section className="card" data-tour="new-project">
        <h2>新規案件</h2>
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
                    <button className="small warn" onClick={() => s.addJob('sync-engine', {}, p.slug)} title={p.engine.files.filter((f) => f.status !== 'ok').map((f) => `${f.file}: ${f.status}`).join('\n')}>
                      STALE → 同期
                    </button>
                  ) : (
                    'ok'
                  )}
                </td>
                <td className="p-chip" data-label="node_modules">
                  {p.nodeModules ? '✓' : <button className="small" onClick={() => s.addJob('npm-install', {}, p.slug)}>npm install</button>}
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
