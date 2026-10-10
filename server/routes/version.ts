// 版の確認と更新（ローカル専用）。クラウド側にはこの経路が無い＝画面もボタンを出さない
// （クラウドの画面は Vercel にデプロイした版で動くので、更新は git push → デプロイ）。
import {Router} from 'express';
import {checkUpdate, localVersion, pullUpdate} from '../../core/version';
import {loadSettings} from '../../core/settings';
import {LAUNCHER_ENV, RESTART_EXIT_CODE, restartBlocker} from '../../shared/update';
import {jobs} from '../jobs';

export const versionRouter = Router();

/** このサーバーが起動した時刻。画面は「再起動したあとの新しいサーバーか」をこれの変化で見分ける */
const STARTED_AT = new Date().toISOString();

/** 画面が「更新する」を押したあと自動で起動し直せるか。理由が付いていればできない */
const restartState = () => {
  const launcher = process.env[LAUNCHER_ENV] === '1';
  const blocker = restartBlocker({launcher, runningJobs: jobs.runningJobs().length});
  return {launcher, blocker, startedAt: STARTED_AT};
};

versionRouter.get('/', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-cache');
    // notify＝ポップアップを出すか（設定）、restart＝押したあと自動で起動し直せるか
    const extra = {notify: loadSettings().update.notify, restart: restartState()};
    if (process.env.REEL_STUDIO_DESKTOP === '1') return res.json({local: await localVersion(), latest: null, behind: null, commits: [], problem: null, checkedAt: new Date().toISOString(), distribution: 'desktop', ...extra});
    // ?check=0 なら GitHub に問い合わせず手元の版だけ返す（起動直後の表示用・再起動待ち）
    if (req.query.check === '0') return res.json({local: await localVersion(), latest: null, behind: null, commits: [], problem: null, checkedAt: new Date().toISOString(), ...extra});
    res.json({...(await checkUpdate({refresh: req.query.refresh === '1'})), ...extra});
  } catch (e) {
    res.status(500).json({error: (e as Error).message});
  }
});

/** git pull --ff-only。npm install はしない（動いているサーバーが node_modules を掴んでいるため） */
versionRouter.post('/update', async (_req, res) => {
  if (process.env.REEL_STUDIO_DESKTOP === '1') return res.status(409).json({error: 'デスクトップ版は新しいインストーラーで更新してください。'});
  try {
    res.json(await pullUpdate());
  } catch (e) {
    res.status(500).json({error: (e as Error).message});
  }
});

/**
 * 起動し直す。応答を返してからサーバーを RESTART_EXIT_CODE で終わらせ、ランチャーが依存の導入・ビルド・起動をやり直す。
 * ランチャー経由でない・ジョブが走っているときは断る（落としたまま誰も起こさない／作業を途中で切る、を防ぐ）
 */
versionRouter.post('/restart', (_req, res) => {
  const {blocker} = restartState();
  if (blocker) return res.status(409).json({error: blocker});
  res.json({ok: true});
  console.log('更新を取り込むため、起動し直します…');
  setTimeout(() => process.exit(RESTART_EXIT_CODE), 300);
});
