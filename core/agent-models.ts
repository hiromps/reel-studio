import type {AgentModelOption, AgentModelsView, AgentProvider} from '../shared/schema/settings';
import {claudeCatalogApiKey, deepseekApiKey} from './settings';
import {codexAvailable, listCodexModels} from './codex';
import {fetchClaudeModels, fetchDeepseekModels} from '../shared/agent-models';

const unique = (models: AgentModelOption[]): AgentModelOption[] => [...new Map(models.map((model) => [model.id, model])).values()];

/** Provider catalog is fetched on demand; no model IDs are maintained in the UI. */
export const listAgentModels = async (provider: AgentProvider, opt: {deepseekKey?: string; claudeKey?: string; codexBin?: string} = {}): Promise<AgentModelsView> => {
  if (provider === 'codex') {
    if (!opt.codexBin && !codexAvailable()) throw new Error('Codex CLI が見つかりません');
    const models = await listCodexModels(opt.codexBin?.trim() || undefined);
    if (!models.length) throw new Error('Codex のモデル一覧が空です');
    return {provider, models: unique(models), source: 'cli'};
  }
  if (provider === 'deepseek') {
    const key = opt.deepseekKey?.trim() || deepseekApiKey();
    if (!key) throw new Error('DeepSeek の API キーを入力してください');
    const models = await fetchDeepseekModels(key);
    if (!models.length) throw new Error('DeepSeek のモデル一覧が空です');
    return {provider, models: unique(models), source: 'provider'};
  }
  // Claude Code のサブスクリプション認証は Anthropic API キーを公開しない。
  // API キーがある環境では公式一覧、無い環境では CLI の最新モデル alias を選ばせる。
  const key = opt.claudeKey?.trim() || claudeCatalogApiKey();
  if (key) {
    const models = await fetchClaudeModels(key);
    if (!models.length) throw new Error('Claude のモデル一覧が空です');
    return {provider, models: unique(models), source: 'provider'};
  }
  return {provider, source: 'cli', models: [
    {id: 'fable', label: 'Fable（Claude Code の最新）'},
    {id: 'opus', label: 'Opus（Claude Code の最新）'},
    {id: 'sonnet', label: 'Sonnet（Claude Code の最新）'},
    {id: 'haiku', label: 'Haiku（Claude Code の最新）'},
  ]};
};
