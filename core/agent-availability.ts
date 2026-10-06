import {claudeAvailable, claudeBin} from './agent';
import {codexAvailable, codexBinInfo} from './codex';
import {agentProvider} from './settings';

export const agentAvailable = (): boolean => agentProvider() === 'codex' ? codexAvailable() : claudeAvailable();
export const agentMissingMessage = (): string => agentProvider() === 'codex'
  ? `codex 実行ファイルが見つかりません（${codexBinInfo().bin}）。Settings の「AI」で確認してください`
  : `claude 実行ファイルが見つかりません（${claudeBin()}）。PATH に入れるか REEL_STUDIO_CLAUDE_BIN で場所を指定してください`;
