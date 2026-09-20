// クラウドモードの初期設定を 1 本で行う。**人ごとに 1 つ**の環境を作る。
//
//   npm run cloud:setup
//
// なぜ人ごとに分けるか:
//   いまの作りは「1 つのデプロイ＝1 人ぶん」。案件にもジョブにも持ち主の区別が無く、
//   ワーカーはキューにあるジョブを誰のものでも取る。つまり同じデプロイに 2 人がぶら下がると、
//   **相手の案件が見えて、相手のジョブを自分の PC が実行してしまう**。
//   お店の素材を扱う以上それは事故なので、分ける。
//
// この script がやること:
//   Vercel のプロジェクト作成 → 保護を外す → Blob ストア作成と接続 → DB のスキーマ適用 →
//   パスワードとトークンの生成 → 環境変数の設定 → 本番デプロイ → PC 側の接続設定
//
// 秘密の扱い: パスワードは打った本人の手元でハッシュにしてから Vercel に入れる（平文は送らない）。
// トークンの類はこの画面にも出さない（PC の設定ファイルに直接書く）。
import {spawnSync} from 'node:child_process';
import {randomBytes, scrypt} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const scryptAsync = promisify(scrypt);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const C = {dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', reset: '\x1b[0m'};
const log = (m) => console.log(`${C.cyan}▸${C.reset} ${m}`);
const ok = (m) => console.log(`${C.green}✔${C.reset} ${m}`);
const warn = (m) => console.log(`${C.yellow}!${C.reset} ${m}`);
const fail = (m) => console.log(`${C.red}✖${C.reset} ${m}`);
const step = (n, total, m) => console.log(`\n${C.cyan}[${n}/${total}]${C.reset} ${m}`);

const rl = readline.createInterface({input: process.stdin, output: process.stdout});
const ask = (q, def = '') =>
  new Promise((res) => rl.question(def ? `${q}（既定: ${def}）: ` : `${q}: `, (a) => res(a.trim() || def)));
/** 打った文字を画面に出さずに読む（パスワード用） */
const askSecret = (q) =>
  new Promise((res) => {
    const onData = () => rl.output.write(`\x1b[2K\r${q}: `);
    rl.input.on('data', onData);
    rl.question(`${q}: `, (a) => {
      rl.input.off('data', onData);
      rl.output.write('\n');
      res(a.trim());
    });
  });
const yes = async (q, def = true) => /^(y|yes|はい|)$/i.test(await ask(`${q} [${def ? 'Y/n' : 'y/N'}]`, def ? 'y' : 'n'));

/**
 * vercel CLI を呼ぶ。
 * Windows では `npx.cmd` を直接 spawn できない（Node 20 以降は .cmd の起動を塞いでいる）ので、
 * node で npx-cli.js を直に叩く。shell: true は使わない —— URL に ? や & が入るため。
 */
const npxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
const vercel = (args, opt = {}) => {
  const [cmd, argv] = fs.existsSync(npxCli)
    ? [process.execPath, [npxCli, '--yes', 'vercel', ...args]]
    : [isWin ? 'npx.cmd' : 'npx', ['vercel', ...args]];
  const r = spawnSync(cmd, argv, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: opt.inherit ? 'inherit' : 'pipe',
    input: opt.input,
    shell: !fs.existsSync(npxCli) && isWin,
  });
  return {code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim()};
};

const setEnv = (name, value) => {
  for (const env of ['production', 'preview', 'development']) {
    const r = vercel(['env', 'add', name, env, '--force'], {input: value});
    if (r.code !== 0) throw new Error(`環境変数 ${name}（${env}）の設定に失敗: ${r.err.split('\n').slice(-2).join(' ')}`);
  }
  ok(`${name} を設定しました`);
};

const main = async () => {
  console.log(`\n${C.cyan}Reel Studio クラウドモードの設定${C.reset}`);
  console.log(`${C.dim}スマホから使えるようにします。重い処理（ffmpeg・Remotion・Claude Code）はこの PC が実行します。${C.reset}`);
  console.log(`${C.dim}この設定は「あなた 1 人ぶん」の環境を作ります。他の人と共有はしません。${C.reset}\n`);
  const TOTAL = 8;

  // ── 1. Vercel にログインしているか
  step(1, TOTAL, 'Vercel の確認');
  const who = vercel(['whoami']);
  if (who.code !== 0) {
    fail('Vercel にログインしていません。次を実行してから、もう一度このコマンドを実行してください:');
    console.log(`  ${C.dim}npx vercel login${C.reset}\n`);
    process.exit(1);
  }
  ok(`Vercel: ${who.out.split('\n').pop()}`);

  // ── 2. プロジェクト
  step(2, TOTAL, 'Vercel プロジェクト');
  const linkFile = path.join(root, '.vercel', 'project.json');
  if (fs.existsSync(linkFile)) {
    ok('すでに紐づいています（.vercel/project.json）');
  } else {
    const name = await ask('プロジェクト名（URL の一部になります）', 'reel-studio');
    log('プロジェクトを作って紐づけます…');
    const r = vercel(['link', '--yes', '--project', name], {inherit: true});
    if (r.code !== 0) throw new Error('vercel link に失敗しました');
    ok(`プロジェクト: ${name}`);
  }
  const project = JSON.parse(fs.readFileSync(linkFile, 'utf8'));
  const teamQ0 = project.orgId?.startsWith('team_') ? `?teamId=${project.orgId}` : '';

  // ── GitHub との自動連携を切る
  // vercel link は git remote を見て勝手に連携する。繋がったままだと、公開リポジトリへ
  // push したときに「クラウド層の入っていない版」が本番に上書きされ、画面は出るのに
  // API が全部 404 になる（実際に一度やった）。出すのは npm run cloud:deploy からだけにする。
  const unlink = vercel(['api', `/v9/projects/${project.projectId}/link${teamQ0}`, '-X', 'DELETE', '--dangerously-skip-permissions']);
  if (unlink.code === 0) ok('GitHub の自動連携を切りました（本番に出すのは npm run cloud:deploy から）');

  // ── 3. デプロイ保護を外す（付いたままだとスマホも PC も Vercel のログイン画面で弾かれる）
  step(3, TOTAL, 'デプロイ保護を外す');
  const teamQ = teamQ0;
  const body = path.join(os.tmpdir(), `reel-sso-${process.pid}.json`);
  fs.writeFileSync(body, JSON.stringify({ssoProtection: null}));
  const sso = vercel(['api', `/v9/projects/${project.projectId}${teamQ}`, '-X', 'PATCH', '--input', body]);
  fs.rmSync(body, {force: true});
  if (sso.code === 0) ok('保護を外しました（この URL は自分のパスワードで守ります）');
  else warn('保護を外せませんでした。Vercel の Settings → Deployment Protection を手で Off にしてください');

  // ── 4. Blob（サムネイル・軽量プレビュー・完成動画の置き場）
  step(4, TOTAL, 'メディアの置き場（Vercel Blob）');
  const stores = vercel(['api', `/v1/storage/stores${teamQ}`]);
  let storeId = null;
  try {
    const list = JSON.parse(stores.out.slice(stores.out.indexOf('{')));
    const mine = (list.stores ?? []).find((s) => s.type === 'blob' && (s.projectsMetadata ?? []).some((p) => p.projectId === project.projectId));
    if (mine) {
      storeId = mine.id;
      ok(`すでに接続済み: ${mine.name}`);
    }
  } catch {
    /* 一覧が読めなければ作りにいく */
  }
  if (!storeId) {
    const storeName = await ask('Blob ストア名', 'reel-studio-media');
    const created = vercel(['blob', 'create-store', storeName]);
    const m = /store_[A-Za-z0-9]+/.exec(created.out + created.err);
    if (!m) throw new Error(`Blob ストアを作れませんでした: ${(created.err || created.out).split('\n').slice(-2).join(' ')}`);
    storeId = m[0];
    const connBody = path.join(os.tmpdir(), `reel-blob-${process.pid}.json`);
    fs.writeFileSync(connBody, JSON.stringify({projectId: project.projectId, envVarEnvironments: ['production', 'preview', 'development']}));
    const conn = vercel(['api', `/v1/storage/stores/${storeId}/connections${teamQ}`, '-X', 'POST', '--input', connBody]);
    fs.rmSync(connBody, {force: true});
    if (conn.code !== 0) throw new Error('Blob ストアをプロジェクトに接続できませんでした');
    ok(`${storeName} を作って接続しました（BLOB_READ_WRITE_TOKEN は自動で入ります）`);
  }

  // ── 5. データベース（案件・契約ファイル・ジョブ）
  step(5, TOTAL, 'データベース（Neon / Postgres）');
  console.log(`  ${C.dim}まだ無ければ https://neon.tech で無料のプロジェクトを作り、${C.reset}`);
  console.log(`  ${C.dim}「Connection string」（postgresql://… で始まる pooler のもの）をコピーしてください。${C.reset}`);
  const dbUrl = await askSecret('接続文字列を貼り付け');
  if (!/^postgres(ql)?:\/\//.test(dbUrl)) throw new Error('接続文字列の形が違います（postgresql://… で始まります）');

  log('スキーマを作っています…');
  const {neon} = await import('@neondatabase/serverless');
  const sql = neon(dbUrl);
  const migrations = fs
    .readdirSync(path.join(root, 'cloud', 'db', 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of migrations) {
    const text = fs.readFileSync(path.join(root, 'cloud', 'db', 'migrations', f), 'utf8');
    const statements = text
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of statements) await sql(s);
    ok(`${f}（${statements.length} 文）`);
  }

  // ── 6. ログインのパスワードと鍵
  step(6, TOTAL, 'ログインのパスワード');
  console.log(`  ${C.dim}スマホからこの画面を開くときのパスワードです。あなた以外は使えません。${C.reset}`);
  console.log(`  ${C.dim}打った文字は画面に出ません。Vercel には**ハッシュだけ**が入ります（平文は送りません）。${C.reset}`);
  let password = '';
  for (;;) {
    password = await askSecret('パスワード（8 文字以上）');
    if (password.length < 8) {
      warn('8 文字以上にしてください');
      continue;
    }
    if ((await askSecret('もう一度')) === password) break;
    warn('一致しません。やり直してください');
  }
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32);
  const passwordHash = `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
  const jwtSecret = randomBytes(48).toString('base64url');
  const workerToken = randomBytes(32).toString('base64url');
  ok('パスワードをハッシュにしました');

  // ── 7. 環境変数
  step(7, TOTAL, '環境変数の設定');
  setEnv('DATABASE_URL', dbUrl);
  setEnv('AUTH_PASSWORD_HASH', passwordHash);
  setEnv('AUTH_JWT_SECRET', jwtSecret);
  setEnv('WORKER_TOKEN', workerToken);

  if (await yes('音声生成（Fish Audio）の鍵を入れますか', false)) {
    const key = await askSecret('Fish Audio の API キー');
    if (key) setEnv('FISH_API_KEY', key);
  }
  if (await yes('レンダー完了の通知を使いますか')) {
    try {
      const webpush = (await import('web-push')).default;
      const keys = webpush.generateVAPIDKeys();
      setEnv('VAPID_PUBLIC_KEY', keys.publicKey);
      setEnv('VAPID_PRIVATE_KEY', keys.privateKey);
      const mail = await ask('連絡先メール（通知の仕様で必要）', '');
      if (mail) setEnv('VAPID_SUBJECT', `mailto:${mail}`);
    } catch (e) {
      warn(`通知の鍵を作れませんでした（あとで設定できます）: ${e.message}`);
    }
  }

  // ── 8. デプロイと PC 側の接続
  step(8, TOTAL, 'デプロイ');
  const dep = vercel(['deploy', '--prod', '--yes'], {inherit: true});
  if (dep.code !== 0) throw new Error('デプロイに失敗しました');
  const inspect = vercel(['inspect', '--wait']);
  const aliasMatch = /https:\/\/[a-z0-9.-]+\.vercel\.app/i.exec(inspect.out + inspect.err);
  let url = aliasMatch ? aliasMatch[0] : '';
  if (!url) url = await ask('デプロイ先の URL を貼り付け（https://… .vercel.app）');
  url = url.replace(/\/+$/, '');

  log('この PC をワーカーとして繋ぎます…');
  const setCloud = spawnSync(process.execPath, [path.join(root, 'scripts', 'set-cloud.mjs'), url, workerToken], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (setCloud.status !== 0) throw new Error('PC 側の接続設定に失敗しました');

  console.log(`\n${C.green}できました。${C.reset}\n`);
  console.log(`  画面:      ${C.cyan}${url}${C.reset}`);
  console.log(`  ログイン:  いま決めたパスワード`);
  console.log(`\n  次の 2 つで使えるようになります:`);
  console.log(`   1. この PC で ${C.cyan}Reel Studio${C.reset}（デスクトップのショートカット）を起動したままにする`);
  console.log(`   2. スマホで上の URL を開き、ログインして「ホーム画面に追加」`);
  console.log(`\n  ${C.dim}PC で Reel Studio が動いていないとジョブは待機します（消えません）。${C.reset}`);
  console.log(`  ${C.dim}常駐のさせ方・困ったときは docs/cloud.md を見てください。${C.reset}\n`);
};

main()
  .then(() => rl.close())
  .catch((e) => {
    rl.close();
    fail(e instanceof Error ? e.message : String(e));
    console.log(`\n${C.dim}途中まで出来たものはそのまま残っています。直してから、もう一度同じコマンドを実行してください。${C.reset}\n`);
    process.exitCode = 1;
  });
