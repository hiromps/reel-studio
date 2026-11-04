// Provision only this Reel Studio project's production secrets. No credentials
// in argv, source, deployment archive, generated env files, stdout, or stderr.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {modalConfig, modalSecrets} from '../core/modal-vault';
import {validateModalEndpoint} from '../core/modal-client';

const root = process.cwd();
const link = JSON.parse(fs.readFileSync(path.join(root, '.vercel/project.json'), 'utf8'));
if (link.projectName !== 'reel-studio' || link.projectId !== 'prj_fus50l6gsloYAMZ3J3tgrnUdfUmc') throw new Error('Unexpected Vercel project');
const cli = path.join(process.env.APPDATA!, 'npm/node_modules/vercel/dist/vc.js');
if (!fs.existsSync(cli)) throw new Error('Vercel CLI is required');
const config = modalConfig(), secrets = modalSecrets();
const values = {REEL_MODAL_ENDPOINT_URL: validateModalEndpoint(config.endpointUrl), REEL_MODAL_PROXY_TOKEN_ID: secrets.proxyTokenId, REEL_MODAL_PROXY_TOKEN_SECRET: secrets.proxyTokenSecret};
for (const [name, value] of Object.entries(values)) {
  if (!value) throw new Error('Configure Modal locally first');
  const args = [cli, 'env', 'add', name, 'production', '--yes', '--force', ...(name === 'REEL_MODAL_ENDPOINT_URL' ? [] : ['--sensitive'])];
  const r = spawnSync(process.execPath, args, {cwd: root, input: value, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000});
  if (r.status !== 0) throw new Error(`Could not provision ${name}; no credential output was exposed`);
  console.log(`${name}: production設定完了（値は非表示）`);
}
