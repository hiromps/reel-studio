// Settings：データフォルダ・音声生成（Fish Audio）・AI（Claude Code CLI）・人格。
// 設定の実体は ~/.reel-studio/（settings.json / personas.json）。鍵は画面に戻ってこない（マスクだけ）。
// 案件に依存しない画面なので、案件が無くても開ける。
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {api, type ApiError} from '../api';
import {useStudio} from '../state/store';
import {NotificationsCard} from '../components/NotificationsCard';
import {UpdateCard} from '../components/UpdateCard';
import {DEFAULT_INSTAGRAM_MCP_URL, PATH_KEYS, type InstagramAccount, type MosaicStatus, type PathKey, type SettingsPatch, type SettingsView, type VoiceEntry} from '@shared/schema/settings';
import {PersonaSchema, type Persona} from '@shared/personas';
import {FORMAT_IDS, FORMAT_SPECS} from '@shared/format-specs';
import {ThemeSchema} from '@shared/schema/cuts';
import {AI_MODELS} from '../hooks/useAiModel';
import {AiJobStatus} from '../components/AiJobStatus';
import {useMosaicStatus} from '../components/MosaicPanel';

type Voice = {id: string; title: string; source: 'own' | 'persona' | 'extra'; personas: string[]; state?: string};
type TestResult = {ok: boolean; message: string; version?: string | null; bin?: string};
type Save = (patch: SettingsPatch, done: string) => Promise<boolean>;

const SUB_KEYS = ['workDir', 'uploadsRoot', 'outputsDir', 'sfxDir'] as const;
type SubKey = (typeof SUB_KEYS)[number];
const PATH_LABEL: Record<PathKey, string> = {dataRoot: 'データフォルダ（親）', workDir: '案件（work）', uploadsRoot: '生素材（uploads）', outputsDir: '納品（outputs）', sfxDir: '効果音（sfx）'};
const SOURCE_LABEL = {env: '環境変数', settings: '設定', default: '既定'} as const;
const FISH_MODELS = ['s2.1-pro-free', 's2.1-pro', 's2-pro', 's1'];
const ID_RE = /^[a-z][a-z0-9-]{0,30}$/;

const msg = (e: unknown): string => (e as ApiError)?.message ?? String(e);
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export const SettingsPage: React.FC = () => {
  const s = useStudio();
  const [view, setView] = useState<SettingsView | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<SettingsView>('/api/settings');
      setView(r.data);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(msg(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback<Save>(
    async (patch, done) => {
      try {
        const r = await api.put<SettingsView>('/api/settings', patch);
        setView(r.data);
        s.toast(done, 'ok');
        await s.reloadConfig();
        await s.refreshProjects();
        return true;
      } catch (e) {
        s.toast(msg(e), 'error');
        return false;
      }
    },
    [s],
  );

  if (loadErr)
    return (
      <div className="page">
        <section className="card">
          <h2>Settings</h2>
          <p className="warn-text">設定を読めません: {loadErr}（サーバーが古いプロセスかもしれません。Reel Studio を再起動してください）</p>
          <button onClick={() => void load()}>再試行</button>
        </section>
      </div>
    );
  if (!view)
    return (
      <div className="page">
        <section className="card">
          <p className="hint">読み込み中…</p>
        </section>
      </div>
    );

  return (
    <div className="page" data-tour="settings">
      {(view.problem || s.config?.personasProblem) && (
        <section className="card">
          {view.problem && <p className="warn-text">{view.problem}</p>}
          {s.config?.personasProblem && <p className="warn-text">{s.config.personasProblem}</p>}
        </section>
      )}
      <FoldersCard view={view} save={save} />
      <TtsCard view={view} save={save} />
      <AgentCard view={view} save={save} />
      <InstagramCard view={view} save={save} />
      <FontsCard view={view} save={save} reload={load} />
      <MosaicSettingsCard view={view} save={save} />
      <CloudCard view={view} save={save} />
      <NotificationsCard />
      <PersonasCard />
      <UpdateCard />
      <p className="hint">
        設定ファイル: <span className="mono">{view.file}</span>
        {view.exists ? '' : '（まだ無い。何か保存すると作られます）'}／人格: <span className="mono">{view.dir.replace(/\\/g, '/')}/personas.json</span>
        。鍵は平文で保存されます（Windows ではユーザープロファイルのアクセス権だけで守られます）。置き場は環境変数 REEL_STUDIO_HOME で変えられます
      </p>
    </div>
  );
};

// ───────────────────────── データフォルダ ─────────────────────────

const FoldersCard: React.FC<{view: SettingsView; save: Save}> = ({view, save}) => {
  const s = useStudio();
  const fromView = useCallback(() => ({dataRoot: view.settings.dataRoot ?? '', paths: Object.fromEntries(SUB_KEYS.map((k) => [k, view.settings.paths[k] ?? ''])) as Record<SubKey, string>}), [view]);
  const [form, setForm] = useState(fromView);
  useEffect(() => setForm(fromView()), [fromView]);
  const [picking, setPicking] = useState(false);

  const pick = async (initial: string, apply: (p: string) => void) => {
    setPicking(true);
    try {
      const r = await api.post<{path: string | null; cancelled: boolean}>('/api/pick-folder', {initial: initial || undefined});
      if (r.data.path) apply(r.data.path);
    } catch (e) {
      s.toast(msg(e), 'error');
    } finally {
      setPicking(false);
    }
  };

  const base = fromView();
  const dirty = form.dataRoot !== base.dataRoot || SUB_KEYS.some((k) => form.paths[k] !== base.paths[k]);
  const submit = () =>
    save({dataRoot: form.dataRoot.trim(), paths: Object.fromEntries(SUB_KEYS.map((k) => [k, form.paths[k].trim()])) as Record<SubKey, string>}, 'フォルダ設定を保存しました');
  const envLocked = (k: PathKey) => view.paths[k].source === 'env';

  return (
    <section className="card" data-tour="settings-folders">
      <h2>データフォルダ</h2>
      <p className="hint">
        案件（work/）・生素材（uploads/）・納品（outputs/）・効果音（sfx/）を置く場所。空欄なら「既定」の場所（アプリ内の data/）を使います。個別に別の場所を使うときは絶対パスか、データフォルダからの相対パスを入れます。
      </p>
      <div className="form">
        <label className="full">
          {PATH_LABEL.dataRoot}
          <span className="btns">
            <input
              value={form.dataRoot}
              onChange={(e) => setForm({...form, dataRoot: e.target.value})}
              placeholder={view.paths.dataRoot.source === 'default' ? `既定: ${view.paths.dataRoot.value}` : ''}
              disabled={envLocked('dataRoot')}
              style={{flex: 1, minWidth: 320}}
            />
            <button className="small" onClick={() => void pick(form.dataRoot || view.paths.dataRoot.value, (p) => setForm({...form, dataRoot: p}))} disabled={picking || envLocked('dataRoot')}>
              フォルダを選ぶ
            </button>
            <button className="small" onClick={() => setForm({...form, dataRoot: ''})} disabled={!form.dataRoot || envLocked('dataRoot')}>
              既定に戻す
            </button>
          </span>
        </label>
        {SUB_KEYS.map((k) => (
          <label key={k} className="full">
            {PATH_LABEL[k]}
            <span className="btns">
              <input
                value={form.paths[k]}
                onChange={(e) => setForm({...form, paths: {...form.paths, [k]: e.target.value}})}
                placeholder={`既定: データフォルダ内の ${k === 'workDir' ? 'work' : k === 'uploadsRoot' ? 'uploads' : k === 'outputsDir' ? 'outputs' : 'sfx'}/`}
                disabled={envLocked(k)}
                style={{flex: 1, minWidth: 320}}
              />
              <button className="small" onClick={() => void pick(form.paths[k] || view.paths[k].value, (p) => setForm({...form, paths: {...form.paths, [k]: p}}))} disabled={picking || envLocked(k)}>
                選ぶ
              </button>
            </span>
          </label>
        ))}
      </div>
      <table className="table" style={{marginTop: 8}}>
        <thead>
          <tr>
            <th>項目</th>
            <th>いまの場所</th>
            <th>出典</th>
            <th>存在</th>
          </tr>
        </thead>
        <tbody>
          {PATH_KEYS.map((k) => (
            <tr key={k}>
              <td>{PATH_LABEL[k]}</td>
              <td className="mono">{view.paths[k].value}</td>
              <td>
                <span className={`pill${view.paths[k].source === 'env' ? ' warn' : ''}`}>{SOURCE_LABEL[view.paths[k].source]}</span>
              </td>
              <td>{view.paths[k].exists ? <span className="pill">あり</span> : <span className="pill warn">まだ無い（使うときに作られます）</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <span className="hint">環境変数（REEL_STUDIO_DATA_ROOT など）で指定された項目はここでは変えられません。ジョブの実行中は保存できません</span>
        <span style={{flex: 1}} />
        <button className="primary" onClick={() => void submit()} disabled={!dirty}>
          フォルダ設定を保存
        </button>
      </div>
    </section>
  );
};

// ───────────────────────── 音声生成 ─────────────────────────

const TtsCard: React.FC<{view: SettingsView; save: Save}> = ({view, save}) => {
  const key = view.settings.tts.apiKey;
  const [typed, setTyped] = useState('');
  const [modelId, setModelId] = useState(view.settings.tts.modelId);
  const [voices, setVoices] = useState<VoiceEntry[]>(view.settings.tts.voices);
  useEffect(() => {
    setTyped('');
    setModelId(view.settings.tts.modelId);
    setVoices(view.settings.tts.voices);
  }, [view]);
  const [test, setTest] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [list, setList] = useState<Voice[] | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);

  const dirty = typed.trim() !== '' || modelId !== view.settings.tts.modelId || JSON.stringify(voices) !== JSON.stringify(view.settings.tts.voices);
  const voicesValid = voices.every((v) => /^[0-9a-f]{32}$/.test(v.id.trim()) && v.title.trim());

  const submit = async () => {
    const ok = await save(
      {
        tts: {
          apiKey: typed.trim() || undefined,
          modelId: modelId.trim(),
          voices: voices.map((v) => ({id: v.id.trim(), title: v.title.trim(), ...(v.note?.trim() ? {note: v.note.trim()} : {})})),
        },
      },
      '音声生成の設定を保存しました',
    );
    if (ok) setTyped('');
  };
  const clearKey = () => void save({tts: {apiKey: ''}}, 'API キーを消しました');
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const r = await api.post<TestResult>('/api/settings/test/tts', {apiKey: typed.trim() || undefined});
      setTest(r.data);
    } catch (e) {
      setTest({ok: false, message: msg(e)});
    } finally {
      setTesting(false);
    }
  };
  const loadList = async () => {
    setList(null);
    setListErr(null);
    try {
      const r = await api.get<{voices: Voice[]; apiError?: string}>('/api/tts/voices');
      setList(r.data.voices ?? []);
      setListErr(r.data.apiError ?? null);
    } catch (e) {
      setListErr(msg(e));
    }
  };

  return (
    <section className="card" data-tour="settings-tts">
      <h2>音声生成（Fish Audio）</h2>
      <p className="hint">
        ナレーションの音声は Fish Audio の TTS で作ります。
        <a href="https://fish.audio/" target="_blank" rel="noreferrer">
          fish.audio
        </a>{' '}
        の API キーを入れてください（任意。無ければ音声生成だけ使えません）。環境変数 FISH_API_KEY があればそちらが優先されます。
      </p>
      <div className="form">
        <label className="full">
          API キー
          <span className="btns">
            <input
              type="password"
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={key.present ? `設定済み ${key.masked}（${key.source === 'env' ? '環境変数 FISH_API_KEY' : '設定ファイル'}）` : '未設定'}
              disabled={view.env.fishApiKey}
              style={{flex: 1, minWidth: 320}}
            />
            <button className="small" onClick={() => void runTest()} disabled={testing || (!typed.trim() && !key.present)}>
              {testing ? '確認中…' : '接続テスト'}
            </button>
            {key.present && key.source === 'settings' && (
              <button className="small danger" onClick={clearKey}>
                鍵を消す
              </button>
            )}
          </span>
        </label>
        <label>
          モデル
          <input list="fish-models" value={modelId} onChange={(e) => setModelId(e.target.value)} disabled={view.env.fishModelId} />
          <datalist id="fish-models">
            {FISH_MODELS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        {test && (
          <span>
            <span className={`pill${test.ok ? '' : ' err'}`}>{test.message}</span>
          </span>
        )}
      </div>
      <h3>追加ボイス</h3>
      <p className="hint">
        人格の既定ボイス以外に Render の「ボイス」で選べるようにしたいモデル。自分で登録したモデルは自動で一覧に出るので、ここに書くのは他の人の公開モデルなど（Fish Audio のモデルページ URL 末尾の 32 桁が reference_id）。
      </p>
      {voices.length > 0 && (
        <div className="narr-rows">
          {voices.map((v, i) => (
            <div key={i} className="narr-row">
              <input className="mono" value={v.id} onChange={(e) => setVoices(voices.map((x, j) => (j === i ? {...x, id: e.target.value} : x)))} placeholder="reference_id（32 桁）" style={{width: 300}} />
              <input value={v.title} onChange={(e) => setVoices(voices.map((x, j) => (j === i ? {...x, title: e.target.value} : x)))} placeholder="表示名" style={{flex: 1}} />
              <input value={v.note ?? ''} onChange={(e) => setVoices(voices.map((x, j) => (j === i ? {...x, note: e.target.value} : x)))} placeholder="メモ（任意）" style={{flex: 1}} />
              <button className="small danger" onClick={() => setVoices(voices.filter((_, j) => j !== i))} title="この行を消す">
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="row">
        <button className="small" onClick={() => setVoices([...voices, {id: '', title: ''}])}>
          ＋ ボイスを足す
        </button>
        <button className="small" onClick={() => void loadList()}>
          いま選べるボイスを確認
        </button>
        <span style={{flex: 1}} />
        <button className="primary" onClick={() => void submit()} disabled={!dirty || !voicesValid} title={voicesValid ? undefined : '追加ボイスの id（32 桁）と表示名を埋めてください'}>
          音声生成の設定を保存
        </button>
      </div>
      {listErr && <span className="pill warn">{listErr}</span>}
      {list && (
        <ul className="hint" style={{marginTop: 6}}>
          {list.length === 0 && <li>選べるボイスがありません</li>}
          {list.map((v) => (
            <li key={v.id}>
              {v.title} <span className="mono">{v.id}</span>
              {v.source === 'own' ? '（自分のモデル）' : v.source === 'extra' ? '（追加ボイス）' : ''}
              {v.personas.length ? `（${v.personas.join('・')} の既定）` : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

// ───────────────────────── AI ─────────────────────────

const AgentCard: React.FC<{view: SettingsView; save: Save}> = ({view, save}) => {
  const a = view.settings.agent;
  const [form, setForm] = useState({claudeBin: a.claudeBin ?? '', model: a.model, tagBatchSize: a.tagBatchSize, tagConcurrency: a.tagConcurrency, timeoutMin: a.timeoutMin});
  useEffect(() => setForm({claudeBin: a.claudeBin ?? '', model: a.model, tagBatchSize: a.tagBatchSize, tagConcurrency: a.tagConcurrency, timeoutMin: a.timeoutMin}), [a]);
  const [test, setTest] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const dirty = form.claudeBin !== (a.claudeBin ?? '') || form.model !== a.model || form.tagBatchSize !== a.tagBatchSize || form.tagConcurrency !== a.tagConcurrency || form.timeoutMin !== a.timeoutMin;

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const r = await api.post<TestResult>('/api/settings/test/claude', {bin: form.claudeBin.trim() || undefined});
      setTest(r.data);
    } catch (e) {
      setTest({ok: false, message: msg(e)});
    } finally {
      setTesting(false);
    }
  };
  const submit = () =>
    void save({agent: {claudeBin: form.claudeBin.trim(), model: form.model.trim(), tagBatchSize: form.tagBatchSize, tagConcurrency: form.tagConcurrency, timeoutMin: form.timeoutMin}}, 'AI の設定を保存しました');

  const c = view.claude;
  return (
    <section className="card" data-tour="settings-agent">
      <h2>AI（Claude Code CLI）</h2>
      <p className="hint">
        タグ付け・並べ替え・テロップ・ナレーション原稿・キャプションは、ローカルにインストールされた Claude Code（claude コマンド）を裏で走らせて作ります。API キーは要りません。ターミナルで一度 claude を起動してログインしておいてください。実行のたびに利用枠（または API 課金）を使います。
      </p>
      <div className="row">
        <span>
          検出: <span className="mono">{c.bin}</span>
        </span>
        <span className={`pill${c.available ? '' : ' err'}`}>{c.available ? `見つかりました（${SOURCE_LABEL[c.source === 'path' ? 'default' : c.source === 'none' ? 'default' : c.source]}${c.source === 'path' ? '・PATH' : ''}）` : '見つかりません'}</span>
        {c.version && <span className="pill">{c.version}</span>}
      </div>
      <div className="form">
        <label className="full">
          claude の実行ファイル（任意。空なら PATH から探す）
          <span className="btns">
            <input value={form.claudeBin} onChange={(e) => setForm({...form, claudeBin: e.target.value})} placeholder="例: C:\Users\you\.local\bin\claude.exe" disabled={view.env.claudeBin} style={{flex: 1, minWidth: 320}} />
            <button className="small" onClick={() => void runTest()} disabled={testing}>
              {testing ? '確認中…' : 'テスト'}
            </button>
          </span>
        </label>
        {test && (
          <span>
            <span className={`pill${test.ok ? '' : ' err'}`}>{test.message}</span>
          </span>
        )}
        <label title="既定のモデル。各画面の「モデル」でその場だけ変えることもできます">
          既定のモデル
          <input list="ai-models" value={form.model} onChange={(e) => setForm({...form, model: e.target.value})} disabled={view.env.agentModel} />
          <datalist id="ai-models">
            {AI_MODELS.map(([id, text]) => (
              <option key={id} value={id}>
                {text}
              </option>
            ))}
          </datalist>
        </label>
        <label title="タグ付け 1 回で見せるクリップ数。多いと 1 回が長くなり、失敗時に巻き戻る範囲も広がる">
          タグ付けの 1 回あたりクリップ数
          <input type="number" min={1} max={50} value={form.tagBatchSize} onChange={(e) => setForm({...form, tagBatchSize: Number(e.target.value)})} />
        </label>
        <label title="タグ付けを何本並列で走らせるか（claude 1 本あたり数百 MB のメモリ）">
          タグ付けの並列数
          <input type="number" min={1} max={8} value={form.tagConcurrency} onChange={(e) => setForm({...form, tagConcurrency: Number(e.target.value)})} />
        </label>
        <label title="1 回の実行の上限時間">
          上限時間（分）
          <input type="number" min={1} max={180} value={form.timeoutMin} onChange={(e) => setForm({...form, timeoutMin: Number(e.target.value)})} />
        </label>
      </div>
      <div className="row">
        <span style={{flex: 1}} />
        <button className="primary" onClick={submit} disabled={!dirty}>
          AI の設定を保存
        </button>
      </div>
    </section>
  );
};

// ───────────────────────── Instagram の情報取得（Smartgram MCP） ─────────────────────────

type InstagramTest = TestResult & {accounts?: InstagramAccount[]; server?: string; tools?: string[]; url?: string};

/**
 * 店舗情報の裏取りで、店の公式 Instagram を Smartgram の MCP サーバー経由で読むための鍵。
 * 無ければ従来どおり Web 検索だけで裏取りする（Instagram はログイン壁で読めないことが多い）。
 * 古いワーカーが送ってきた見え方には instagram が無いことがあるので、無くても開けるようにしておく
 */
const InstagramCard: React.FC<{view: SettingsView; save: Save}> = ({view, save}) => {
  const ig = view.settings.instagram ?? {mcpKey: {present: false, masked: '', source: null}};
  const key = ig.mcpKey;
  const env = {url: !!view.env.instagramMcpUrl, key: !!view.env.instagramMcpKey, account: !!view.env.instagramAccount};
  const fromView = useCallback(() => ({mcpUrl: ig.mcpUrl ?? '', account: ig.account ?? ''}), [ig.mcpUrl, ig.account]);
  const [form, setForm] = useState(fromView);
  const [typed, setTyped] = useState('');
  useEffect(() => {
    setForm(fromView());
    setTyped('');
  }, [fromView]);
  const [test, setTest] = useState<InstagramTest | null>(null);
  const [testing, setTesting] = useState(false);

  const dirty = typed.trim() !== '' || form.mcpUrl.trim() !== (ig.mcpUrl ?? '') || form.account.trim() !== (ig.account ?? '');
  const urlValid = !form.mcpUrl.trim() || /^https?:\/\/\S+$/.test(form.mcpUrl.trim());

  const submit = async () => {
    const ok = await save(
      {
        instagram: {
          ...(typed.trim() ? {mcpKey: typed.trim()} : {}),
          mcpUrl: form.mcpUrl.trim(),
          account: form.account.trim().replace(/^@/, ''),
        },
      },
      'Instagram の情報取得の設定を保存しました',
    );
    if (ok) setTyped('');
  };
  const clearKey = () => void save({instagram: {mcpKey: ''}}, 'MCP の鍵を消しました');
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const r = await api.post<InstagramTest>('/api/settings/test/instagram', {mcpKey: typed.trim() || undefined, mcpUrl: form.mcpUrl.trim() || undefined});
      setTest(r.data);
    } catch (e) {
      setTest({ok: false, message: msg(e)});
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="card" data-tour="settings-instagram">
      <h2>Instagram の情報取得（Smartgram MCP）</h2>
      <p className="hint">
        キャプションを書く前の「店舗情報の裏取り」で、店の公式 Instagram（プロフィール・投稿）を{' '}
        <a href="https://app.smartgram.jp/" target="_blank" rel="noreferrer">
          Smartgram
        </a>{' '}
        の MCP サーバー経由で読みます（任意。無ければ Web 検索だけで裏取りしますが、Instagram はログイン壁で読めないことが多い）。
        Smartgram に登録済みのアカウントから公開アカウントを見るだけで、投稿・フォローなどの操作はしません。環境変数 SMARTGRAM_MCP_KEY があればそちらが優先されます。
      </p>
      <div className="form">
        <label className="full">
          MCP 用 API キー
          <span className="btns">
            <input
              type="password"
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={key.present ? `設定済み ${key.masked}（${key.source === 'env' ? '環境変数 SMARTGRAM_MCP_KEY' : '設定ファイル'}）` : '未設定（growgram_mcp_… で始まる鍵）'}
              disabled={env.key}
              style={{flex: 1, minWidth: 320}}
            />
            <button className="small" onClick={() => void runTest()} disabled={testing || (!typed.trim() && !key.present)}>
              {testing ? '確認中…' : '接続テスト'}
            </button>
            {key.present && key.source === 'settings' && (
              <button className="small danger" onClick={clearKey}>
                鍵を消す
              </button>
            )}
          </span>
        </label>
        <label className="full" title="Smartgram の MCP サーバー。空なら本番の URL">
          MCP サーバーの URL（任意）
          <input value={form.mcpUrl} onChange={(e) => setForm({...form, mcpUrl: e.target.value})} placeholder={DEFAULT_INSTAGRAM_MCP_URL} disabled={env.url} />
        </label>
        <label className="full" title="MCP ツールの username に渡す、Smartgram に登録済みのアカウント。空なら claude が一覧から有効なものを選びます">
          実行アカウント（任意）
          <input list="instagram-accounts" value={form.account} onChange={(e) => setForm({...form, account: e.target.value})} placeholder="空＝自動（接続テストで候補が出ます）" disabled={env.account} />
          <datalist id="instagram-accounts">
            {(test?.accounts ?? []).map((a) => (
              <option key={a.username} value={a.username}>
                {a.active ? '有効' : '無効'}
                {a.fullName ? `・${a.fullName}` : ''}
              </option>
            ))}
          </datalist>
        </label>
        {test && (
          <span>
            <span className={`pill${test.ok ? '' : ' err'}`}>{test.message}</span>
          </span>
        )}
      </div>
      {test?.accounts && test.accounts.length > 0 && (
        <ul className="hint" style={{marginTop: 6}}>
          {test.accounts.map((a) => (
            <li key={a.username}>
              <button className="small" onClick={() => setForm({...form, account: a.username})} disabled={env.account} title="この username を実行アカウントにする">
                @{a.username}
              </button>{' '}
              {a.fullName ?? ''}
              {typeof a.followers === 'number' ? `（フォロワー ${a.followers.toLocaleString()}）` : ''} <span className={`pill${a.active ? '' : ' warn'}`}>{a.active ? '有効' : '無効'}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        {(env.url || env.key || env.account) && <span className="hint">環境変数（SMARTGRAM_MCP_URL / SMARTGRAM_MCP_KEY / SMARTGRAM_ACCOUNT）で固定されている項目は画面から変えられません</span>}
        <span style={{flex: 1}} />
        <button className="primary" onClick={() => void submit()} disabled={!dirty || !urlValid} title={urlValid ? undefined : 'URL は https:// から始めてください'}>
          Instagram の設定を保存
        </button>
      </div>
    </section>
  );
};

// ───────────────────────── クラウド接続（スマホから使う） ─────────────────────────

/**
 * この PC を「重い処理を実行する係（ワーカー）」としてクラウドに繋ぐための設定。
 * 空ならローカル専用のまま。詳しくは docs/cloud.md。
 * クラウド側の画面からは編集させない（PC の設定なので、PC の Reel Studio で入れる）。
 */
const CloudCard: React.FC<{view: SettingsView; save: Save}> = ({view, save}) => {
  const s = useStudio();
  const fromView = useCallback(() => ({url: view.settings.cloud.url ?? '', token: '', enabled: view.settings.cloud.enabled !== false}), [view]);
  const [form, setForm] = useState(fromView);
  useEffect(() => setForm(fromView()), [fromView]);

  const base = fromView();
  const dirty = form.url !== base.url || form.token.trim() !== '' || form.enabled !== base.enabled;
  const tokenView = view.settings.cloud.token;
  const submit = () =>
    void save(
      {cloud: {url: form.url.trim(), ...(form.token.trim() ? {token: form.token.trim()} : {}), enabled: form.enabled}},
      'クラウド接続を保存しました（Reel Studio を起動し直すと繋がります）',
    ).then((ok) => ok && setForm({...form, token: ''}));

  // クラウド側の画面（PWA）では PC のワーカー設定は触れない
  if (s.isCloud)
    return (
      <section className="card">
        <h2>クラウド接続</h2>
        <p className="hint">
          この画面はクラウド版です。重い処理（素材のカタログ化・AI・レンダー）は自宅の PC が実行します。
          {s.config?.worker?.online ? (
            <>
              {' '}
              いま PC は <b>接続中</b>
              {s.config.worker.host ? `（${s.config.worker.host}）` : ''} です。
            </>
          ) : (
            ' いま PC は繋がっていません（PC で Reel Studio を起動してください）。'
          )}
          {' '}接続先の設定は PC の Reel Studio で行います。
        </p>
      </section>
    );

  return (
    <section className="card">
      <h2>クラウド接続（スマホから使う・任意）</h2>
      <p className="hint">
        Vercel に置いた画面（PWA）からこの PC に仕事をさせるための設定です。入れたあと Reel Studio を起動し直すと、
        デスクトップのショートカットから立ち上げているあいだ、スマホからもこの PC が使えます（PC を閉じると切れます）。
        空ならローカル専用のまま動きます（詳細は docs/cloud.md）。
      </p>
      <div className="form">
        <label className="full">
          クラウドの URL
          <input
            value={form.url}
            onChange={(e) => setForm({...form, url: e.target.value})}
            placeholder="https://reel-studio-xxxx.vercel.app"
            spellCheck={false}
            disabled={view.env.cloudUrl}
            style={{flex: 1, minWidth: 320}}
          />
        </label>
        <label className="full">
          ワーカートークン（Vercel の WORKER_TOKEN と同じ値）
          <span className="btns">
            <input
              type="password"
              value={form.token}
              onChange={(e) => setForm({...form, token: e.target.value})}
              placeholder={tokenView.present ? `保存済み（${tokenView.masked}）。変えるときだけ入力` : '未設定'}
              spellCheck={false}
              disabled={view.env.cloudToken}
              style={{flex: 1, minWidth: 320}}
            />
            {tokenView.present && <span className="pill">{tokenView.source === 'env' ? '環境変数' : '保存済み'}</span>}
          </span>
        </label>
        <label title="URL とトークンを残したまま、繋ぐのだけをやめる">
          繋ぐ
          <select value={form.enabled ? '1' : '0'} onChange={(e) => setForm({...form, enabled: e.target.value === '1'})}>
            <option value="1">繋ぐ</option>
            <option value="0">繋がない（ローカル専用）</option>
          </select>
        </label>
      </div>
      {(view.env.cloudUrl || view.env.cloudToken) && <p className="hint">環境変数（REEL_CLOUD_URL / REEL_WORKER_TOKEN）で固定されている項目は画面から変えられません。</p>}
      <div className="row">
        <span style={{flex: 1}} />
        <button className="primary" onClick={submit} disabled={!dirty}>
          クラウド接続を保存
        </button>
      </div>
    </section>
  );
};

// ───────────────────────── 顔モザイク ─────────────────────────

const MOSAIC_SOURCE_LABEL: Record<MosaicStatus['source'], string> = {env: '環境変数', settings: '設定', venv: '導入した venv', path: 'PATH', none: '見つからない'};

const MosaicSettingsCard: React.FC<{view: SettingsView; save: Save}> = ({view, save}) => {
  const s = useStudio();
  const {status, error, reload} = useMosaicStatus();
  const saved = view.settings.mosaic?.python ?? '';
  const [python, setPython] = useState(saved);
  useEffect(() => setPython(saved), [saved]);
  const [test, setTest] = useState<MosaicStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const setupJob = s.jobs.find((j) => j.type === 'mosaic-setup' && (j.status === 'running' || j.status === 'queued'));
  const lastSetup = s.jobs.find((j) => j.type === 'mosaic-setup');
  const stale = !s.supportsJob('mosaic-setup');
  const isWindows = /win/i.test(navigator.platform);

  // 導入が終わったら確かめ直す
  useEffect(() => {
    if (lastSetup?.status === 'done' || lastSetup?.status === 'failed') {
      setTest(null);
      void reload(true);
    }
  }, [lastSetup?.id, lastSetup?.status, reload]);

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const r = await api.post<MosaicStatus>('/api/settings/test/mosaic', {python: python.trim() || undefined});
      setTest(r.data);
      if (!python.trim()) void reload();
    } catch (e) {
      s.toast(msg(e), 'error');
    } finally {
      setTesting(false);
    }
  };
  const submit = async () => {
    if (await save({mosaic: {python: python.trim()}}, '顔モザイクの設定を保存しました')) {
      setTest(null);
      void reload(true);
    }
  };

  const st = test ?? status;
  return (
    <section className="card" data-tour="settings-mosaic">
      <h2>顔モザイク（deface）</h2>
      <p className="hint">
        素材に映った店員さんや他のお客さんの顔にモザイクをかけます（Materials の「顔モザイク」）。顔の検出に{' '}
        <a href="https://github.com/ORB-HD/deface" target="_blank" rel="noreferrer">
          deface
        </a>
        （MIT）を使うので Python 3.10 以上が要ります。「導入する」は <span className="mono">{status?.venvDir ?? '~/.reel-studio/deface-venv'}</span> に専用の環境を作って入れます（グローバルの Python には入れません。消すときはこのフォルダを消すだけ）。
      </p>
      <div className="row">
        {error ? (
          <span className="pill err">確認できません: {error}</span>
        ) : !st ? (
          <span className="hint">確認中…（python を起動して確かめています）</span>
        ) : (
          <>
            <span className={`pill${st.ok ? '' : ' err'}`}>{st.ok ? `使えます（deface ${st.deface}${st.onnxruntime ? ` / onnxruntime ${st.onnxruntime}` : ''}）` : '使えません'}</span>
            <span className="hint">{st.message}</span>
          </>
        )}
      </div>
      {st && (
        <div className="hint">
          python: <span className="mono">{st.python}</span>（{MOSAIC_SOURCE_LABEL[st.source]}）{st.pythonVersion ? ` / Python ${st.pythonVersion}` : ''}
          {st.providers.length ? ` / ${st.providers.join(', ')}` : ''}
        </div>
      )}
      <div className="row" style={{marginTop: 6}}>
        <button className="primary" onClick={() => void s.addJob('mosaic-setup', {gpu: false})} disabled={!!setupJob || stale} title={stale ? 'Reel Studio を再起動してください（サーバーが古いプロセスです）' : 'deface・onnx・onnxruntime（CPU 版）を入れます。初回は 200MB ほどダウンロードします'}>
          {status?.ok ? '入れ直す（CPU 版）' : '導入する（CPU 版）'}
        </button>
        {isWindows && (
          <button onClick={() => void s.addJob('mosaic-setup', {gpu: true})} disabled={!!setupJob || stale} title="onnxruntime-directml を入れて GPU で検出します（NVIDIA / AMD / Intel。実測で CPU の約 3.6 倍の速さ）">
            GPU 版で導入する（DirectML）
          </button>
        )}
        <button onClick={() => void reload(true)} disabled={!!setupJob}>
          確かめ直す
        </button>
      </div>
      {setupJob && <AiJobStatus job={setupJob} onCancel={(id) => void s.cancelJob(id)} compact lines={4} />}
      {!setupJob && lastSetup?.status === 'failed' && <p className="warn-text">導入に失敗しました: {lastSetup.error}</p>}
      <div className="form">
        <label className="full">
          deface を入れた python（任意。空なら導入した venv → PATH の python の順に探す）
          <span className="btns">
            <input value={python} onChange={(e) => setPython(e.target.value)} placeholder="例: C:\Users\you\venvs\deface\Scripts\python.exe" disabled={view.env.mosaicPython} style={{flex: 1, minWidth: 320}} />
            <button className="small" onClick={() => void runTest()} disabled={testing}>
              {testing ? '確認中…' : 'テスト'}
            </button>
          </span>
        </label>
      </div>
      <div className="row">
        {view.env.mosaicPython && <span className="hint">環境変数 REEL_STUDIO_MOSAIC_PYTHON で固定されています</span>}
        <span style={{flex: 1}} />
        <button className="primary" onClick={() => void submit()} disabled={python.trim() === saved}>
          顔モザイクの設定を保存
        </button>
      </div>
    </section>
  );
};

// ───────────────────────── テロップのフォント ─────────────────────────

/** そのフォントで見本を描く。読み込めないときは既定のフォントのまま（クラウドでは実体が無い） */
const FontSample: React.FC<{file: string; family: string; text: string}> = ({file, family, text}) => {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    let alive = true;
    // 取り込んだ原本の置き場（クラウドではワーカーが上げた写しに飛ぶ）
    const face = new FontFace(family, `url(/p/_global/full/fonts/${encodeURIComponent(file)})`);
    face.load().then(
      (f) => {
        if (!alive) return;
        document.fonts.add(f);
        setReady(true);
      },
      () => undefined, // 読めなければ見本を出さないだけ
    );
    return () => {
      alive = false;
    };
  }, [file, family]);
  return (
    <div className="font-sample" style={ready ? {fontFamily: `"${family}"`} : undefined} title={ready ? file : '見本を読み込めませんでした'}>
      {text}
    </div>
  );
};

const SAMPLE_TEXT = 'この一杯が旨い 1,280円';

const FontsCard: React.FC<{view: SettingsView; save: Save; reload: () => Promise<void>}> = ({view, save, reload}) => {
  const s = useStudio();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{name: string; pct: number; index: number; count: number} | null>(null);
  const fonts = view.fonts ?? [];
  const selected = view.settings.telop?.font ?? '';
  // クラウドでは PC が取り込む（走っている間は一覧にまだ出ない）
  const job = s.jobs.find((j) => j.type === 'fonts' && (j.status === 'running' || j.status === 'queued'));

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      if (s.isCloud) {
        // フォントは Function の本文上限（4.5MB）を超えるので、ブラウザから Blob へ直接上げ、
        // そのあと PC に取り込ませる（素材アップロードと同じ二段構え）
        const {put} = await import('@vercel/blob/client');
        const uploaded: {url: string; name: string}[] = [];
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          setProgress({name: f.name, pct: 0, index: i + 1, count: files.length});
          const t = await api.post<{token: string; pathname: string}>('/api/fonts/token', {filename: f.name});
          const r = await put(t.data.pathname, f, {
            access: 'public',
            token: t.data.token,
            contentType: f.type || 'application/octet-stream',
            onUploadProgress: (p) => setProgress({name: f.name, pct: Math.round((p.loaded / (p.total || f.size)) * 100), index: i + 1, count: files.length}),
          });
          uploaded.push({url: r.url, name: f.name});
        }
        await api.post('/api/fonts/ingest', {files: uploaded});
        s.toast(`${uploaded.length} 件を PC に取り込み中です（終わると一覧に出ます）`, 'ok');
      } else {
        for (const f of [...files]) await api.upload(`/api/fonts?filename=${encodeURIComponent(f.name)}`, f);
        s.toast(`${files.length} 件のフォントを取り込みました`, 'ok');
      }
      // 一覧は SettingsView（この画面）と /api/config（Timeline のフォント選択）の両方に出る
      await reload();
      await s.reloadConfig();
    } catch (e) {
      s.toast(msg(e), 'error');
    } finally {
      setBusy(false);
      setProgress(null);
      if (input.current) input.current.value = '';
    }
  };

  const remove = async (file: string) => {
    if (!confirm(`「${file}」を置き場から消します。すでに使っている案件（public/fonts/ に配り済み）の見た目は変わりません。よろしいですか？`)) return;
    setBusy(true);
    try {
      await api.del(`/api/fonts/${encodeURIComponent(file)}`);
      if (s.isCloud) s.toast(`${file} を消すよう PC に伝えました`, 'ok');
      // 既定に選んでいたものを消したときは、サーバー側で既定も外れている
      else s.toast(selected === file ? `${file} を消しました（既定は同梱の明朝に戻しました）` : `${file} を消しました`, 'ok');
      await reload();
      await s.reloadConfig();
    } catch (e) {
      s.toast(msg(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const choose = async (file: string) => {
    if (await save({telop: {font: file || null}}, file ? `これから作る動画は「${file}」で描きます` : '同梱の明朝に戻しました')) await s.reloadConfig();
  };

  return (
    <section className="card" data-tour="settings-fonts">
      <h2>テロップのフォント</h2>
      <p className="hint">
        自前のフォント（ttf / otf / ttc / woff / woff2）を取り込んで、テロップに使えます。置き場は <span className="mono">{view.dir.replace(/\\/g, '/')}/fonts/</span>。
        ここで選んだものが<b>これから作る動画</b>の既定になります（作成済みの案件は Timeline の「動画全体 → フォント」で選び直せます）。
        テロップは太字前提なので、<b>Bold / 太ゴシック・太明朝のフォント</b>を入れると綺麗に出ます。
        <b>フォントのライセンス（商用利用・埋め込みの可否）は自分で確認してください。</b>
      </p>
      <div className="row">
        <button className="primary" onClick={() => input.current?.click()} disabled={busy || !!job}>
          {busy ? '取り込み中…' : 'フォントを取り込む'}
        </button>
        <input ref={input} type="file" accept=".ttf,.otf,.ttc,.woff,.woff2,font/*" multiple hidden onChange={(e) => void upload(e.target.files)} />
        <span className="hint">1 ファイル 40MB まで{s.isCloud ? '。スマホから上げたものは PC が受け取ります' : ''}</span>
      </div>
      {progress && (
        <div>
          <div className="hint">
            {progress.index}/{progress.count} {progress.name} — {progress.pct}%
          </div>
          <div className="progress">
            <div style={{width: `${progress.pct}%`}} />
          </div>
        </div>
      )}
      {job && <AiJobStatus job={job} onCancel={(id) => void s.cancelJob(id)} compact lines={3} />}
      {s.isCloud && !s.config?.worker?.online && <p className="warn-text">PC がオフラインです。取り込み・削除は PC が繋がったときに実行されます。</p>}
      <ul className="font-list">
        <li>
          <label className="font-pick">
            <input type="radio" name="telop-font" checked={!selected} onChange={() => void choose('')} disabled={busy} />
            <span>
              <b>同梱の明朝（Noto Serif JP Bold）</b>
              <span className="hint"> — 既定。取り込まなくても使えます</span>
            </span>
          </label>
        </li>
        {fonts.map((f) => (
          <li key={f.file}>
            <label className="font-pick">
              <input type="radio" name="telop-font" checked={selected === f.file} onChange={() => void choose(f.file)} disabled={busy} />
              <span>
                <b>{f.label}</b>
                <span className="hint">
                  {' '}
                  — {(f.sizeBytes / 1024 / 1024).toFixed(1)} MB / {new Date(f.addedAt).toLocaleDateString('ja-JP')}
                </span>
              </span>
            </label>
            <FontSample file={f.file} family={f.family} text={SAMPLE_TEXT} />
            {!s.isCloud && (
              <button className="small" onClick={() => void remove(f.file)} disabled={busy}>
                消す
              </button>
            )}
          </li>
        ))}
      </ul>
      {!fonts.length && <p className="hint">まだ取り込んでいません。</p>}
    </section>
  );
};

// ───────────────────────── 人格 ─────────────────────────

const PersonasCard: React.FC = () => {
  const s = useStudio();
  const [sel, setSel] = useState('');
  const cur = s.personas.find((p) => p.id === sel) ?? s.personas[0];
  useEffect(() => {
    if (!s.personas.some((p) => p.id === sel) && s.personas[0]) setSel(s.personas[0].id);
  }, [s.personas, sel]);
  const [draft, setDraft] = useState<Persona | null>(null);
  useEffect(() => setDraft(cur ? clone(cur) : null), [cur]);
  const [voices, setVoices] = useState<Voice[]>([]);
  useEffect(() => {
    void api
      .get<{voices: Voice[]}>('/api/tts/voices')
      .then((r) => setVoices(r.data.voices ?? []))
      .catch(() => {});
  }, []);
  const [newId, setNewId] = useState('');

  const dirty = !!draft && !!cur && JSON.stringify(draft) !== JSON.stringify(cur);
  const parsed = draft ? PersonaSchema.safeParse(draft) : null;
  const issue = parsed && !parsed.success ? `${parsed.error.issues[0]?.path.join('.') || '(root)'}: ${parsed.error.issues[0]?.message}` : null;

  const savePersona = async () => {
    if (!draft || !parsed?.success) return;
    try {
      await api.put(`/api/personas/${encodeURIComponent(draft.id)}`, parsed.data);
      await s.loadPersonas();
      s.toast(`人格「${parsed.data.label}」を保存しました`, 'ok');
    } catch (e) {
      s.toast(msg(e), 'error');
    }
  };
  const duplicate = async () => {
    const id = newId.trim();
    if (!cur || !ID_RE.test(id)) return;
    try {
      const r = await api.post<{persona: Persona}>('/api/personas', {from: cur.id, id});
      await s.loadPersonas();
      setSel(r.data.persona.id);
      setNewId('');
      s.toast(`人格「${r.data.persona.label}」を追加しました。表示名などを直して保存してください`, 'ok');
    } catch (e) {
      s.toast(msg(e), 'error');
    }
  };
  const remove = async () => {
    if (!cur) return;
    if (!window.confirm(`人格「${cur.label}」（${cur.id}）を消しますか？`)) return;
    const url = `/api/personas/${encodeURIComponent(cur.id)}`;
    try {
      await api.del(url);
    } catch (e) {
      const err = e as ApiError;
      const projects = (err.body as {projects?: string[]} | null)?.projects;
      if (err.status !== 409 || !projects?.length) return s.toast(err.message, 'error');
      if (!window.confirm(`${err.message}\n\nそれでも消しますか？（案件の brief.json は残り、開くと「未登録の人格」と表示されます）`)) return;
      try {
        await api.del(`${url}?force=1`);
      } catch (e2) {
        return s.toast(msg(e2), 'error');
      }
    }
    await s.loadPersonas();
    setSel('');
    s.toast(`人格「${cur.label}」を消しました`, 'ok');
  };

  const set = (patch: Partial<Persona>) => draft && setDraft({...draft, ...patch});
  const setN = (patch: Partial<Persona['narration']>) => draft && setDraft({...draft, narration: {...draft.narration, ...patch}});
  const setC = (patch: Partial<Persona['caption']>) => draft && setDraft({...draft, caption: {...draft.caption, ...patch}});
  const lines = (v: string) => v.split('\n').map((x) => x.trim()).filter(Boolean);
  const parts = (v: string) => v.split(/[,、／/]/).map((x) => x.trim()).filter(Boolean);
  const num = (v: string, fallback: number) => (v === '' || Number.isNaN(Number(v)) ? fallback : Number(v));

  return (
    <section className="card" data-tour="settings-personas">
      <h2>人格（persona）</h2>
      <p className="hint">
        「誰の声・文体で作るか」のまとまり。案件の Brief で選びます。文体・締めの文言・ボイス・話速・キャプションの型をここで決めると、AI のテロップ・ナレーション・キャプションに効きます。id は案件の brief.json が参照するので後から変えられません（複製して作り直してください）。
      </p>
      <div className="row">
        <label>
          人格
          <select value={cur?.id ?? ''} onChange={(e) => setSel(e.target.value)}>
            {s.personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}（{p.id}）{p.narration.voiceId ? '' : '・ボイス未設定'}
              </option>
            ))}
          </select>
        </label>
        <label title="英小文字で始まり、英数字とハイフンだけ（最大 31 文字）">
          新しい id
          <span className="btns">
            <input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="例: my-voice" style={{width: 160}} />
            <button className="small" onClick={() => void duplicate()} disabled={!cur || !ID_RE.test(newId.trim())}>
              選択中を複製して追加
            </button>
          </span>
        </label>
        <span style={{flex: 1}} />
        <button className="small danger" onClick={() => void remove()} disabled={!cur || s.personas.length <= 1} title={s.personas.length <= 1 ? '最後の 1 件は消せません' : undefined}>
          この人格を削除
        </button>
      </div>

      {draft && (
        <>
          <div className="form" style={{marginTop: 8}}>
            <label>
              id
              <input value={draft.id} disabled />
            </label>
            <label>
              表示名
              <input value={draft.label} onChange={(e) => set({label: e.target.value})} />
            </label>
            <label title="Brief で人格を選んだときの構成の型">
              既定の型
              <select value={draft.defaultFormat} onChange={(e) => set({defaultFormat: e.target.value as Persona['defaultFormat']})}>
                {FORMAT_IDS.map((f) => (
                  <option key={f} value={f}>
                    {f} {FORMAT_SPECS[f].name}
                  </option>
                ))}
              </select>
            </label>
            <label title="テロップの配色">
              テーマ
              <select value={draft.theme} onChange={(e) => set({theme: e.target.value as Persona['theme']})}>
                {ThemeSchema.options.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label title="冒頭フックの型。areaDigit は「地元の9割が知らない」のような一桁数字入りで、エリア名はバッジに出す">
              フックの型
              <select value={draft.hookStyle} onChange={(e) => set({hookStyle: e.target.value as Persona['hookStyle']})}>
                <option value="areaDigit">エリア名＋一桁数字（エリア名はバッジへ）</option>
                <option value="free">縛らない</option>
              </select>
            </label>
            <label title="発見型（F7）で店名をテロップに書かず、映像だけで明かす人格なら ON">
              <span>F7 で店名テロップを空にしてよい</span>
              <input type="checkbox" checked={draft.allowEmptyReveal} onChange={(e) => set({allowEmptyReveal: e.target.checked})} />
            </label>
            <label className="full" title="プロンプトに「文体: …」としてそのまま入る 1 行">
              文体
              <input value={draft.tone} onChange={(e) => set({tone: e.target.value})} placeholder="例: 標準語・体言止めの短文" />
            </label>
            <label title="締めテロップの既定文。／で区切って複数可（先頭が下書きに使われる）">
              締めテロップの既定文
              <input value={draft.cta.join('／')} onChange={(e) => set({cta: parts(e.target.value)})} placeholder="例: ぜひ行ってみて" />
            </label>
            <label title="締めテロップとして認める語。これを含まないと検証で W が出る">
              締めとして認める語（／区切り）
              <input value={draft.ctaPatterns.join('／')} onChange={(e) => set({ctaPatterns: parts(e.target.value)})} placeholder="例: 行ってみて／詳細はキャプションへ" />
            </label>
            <label className="full" title="ナレーション原稿の禁則。1 行 1 条でプロンプトの箇条書きになる">
              ナレーションの禁則（1 行 1 条）
              <textarea value={draft.narrationRules.join('\n')} onChange={(e) => set({narrationRules: lines(e.target.value)})} placeholder="例: 語尾に「〜わ」を使わない" />
            </label>
          </div>

          <h3>声（Fish Audio）</h3>
          <div className="form">
            <label title="Render の「ボイス」の既定。案件ごとに narration.json で上書きできる">
              ボイス
              <select
                value={voices.some((v) => v.id === draft.narration.voiceId) ? draft.narration.voiceId : ''}
                onChange={(e) => {
                  const v = voices.find((x) => x.id === e.target.value);
                  setN({voiceId: e.target.value, voiceTitle: v?.title ?? draft.narration.voiceTitle});
                }}
              >
                <option value="">（未設定／下に直接入力）</option>
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.title}
                    {v.source === 'own' ? '（自分のモデル）' : v.source === 'extra' ? '（追加ボイス）' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label title="Fish Audio のモデルページ URL 末尾の 32 桁。空＝未設定（音声生成が止まる）">
              reference_id
              <input className="mono" value={draft.narration.voiceId} onChange={(e) => setN({voiceId: e.target.value.trim()})} placeholder="32 桁の 16 進数。空＝未設定" />
            </label>
            <label>
              ボイスの表示名
              <input value={draft.narration.voiceTitle} onChange={(e) => setN({voiceTitle: e.target.value})} />
            </label>
            <label title="読み上げ速度（0.5〜2）">
              速度
              <input type="number" step={0.05} min={0.5} max={2} value={draft.narration.speed} onChange={(e) => setN({speed: num(e.target.value, draft.narration.speed)})} />
            </label>
            <label title="ブロックの文字数の上限に使う値（秒 × この値）">
              設計話速（文字/秒）
              <input type="number" step={0.1} min={1} value={draft.narration.charsPerSec} onChange={(e) => setN({charsPerSec: num(e.target.value, draft.narration.charsPerSec)})} />
            </label>
            <label title="実際に生成して測った話速。尺の見積もりに使う">
              実測話速（文字/秒）
              <input type="number" step={0.1} min={1} value={draft.narration.charsPerSecMeasured} onChange={(e) => setN({charsPerSecMeasured: num(e.target.value, draft.narration.charsPerSecMeasured)})} />
            </label>
          </div>

          <h3>キャプション</h3>
          <div className="form">
            <label title="ちょうどこの本数。違うと検証で W">
              ハッシュタグの本数
              <input type="number" min={0} max={30} value={draft.caption.hashtags} onChange={(e) => setC({hashtags: Math.round(num(e.target.value, draft.caption.hashtags))})} />
            </label>
            <label title="0 なら上限なし">
              長さの目安（文字）
              <input type="number" min={0} value={draft.caption.maxChars} onChange={(e) => setC({maxChars: Math.round(num(e.target.value, draft.caption.maxChars))})} />
            </label>
            <label title="「他の投稿はコチラ」で誘導する自分のアカウント（@ 無し）。空なら書かない">
              誘導する自分のアカウント（任意）
              <input value={draft.caption.repostAccount ?? ''} onChange={(e) => setC({repostAccount: e.target.value.trim() || undefined})} placeholder="例: my_account" />
            </label>
            <label className="full" title="Claude Code のスキルフォルダなど。指定すると、そこの SKILL.md（「Step 4: キャプションの生成」）と references/hashtag-bank.md を型として読ませ、下の 2 つは使われない">
              外部のスキルフォルダ（任意・絶対パス）
              <input value={draft.skillDir ?? ''} onChange={(e) => set({skillDir: e.target.value.trim() || undefined})} placeholder="例: C:\path\to\my-skill" />
            </label>
            <label className="full">
              キャプションの型（markdown）{draft.skillDir ? '（スキルフォルダ指定中は使われません）' : ''}
              <textarea value={draft.captionGuide} onChange={(e) => set({captionGuide: e.target.value})} disabled={!!draft.skillDir} style={{minHeight: 180}} />
            </label>
            <label className="full">
              ハッシュタグの選び方（markdown）{draft.skillDir ? '（スキルフォルダ指定中は使われません）' : ''}
              <textarea value={draft.hashtagBank} onChange={(e) => set({hashtagBank: e.target.value})} disabled={!!draft.skillDir} style={{minHeight: 110}} />
            </label>
          </div>

          <div className="row">
            {issue && <span className="pill err">{issue}</span>}
            <span style={{flex: 1}} />
            <button onClick={() => cur && setDraft(clone(cur))} disabled={!dirty}>
              元に戻す
            </button>
            <button className="primary" onClick={() => void savePersona()} disabled={!dirty || !!issue}>
              人格を保存
            </button>
          </div>
        </>
      )}
    </section>
  );
};
