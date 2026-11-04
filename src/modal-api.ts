let session: Promise<string> | null = null;
const token = () => session ??= fetch('/api/modal/session', {headers: {'X-Reel-Modal-Client': 'reel-studio'}, cache: 'no-store'}).then(async r => {
  if (!r.ok) throw new Error('Modal操作を認証できません。Reel Studioを再読み込みしてください');
  return (await r.json() as {token: string}).token;
}).catch(e => {session = null; throw e;});

const request = async (route: string, body?: unknown, method = 'GET'): Promise<Response> => {
  const r = await fetch(`/api/modal${route}`, {method, cache: 'no-store', headers: {'X-Reel-Modal-Session': await token(), 'Content-Type': 'application/json'}, ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
  if (!r.ok) {
    if (r.status === 401) session = null;
    const v = await r.json().catch(() => null);
    throw Object.assign(new Error(v?.error ?? `Modal接続エラー（${r.status}）`), {status: r.status});
  }
  return r;
};
export const modalApi = {
  get: async <T,>(route: string): Promise<T> => (await request(route)).json(),
  post: async <T,>(route: string, body?: unknown): Promise<T> => (await request(route, body, 'POST')).json(),
  put: async <T,>(route: string, body: unknown): Promise<T> => (await request(route, body, 'PUT')).json(),
  blob: async (route: string): Promise<Blob> => (await request(route)).blob(),
};
