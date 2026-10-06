// 接続先ごとのモデル選択。候補はサーバーがプロバイダーから取得する。
import React, {useCallback, useEffect, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import {readPref, writePref} from './usePref';
import type {AgentModelsView, AgentProvider} from '@shared/schema/settings';

const keyOf = (provider: AgentProvider) => `reel-studio.aiModel.${provider}`;

export const useAiModel = (): [string, (next: string) => void] => {
  const {config} = useStudio();
  const provider = config?.agent?.provider ?? 'claude';
  const fallback = config?.agent?.model ?? (provider === 'claude' ? 'opus' : '');
  const [value, setValue] = useState(() => readPref(keyOf(provider), fallback, (s) => s));
  useEffect(() => setValue(readPref(keyOf(provider), fallback, (s) => s)), [provider, fallback]);
  const change = useCallback((next: string) => {setValue(next); writePref(keyOf(provider), next);}, [provider]);
  return [value, change];
};

const cache = new Map<AgentProvider, {at: number; promise: Promise<AgentModelsView>}>();
export const fetchAiModels = (provider: AgentProvider, refresh = false): Promise<AgentModelsView> => {
  const found = cache.get(provider);
  if (!refresh && found && Date.now() - found.at < 60_000) return found.promise;
  const promise = api.post<AgentModelsView>('/api/settings/models', {provider}).then((r) => r.data);
  cache.set(provider, {at: Date.now(), promise});
  void promise.catch(() => {if (cache.get(provider)?.promise === promise) cache.delete(provider);});
  return promise;
};

export const AiModelSelect: React.FC<{value: string; onChange: (v: string) => void; label?: string; title?: string}> = ({value, onChange, label = 'モデル', title}) => {
  const {config} = useStudio();
  const provider = config?.agent?.provider ?? 'claude';
  const [catalog, setCatalog] = useState<AgentModelsView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setCatalog(null);
    setError('');
    void fetchAiModels(provider).then((data) => {if (active) setCatalog(data);}).catch((e) => {if (active) setError(e.message ?? 'モデル一覧を取得できません');}).finally(() => {if (active) setLoading(false);});
    return () => {active = false;};
  }, [provider]);
  useEffect(() => {
    if (catalog?.models.length && !catalog.models.some((m) => m.id === value)) onChange(catalog.models[0].id);
  }, [catalog, value, onChange]);
  return (
    <label title={title ?? '接続先のモデル一覧から選びます'}>
      {label}
      <select value={catalog?.models.some((m) => m.id === value) ? value : ''} onChange={(e) => onChange(e.target.value)} disabled={loading || !!error || !catalog?.models.length} aria-busy={loading}>
        {loading && <option value="">取得中…</option>}
        {error && <option value="">取得できません</option>}
        {!loading && !error && !catalog?.models.length && <option value="">モデルなし</option>}
        {catalog?.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
      {error && <span role="alert" className="hint">{error}</span>}
    </label>
  );
};
