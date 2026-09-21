// サーバー API の薄いラッパ。
export type ApiError = Error & {status?: number; body?: unknown};

/**
 * セッション切れ（401）の知らせ先。クラウド版で使う（src/Gate.tsx がログイン画面に戻す）。
 * ローカル版では 401 が起きないので誰も呼ばれない。
 */
const unauthorizedListeners = new Set<() => void>();
export const onUnauthorized = (fn: () => void): (() => void) => {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
};

/** ログインの確認そのものは 401 を「切れた」とみなさない（初回は未ログインが普通） */
const SILENT_401 = /\/api\/auth\//;

const handle = async <T,>(res: Response, url = ''): Promise<{data: T; etag: string | null; status: number}> => {
  const etag = res.headers.get('ETag');
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = {error: text};
  }
  if (!res.ok) {
    if (res.status === 401 && !SILENT_401.test(url)) for (const fn of unauthorizedListeners) fn();
    const e: ApiError = new Error((json as {error?: string})?.error ?? `${res.status} ${res.statusText}`);
    e.status = res.status;
    e.body = json;
    throw e;
  }
  return {data: json as T, etag, status: res.status};
};

export const api = {
  get: async <T,>(path: string) => handle<T>(await fetch(path, {cache: 'no-store'}), path),
  post: async <T,>(path: string, body?: unknown) =>
    handle<T>(await fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)}), path),
  put: async <T,>(path: string, body: unknown, ifMatch?: string | null) =>
    handle<T>(
      await fetch(path, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json', ...(ifMatch ? {'If-Match': ifMatch} : {})},
        body: JSON.stringify(body),
      }),
      path,
    ),
  del: async <T,>(path: string) => handle<T>(await fetch(path, {method: 'DELETE'}), path),
  /** ファイルそのものを本文にして送る（フォントの取り込み。名前は path のクエリに入れる） */
  upload: async <T,>(path: string, file: File) =>
    handle<T>(await fetch(path, {method: 'POST', headers: {'Content-Type': file.type || 'application/octet-stream'}, body: file}), path),
};

export type ProjectInfo = {
  slug: string;
  dir: string;
  has: {catalog: boolean; brief: boolean; cuts: boolean; narration: boolean};
  out?: {draft: boolean; final: boolean; narration: boolean};
  engine: {stale: boolean; files: {file: string; status: string}[]};
  nodeModules: boolean;
  updatedAt: string;
  persona?: string;
  format?: string;
};

export type Job = {
  id: string;
  type: string;
  slug: string;
  params: Record<string, unknown>;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  progress?: {phase: string; done: number; total: number};
  logTail?: string[];
  log?: string[];
  result?: Record<string, unknown>;
  error?: string;
};
