import React, {useEffect, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
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

  const create = async () => {
    if (!slug.trim()) return s.toast('slug を入力', 'error');
    setBusy(true);
    try {
      const r = await api.post<{slug: string; jobId?: string; lines?: string[]}>('/api/projects', {
        slug: slug.trim(),
        persona,
        shopName: shop,
        from: from || undefined,
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
            <select value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">（まっさらな新規）</option>
              {s.projects.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.slug}
                </option>
              ))}
            </select>
          </label>
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
          構成（cuts）・ナレーション・キャプションは版ごとに作るので引き継ぎません。Materials のカタログ実行は不要で、Brief から始められます。
        </p>
      </section>
      <section className="card" data-tour="project-list">
        <h2>案件一覧（work/*-reel）</h2>
        <p className="hint">1 行＝動画 1 本。「開く」を押すと全タブがその案件に切り替わります。catalog / brief / cuts の ✓ が、どこまで進んでいるかの目印です。</p>
        <table className="table">
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
            {s.projects.map((p) => (
              <tr key={p.slug} className={p.slug === s.active ? 'active' : ''}>
                <td>
                  <b>{p.slug}</b>
                </td>
                <td>{p.persona ?? '-'}</td>
                <td>{p.format ?? '-'}</td>
                <td>{p.has.catalog ? '✓' : ''}</td>
                <td>{p.has.brief ? '✓' : ''}</td>
                <td>{p.has.cuts ? '✓' : ''}</td>
                <td>{p.has.narration ? '✓' : ''}</td>
                <td>
                  {p.engine.stale ? (
                    <button className="small warn" onClick={() => s.addJob('sync-engine', {}, p.slug)} title={p.engine.files.filter((f) => f.status !== 'ok').map((f) => `${f.file}: ${f.status}`).join('\n')}>
                      STALE → 同期
                    </button>
                  ) : (
                    'ok'
                  )}
                </td>
                <td>{p.nodeModules ? '✓' : <button className="small" onClick={() => s.addJob('npm-install', {}, p.slug)}>npm install</button>}</td>
                <td>{localDateTime(p.updatedAt)}</td>
                <td>
                  <button className="small primary" onClick={() => s.setActive(p.slug)} disabled={p.slug === s.active}>
                    {p.slug === s.active ? '開いている' : '開く'}
                  </button>{' '}
                  {/* 案件はタブごとに独立している。別案件を並行して進めたいときはこちら */}
                  <a className="small btn-like" href={`/?p=${encodeURIComponent(p.slug)}`} target="_blank" rel="noreferrer" title="この案件を新しいタブで開く（いまのタブはそのまま）">
                    別タブで開く
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
};
