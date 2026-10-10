const {app, BrowserWindow, Menu, dialog, shell, session} = require('electron');
const {spawn, spawnSync} = require('node:child_process');
const {randomBytes} = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {locations, backendEnvironment, externalUrl, permissionAllowed, checkFiles} = require('./runtime.cjs');

app.setName('Reel Studio');
const root = path.resolve(__dirname, '..');
const paths = locations(app.isPackaged, process.resourcesPath, root);
const token = randomBytes(32).toString('base64url');
const smoke = process.argv.includes('--smoke-test');
const children = new Set();
let mainWindow;
let origin;
let quitting = false;
let logStream;
let backendEnv;
let closingApproved = false;
if (smoke && process.env.REEL_DESKTOP_TEST_HOME) app.setPath('userData', path.join(process.env.REEL_DESKTOP_TEST_HOME, 'electron-profile'));

function stopChildren() {
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
    else child.kill('SIGTERM');
  }
  children.clear();
}

function launch(script, ipc = false, args = []) {
  const child = spawn(paths.node, ['--import', 'tsx', path.join(paths.backend, script), ...args], {
    cwd: paths.backend, env: backendEnv, windowsHide: true,
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.stdout.on('data', (chunk) => logStream.write(chunk));
  child.stderr.on('data', (chunk) => logStream.write(chunk));
  child.on('error', (error) => logStream.write(`${error.message}\n`));
  child.on('exit', () => children.delete(child));
  return child;
}

function secureWindow(window) {
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin === origin) return;
    event.preventDefault();
    if (externalUrl(url)) void shell.openExternal(url);
  });
  window.webContents.setWindowOpenHandler(({url}) => {
    if (new URL(url).origin === origin) return {action: 'allow', overrideBrowserWindowOptions: windowOptions()};
    if (externalUrl(url)) void shell.openExternal(url);
    return {action: 'deny'};
  });
  window.webContents.on('did-create-window', secureWindow);
  window.webContents.on('will-prevent-unload', (event) => {
    const selected = dialog.showMessageBoxSync(window, {type: 'question', buttons: ['編集を続ける', '閉じる'], defaultId: 0, cancelId: 0, title: '未保存の編集', message: '保存していない変更があります。閉じますか？'});
    if (selected === 1) event.preventDefault();
    else closingApproved = false;
  });
}

function windowOptions() {
  return {title: 'Reel Studio', width: 1440, height: 960, minWidth: 1024, minHeight: 700,
    backgroundColor: '#f4f4f1', icon: app.isPackaged ? path.join(process.resourcesPath, 'reel-studio-v2.ico') : path.join(root, 'assets', 'reel-studio.ico'),
    webPreferences: {nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true},
  };
}

function menu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label: 'ファイル', submenu: [{label: '終了', accelerator: 'Alt+F4', click: () => BrowserWindow.getFocusedWindow()?.close()}]},
    {label: '編集', submenu: [{role: 'undo', label: '元に戻す'}, {role: 'redo', label: 'やり直す'}, {type: 'separator'}, {role: 'cut', label: '切り取り'}, {role: 'copy', label: 'コピー'}, {role: 'paste', label: '貼り付け'}, {role: 'selectAll', label: 'すべて選択'}]},
    {label: '表示', submenu: [{role: 'resetZoom', label: '標準の表示倍率'}, {role: 'zoomIn', label: '拡大'}, {role: 'zoomOut', label: '縮小'}, {type: 'separator'}, {role: 'togglefullscreen', label: '全画面表示'}]},
    {label: 'ヘルプ', submenu: [
      {label: 'ログフォルダを開く', click: () => void shell.openPath(app.getPath('logs'))},
      {label: 'ライセンス', click: () => void shell.openPath(app.isPackaged ? path.join(process.resourcesPath, 'licenses') : path.join(root, '.runtime', 'desktop-stage', 'licenses'))},
      {label: 'Reel Studioについて', click: () => void dialog.showMessageBox({type: 'info', title: 'Reel Studio', message: `Reel Studio ${app.getVersion()}`, detail: '動画編集・縦型ショート動画の書き出し\nAIや音声生成は設定画面で接続してください。'})},
    ]},
  ]));
}

async function startup() {
  checkFiles(paths);
  const home = smoke ? process.env.REEL_DESKTOP_TEST_HOME : (process.env.REEL_STUDIO_HOME || path.join(os.homedir(), '.reel-studio'));
  if (!home) throw new Error('動作確認の保存先が指定されていません。');
  fs.mkdirSync(home, {recursive: true});
  backendEnv = backendEnvironment(process.env, paths, smoke ? path.join(home, 'data') : path.join(app.getPath('documents'), 'Reel Studio Data'), token, home);
  if (smoke) backendEnv.REEL_STUDIO_DATA_ROOT = path.join(home, 'data');
  app.setAppLogsPath();
  fs.mkdirSync(app.getPath('logs'), {recursive: true});
  logStream = fs.createWriteStream(path.join(app.getPath('logs'), 'desktop.log'), {flags: 'a'});
  menu();
  mainWindow = new BrowserWindow({...windowOptions(), show: false});
  mainWindow.on('ready-to-show', () => { if (!smoke) mainWindow.show(); });
  await mainWindow.loadFile(path.join(__dirname, 'starting.html'));
  const server = launch('server/index.ts', true);
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('起動に時間がかかっています。アプリを再起動してください。')), 60000);
    const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
    server.once('error', (error) => finish(error));
    server.once('exit', (code) => finish(new Error(`動画処理の起動に失敗しました（${code}）。ログフォルダを確認してください。`)));
    server.on('message', (message) => { if (message?.type === 'reel-ready') finish(null, message.port); });
  });
  origin = `http://127.0.0.1:${port}`;
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(permissionAllowed(permission, details.requestingUrl || contents.getURL(), origin)));
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => permissionAllowed(permission, requestingOrigin, origin));
  session.defaultSession.webRequest.onBeforeSendHeaders({urls: [`${origin}/*`]}, (details, callback) => callback({requestHeaders: {...details.requestHeaders, 'X-Reel-Desktop-Token': token}}));
  secureWindow(mainWindow);
  server.on('exit', (code) => {
    if (!quitting) {
      void dialog.showMessageBox(mainWindow, {type: 'error', title: 'Reel Studio', message: '動画処理が終了しました。アプリを起動し直してください。', detail: `終了コード: ${code}\nヘルプの「ログフォルダを開く」から詳細を確認できます。`});
    }
  });
  if (!smoke) launch('worker/index.ts', false, ['--auto']);
  await mainWindow.loadURL(`${origin}/`);
  mainWindow.on('close', (event) => {
    if (quitting || closingApproved) return;
    event.preventDefault();
    void confirmClose();
  });
  if (smoke) {
    const health = await fetch(`${origin}/api/health`, {headers: {'X-Reel-Desktop-Token': token}}).then((res) => res.json());
    const rejected = await fetch(`${origin}/api/health`).then((res) => res.status);
    fs.writeFileSync(path.join(home, 'electron-smoke.json'), JSON.stringify({ok: health.ok && rejected === 403, packaged: app.isPackaged, appVersion: app.getVersion(), url: mainWindow.webContents.getURL(), node: health.node, unauthenticatedStatus: rejected}, null, 2));
    quitting = true;
    app.quit();
  }
}

let checkingClose = false;
async function confirmClose() {
  if (checkingClose) return;
  checkingClose = true;
  try {
    const jobs = await fetch(`${origin}/api/jobs`, {headers: {'X-Reel-Desktop-Token': token}, signal: AbortSignal.timeout(2500)}).then((res) => res.json());
    const active = Array.isArray(jobs) ? jobs.filter((job) => ['running', 'queued'].includes(job.status)).length : 0;
    if (active) {
      const answer = await dialog.showMessageBox(mainWindow, {type: 'question', buttons: ['作業を続ける', '処理を止めて終了'], defaultId: 0, cancelId: 0, title: '処理が進行中です', message: `${active}件の処理が進行中です。終了すると処理を中止します。`});
      if (answer.response === 0) return;
    }
    // Let the renderer's beforeunload handler protect unsaved edits.
    closingApproved = true;
    mainWindow.close();
  } catch { closingApproved = true; mainWindow.close(); }
  finally { checkingClose = false; }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { const window = BrowserWindow.getAllWindows()[0]; if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(startup).catch(async (error) => {
    if (smoke && process.env.REEL_DESKTOP_TEST_HOME) fs.writeFileSync(path.join(process.env.REEL_DESKTOP_TEST_HOME, 'electron-smoke.json'), JSON.stringify({ok: false, error: error.message}));
    else {
      const answer = await dialog.showMessageBox({type: 'error', buttons: ['終了', 'ログを開く'], title: 'Reel Studioを起動できませんでした', message: error.message, detail: 'アプリを再起動してください。改善しない場合はインストーラーを実行し直してください。'});
      if (answer.response === 1) await shell.openPath(app.getPath('logs'));
    }
    quitting = true;
    stopChildren();
    app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { quitting = true; stopChildren(); logStream?.end(); });
  app.on('will-quit', stopChildren);
}
