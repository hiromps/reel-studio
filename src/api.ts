// サーバー API の薄いラッパ。
export type ApiError = Error & {status?: number; body?: unknown};

const handle = async <T,>(res: Response): Promise<{data: T; etag: string | null; status: number}> => {
  const etag = res.headers.get('ETag');
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = {error: text};
  }
  if (!res.ok) {
    const e: ApiError = new Error((json as {error?: string})?.error ?? `${res.status} ${res.statusText}`);
    e.status = res.status;
    e.body = json;
    throw e;
  }
  return {data: json as T, etag, status: res.status};
};

export const api = {
  get: async <T,>(path: string) => handle<T>(await fetch(path, {cache: 'no-store'})),
  post: async <T,>(path: string, body?: unknown) =>
    handle<T>(await fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)})),
  put: async <T,>(path: string, body: unknown, ifMatch?: string | null) =>
    handle<T>(
      await fetch(path, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json', ...(ifMatch ? {'If-Match': ifMatch} : {})},
        body: JSON.stringify(body),
      }),
    ),
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
