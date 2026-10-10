const path = require('node:path');

module.exports = {
  appId: 'jp.reelstudio.desktop',
  productName: 'Reel Studio',
  electronVersion: '44.7.0',
  directories: {app: '.runtime/desktop-stage/app', output: 'desktop-out', buildResources: 'assets'},
  files: ['package.json', 'main.cjs', 'runtime.cjs', 'starting.html', 'reel-studio.svg', '!node_modules/**/*'],
  asar: true,
  extraResources: [
    {from: '.runtime/desktop-stage/backend', to: 'backend', filter: ['**/*']},
    // electron-builder excludes a root node_modules directory from a FileSet.
    // Copy its contents through a separate FileSet so the backend is independent.
    {from: '.runtime/desktop-stage/backend/node_modules', to: 'backend/node_modules', filter: ['**/*']},
    {from: '.runtime/desktop-stage/runtime', to: 'runtime', filter: ['**/*']},
    {from: '.runtime/desktop-stage/licenses', to: 'licenses', filter: ['**/*']},
    {from: 'assets/reel-studio.ico', to: 'reel-studio-v2.ico'},
  ],
  win: {target: [{target: 'nsis', arch: ['x64']}], icon: path.resolve('assets/reel-studio.ico'), signExecutable: false},
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Reel Studio',
    deleteAppDataOnUninstall: false,
    runAfterFinish: true,
    artifactName: 'Reel-Studio-${version}-Setup.${ext}',
    installerLanguages: ['ja_JP', 'en_US'],
    language: '1041',
    include: path.resolve('desktop/installer.nsh'),
  },
  publish: null,
  afterPack: ({appOutDir}) => {
    const {checkFiles, locations} = require('./runtime.cjs');
    checkFiles(locations(true, path.join(appOutDir, 'resources'), __dirname));
  },
};
