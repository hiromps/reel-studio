// Explicit local setup: read the already-authenticated SDK profile, create a
// dedicated HTTP Proxy Token, encrypt everything. Never print token values.
import {execFileSync} from 'node:child_process';
import {modalConfig, modalSecrets, saveModalSettings} from '../core/modal-vault';
import {validateModalEndpoint} from '../core/modal-client';

try {
  const endpointUrl = validateModalEndpoint(process.argv[2] ?? '');
  if (!endpointUrl) throw new Error('endpoint required');
  const python = process.env.REEL_MODAL_PYTHON || 'python';
  const run = (args: string[]) => execFileSync(python, ['-X', 'utf8', ...args], {encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe']});
  const sdk = JSON.parse(run(['-c', 'import json; from modal.config import config; print(json.dumps({"tokenId":config.get("token_id"),"tokenSecret":config.get("token_secret")}))']));
  if (!sdk.tokenId || !sdk.tokenSecret) throw new Error('SDK login required');
  let secrets = modalSecrets();
  if (!secrets.proxyTokenId || !secrets.proxyTokenSecret) {
    const proxy = JSON.parse(run(['-m', 'modal', 'workspace', 'proxy-tokens', 'create', '--name', 'Reel Studio Cloud GPU', '--json']));
    secrets = {...secrets, proxyTokenId: proxy['Modal-Key'], proxyTokenSecret: proxy['Modal-Secret']};
    if (!secrets.proxyTokenId || !secrets.proxyTokenSecret) throw new Error('Unexpected proxy token format');
  }
  saveModalSettings({...modalConfig(), endpointUrl}, {...secrets, ...sdk});
  console.log('Modal SDK認証と専用Proxy Tokenを暗号化して保存しました。秘密情報は表示しません。');
} catch {
  console.error('Modal設定に失敗しました。python -m modal setup で認証し、正しい https://…modal.run URLを渡してください。');
  process.exitCode = 1;
}
