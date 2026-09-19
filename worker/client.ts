// クラウドへの HTTP クライアント。**発信は常にこちらから**（この PC のポートは開けない）。
// 設定は ~/.reel-studio/settings.json の cloud（環境変数 REEL_CLOUD_URL / REEL_WORKER_TOKEN が優先）。
import {loadSettings} from '../core/settings';
import type {CloudJob} from '../cloud/store';
import type {WorkerStatus} from '../cloud/worker-status';
import type {SettingsView} from '../shared/schema/settings';
import type {SfxLibrary} from '../shared/sfx';
import type {DocName} from '../shared/project';
import type {BuildFacts} from '../shared/build';
import type {ProjectSnapshot} from '../cloud/db/schema';

export type CloudConfig = {url: string; token: string};

export const cloudConfig = (): CloudConfig | null => {
  const s = loadSettings().cloud;
  const url = (process.env.REEL_CLOUD_URL?.trim() || s.url || '').replace(/\/+$/, '');
  const token = process.env.REEL_WORKER_TOKEN?.trim() || s.token || '';
  if (!url || !token) return null;
  if (s.enabled === false && !process.env.REEL_CLOUD_URL) return null;
  return {url, token};
};

export class CloudError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type HelloReply = {
  blobToken: string | null;
  settingsPatch: {rev: number; patch: Record<string, unknown>} | null;
  personasRev: number;
  sfx: {rev: number; lib: SfxLibrary} | null;
};

export type DocPull = {name: DocName; data: unknown; rev: number; hash: string; updatedBy: string; updatedAt: string};
export type DocPushResult = {name: string; ok: boolean; rev?: number; hash?: string; conflict?: {rev: number; hash: string; data: unknown}};
export type AssetRow = {kind: string; mode: string; relPath: string; hash: string; bytes: number};

export class CloudClient {
  constructor(private cfg: CloudConfig) {}

  get baseUrl(): string {
    return this.cfg.url;
  }

  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const res = await fetch(`${this.cfg.url}/api/worker${path}`, {
      method,
      headers: {Authorization: `Bearer ${this.cfg.token}`, ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = {error: text.slice(0, 300)};
    }
    if (!res.ok) throw new CloudError(res.status, (json as {error?: string})?.error ?? `${res.status} ${res.statusText}`);
    return json as T;
  }

  hello = (status: Omit<WorkerStatus, 'lastSeen'>) => this.call<HelloReply>('POST', '/hello', status);
  claim = (running: {slug: string; type: string}[], maxConcurrent: number) => this.call<{job: CloudJob | null}>('POST', '/claim', {running, maxConcurrent});
  progress = (id: string, body: {progress?: {phase: string; done: number; total: number}; lines?: string[]}) => this.call<{cancelRequested: boolean}>('POST', `/jobs/${id}/progress`, body);
  finish = (id: string, body: {status: 'done' | 'failed' | 'cancelled'; result?: unknown; error?: string; lines?: string[]}) => this.call<{ok: true}>('POST', `/jobs/${id}/finish`, body);

  pullDocs = (slug: string) => this.call<{docs: DocPull[]}>('GET', `/docs/${encodeURIComponent(slug)}`);
  pushDocs = (slug: string, docs: {name: DocName; data: unknown; baseRev?: number | null}[]) => this.call<{results: DocPushResult[]}>('POST', `/docs/${encodeURIComponent(slug)}`, {docs}, 60_000);

  pushProject = (slug: string, body: {info?: ProjectSnapshot; buildFacts?: BuildFacts; persona?: string; format?: string; shopName?: string}) =>
    this.call<{ok: true}>('POST', `/project/${encodeURIComponent(slug)}`, body);
  dropProject = (slug: string) => this.call<{ok: true}>('DELETE', `/project/${encodeURIComponent(slug)}`);

  listAssets = (slug: string) => this.call<{assets: AssetRow[]}>('GET', `/assets/${encodeURIComponent(slug)}`);
  registerAssets = (slug: string, assets: {kind: string; mode: string; relPath: string; url: string; bytes: number; hash: string; contentType: string}[]) =>
    this.call<{ok: true; saved: number; bad: string[]}>('POST', `/assets/${encodeURIComponent(slug)}`, {assets}, 60_000);

  pushSettings = (view: SettingsView, appliedPatchRev?: number) => this.call<{ok: true}>('POST', '/settings', {view, appliedPatchRev});
  pullPersonas = () => this.call<{personas: unknown[]}>('GET', '/personas');
  pushPersonas = (personas: unknown[]) => this.call<{ok: true; count: number}>('POST', '/personas', {personas});
  pushSfx = (lib: SfxLibrary) => this.call<{ok: true}>('POST', '/sfx', {lib});
}
