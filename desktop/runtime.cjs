const fs = require('node:fs');
const path = require('node:path');

function locations(packaged, resources, root) {
  const base = packaged ? resources : path.join(root, '.runtime', 'desktop-stage');
  return {
    backend: path.join(base, 'backend'),
    node: path.join(base, 'runtime', 'node', 'node.exe'),
    ffmpeg: path.join(base, 'runtime', 'ffmpeg', 'bin'),
    browser: path.join(base, 'runtime', 'chrome', 'chrome-headless-shell.exe'),
  };
}

function backendEnvironment(base, paths, dataRoot, token, home) {
  const env = {...base};
  // Dev-tool environment variables must not redirect the installed app's renderer/tools.
  for (const key of ['REEL_STUDIO_BROWSER_EXECUTABLE', 'REEL_STUDIO_BUNDLED_ENGINE', 'REEL_STUDIO_FFMPEG_DIR', 'REEL_STUDIO_RUNTIME_FILE', 'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
  env[pathKey] = [path.dirname(paths.node), paths.ffmpeg, env[pathKey] || ''].join(path.delimiter);
  return {...env,
    REEL_STUDIO_DESKTOP: '1',
    REEL_STUDIO_HOME: home,
    REEL_STUDIO_DEFAULT_DATA_ROOT: dataRoot,
    REEL_STUDIO_BUNDLED_ENGINE: path.join(paths.backend, 'engine'),
    REEL_STUDIO_FFMPEG_DIR: paths.ffmpeg,
    REEL_STUDIO_BROWSER_EXECUTABLE: paths.browser,
    REEL_STUDIO_RUNTIME_FILE: path.join(home, 'desktop-tools.json'),
    REEL_STUDIO_HOST: '127.0.0.1',
    REEL_STUDIO_PORT: '0',
    REEL_STUDIO_DESKTOP_TOKEN: token,
  };
}

function externalUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

function permissionAllowed(permission, requestingUrl, origin) {
  try {
    return permission === 'clipboard-sanitized-write' && new URL(requestingUrl).origin === origin;
  } catch { return false; }
}

function checkFiles(paths) {
  for (const file of [paths.node, paths.browser, path.join(paths.ffmpeg, 'ffmpeg.exe'), path.join(paths.ffmpeg, 'ffprobe.exe'), path.join(paths.backend, 'server', 'index.ts'), path.join(paths.backend, 'dist', 'index.html'), path.join(paths.backend, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(paths.backend, 'node_modules', 'express', 'package.json'), path.join(paths.backend, 'engine', 'node_modules', '@remotion', 'cli', 'remotion-cli.js')]) {
    if (!fs.existsSync(file)) throw new Error(`必要な部品が見つかりません: ${file}\nインストーラーを実行し直してください。`);
  }
}

module.exports = {locations, backendEnvironment, externalUrl, permissionAllowed, checkFiles};
