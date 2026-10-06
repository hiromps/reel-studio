import type {AgentModelOption} from './schema/settings';

export const fetchDeepseekModels = async (key: string): Promise<AgentModelOption[]> => {
  const response = await fetch('https://api.deepseek.com/models', {
    headers: {Authorization: `Bearer ${key}`, Accept: 'application/json'}, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`DeepSeek のモデル一覧を取得できません（${response.status}）`);
  const body = await response.json() as {data?: {id?: string; name?: string}[]};
  return (body.data ?? []).filter((item) => item.id).map((item) => ({id: item.id!, label: item.name ? `${item.name}（${item.id}）` : item.id!}));
};

export const fetchClaudeModels = async (key: string): Promise<AgentModelOption[]> => {
  const response = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
    headers: {'x-api-key': key, 'anthropic-version': '2023-06-01', Accept: 'application/json'}, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Claude のモデル一覧を取得できません（${response.status}）`);
  const body = await response.json() as {data?: {id?: string; display_name?: string}[]};
  return (body.data ?? []).filter((item) => item.id).map((item) => ({id: item.id!, label: item.display_name ? `${item.display_name}（${item.id}）` : item.id!}));
};
