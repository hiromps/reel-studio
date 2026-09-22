// GUI の状態：案件一覧・active・契約ファイル（etag / dirty）・ジョブ・SSE・トースト。
import React, {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {api, type ApiError, type Job, type ProjectInfo} from '../api';
import type {Brief, Catalog, Narration, ReelData} from '@shared/schema';
import type {CaptionIssue} from '@shared/caption';
import type {FontEntry} from '@shared/schema/fonts';
import {listPersonas, setPersonas, type Persona} from '@shared/personas';

export type ContractName = 'catalog' | 'brief' | 'cuts' | 'narration';
type ContractMap = {catalog: Catalog; brief: Brief; cuts: ReelData; narration: Narration};

export type FileState<T> = {data: T | null; etag: string | null; dirty: boolean; loading: boolean; error?: string; external?: string | null};

type Files = {[K in ContractName]: FileState<ContractMap[K]>};

export type Toast = {id: number; kind: 'info' | 'error' | 'ok'; text: string};

/** caption.txt は JSON ではないので Files には入れない（素のテキスト＋点検結果だけ持つ） */
export type CaptionState = {text: string | null; etag: string | null; issues: CaptionIssue[]};

type Store = {
  projects: ProjectInfo[];
  active: string | null;
  files: Files;
  caption: CaptionState;
  jobs: Job[];
  logs: Record<string, string[]>;
  toasts: Toast[];
  config: {
    uploadsFolders: string[];
    workDir: string;
    uploadsRoot: string;
    dataRoot?: string;
    outputsDir?: string;
    sfxDir?: string;
    settingsDir?: string;
    jobTypes?: string[];
    stale?: boolean;
    startedAt?: string;
    /** 音声生成（Fish Audio）の鍵があるか */
    tts?: boolean;
    /** 裏で走らせる claude が見つかっているか */
    claude?: boolean;
    /** 店舗情報の裏取りで Instagram を Smartgram MCP 経由で読めるか（Settings に鍵があるか） */
    instagramMcp?: boolean;
    settingsProblem?: string | null;
    personasProblem?: string | null;
    /** 取り込み済みの自前フォント（Settings で取り込む。Timeline のフォント選択が使う） */
    fonts?: FontEntry[];
    /** 新しく作る動画で使う既定のフォント（<設定の置き場>/fonts/ の中のファイル名） */
    telopFont?: string | null;
    /**
     * cloud = Vercel 上で動いていて、重い処理は自宅 PC のワーカーが行う。
     * 未指定（ローカルのサーバー）は今までどおり全部この PC で動く。
     */
    mode?: 'cloud';
    /** クラウド版のみ。PC のワーカーが繋がっているか */
    worker?: {online: boolean; lastSeen: string | null; node: string | null; ffmpeg: string | null; ffprobe: string | null; host: string | null};
  } | null;
  /** クラウド版か（ローカル専用の UI を隠すのに使う） */
  isCloud: boolean;
  /** 人格の一覧（GET /api/personas）。shared/personas.ts のレジストリにも同じものが入る */
  personas: Persona[];
  personasLoaded: boolean;
  loadPersonas: () => Promise<void>;
  /** Settings で保存したあとに /api/config を読み直す */
  reloadConfig: () => Promise<void>;
  /** 起動中のサーバーがそのジョブを扱えるか（古いプロセスのまま新しいボタンを押すのを防ぐ） */
  supportsJob: (type: string) => boolean;
  refreshProjects: () => Promise<void>;
  setActive: (slug: string) => Promise<void>;
  /** 投稿し終えた案件を一覧から隠す／戻す（消さない。PC とスマホで同じ状態になる） */
  setArchived: (slug: string, archived: boolean) => Promise<void>;
  /** 開いている案件のファイルを読み直す（未保存の編集は上書きしない） */
  reloadActive: (opt?: {quiet?: boolean}) => Promise<void>;
  /** 「最新に」。クラウドでは PC に今すぐ同期させてから読み直す */
  pullLatest: () => Promise<void>;
  /** 「最新に」の実行中（ボタンの二度押しよけ） */
  pulling: boolean;
  /** 軽量プレビュー（.studio/preview/ の 540x960 を使う）。タブごとの表示設定 */
  light: boolean;
  setLight: (v: boolean) => void;
  /** このタブの案件の素材 URL の先頭（`/p/<slug>/<mode>`）。案件が無ければ null */
  mediaBase: string | null;
  loadFile: <K extends ContractName>(name: K) => Promise<void>;
  /** 編集中の値を入れる。dirty は既定 true（取り消しで保存時の状態に戻したときだけ false を渡す） */
  setFile: <K extends ContractName>(name: K, data: ContractMap[K], opt?: {dirty?: boolean}) => void;
  saveFile: <K extends ContractName>(name: K, force?: boolean) => Promise<boolean>;
  loadCaption: () => Promise<void>;
  saveCaption: (text: string) => Promise<boolean>;
  addJob: (type: string, params?: Record<string, unknown>, slug?: string, opt?: {quiet?: boolean}) => Promise<Job | null>;
  cancelJob: (id: string) => Promise<void>;
  fetchJobLog: (id: string) => Promise<string[]>;
  toast: (text: string, kind?: Toast['kind']) => void;
};

const StudioContext = createContext<Store | null>(null);

const emptyFile = <T,>(): FileState<T> => ({data: null, etag: null, dirty: false, loading: false});

/** ジョブ投入直後のレスポンスで、SSE 経由の新しい状態を巻き戻さないための順序 */
const JOB_STATUS_RANK: Record<Job['status'], number> = {queued: 0, running: 1, done: 2, failed: 2, cancelled: 2};

// 「いま編集している案件」はタブごとに持つ（URL の ?p=）。サーバーに 1 つだけ持たせていた頃は、
// タブを複製して片方の案件を変えるともう片方まで同じ案件に変わってしまった。
// URL に入れておくと、タブを複製した直後は同じ案件・そのあと片方だけ変えても他のタブに影響しない。
const slugFromUrl = (): string | null => new URLSearchParams(location.search).get('p');
const writeSlugToUrl = (slug: string | null) => {
  const u = new URL(location.href);
  if (slug) u.searchParams.set('p', slug);
  else u.searchParams.delete('p');
  history.replaceState(null, '', u);
};
/** 素材 URL の先頭。mode はサーバーが .studio/preview/ を使うかどうかの目印 */
export const mediaBaseOf = (slug: string | null, light: boolean): string | null => (slug ? `/p/${encodeURIComponent(slug)}/${light ? 'light' : 'full'}` : null);
const emptyCaption = (): CaptionState => ({text: null, etag: null, issues: []});

export const StudioProvider: React.FC<{children: React.ReactNode}> = ({children}) => {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [active, setActiveState] = useState<string | null>(null);
  const [files, setFiles] = useState<Files>({catalog: emptyFile(), brief: emptyFile(), cuts: emptyFile(), narration: emptyFile()});
  const [caption, setCaption] = useState<CaptionState>(emptyCaption());
  const [jobs, setJobs] = useState<Job[]>([]);
  const [logs, setLogs] = useState<Record<string, string[]>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [config, setConfig] = useState<Store['config']>(null);
  const [personas, setPersonasState] = useState<Persona[]>(() => listPersonas());
  const [personasLoaded, setPersonasLoaded] = useState(false);
  const [light, setLightState] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem('reel-studio.light') === '1';
    } catch {
      return false;
    }
  });
  const [pulling, setPulling] = useState(false);
  const toastId = useRef(0);
  const filesRef = useRef(files);
  filesRef.current = files;
  const configRef = useRef(config);
  configRef.current = config;
  const activeRef = useRef(active);
  activeRef.current = active;
  const captionRef = useRef(caption);
  captionRef.current = caption;

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, {id, kind, text}]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4000);
  }, []);

  const setLight = useCallback((v: boolean) => {
    setLightState(v);
    try {
      sessionStorage.setItem('reel-studio.light', v ? '1' : '0');
    } catch {
      /* 記憶できなくても動作には影響しない */
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    const r = await api.get<ProjectInfo[]>('/api/projects');
    setProjects(r.data);
  }, []);

  const loadPersonas = useCallback(async () => {
    try {
      const r = await api.get<{personas: Persona[]}>('/api/personas');
      setPersonas(r.data.personas);
      setPersonasState(r.data.personas);
    } catch {
      // 古いサーバーには /api/personas が無い。同梱の人格で動かす
      setPersonasState(listPersonas());
    } finally {
      setPersonasLoaded(true);
    }
  }, []);

  const reloadConfig = useCallback(async () => {
    const c = await api.get<Store['config']>('/api/config');
    setConfig(c.data);
  }, []);

  const loadFile = useCallback(async <K extends ContractName>(name: K) => {
    const slug = activeRef.current;
    if (!slug) return;
    setFiles((f) => ({...f, [name]: {...f[name], loading: true, error: undefined}}));
    try {
      const r = await api.get<{etag: string | null; data: ContractMap[K] | null}>(`/api/projects/${slug}/files/${name}`);
      setFiles((f) => ({...f, [name]: {data: r.data.data, etag: r.data.etag, dirty: false, loading: false, external: null}}));
    } catch (e) {
      const err = e as ApiError;
      setFiles((f) => ({...f, [name]: {data: null, etag: null, dirty: false, loading: false, error: err.status === 404 ? undefined : err.message}}));
    }
  }, []);

  const loadCaption = useCallback(async () => {
    const slug = activeRef.current;
    if (!slug) return;
    try {
      const r = await api.get<{etag: string | null; data: string | null; issues: CaptionIssue[]}>(`/api/projects/${slug}/caption`);
      setCaption({text: r.data.data, etag: r.data.etag, issues: r.data.issues ?? []});
    } catch {
      setCaption(emptyCaption()); // caption.txt が無いのは普通（404 は出ないが、古いサーバーだと 404 になる）
    }
  }, []);

  const saveCaption = useCallback(
    async (text: string): Promise<boolean> => {
      const slug = activeRef.current;
      if (!slug) return false;
      try {
        const r = await api.put<{etag: string; issues: CaptionIssue[]}>(`/api/projects/${slug}/caption`, {text}, captionRef.current.etag);
        setCaption({text, etag: r.data.etag, issues: r.data.issues ?? []});
        toast('caption.txt を保存', 'ok');
        return true;
      } catch (e) {
        const err = e as ApiError;
        toast(err.status === 409 ? 'caption.txt は外部で変更されています。「読み直す」で取り込んでから保存してください' : `保存に失敗: ${err.message}`, 'error');
        return false;
      }
    },
    [toast],
  );

  const setActive = useCallback(
    async (slug: string) => {
      // サーバーにも伝えるが、これは「?p= 無しで開いた新しいタブの初期値」用。画面は URL を見る
      await api.put('/api/projects/active', {slug});
      writeSlugToUrl(slug);
      setActiveState(slug);
      activeRef.current = slug;
      setFiles({catalog: emptyFile(), brief: emptyFile(), cuts: emptyFile(), narration: emptyFile()});
      setCaption(emptyCaption());
      await Promise.all([...(['catalog', 'brief', 'cuts', 'narration'] as ContractName[]).map((n) => loadFile(n)), loadCaption()]);
    },
    [loadFile, loadCaption],
  );

  const setArchived = useCallback(
    async (slug: string, archived: boolean) => {
      try {
        await api.put(`/api/projects/${encodeURIComponent(slug)}/archived`, {archived});
        await refreshProjects();
        toast(archived ? `${slug} を一覧から隠しました（「隠した案件も表示」で戻せます）` : `${slug} を一覧に戻しました`, 'ok');
      } catch (e) {
        const err = e as ApiError;
        // 起動しっぱなしの古いサーバーにはこの口が無い（express が HTML の 404 を返す）
        const old = err.status === 404 && /cannot put/i.test(err.message);
        toast(old ? 'この機能は起動中のサーバーにありません。Reel Studio を一度閉じて起動し直してください' : `変更に失敗: ${err.message}`, 'error');
      }
    },
    [refreshProjects, toast],
  );

  /**
   * 開いている案件のファイル（契約ファイル 4 つ + caption.txt）を読み直す。
   * **未保存の編集があるものは読み直さない**（黙って捨てない）。
   * quiet は SSE の再接続ごとに呼ぶとき用（毎分「読み直していません」と言わない）。
   */
  const reloadActive = useCallback(
    async ({quiet = false}: {quiet?: boolean} = {}): Promise<void> => {
      if (!activeRef.current) return;
      const names: ContractName[] = ['catalog', 'brief', 'cuts', 'narration'];
      const dirty = names.filter((n) => filesRef.current[n].dirty);
      await Promise.all([...names.filter((n) => !dirty.includes(n)).map((n) => loadFile(n)), loadCaption()]);
      if (dirty.length && !quiet) toast(`未保存の編集があるので ${dirty.join(', ')} は読み直していません（保存するか取り消してから押してください）`, 'error');
    },
    [loadFile, loadCaption, toast],
  );

  const setFile = useCallback(<K extends ContractName>(name: K, data: ContractMap[K], opt: {dirty?: boolean} = {}) => {
    setFiles((f) => ({...f, [name]: {...f[name], data, dirty: opt.dirty ?? true}}));
  }, []);

  const saveFile = useCallback(
    async <K extends ContractName>(name: K, force = false): Promise<boolean> => {
      const slug = activeRef.current;
      const st = filesRef.current[name];
      if (!slug || !st.data) return false;
      try {
        const r = await api.put<{etag: string}>(`/api/projects/${slug}/files/${name}`, st.data, force ? null : st.etag);
        setFiles((f) => ({...f, [name]: {...f[name], etag: r.data.etag, dirty: false, external: null}}));
        toast(`${name}.json を保存`, 'ok');
        return true;
      } catch (e) {
        const err = e as ApiError;
        if (err.status === 409) {
          toast(`${name}.json は外部で変更されています。「読み直す」か「上書き」を選んでください`, 'error');
          setFiles((f) => ({...f, [name]: {...f[name], external: (err.body as {etag?: string})?.etag ?? 'changed'}}));
        } else toast(`保存に失敗: ${err.message}`, 'error');
        return false;
      }
    },
    [toast],
  );

  // jobTypes を返さない＝この仕組みより前のサーバー。その場合は判定できないのでサーバーに任せる
  const supportsJob = useCallback((type: string) => !config?.jobTypes || config.jobTypes.includes(type), [config]);

  const addJob = useCallback(
    async (type: string, params: Record<string, unknown> = {}, slug?: string, opt: {quiet?: boolean} = {}) => {
      if (!supportsJob(type)) {
        toast('この機能は起動中のサーバーにありません。Reel Studio を一度閉じて起動し直してください（画面だけ新しくなっています）', 'error');
        return null;
      }
      try {
        const r = await api.post<Job>('/api/jobs', {type, slug: slug ?? activeRef.current, params});
        // このレスポンスはジョブ投入直後のスナップショット（queued/running）。preflight 失敗のように
        // 一瞬で終わるジョブだと、SSE の job:update が先に「失敗」を届けたあとにこれが遅れて届き、
        // そのまま上書きすると失敗が消えて見える。既存の方が進んだ状態ならそちらを残す
        setJobs((j) => {
          const existing = j.find((x) => x.id === r.data.id);
          if (existing && JOB_STATUS_RANK[existing.status] > JOB_STATUS_RANK[r.data.status]) return j;
          return [r.data, ...j.filter((x) => x.id !== r.data.id)];
        });
        // quiet は「最新に」のように、押したこと自体が見えているボタン用（知らせを重ねない）
        if (!opt.quiet) toast(`ジョブ ${type} を投入`);
        return r.data;
      } catch (e) {
        toast(`ジョブ投入に失敗: ${(e as Error).message}`, 'error');
        return null;
      }
    },
    [toast, supportsJob],
  );

  /**
   * 「最新に」。クラウド版では **PC の最新がまだ上がっていないことがある**（ワーカーの棚卸しは 5 分ごと）。
   * 同期ジョブを積んで PC に今すぐ送らせ、そのうえで**いまクラウドにあるもの**を読み直す。
   * PC から届くのはそのあとなので、ジョブ完了（SSE の job:update）でもう一度読み直す。
   */
  const pullLatest = useCallback(async (): Promise<void> => {
    setPulling(true);
    try {
      const cfg = configRef.current;
      if (cfg?.mode === 'cloud' && activeRef.current) {
        const job = await addJob('sync', {}, activeRef.current, {quiet: true});
        if (job && cfg.worker && !cfg.worker.online) toast('PC が繋がっていないので、PC で Reel Studio を起動したときに同期されます', 'info');
      }
      await Promise.all([reloadConfig(), refreshProjects()]);
      await reloadActive();
    } catch (e) {
      toast(`最新の取り込みに失敗: ${(e as Error).message}`, 'error');
    } finally {
      setPulling(false);
    }
  }, [addJob, reloadConfig, refreshProjects, reloadActive, toast]);

  const cancelJob = useCallback(async (id: string) => {
    await api.post(`/api/jobs/${id}/cancel`);
  }, []);

  const fetchJobLog = useCallback(async (id: string) => {
    const r = await api.get<Job>(`/api/jobs/${id}`);
    const log = r.data.log ?? [];
    setLogs((l) => ({...l, [id]: log}));
    return log;
  }, []);

  // 初期化：config / projects / active
  useEffect(() => {
    (async () => {
      try {
        const c = await api.get<Store['config']>('/api/config');
        setConfig(c.data);
        await loadPersonas();
        await refreshProjects();
        const j = await api.get<Job[]>('/api/jobs');
        setJobs(j.data);
        // このタブの案件は URL（?p=）が正。無ければサーバーの既定＝最後に開いた案件を使う
        const fromUrl = slugFromUrl();
        const slug = fromUrl ?? (await api.get<{slug: string | null}>('/api/projects/active')).data.slug;
        if (slug) {
          if (!fromUrl) writeSlugToUrl(slug);
          else void api.put('/api/projects/active', {slug}).catch(() => {}); // サーバー側にも監視させる
          setActiveState(slug);
          activeRef.current = slug;
          await Promise.all([...(['catalog', 'brief', 'cuts', 'narration'] as ContractName[]).map((n) => loadFile(n)), loadCaption()]);
        }
      } catch (e) {
        toast(`サーバーに接続できません: ${(e as Error).message}（npm run server で起動）`, 'error');
      }
    })();
  }, [refreshProjects, loadPersonas, loadFile, loadCaption, toast]);

  // SSE
  useEffect(() => {
    const es = new EventSource('/events');
    // 接続（再接続）時：切断中に取りこぼしたジョブ更新を取り直す。
    // **案件の一覧も取り直す。** クラウドでは SSE が一定時間で切れて繋ぎ直すが、
    // その繋ぎ目に終わったジョブの job:update は届かない（新しい接続は「いまの状態」を
    // 配るだけで、過去の変化は流さない）。ジョブだけ取り直していたので、
    // 「mix は done なのに out/final_narration.mp4 が無いと言われる」が起きていた
    es.addEventListener('hello', () => {
      void api.get<Job[]>('/api/jobs').then((r) => setJobs(r.data)).catch(() => {});
      void refreshProjects().catch(() => {});
      // **開いている案件のファイルも読み直す。** file:changed は「繋がっている間」の変化しか流れない
      // （新しい接続はいまの状態を配るだけ）。スマホは画面を閉じるたびに切れるので、これが無いと
      // 切れていた間に PC が書き戻したキャプション・構成が、案件を開き直すまで古いままになる
      void reloadActive({quiet: true}).catch(() => {});
    });
    es.addEventListener('job:update', (ev) => {
      const j = JSON.parse((ev as MessageEvent).data) as Job;
      setJobs((list) => (list.some((x) => x.id === j.id) ? list.map((x) => (x.id === j.id ? {...x, ...j} : x)) : [j, ...list]));
      // ジョブは全案件ぶん流れてくる。**このタブが開いている案件のものだけ**を通知し、
      // ファイルの読み直しも行う（別の案件のジョブで、いま編集中のファイルを差し替えない）
      if (j.slug !== activeRef.current) return;
      // 「最新に」で積んだ同期。PC が送り終えたところなので、ここで初めて PC の最新が読める
      if (j.status === 'done' && j.type === 'sync') {
        toast('PC の最新を取り込みました', 'ok');
        void reloadActive();
        void refreshProjects();
        return;
      }
      if (j.status === 'done') toast(`${j.type} 完了`, 'ok');
      if (j.status === 'failed') toast(`${j.type} 失敗: ${j.error ?? ''}`, 'error');
      if (j.status === 'done' && (j.type === 'ai-caption' || j.type === 'tts')) {
        // caption.txt / narration.json はジョブが直接書く。編集中でなければ取り込む
        if (j.type === 'ai-caption') void loadCaption();
        else if (!filesRef.current.narration.dirty) void loadFile('narration');
      }
      // out/ の中身が変わるジョブ。ボタンの活性（mix を押せるか等）が projects の out を見ているので取り直す
      if (j.status === 'done' && ['render', 'draft', 'mix', 'deliver'].includes(j.type)) void refreshProjects();
      if (j.status === 'done' && ['catalog', 'thumbs', 'proxy', 'aliases', 'sync-engine', 'ai-tag', 'ai-order', 'ai-telop', 'ai-edit', 'ai-narration', 'mosaic', 'mosaic-revert'].includes(j.type)) {
        // 未保存の編集があるときは黙って上書きしない（file:changed と同じ扱いにする）
        const reload = (name: ContractName) => {
          if (!filesRef.current[name].dirty) return void loadFile(name);
          setFiles((f) => ({...f, [name]: {...f[name], external: 'changed'}}));
          toast(`${name}.json をジョブが書き換えました（未保存の編集あり。「読み直す」か「上書き」を選んでください）`, 'error');
        };
        if (['catalog', 'thumbs', 'proxy', 'ai-tag', 'mosaic', 'mosaic-revert'].includes(j.type)) reload('catalog');
        if (j.type === 'aliases' || j.type === 'ai-telop') reload('cuts');
        if (j.type === 'ai-narration') reload('narration');
        if (j.type === 'ai-edit') {
          reload('cuts');
          reload('narration');
        }
        if (j.type === 'ai-order') {
          reload('brief');
          reload('cuts');
        }
        void refreshProjects();
      }
    });
    es.addEventListener('job:progress', (ev) => {
      const p = JSON.parse((ev as MessageEvent).data) as {jobId: string; phase: string; done: number; total: number};
      setJobs((list) => list.map((x) => (x.id === p.jobId ? {...x, progress: {phase: p.phase, done: p.done, total: p.total}} : x)));
    });
    es.addEventListener('job:log', (ev) => {
      const d = JSON.parse((ev as MessageEvent).data) as {jobId: string; line: string};
      setLogs((l) => ({...l, [d.jobId]: [...(l[d.jobId] ?? []).slice(-799), d.line]}));
    });
    es.addEventListener('file:changed', (ev) => {
      const d = JSON.parse((ev as MessageEvent).data) as {slug: string; name: ContractName; etag: string | null};
      if (d.slug !== activeRef.current) return;
      const st = filesRef.current[d.name];
      if (st.etag === d.etag) return;
      if (st.dirty) {
        setFiles((f) => ({...f, [d.name]: {...f[d.name], external: d.etag}}));
        toast(`${d.name}.json が外部で変更されました（未保存の編集あり）`, 'error');
      } else void loadFile(d.name);
    });
    return () => es.close();
  }, [loadFile, loadCaption, refreshProjects, reloadActive, toast]);

  const value = useMemo<Store>(
    () => ({projects, active, files, caption, jobs, logs, toasts, config, isCloud: config?.mode === 'cloud', personas, personasLoaded, loadPersonas, reloadConfig, light, setLight, mediaBase: mediaBaseOf(active, light), supportsJob, refreshProjects, setActive, setArchived, reloadActive, pullLatest, pulling, loadFile, setFile, saveFile, loadCaption, saveCaption, addJob, cancelJob, fetchJobLog, toast}),
    [projects, active, files, caption, jobs, logs, toasts, config, personas, personasLoaded, loadPersonas, reloadConfig, light, setLight, supportsJob, refreshProjects, setActive, setArchived, reloadActive, pullLatest, pulling, loadFile, setFile, saveFile, loadCaption, saveCaption, addJob, cancelJob, fetchJobLog, toast],
  );
  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
};

export const useStudio = (): Store => {
  const s = useContext(StudioContext);
  if (!s) throw new Error('StudioProvider の外');
  return s;
};
