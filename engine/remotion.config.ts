import {Config} from '@remotion/cli/config';

Config.setEntryPoint('./src/index.ts');
Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
// 初回セットアップで導入したブラウザを各案件から共有する。
if (process.env.REEL_STUDIO_BROWSER_EXECUTABLE) {
  Config.setBrowserExecutable(process.env.REEL_STUDIO_BROWSER_EXECUTABLE);
}
